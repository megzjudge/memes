// worker.js — updated with robust Imgflip scraping (fixed ID collection + parsers)
// ------------------------------------------------------------------------------
//
// Notes on key fixes:
// - Removed browser WebWorker self.onmessage handler (not used in Cloudflare Workers).
// - Fixed collectIdsFromAllPages(): capture group usage + next cursor extraction.
// - Fixed oldParse(): correct regex group usage; fixed title/tag extraction; safer keyword logic.
// - Hardened parseFromJson(): normalizes tags, views, meme_type fallback.
// - Kept existing KV caching behavior.
//
// Ensure your wrangler.toml binds env.NINJAMEMES to a KV namespace.

const USERNAME = "mbtininja";
const LIST_BASE = `https://imgflip.com/all/user-images/${USERNAME}?sort=latest`;

const HARD_MAX_ITEMS = 5000;
const HARD_MAX_LIST_PAGES = 500;

const KV_FEED_KEY = "imgflip-feed-v2";
const FEED_TTL_SECONDS = 900;

const IMGFLIP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: `https://imgflip.com/user/${USERNAME}`
};

const MBTI_TYPES = new Set([
  "ESTP","ISTP","ESFP","ISFP",
  "ESTJ","ISTJ","ESFJ","ISFJ",
  "ENFP","INFP","ENFJ","INFJ",
  "ENTJ","INTJ","ENTP","INTP"
]);

const MEME_TYPE_EXCLUDE = new Set([
  "mbti","myers briggs","myers-briggs","personality",
  "meme","memes","fun","fun stream","psychology"
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: basicHeaders() });
    }

    if (url.pathname === "/feed") {
      const fresh = url.searchParams.get("fresh") === "1";
      return handleFeed(env, fresh);
    }

    if (url.pathname === "/kym") {
      return handleKym(url);
    }

    return new Response("Not found", { status: 404, headers: basicHeaders() });
  }
};

// =========================================================
// FETCH WITH RETRY LOGIC
// =========================================================

async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
  const { headers = IMGFLIP_HEADERS, ...rest } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Fetching ${url} (attempt ${attempt}/${retries})`);
      const res = await fetch(url, { headers, ...rest });

      if (res.ok) return res;

      if (res.status === 429 || res.status === 503) {
        console.log(`Rate limited or service unavailable (${res.status}). Retrying...`);
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, delay * attempt));
        }
        continue;
      }

      if (attempt === retries) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.log(`Attempt ${attempt} failed:`, err && err.message ? err.message : String(err));

      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, delay * attempt));
      } else {
        throw err;
      }
    }
  }

  throw new Error("Max retries exceeded");
}

// Helpers -------------------------------------------------

function basicHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...basicHeaders(),
      "Content-Type": "application/json"
    }
  });
}

// =========================================================
// FEED HANDLER
// =========================================================

async function handleFeed(env, fresh) {
  const kv = env.NINJAMEMES;

  if (!fresh) {
    const cached = await kv.get(KV_FEED_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.items) return jsonResponse(parsed);
      } catch {}
    }
  }

  console.log("Building fresh feed…");

  const ids = await collectIdsFromAllPages();
  console.log("IDs collected:", ids.length);

  const items = new Array(ids.length);
  let index = 0;
  const concurrency = 3;

  async function workerLoop() {
    while (index < ids.length) {
      const myIndex = index++;
      const id = ids[myIndex];

      try {
        const item = await fetchItemDetails(id);
        items[myIndex] = item || minimalItemFromId(id);
      } catch (err) {
        console.log("Error fetching id", id, err && err.message ? err.message : String(err));
        items[myIndex] = minimalItemFromId(id);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, workerLoop));
  const filtered = items.filter(Boolean);

  const payload = {
    updated_at: new Date().toISOString(),
    count: filtered.length,
    items: filtered
  };

  try {
    await kv.put(KV_FEED_KEY, JSON.stringify(payload), {
      expirationTtl: FEED_TTL_SECONDS
    });
  } catch (err) {
    console.log("KV write error:", err && err.message ? err.message : String(err));
  }

  return jsonResponse(payload);
}

// =========================================================
// KNOW YOUR MEME REDIRECT
// =========================================================

async function handleKym(url) {
  const name = url.searchParams.get("name") || "";
  const explicit = url.searchParams.get("slug") || "";
  const label = name || explicit;
  const slug = explicit ? slugifyForKym(explicit) : slugifyForKym(name);

  if (slug) {
    const target = `https://knowyourmeme.com/memes/${slug}`;
    if (await urlExists(target)) return redirect(target);
  }

  return redirect(
    "https://knowyourmeme.com/search?context=&sort=&q=" + encodeURIComponent(label)
  );
}

