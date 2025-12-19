// worker.js
// Two-key KV model:
// - KV key "static": stable metadata (id, title, tags, meme_type, mbti_types, keywords, created_at, etc.)
// - KV key "dynamic": dynamic metadata (views, age_text), refreshed daily
//
// /feed merges static + dynamic and returns a single response for the frontend.

const USERNAME = "mbtininja";
const LIST_PAGE_1 = `https://imgflip.com/all/user-images/${USERNAME}?sort=latest`;

const KV_STATIC_KEY = "static";
const KV_DYNAMIC_KEY = "dynamic";

// Use cron for daily refresh; if your cron is hourly, this still works.
// You can adjust logic below if you want to throttle dynamic refresh across multiple runs.
const STATIC_MAX_ITEMS = 5000;

const IMGFLIP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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
      // Frontend endpoint: always return merged
      return handleFeed(env);
    }

    if (url.pathname === "/kym") {
      return handleKym(url);
    }

    return new Response("Not found", { status: 404, headers: basicHeaders() });
  },

  async scheduled(event, env, ctx) {
    // Daily (or hourly) refresh:
    // 1) refresh static from listing page 1 (only adds new memes)
    // 2) refresh dynamic (views + age_text) for all static ids
    ctx.waitUntil(refreshAll(env));
  }
};

// =========================================================
// Refresh pipeline
// =========================================================

async function refreshAll(env) {
  const kv = env.NINJAMEMES;

  const staticObj = await kvGetJson(kv, KV_STATIC_KEY, { updated_at: "", items: [] });
  const dynamicObj = await kvGetJson(kv, KV_DYNAMIC_KEY, { updated_at: "", items: [] });

  const updatedStatic = await refreshStaticFromPage1(kv, staticObj);

  const updatedDynamic = await refreshDynamicForStatic(kv, updatedStatic, dynamicObj);

  await kv.put(KV_STATIC_KEY, JSON.stringify(updatedStatic));
  await kv.put(KV_DYNAMIC_KEY, JSON.stringify(updatedDynamic));
}

// =========================================================
// FEED HANDLER: merge static + dynamic
// =========================================================

async function handleFeed(env) {
  const kv = env.NINJAMEMES;

  const staticObj = await kvGetJson(kv, KV_STATIC_KEY, { updated_at: "", items: [] });
  const dynamicObj = await kvGetJson(kv, KV_DYNAMIC_KEY, { updated_at: "", items: [] });

  const dynMap = new Map(
    Array.isArray(dynamicObj.items)
      ? dynamicObj.items.map(d => [d.id, d])
      : []
  );

  const merged = (Array.isArray(staticObj.items) ? staticObj.items : []).map(s => {
    const d = dynMap.get(s.id);
    return {
      ...s,
      views: (d && Number.isFinite(Number(d.views))) ? Number(d.views) : (Number.isFinite(Number(s.views)) ? Number(s.views) : 0),
      age_text: (d && typeof d.age_text === "string") ? d.age_text : (typeof s.age_text === "string" ? s.age_text : "")
    };
  });

  return jsonResponse(
    {
      updated_at: new Date().toISOString(),
      count: merged.length,
      items: merged
    },
    200
  );
}

// =========================================================
// Static refresh: parse ONLY listing page 1
// - This only adds new memes; it does not re-scrape older pages.
// =========================================================

async function refreshStaticFromPage1(kv, staticObj) {
  const existing = Array.isArray(staticObj.items) ? staticObj.items : [];
  const existingIds = new Set(existing.map(x => x && x.id).filter(Boolean));

  const html = await fetchHtml(LIST_PAGE_1);
  const page1Ids = collectIdsFromListingHtml(html);

  if (!page1Ids.length) {
    return {
      updated_at: new Date().toISOString(),
      items: existing.slice(0, STATIC_MAX_ITEMS)
    };
  }

  const newIds = page1Ids.filter(id => !existingIds.has(id));

  if (!newIds.length) {
    return {
      updated_at: new Date().toISOString(),
      items: existing.slice(0, STATIC_MAX_ITEMS)
    };
  }

  // Fetch details for new items only (page1 delta)
  const newItems = [];
  for (const id of newIds) {
    const item = await fetchAndParseItem(id);
    if (item) newItems.push(item);
    // small delay to be gentle
    await sleep(150);
  }

  // Keep newest first: page1Ids is newest-first; newItems was fetched in that order
  const merged = [...newItems, ...existing].slice(0, STATIC_MAX_ITEMS);

  return {
    updated_at: new Date().toISOString(),
    items: merged
  };
}

// =========================================================
// Dynamic refresh: views + age_text for all static ids
// - Views require per-item fetch.
// - age_text is derived from static.created_ts (no extra Imgflip calls needed).
// - IMPORTANT: if a fetch fails, we keep the prior dynamic value (no zeroing).
// =========================================================

