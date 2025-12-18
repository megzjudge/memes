// worker.js — incremental + throttled Imgflip scraping (compliant approach)
// ----------------------------------------------------------------------

const USERNAME = "mbtininja";
const LIST_BASE = `https://imgflip.com/all/user-images/${USERNAME}?sort=latest`;

const KV_FEED_KEY = "imgflip";
const KV_META_KEY = "imgflip-feed-meta-v1"; // cursor + seen ids
const FEED_TTL_SECONDS = 900;

// Safety caps (keep these conservative)
const MAX_LIST_PAGES_PER_REFRESH = 3;     // don’t walk hundreds of pages per run
const MAX_ITEMS_TOTAL = 600;              // max items stored in feed
const MAX_ITEM_ENRICH_PER_REFRESH = 40;   // enrich only N item pages per refresh
const CONCURRENCY = 2;                    // low concurrency reduces blocks
const THROTTLE_MS = 450;                  // delay between item fetches

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

// Tags you do NOT want as “keywords”
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
  },

  async scheduled(event, env, ctx) {
    // Cron refresh: build + cache feed in KV
    ctx.waitUntil(buildAndCacheFeed(env));
  }
};

// =========================================================
// HTTP helpers
// =========================================================

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
    headers: { ...basicHeaders(), "Content-Type": "application/json" }
  });
}

function redirect(loc) {
  return new Response(null, {
    status: 302,
    headers: { ...basicHeaders(), Location: loc }
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// =========================================================
// FETCH WITH RETRY (polite + backoff)
// =========================================================

async function fetchWithRetry(url, options = {}, retries = 3, baseDelay = 900) {
  const { headers = IMGFLIP_HEADERS, ...rest } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers, ...rest });

      if (res.ok) return res;

      // Treat these as transient / throttling
      if (res.status === 429 || res.status === 503) {
        if (attempt < retries) {
          await sleep(baseDelay * attempt + Math.floor(Math.random() * 250));
          continue;
        }
      }

      if (attempt === retries) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt < retries) {
        await sleep(baseDelay * attempt + Math.floor(Math.random() * 250));
      } else {
        throw err;
      }
    }
  }

  throw new Error("Max retries exceeded");
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
        if (parsed && Array.isArray(parsed.items)) return jsonResponse(parsed);
      } catch {}
    }
  }

  // If /feed?fresh=1, or cache miss: rebuild
  const payload = await buildAndCacheFeed(env);
  return jsonResponse(payload);
}

/**
 * Build feed incrementally:
 * - Load previous feed + meta (seen ids + cursor)
 * - Crawl only a few newest list pages
 * - Merge ids, keep MAX_ITEMS_TOTAL
 * - Enrich only a limited number of items per run
 */
async function buildAndCacheFeed(env) {
  const kv = env.NINJAMEMES;

  const priorFeed = await loadJsonKV(kv, KV_FEED_KEY) || { items: [] };
  const priorItems = Array.isArray(priorFeed.items) ? priorFeed.items : [];

  const meta = await loadJsonKV(kv, KV_META_KEY) || { cursor: null, seen: [] };
  const seen = new Set(Array.isArray(meta.seen) ? meta.seen : []);

  // 1) Get latest IDs from listing pages (few pages only)
  const latestIds = await collectIdsFromAllPages({
    maxPages: MAX_LIST_PAGES_PER_REFRESH,
    maxItems: MAX_ITEMS_TOTAL
  });

  // 2) Merge IDs: newest first, then prior
  const mergedIds = [];
  for (const id of latestIds) {
    if (!seen.has(id)) {
      seen.add(id);
    }
    mergedIds.push(id);
  }
  // Append any old ids we already had, preserving older content
  for (const item of priorItems) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    if (!mergedIds.includes(id)) mergedIds.push(id);
  }

  // Cap total
  const finalIds = mergedIds.slice(0, MAX_ITEMS_TOTAL);

  // 3) Index prior items by id for reuse
  const byId = new Map();
  for (const it of priorItems) {
    if (it && it.id) byId.set(String(it.id), it);
  }

  // 4) Determine which items need enrichment
  // “Needs enrichment” = looks like minimal / missing core fields
  const toEnrich = [];
  for (const id of finalIds) {
    const existing = byId.get(id);
    if (!existing) {
      toEnrich.push(id);
      continue;
    }

    const title = String(existing.title || "");
    const memeType = String(existing.meme_type || "");
    const hasKeywords = Array.isArray(existing.keywords) && existing.keywords.length > 0;
    const hasAge = String(existing.age_text || "").length > 0;

    const looksMinimal =
      title === id ||
      (!memeType && !hasKeywords && !hasAge);

    if (looksMinimal) toEnrich.push(id);
  }

  // Only enrich a limited number each refresh
  const enrichIds = toEnrich.slice(0, MAX_ITEM_ENRICH_PER_REFRESH);

  // 5) Fetch + parse item pages (throttled)
  let idx = 0;
  const results = new Map();

  async function enrichLoop() {
    while (idx < enrichIds.length) {
      const my = idx++;
      const id = enrichIds[my];

      try {
        // Throttle between attempts
        if (my > 0) await sleep(THROTTLE_MS);

        const item = await fetchItemDetails(id);
        if (item) results.set(id, item);
      } catch {
        // Keep existing / minimal; do not fail whole run
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, enrichLoop));

  // 6) Build final items array in id order
  const items = finalIds.map(id => {
    const enriched = results.get(id);
    if (enriched) return enriched;

    const existing = byId.get(id);
    if (existing) return normalizeItem(existing);

    return minimalItemFromId(id);
  });

  const payload = {
    updated_at: new Date().toISOString(),
    count: items.length,
    items
  };

  // 7) Save feed + meta
  await kv.put(KV_FEED_KEY, JSON.stringify(payload), { expirationTtl: FEED_TTL_SECONDS });

  // Keep meta a bit longer than feed TTL so incremental can continue
  const metaPayload = {
    cursor: null,
    seen: Array.from(seen).slice(-5000)
  };
  await kv.put(KV_META_KEY, JSON.stringify(metaPayload), { expirationTtl: 60 * 60 * 24 * 7 });

  return payload;
}