function redirect(loc) {
  return new Response(null, {
    status: 302,
    headers: { ...basicHeaders(), Location: loc }
  });
}

async function urlExists(url) {
  try {
    const r = await fetch(url, { method: "HEAD", headers: IMGFLIP_HEADERS });
    return r && r.ok && r.status !== 404;
  } catch {
    return false;
  }
}

// =========================================================
// LISTING PAGE ID CRAWLER
// =========================================================

async function collectIdsFromAllPages() {
  const seen = new Set();
  const ids = [];
  const visited = new Set();
  let cursor = null;
  let page = 0;

  while (true) {
    if (page >= HARD_MAX_LIST_PAGES || ids.length >= HARD_MAX_ITEMS) break;

    const url = cursor ? `${LIST_BASE}&after=${encodeURIComponent(cursor)}` : LIST_BASE;
    page++;
    console.log("Fetching list page", page, url);

    const html = await fetchHtml(url);
    if (!html) break;

    const imgRegex =
      /(?:https?:)?\/\/i\.imgflip\.com\/([A-Za-z0-9]+)\.(?:jpg|png|gif|webp)/g;

    let m;
    const got = [];
    while ((m = imgRegex.exec(html))) {
      const id = m[1]; // FIX: capture group (string)
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
        got.push(id);
        if (ids.length >= HARD_MAX_ITEMS) break;
      }
    }

    if (got.length === 0) break;

    // FIX: extract cursor string, not the entire match array
    const nextMatch = html.match(/after=([0-9A-Za-z]+)[^"']*["'][^>]*>\s*Next/i);
    const next = nextMatch ? nextMatch[1] : null;

    if (!next || visited.has(next)) break;
    visited.add(next);
    cursor = next;
  }

  return ids;
}

// =========================================================
// FETCH INDIVIDUAL ITEM PAGE
// =========================================================

async function fetchItemDetails(id) {
  const url = `https://imgflip.com/i/${id}`;
  const html = await fetchHtml(url);
  if (!html) return null;
  return parseItemPage(html, id, url);
}

// =========================================================
// PARSER — JSON + fallback
// =========================================================

function parseItemPage(html, id, pageUrl) {
  const json = extractNextData(html);
  if (json?.props?.pageProps?.image) {
    return parseFromJson(json.props.pageProps.image, id, pageUrl);
  }
  return oldParse(html, id, pageUrl);
}

function extractNextData(html) {
  const match = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function parseFromJson(obj, id, pageUrl) {
  const item = minimalItemFromId(id);
  item.page_url = pageUrl;

  // Title
  item.title = (obj && obj.title && String(obj.title).trim())
    ? String(obj.title).trim()
    : id;

  // Views (Imgflip sometimes uses ensighten_views)
  const viewsRaw = obj ? (obj.ensighten_views ?? obj.views ?? 0) : 0;
  const viewsNum = Number(viewsRaw);
  item.views = Number.isFinite(viewsNum) ? viewsNum : 0;

  // Age text (keep as string; front-end can interpret if needed)
  item.age_text = (obj && obj.created_at) ? String(obj.created_at) : "";

  // Image URL + GIF detection
  if (obj && obj.url) {
    const rawUrl = String(obj.url);
    const u = rawUrl.startsWith("//") ? "https:" + rawUrl : rawUrl;
    item.image_url = u;
    item.is_gif = u.toLowerCase().endsWith(".gif");
  }

  // Tags can be strings or objects (harden)
  const tagsArr = (obj && Array.isArray(obj.tags)) ? obj.tags : [];
  item.tags = tagsArr
    .map(t => (typeof t === "string" ? t : (t && t.text ? t.text : "")))
    .map(t => String(t).toLowerCase().trim())
    .filter(Boolean);

  // Meme type from template if present
  if (obj && obj.template && obj.template.name) {
    const raw = String(obj.template.name).replace(/ meme$/i, "");
    item.meme_type = toTitleCase(raw);
    item.kym_slug = slugifyForKym(item.meme_type);
  }

  // Derive MBTI + keywords from tags
  for (const t of item.tags) {
    const upper = t.toUpperCase();
    if (MBTI_TYPES.has(upper)) item.mbti_types.push(upper);
    else item.keywords.push(t);
  }

  // Fallback meme_type from first acceptable tag if template missing
  if (!item.meme_type) {
    const candidate = item.tags.find(
      t => !MBTI_TYPES.has(t.toUpperCase()) && !MEME_TYPE_EXCLUDE.has(t)
    );
    if (candidate) {
      item.meme_type = toTitleCase(candidate);
      item.kym_slug = slugifyForKym(item.meme_type);
    }
  }

  return item;
}

// =========================================================
// FALLBACK PARSER (regex)
// =========================================================

function oldParse(html, id, pageUrl) {
  const item = minimalItemFromId(id);
  item.page_url = pageUrl;

  const tMatch =
    html.match(/<h1[^>]+id=["']img-title["'][^>]*>([\s\S]*?)<\/h1>/i) ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  // FIX: use capture group tMatch[1]
  if (tMatch && tMatch[1]) {
    item.title = decode(strip(tMatch[1])).trim() || id;
  }

  // Detect GIF
  const gifMatch = html.match(
    new RegExp(`["'](?:https?:)?//i\\.imgflip\\.com/${id}\\.gif["']`, "i")
  );
  // FIX: match array -> use [0]
  if (gifMatch && gifMatch[0]) {
    let u = gifMatch[0].replace(/["']/g, "");
    item.image_url = u.startsWith("//") ? "https:" + u : u;
    item.is_gif = true;
  }

  // Tags from /tag/ links
  const tags = [];
  let m;
  const tagRegex = /<a[^>]+href=["']\/tag\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = tagRegex.exec(html))) {
    // FIX: use capture group m[1]
    const t = decode(strip(m[1])).trim().toLowerCase();
    if (t) tags.push(t);
  }
  item.tags = tags;

  // Derive meme_type, mbti_types, keywords
  for (const t of tags) {
    const upper = t.toUpperCase();

    if (MBTI_TYPES.has(upper)) {
      item.mbti_types.push(upper);
      continue;
    }

    if (!item.meme_type && !MEME_TYPE_EXCLUDE.has(t)) {
      item.meme_type = toTitleCase(t);
      item.kym_slug = slugifyForKym(item.meme_type);
      continue;
    }

    // Keywords: keep non-meme-type tags
    if (item.meme_type && t !== item.meme_type.toLowerCase()) {
      item.keywords.push(t);
    } else if (!item.meme_type) {
      item.keywords.push(t);
    }
  }

  return item;
}

// =========================================================
// HTML FETCHING
// =========================================================

async function fetchHtml(url) {
  try {
    const res = await fetchWithRetry(url, {
      headers: IMGFLIP_HEADERS,
      cf: { cacheEverything: true, cacheTtl: 300 }
    });
    if (!res.ok) return "";

    const text = await res.text();

    // crude bot/captcha detection
    const lower = text.slice(0, 3000).toLowerCase();
    if (lower.includes("captcha") || lower.includes("unusual traffic")) return "";

    return text;
  } catch {
    return "";
  }
}

// =========================================================
// Text helpers
// =========================================================

function strip(s) {
  return String(s).replace(/<\/?[^>]+>/g, "");
}

function decode(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function toTitleCase(s) {
  return String(s)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function slugifyForKym(str) {
  return String(str || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function minimalItemFromId(id) {
  return {
    id,
    page_url: `https://imgflip.com/i/${id}`,
    image_url: `https://i.imgflip.com/${id}.jpg`,
    is_gif: false,
    title: id,
    views: 0,
    meme_type: "",
    mbti_types: [],
    keywords: [],
    tags: [],
    age_text: "",
    kym_slug: null
  };
}