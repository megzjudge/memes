// worker.js
// ---------------------------------------------------
// Imgflip feed worker
// - KV key renamed to: "imgflip"
// - Parses ONLY page 1 for new items (latest listing)
// - Updates views by scanning all items in small batches
// ---------------------------------------------------

const USERNAME = "mbtininja";
const LIST_PAGE_1 = `https://imgflip.com/all/user-images/${USERNAME}?sort=latest`;

const KV_FEED_KEY = "imgflip"; // renamed from imgflip-feed-v2
const KV_VIEWS_CURSOR_KEY = "imgflip-views-cursor";

const FEED_SOFT_CACHE_SECONDS = 900; // return cached payload if refreshed recently and fresh!=1
const VIEWS_BATCH_SIZE = 60; // updates views for this many items per refresh to reduce scraping load
const VIEWS_CONCURRENCY = 3;

const IMGFLIP_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": `https://imgflip.com/user/${USERNAME}`
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: basicHeaders() });
    }

    if (url.pathname === "/feed") {
      const fresh = url.searchParams.get("fresh") === "1";
      const viewsAll = url.searchParams.get("views") === "all";
      const payload = await handleFeed(env, { fresh, viewsAll });
      return jsonResponse(payload);
    }

    if (url.pathname === "/kym") {
      return handleKym(url);
    }

    return new Response("Not found", { status: 404, headers: basicHeaders() });
  },

  // Cron: refresh feed on schedule
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleFeed(env, { fresh: true, viewsAll: false, scheduled: true }).catch(() => {}));
  }
};

// =========================================================
// FEED HANDLER
// =========================================================

async function handleFeed(env, opts) {
  const kv = env.NINJAMEMES;

  const existing = await readPayload(kv);

  // soft-cache: if not forcing fresh, return if recently updated
  if (!opts.fresh && existing && existing.updated_at) {
    const ageMs = Date.now() - Date.parse(existing.updated_at);
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < FEED_SOFT_CACHE_SECONDS * 1000) {
      return existing;
    }
  }

  // Step 1: parse ONLY page 1 listing for latest ids
  const page1Html = await fetchHtml(LIST_PAGE_1);
  const page1Ids = parseIdsFromListingPage(page1Html);

  // Step 2: merge with existing KV items
  const prevItems = Array.isArray(existing.items) ? existing.items : [];
  const prevById = new Map(prevItems.map(it => [String(it.id), it]));

  const merged = [];

  // Keep “page 1” items at the front in the order they appear on the listing page.
  for (const id of page1Ids) {
    const existingItem = prevById.get(id);
    if (existingItem) {
      merged.push(existingItem);
      prevById.delete(id);
    } else {
      // New item: fetch full details from its item page
      const item = await fetchItemDetails(id);
      merged.push(item || minimalItemFromId(id));
    }
  }

  // Append remaining existing items (older items) in their previous order.
  for (const it of prevItems) {
    const id = String(it.id);
    if (page1Ids.includes(id)) continue;
    merged.push(it);
  }

  // Step 3: update views (all items in batches by default)
  await updateViews(kv, merged, { viewsAll: Boolean(opts.viewsAll) });

  const payload = {
    updated_at: new Date().toISOString(),
    count: merged.length,
    items: merged
  };

  await kv.put(KV_FEED_KEY, JSON.stringify(payload));
  return payload;
}

async function readPayload(kv) {
  const raw = await kv.get(KV_FEED_KEY);
  if (!raw) return { updated_at: "", count: 0, items: [] };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.items)) return parsed;
  } catch {}
  return { updated_at: "", count: 0, items: [] };
}

// =========================================================
// VIEW UPDATER
// =========================================================

async function updateViews(kv, items, opts) {
  if (!Array.isArray(items) || !items.length) return;

  let indices = [];

  if (opts.viewsAll) {
    indices = items.map((_, i) => i);
  } else {
    const cursorRaw = await kv.get(KV_VIEWS_CURSOR_KEY);
    let cursor = parseInt(cursorRaw || "0", 10);
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

    const n = items.length;
    const batch = Math.min(VIEWS_BATCH_SIZE, n);

    indices = new Array(batch);
    for (let k = 0; k < batch; k++) {
      indices[k] = (cursor + k) % n;
    }

    const nextCursor = (cursor + batch) % n;
    await kv.put(KV_VIEWS_CURSOR_KEY, String(nextCursor));
  }

  // concurrency worker loop
  let p = 0;
  async function loop() {
    while (p < indices.length) {
      const my = p++;
      const idx = indices[my];
      const item = items[idx];
      if (!item || !item.id) continue;

      const view = await fetchViewsOnly(String(item.id));
      if (typeof view === "number" && Number.isFinite(view)) {
        item.views = view;
      }
    }
  }

  await Promise.all(Array.from({ length: VIEWS_CONCURRENCY }, loop));
}