async function loadJsonKV(kv, key) {
  try {
    const v = await kv.get(key);
    if (!v) return null;
    return JSON.parse(v);
  } catch {
    return null;
  }
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

async function urlExists(url) {
  try {
    const r = await fetch(url, { method: "HEAD", headers: IMGFLIP_HEADERS });
    return r && r.ok && r.status !== 404;
  } catch {
    return false;
  }
}

// =========================================================
// LISTING PAGE ID CRAWLER (fixed)
// =========================================================

async function collectIdsFromAllPages({ maxPages, maxItems }) {
  const seen = new Set();
  const ids = [];
  const visitedCursors = new Set();

  let cursor = null;
  let page = 0;

  while (page < maxPages && ids.length < maxItems) {
    const url = cursor ? `${LIST_BASE}&after=${encodeURIComponent(cursor)}` : LIST_BASE;
    page++;

    const html = await fetchHtml(url);
    if (!html) break;

    const imgRegex =
      /(?:https?:)?\/\/i\.imgflip\.com\/([A-Za-z0-9]+)\.(?:jpg|png|gif|webp)/g;

    let m;
    let gotAny = false;

    while ((m = imgRegex.exec(html))) {
      const id = m[1]; // FIX: use capture group
      if (!isLikelyImgflipId(id)) continue;

      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
        gotAny = true;
        if (ids.length >= maxItems) break;
      }
    }

    if (!gotAny) break;

    // Try to find Next cursor; be tolerant of markup changes
    const nextCursor =
      (html.match(/href="[^"]*after=([0-9A-Za-z]+)[^"]*"\s*[^>]*>\s*Next/i) || [])[1] ||
      (html.match(/after=([0-9A-Za-z]+)[^"']*["'][^>]*>\s*Next/i) || [])[1];

    if (!nextCursor) break;
    if (visitedCursors.has(nextCursor)) break;

    visitedCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return ids;
}

function isLikelyImgflipId(id) {
  // Imgflip ids are alnum, typically ~6 chars but can vary
  return typeof id === "string" && /^[A-Za-z0-9]{5,12}$/.test(id);
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
// PARSER — JSON + fallback, with consistent keyword filtering
// =========================================================

function parseItemPage(html, id, pageUrl) {
  const json = extractNextData(html);
  const img = json?.props?.pageProps?.image;
  if (img) return normalizeItem(parseFromJson(img, id, pageUrl));
  return normalizeItem(oldParse(html, id, pageUrl));
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
  item.title = (obj && obj.title) ? String(obj.title) : id;

  const viewsRaw =
    obj?.ensighten_views ??
    obj?.views ??
    obj?.view_count ??
    obj?.num_views ??
    0;

  item.views = Number.isFinite(Number(viewsRaw)) ? Number(viewsRaw) : 0;

  item.age_text = obj?.created_at ? String(obj.created_at) : "";

  if (obj?.url) {
    let u = String(obj.url);
    if (u.startsWith("//")) u = "https:" + u;
    item.image_url = u;
    item.is_gif = u.toLowerCase().endsWith(".gif");
  }

  // Template-based meme type (best signal)
  if (obj?.template?.name) {
    const raw = String(obj.template.name).replace(/ meme$/i, "");
    item.meme_type = toTitleCase(raw);
    item.kym_slug = slugifyForKym(item.meme_type);
  }

  // Tags → mbti_types + keywords (filtered)
  const tags = Array.isArray(obj?.tags) ? obj.tags : [];
  item.tags = tags.map(t => String(t).toLowerCase().trim()).filter(Boolean);

  for (const t of item.tags) {
    const upper = t.toUpperCase();
    if (MBTI_TYPES.has(upper)) item.mbti_types.push(upper);
    else item.keywords.push(t);
  }

  return item;
}

// Fallback parser (old regex)
function oldParse(html, id, pageUrl) {
  const item = minimalItemFromId(id);
  item.page_url = pageUrl;

  const tMatch =
    html.match(/<h1[^>]+id=["']img-title["'][^>]*>([\s\S]*?)<\/h1>/i) ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  if (tMatch) item.title = decode(strip(tMatch[1])).trim();

  const gifMatch = html.match(
    new RegExp(`["'](?:https?:)?//i\\.imgflip\\.com/${id}\\.gif["']`, "i")
  );
  if (gifMatch) {
    let u = gifMatch[0].replace(/["']/g, "");
    if (u.startsWith("//")) u = "https:" + u;
    item.image_url = u;
    item.is_gif = true;
  }

  // Tag extraction
  const tags = [];
  const tagRegex = /<a[^>]+href=["']\/tag\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = tagRegex.exec(html))) {
    const t = decode(strip(m[1])).trim().toLowerCase();
    if (t) tags.push(t);
  }
  item.tags = tags;

  // Choose meme type from first suitable tag if we don’t have a template name
  for (const t of tags) {
    const upper = t.toUpperCase();
    if (!MBTI_TYPES.has(upper) && !MEME_TYPE_EXCLUDE.has(t) && !item.meme_type) {
      item.meme_type = toTitleCase(t);
      item.kym_slug = slugifyForKym(item.meme_type);
    }
  }

  for (const t of tags) {
    const upper = t.toUpperCase();
    if (MBTI_TYPES.has(upper)) item.mbti_types.push(upper);
    else item.keywords.push(t);
  }

  return item;
}

function normalizeItem(raw) {
  const item = raw && typeof raw === "object" ? raw : minimalItemFromId("unknown");

  item.id = String(item.id || "").trim();
  if (!item.id) return minimalItemFromId("unknown");

  item.page_url = item.page_url ? String(item.page_url) : `https://imgflip.com/i/${item.id}`;
  item.image_url = item.image_url ? String(item.image_url) : `https://i.imgflip.com/${item.id}.jpg`;

  item.title = item.title ? String(item.title) : item.id;

  item.views = Number.isFinite(Number(item.views)) ? Number(item.views) : 0;

  item.meme_type = item.meme_type ? String(item.meme_type) : "";
  item.kym_slug = item.kym_slug ? String(item.kym_slug) : (item.meme_type ? slugifyForKym(item.meme_type) : null);

  item.age_text = item.age_text ? String(item.age_text) : "";

  item.mbti_types = Array.isArray(item.mbti_types)
    ? dedupe(item.mbti_types.map(t => String(t).toUpperCase()).filter(t => MBTI_TYPES.has(t)))
    : [];

  // Ensure keywords exists and is filtered consistently:
  // - lowercase
  // - no MBTI types
  // - no excluded “generic” tags
  // - no empty strings
  item.keywords = Array.isArray(item.keywords)
    ? dedupe(
        item.keywords
          .map(k => String(k).toLowerCase().trim())
          .filter(Boolean)
          .filter(k => !MBTI_TYPES.has(k.toUpperCase()))
          .filter(k => !MEME_TYPE_EXCLUDE.has(k))
      )
    : [];

  item.tags = Array.isArray(item.tags)
    ? dedupe(item.tags.map(t => String(t).toLowerCase().trim()).filter(Boolean))
    : [];

  // Recompute is_gif if missing/incorrect
  item.is_gif = Boolean(item.is_gif) || item.image_url.toLowerCase().endsWith(".gif");

  return item;
}

function dedupe(arr) {
  const out = [];
  const s = new Set();
  for (const v of arr) {
    if (!s.has(v)) {
      s.add(v);
      out.push(v);
    }
  }
  return out;
}

// =========================================================
// HTML FETCHING (block-aware, no bypass)
// =========================================================

async function fetchHtml(url) {
  try {
    const res = await fetchWithRetry(url, {
      headers: IMGFLIP_HEADERS,
      cf: { cacheEverything: true, cacheTtl: 300 }
    });

    if (!res.ok) return "";

    const text = await res.text();

    const lower = text.slice(0, 3500).toLowerCase();
    // If we detect a block page, return empty so we fall back to minimal data.
    // (We are NOT trying to bypass, only detect and fail safely.)
    if (lower.includes("captcha") || lower.includes("unusual traffic")) return "";

    return text;
  } catch {
    return "";
  }
}

// =========================================================
// Text helpers
// =========================================================

function strip(s) { return String(s).replace(/<\/?[^>]+>/g, ""); }
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
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
function slugifyForKym(str) {
  return String(str)
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function minimalItemFromId(id) {
  const safeId = String(id || "").trim();
  return {
    id: safeId,
    page_url: `https://imgflip.com/i/${safeId}`,
    image_url: `https://i.imgflip.com/${safeId}.jpg`,
    is_gif: false,
    title: safeId,
    views: 0,
    meme_type: "",
    mbti_types: [],
    keywords: [],
    tags: [],
    age_text: "",
    kym_slug: null
  };
}