async function refreshDynamicForStatic(kv, staticObj, dynamicObj) {
  const staticItems = Array.isArray(staticObj.items) ? staticObj.items : [];
  const priorDyn = Array.isArray(dynamicObj.items) ? dynamicObj.items : [];
  const priorMap = new Map(priorDyn.map(d => [d.id, d]));

  const now = Date.now();

  const out = [];
  const concurrency = 2;
  let idx = 0;

  async function workerLoop() {
    while (idx < staticItems.length) {
      const my = idx++;
      const s = staticItems[my];
      if (!s || !s.id) continue;

      const prior = priorMap.get(s.id) || { id: s.id, views: 0, age_text: "" };

      // Derive age_text from static created_ts (preferred) or keep prior/blank
      let ageText = prior.age_text || "";
      const createdTs = Number(s.created_ts);
      if (Number.isFinite(createdTs) && createdTs > 0) {
        ageText = timeAgo(now - createdTs);
      }

      // Fetch views (and only accept update if parse succeeds)
      const fetched = await fetchViewsOnly(s.id);
      if (fetched && fetched.ok) {
        out[my] = { id: s.id, views: fetched.views, age_text: ageText };
      } else {
        // keep prior views if fetch failed
        const priorViews = Number.isFinite(Number(prior.views)) ? Number(prior.views) : 0;
        out[my] = { id: s.id, views: priorViews, age_text: ageText };
      }

      await sleep(120);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, workerLoop));

  const finalItems = out.filter(Boolean);

  return {
    updated_at: new Date().toISOString(),
    items: finalItems
  };
}

// =========================================================
// Imgflip listing page parser (IDs only)
// =========================================================

function collectIdsFromListingHtml(html) {
  if (!html) return [];
  const seen = new Set();
  const ids = [];

  // Extract IDs from image CDN URLs
  const imgRegex = /(?:https?:)?\/\/i\.imgflip\.com\/([A-Za-z0-9]+)\.(?:jpg|png|gif|webp)/g;
  let m;
  while ((m = imgRegex.exec(html))) {
    const id = m[1];
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

// =========================================================
// Fetch full static item from /i/<id> page
// =========================================================

async function fetchAndParseItem(id) {
  const url = `https://imgflip.com/i/${id}`;
  const html = await fetchHtml(url);
  if (!html) return minimalStaticFromId(id);

  const parsed = parseItemPage(html, id, url);
  return parsed || minimalStaticFromId(id);
}

// =========================================================
// Dynamic-only view fetch (no static fields overwritten)
// =========================================================

async function fetchViewsOnly(id) {
  const url = `https://imgflip.com/i/${id}`;
  const html = await fetchHtml(url);
  if (!html) return { ok: false };

  // Prefer __NEXT_DATA__
  const next = extractNextData(html);
  const image = extractImageFromNext(next);

  if (image) {
    const views = coerceViews(image);
    if (Number.isFinite(views)) return { ok: true, views };
  }

  // Fallback: try a loose regex for views if present
  // (kept conservative; if not found, mark as failure to avoid zeroing)
  const m = html.match(/([0-9][0-9,]*)\s+views/i);
  if (m && m[1]) {
    const v = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(v)) return { ok: true, views: v };
  }

  return { ok: false };
}

// =========================================================
// Full parser for static fields
// =========================================================

function parseItemPage(html, id, pageUrl) {
  const next = extractNextData(html);
  const image = extractImageFromNext(next);

  if (image) return parseFromJson(image, id, pageUrl);

  // fallback minimal
  return minimalStaticFromId(id);
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

function extractImageFromNext(next) {
  // Known-ish paths; keep defensive
  const img =
    next?.props?.pageProps?.image ||
    next?.props?.pageProps?.data?.image ||
    next?.props?.pageProps?.props?.image ||
    null;

  return img && typeof img === "object" ? img : null;
}

function parseFromJson(obj, id, pageUrl) {
  const item = minimalStaticFromId(id);

  item.page_url = pageUrl;

  // Title
  item.title = (obj.title && String(obj.title).trim()) ? String(obj.title).trim() : id;

  // Image URL
  const rawUrl = obj.url || obj.image_url || "";
  if (rawUrl) {
    const u = String(rawUrl).startsWith("//") ? "https:" + rawUrl : String(rawUrl);
    item.image_url = u;
    item.is_gif = u.toLowerCase().endsWith(".gif");
  }

  // Created timestamp (prefer absolute)
  const created =
    obj.created_at ||
    obj.created ||
    obj.createdAt ||
    obj.submitted_at ||
    "";

  const createdTs = Date.parse(String(created));
  if (Number.isFinite(createdTs)) {
    item.created_at = new Date(createdTs).toISOString();
    item.created_ts = createdTs;
  } else {
    item.created_at = "";
    item.created_ts = 0;
  }

  // Tags
  const tagsRaw = Array.isArray(obj.tags) ? obj.tags : [];
  const tags = tagsRaw
    .map(t => String(t).toLowerCase().trim())
    .filter(Boolean);

  item.tags = tags;

  // Meme type
  let memeType = "";
  if (obj.template?.name) {
    memeType = String(obj.template.name).replace(/ meme$/i, "").trim();
  }
  if (!memeType) {
    // fallback: pick first non-excluded, non-mbti tag as meme type candidate
    for (const t of tags) {
      const upper = t.toUpperCase();
      if (MBTI_TYPES.has(upper)) continue;
      if (MEME_TYPE_EXCLUDE.has(t)) continue;
      memeType = t;
      break;
    }
  }
  item.meme_type = memeType ? toTitleCase(memeType) : "";
  item.kym_url = obj.kym_url ? String(obj.kym_url).trim() : "";

  // Split mbti_types vs keywords
  const mbti = [];
  const keywords = [];
  for (const t of tags) {
    const upper = t.toUpperCase();
    if (MBTI_TYPES.has(upper)) {
      mbti.push(upper);
      continue;
    }
    // Keywords are tags minus meme_type tag (if it matches)
    if (item.meme_type && t === item.meme_type.toLowerCase()) continue;
    keywords.push(t);
  }

  item.mbti_types = unique(mbti);
  item.keywords = unique(keywords);

  return item;
}

// =========================================================
// KYM redirect
// =========================================================

async function handleKym(url) {
  const kymUrl = (url.searchParams.get("url") || "").trim();
  const name = (url.searchParams.get("name") || "").trim();

  if (kymUrl) {
    try {
      const u = new URL(kymUrl);
      if (u.hostname === "knowyourmeme.com" || u.hostname.endsWith(".knowyourmeme.com")) {
        return redirect(u.toString());
      }
    } catch {
    }
  }

  return redirect(
    "https://knowyourmeme.com/search?context=&sort=&q=" + encodeURIComponent(name)
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
    const r = await fetch(url, { method: "HEAD" });
    return r && r.ok && r.status !== 404;
  } catch {
    return false;
  }
}

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
    headers: {
      ...basicHeaders(),
      "Content-Type": "application/json"
    }
  });
}