// =========================================================
// LISTING PAGE PARSER (PAGE 1 ONLY)
// =========================================================

function parseIdsFromListingPage(html) {
  if (!html) return [];

  const ids = [];
  const seen = new Set();

  // primary: links like href="/i/af902h"
  const hrefRe = /href=["']\/i\/([A-Za-z0-9]+)["']/g;
  let m;
  while ((m = hrefRe.exec(html))) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  // fallback: image URLs like i.imgflip.com/af902h.jpg
  const imgRe = /\/\/i\.imgflip\.com\/([A-Za-z0-9]+)\.(?:jpg|png|gif|webp)/g;
  while ((m = imgRe.exec(html))) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  return ids;
}

// =========================================================
// ITEM PAGE FETCH + PARSE
// =========================================================

async function fetchItemDetails(id) {
  const pageUrl = `https://imgflip.com/i/${id}`;
  const html = await fetchHtml(pageUrl);
  if (!html) return null;

  const item = minimalItemFromId(id);
  item.page_url = pageUrl;

  // Try __NEXT_DATA__
  const next = extractNextData(html);
  const node = next ? findBestImageNode(next, id) : null;

  // Prefer structured parse if possible
  if (node) {
    applyNodeToItem(item, node, id);
    return finalizeItem(item);
  }

  // Fallback: minimal but try views
  const v = extractViewsFromHtml(html);
  if (Number.isFinite(v)) item.views = v;

  // Also try title from <title> as last resort
  const tMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (tMatch) item.title = decode(strip(tMatch[1])).trim() || id;

  return finalizeItem(item);
}

async function fetchViewsOnly(id) {
  const url = `https://imgflip.com/i/${id}`;
  const html = await fetchHtml(url);
  if (!html) return null;

  // Fast path: regex for ensighten_views in HTML
  const v = extractViewsFromHtml(html);
  if (Number.isFinite(v)) return v;

  // Structured fallback
  const next = extractNextData(html);
  if (!next) return null;

  const node = findBestImageNode(next, id);
  if (!node) return null;

  const views = node.ensighten_views ?? node.views;
  const n = Number(views);
  return Number.isFinite(n) ? n : null;
}

function extractViewsFromHtml(html) {
  if (!html) return null;

  const m1 = html.match(/"ensighten_views"\s*:\s*([0-9]+)/);
  if (m1) return Number(m1[1]);

  // If ensighten_views isn’t present, look for a views field in __NEXT_DATA__ slice
  const next = extractNextDataRaw(html);
  if (next) {
    const m2 = next.match(/"views"\s*:\s*([0-9]+)/);
    if (m2) return Number(m2[1]);
  }

  return null;
}

function extractNextDataRaw(html) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if (!match) return "";
  return match[1] || "";
}

function extractNextData(html) {
  const raw = extractNextDataRaw(html);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Heuristic: find an object that looks like the Imgflip “image” node for this id.
function findBestImageNode(root, id) {
  const queue = [root];
  const seen = new Set();

  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    // Candidate checks
    const curId = cur.id != null ? String(cur.id) : "";
    const url = cur.url != null ? String(cur.url) : (cur.image_url != null ? String(cur.image_url) : "");

    const looksRight =
      (curId === id) ||
      (url && url.includes(id)) ||
      (cur.page_url && String(cur.page_url).includes(`/i/${id}`));

    const hasUsefulFields =
      ("title" in cur) ||
      ("tags" in cur) ||
      ("ensighten_views" in cur) ||
      ("views" in cur) ||
      ("template" in cur) ||
      ("url" in cur) ||
      ("image_url" in cur);

    if (looksRight && hasUsefulFields) {
      return cur;
    }

    // Traverse
    for (const k of Object.keys(cur)) {
      const v = cur[k];
      if (v && typeof v === "object") queue.push(v);
    }
  }

  // Common fallback path (if present)
  const direct = root?.props?.pageProps?.image;
  if (direct && typeof direct === "object") return direct;

  return null;
}

function applyNodeToItem(item, node, id) {
  // title
  const t = node.title != null ? String(node.title).trim() : "";
  item.title = t || id;

  // views
  const v = node.ensighten_views ?? node.views;
  const vn = Number(v);
  item.views = Number.isFinite(vn) ? vn : (item.views || 0);

  // age / timestamps
  if (node.created_at != null) item.age_text = String(node.created_at);
  if (node.createdAt != null && !item.age_text) item.age_text = String(node.createdAt);

  // image URL
  const rawUrl = node.url ?? node.image_url ?? node.imageUrl ?? "";
  if (rawUrl) {
    let u = String(rawUrl);
    if (u.startsWith("//")) u = "https:" + u;
    item.image_url = u;
    item.is_gif = u.toLowerCase().endsWith(".gif");
  }

  // tags (strings, or objects with name)
  let tags = [];
  if (Array.isArray(node.tags)) {
    tags = node.tags.map(t => {
      if (t == null) return "";
      if (typeof t === "string") return t;
      if (typeof t === "object" && t.name) return String(t.name);
      return String(t);
    });
  }
  tags = tags.map(s => String(s).toLowerCase().trim()).filter(Boolean);
  item.tags = tags;

  // meme_type from template name if available
  if (node.template?.name) {
    const raw = String(node.template.name).replace(/ meme$/i, "");
    const mt = toTitleCase(raw);
    item.meme_type = mt;
    item.kym_slug = slugifyForKym(mt);
  } else if (!item.meme_type) {
    // fallback: first non-MBTI, non-excluded tag
    const mtTag = tags.find(t => {
      const upper = t.toUpperCase();
      if (MBTI_TYPES.has(upper)) return false;
      if (MEME_TYPE_EXCLUDE.has(t)) return false;
      return true;
    });
    if (mtTag) {
      const mt = toTitleCase(mtTag);
      item.meme_type = mt;
      item.kym_slug = slugifyForKym(mt);
    }
  }

  // MBTI + keywords
  item.mbti_types = [];
  item.keywords = [];

  for (const t of tags) {
    const upper = t.toUpperCase();
    if (MBTI_TYPES.has(upper)) {
      item.mbti_types.push(upper);
    } else {
      // keep keywords even if they’re excluded for meme_type selection
      item.keywords.push(t);
    }
  }

  // If meme_type exists, avoid duplicating it as a keyword
  if (item.meme_type) {
    const memeLower = String(item.meme_type).toLowerCase();
    item.keywords = item.keywords.filter(k => k !== memeLower);
  }

  // Ensure “memes” keyword when tag has memes
  if (tags.includes("memes") && !item.keywords.includes("memes")) {
    item.keywords.push("memes");
  }
}

function finalizeItem(item) {
  // de-dupe arrays
  item.mbti_types = Array.from(new Set((item.mbti_types || []).map(s => String(s).toUpperCase()).filter(Boolean)));
  item.keywords = Array.from(new Set((item.keywords || []).map(s => String(s).toLowerCase().trim()).filter(Boolean)));
  item.tags = Array.from(new Set((item.tags || []).map(s => String(s).toLowerCase().trim()).filter(Boolean)));

  // ensure kym_slug consistency
  if (!item.kym_slug && item.meme_type) {
    item.kym_slug = slugifyForKym(item.meme_type);
  }
  if (item.kym_slug === "null") item.kym_slug = null;

  // sanity: must have id
  if (!item.id) return null;
  return item;
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
// HTML FETCHING (retry + bot/captcha guard)
// =========================================================

async function fetchWithRetry(url, options = {}, retries = 3, delay = 900) {
  const { headers = IMGFLIP_HEADERS, ...rest } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers, ...rest });
      if (res.ok) return res;

      if (res.status === 429 || res.status === 503) {
        if (attempt < retries) {
          await sleep(delay * attempt);
          continue;
        }
      }
      if (attempt === retries) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt < retries) {
        await sleep(delay * attempt);
      } else {
        throw err;
      }
    }
  }

  throw new Error("Max retries exceeded");
}

async function fetchHtml(url) {
  try {
    const res = await fetchWithRetry(url, {
      headers: IMGFLIP_HEADERS,
      cf: { cacheEverything: true, cacheTtl: 300 }
    });

    const text = await res.text();
    const lower = text.slice(0, 5000).toLowerCase();
    if (lower.includes("captcha") || lower.includes("unusual traffic")) return "";
    return text;
  } catch {
    return "";
  }
}

// =========================================================
// Response helpers
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
    headers: {
      ...basicHeaders(),
      "Content-Type": "application/json"
    }
  });
}

// =========================================================
// Text helpers
// =========================================================

function strip(s) {
  return String(s || "").replace(/<\/?[^>]+>/g, "");
}

function decode(s) {
  return String(s || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function toTitleCase(s) {
  return String(s || "")
    .toLowerCase()
    .split(/\s+/)
    .map(w => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