async function kvGetJson(kv, key, fallback) {
  const raw = await kv.get(key);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// =========================================================
// Fetching (with retry + bot detection guard)
// =========================================================

async function fetchWithRetry(url, options = {}, retries = 3, delay = 900) {
  const { headers = IMGFLIP_HEADERS, ...rest } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers,
        ...rest,
        cf: { cacheEverything: true, cacheTtl: 300 }
      });

      if (res.ok) return res;

      if (res.status === 429 || res.status === 503) {
        if (attempt < retries) {
          await sleep(delay * attempt);
          continue;
        }
      }

      if (attempt === retries) return res;
      await sleep(delay * attempt);
    } catch {
      if (attempt === retries) throw new Error("fetch failed");
      await sleep(delay * attempt);
    }
  }

  throw new Error("Max retries exceeded");
}

async function fetchHtml(url) {
  try {
    const res = await fetchWithRetry(url);
    if (!res.ok) return "";
    const text = await res.text();

    // basic bot/captcha guard
    const head = text.slice(0, 4000).toLowerCase();
    if (head.includes("captcha") || head.includes("unusual traffic")) return "";

    return text;
  } catch {
    return "";
  }
}

// =========================================================
// Utility / formatting
// =========================================================

function minimalStaticFromId(id) {
  return {
    id,
    page_url: `https://imgflip.com/i/${id}`,
    image_url: `https://i.imgflip.com/${id}.jpg`,
    is_gif: false,

    title: id,
    meme_type: "",
    mbti_types: [],
    keywords: [],
    tags: [],
    kym_url: "",

    // static time fields
    created_at: "",
    created_ts: 0,

    // frontend expects these may exist, but in the merged feed dynamic overrides them
    views: 0,
    age_text: ""
  };
}

function unique(arr) {
  return Array.from(new Set(arr));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function toTitleCase(s) {
  return String(s)
    .trim()
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

function coerceViews(imageObj) {
  // Try likely keys without being speculative beyond number coercion
  const candidates = [
    imageObj.views,
    imageObj.ensighten_views,
    imageObj.view_count,
    imageObj.viewCount
  ];

  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function timeAgo(deltaMs) {
  const sec = Math.floor(deltaMs / 1000);
  if (!Number.isFinite(sec) || sec < 0) return "";

  const minute = 60;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  if (sec < minute) return "just now";
  if (sec < hour) {
    const m = Math.floor(sec / minute);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (sec < day) {
    const h = Math.floor(sec / hour);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  if (sec < week) {
    const d = Math.floor(sec / day);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }
  if (sec < month) {
    const w = Math.floor(sec / week);
    return `${w} week${w === 1 ? "" : "s"} ago`;
  }
  if (sec < year) {
    const mo = Math.floor(sec / month);
    return `${mo} month${mo === 1 ? "" : "s"} ago`;
  }
  const y = Math.floor(sec / year);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}
