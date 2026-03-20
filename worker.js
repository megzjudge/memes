// worker.js

export default {
  async fetch(request, env) {
    // Serves static files from root (index.html, script.js, styles.css, images/, etc.)
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const cronId = event.cron;
    const startTime = new Date().toISOString();

    const log = (level, msg, data = {}) => {
      console.log(`[${cronId}] ${startTime} [${level}] ${msg}`, data);
    };

    log("INFO", "Cron started");

    const user = env.IMGFLIP_USER;
    const pass = env.IMGFLIP_PASS;

    if (!user || !pass) {
      log("ERROR", "Missing IMGFLIP_USER or IMGFLIP_PASS");
      return;
    }

    try {
      // Step 1: Discover new memes
      log("INFO", "Step 1: Discovering new memes");
      const newItems = await discoverNewMemes(env, user, pass);

      // Step 2: Enrich / fill
      log("INFO", "Step 2: Enriching new items");
      await enrichItems(env, newItems);

      // Step 3: Update views
      log("INFO", "Step 3: Updating view counts");
      await updateViewCounts(env);

      log("INFO", "Full pipeline completed successfully");
    } catch (err) {
      log("ERROR", "Pipeline failed", {
        message: err.message,
        stack: err.stack || "No stack",
        cron: cronId,
        timestamp: new Date().toISOString()
      });
    }
  }
};

// ======================
// Step 1: Discover new memes (from update-memes.mjs)
// ======================
async function discoverNewMemes(env, user, pass) {
  try {
    log("INFO", "Fetching login page for CSRF");

    const loginPageRes = await fetch("https://imgflip.com/login", {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!loginPageRes.ok) {
      const text = await safeGetText(loginPageRes);
      throw new Error(`Login page fetch failed: ${loginPageRes.status} - ${text.slice(0, 300)}`);
    }

    const loginPageHtml = await loginPageRes.text();
    const csrfMatch = loginPageHtml.match(/name="csrf_token" value="([^"]+)"/);
    const csrf = csrfMatch ? csrfMatch[1] : null;

    if (!csrf) throw new Error("CSRF token not found in login page");

    log("INFO", "CSRF extracted - attempting login");

    const loginRes = await fetch("https://imgflip.com/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0",
        "Cookie": loginPageRes.headers.get("set-cookie") || ""
      },
      body: new URLSearchParams({
        username: user,
        password: pass,
        csrf_token: csrf
      })
    });

    if (!loginRes.ok) {
      const errorText = await safeGetText(loginRes);
      throw new Error(`Login failed: ${loginRes.status} - ${errorText.slice(0, 300)}`);
    }

    log("INFO", "Login success - fetching latest memes");

    const memesRes = await fetch("https://imgflip.com/all/user-images/mbtininja?sort=latest", {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!memesRes.ok) throw new Error(`Memes page fetch failed: ${memesRes.status}`);

    const html = await memesRes.text();

    // Regex parsing
    const items = [];
    const regexes = [
      /href\s*=\s*["']?\/i\/([a-z0-9]{6,8})["'][^>]*>[\s\S]*?<img[^>]+src=["'](https:\/\/i\.imgflip\.com\/[a-z0-9]+\.(?:jpg|png|gif))["']/gi,
      /href\s*=\s*["']?\/gif\/([a-z0-9]{6,8})["']/gi
    ];

    const seen = new Set();
    for (const rx of regexes) {
      let match;
      while ((match = rx.exec(html)) !== null) {
        const id = match[1];
        let imageUrl = match[2] || `https://i.imgflip.com/${id}.gif`;
        if (!seen.has(id)) {
          seen.add(id);
          items.push({ id, imageUrl });
        }
      }
    }

    log("INFO", "Discovered items", { count: items.length });

    // Filter new ones
    let existingCsv = await env.MEMES_KV.get("memes.csv") || "";
    const existingIds = new Set();
    if (existingCsv) {
      const lines = existingCsv.split("\n");
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        if (cols[0]) existingIds.add(cols[0].trim().replace(/^"/, "").replace(/"$/, ""));
      }
    }

    const trulyNew = items.filter(item => !existingIds.has(item.id));

    // Append to CSV
    let updatedCsv = existingCsv || "ID,URLS,IMAGE_URL,IS_GIF,TITLE,MEME_TYPE,KYM_SLUG,MBTI_TYPES,KEYWORDS,TAGS\n";
    trulyNew.forEach(item => {
      const isGif = item.imageUrl.toLowerCase().includes(".gif");
      const row = [
        item.id,
        `https://imgflip.com/${isGif ? "gif" : "i"}/${item.id}`,
        item.imageUrl,
        isGif ? "TRUE" : "FALSE",
        item.id,
        "", "", "", "", ""
      ];
      updatedCsv += csvLine(row) + "\n";
    });

    await env.MEMES_KV.put("memes.csv", updatedCsv);

    log("INFO", "New items appended to KV", { count: trulyNew.length });

    return trulyNew;
  } catch (err) {
    log("ERROR", "discoverNewMemes failed", { message: err.message, stack: err.stack });
    throw err;
  }
}

// ======================
// Step 2: Enrich / fill
// ======================
async function enrichItems(env, newItems) {
  try {
    log("INFO", "Starting enrichment", { count: newItems.length });

    let csvText = await env.MEMES_KV.get("memes.csv") || "";
    let rows = parseCSV(csvText);

    const MAX_ROWS_PER_RUN = 34;
    let processed = 0;

    for (const item of newItems.slice(0, MAX_ROWS_PER_RUN)) {
      if (processed >= MAX_ROWS_PER_RUN) break;

      const url = `https://imgflip.com/i/${item.id}`;
      const { title, imageUrl, tags, kymSlug } = await scrapePage(url);

      const row = rows.find(r => r.id === item.id);
      if (row) {
        if (title) row.title = title;
        if (imageUrl) row.image_url = imageUrl;
        if (kymSlug) row.kym_slug = kymSlug;

        const { mbti, memeType, keywords } = processTags(tags.split(", "));

        row.mbti_types = mbti.join(", ");
        row.meme_type = memeType.replace(/-/g, " ");
        row.keywords = keywords.join(", ").replace(/-/g, " ");
        row.tags = tags.replace(/-/g, " ");
      }

      processed++;
      await sleep(250);
    }

    const updatedCsv = "ID,URLS,IMAGE_URL,IS_GIF,TITLE,MEME_TYPE,KYM_SLUG,MBTI_TYPES,KEYWORDS,TAGS\n" +
      rows.map(r => csvLine([r.id, r.urls, r.image_url, r.is_gif, r.title, r.meme_type, r.kym_slug, r.mbti_types, r.keywords, r.tags])).join("\n");

    await env.MEMES_KV.put("memes.csv", updatedCsv);

    log("INFO", "Enrichment complete", { processed });
  } catch (err) {
    log("ERROR", "enrichItems failed", { message: err.message, stack: err.stack });
    throw err;
  }
}

// ======================
// Step 3: Update views
// ======================
async function updateViewCounts(env) {
  try {
    log("INFO", "Starting views update");

    let csvText = await env.MEMES_KV.get("memes.csv") || "";
    let rows = parseCSV(csvText);

    const MAX_ITEMS = 350;
    const REQUEST_DELAY_MS = 250;
    let blockedCount = 0;
    let updated = 0;
    const results = [];

    for (const row of rows.slice(0, MAX_ITEMS)) {
      const id = row.id;
      if (!id) continue;

      const { views, blocked } = await fetchViewsForMeme(id);

      if (blocked) {
        blockedCount++;
        const fallback = row.views || 0;
        results.push({ id, views: fallback });
        if (blockedCount >= 8) break;
      } else {
        results.push({ id, views });
        if (views !== (row.views || 0)) updated++;
      }

      await sleep(REQUEST_DELAY_MS);
    }

    const dailyCsv = "ID,URLS,VIEWS\n" + results.map(r =>
      csvLine([r.id, `https://imgflip.com/i/${r.id}`, r.views])
    ).join("\n");

    await env.MEMES_KV.put("meme-views.csv", dailyCsv);

    log("INFO", "Views update complete", { updated, blocked: blockedCount });
  } catch (err) {
    log("ERROR", "updateViewCounts failed", { message: err.message, stack: err.stack });
    throw err;
  }
}

// ======================
// Shared helpers
// ======================

async function safeGetText(res) {
  try { return await res.text(); } catch { return "Body not readable"; }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvLine(fields) {
  return fields.map(csvEscape).join(",");
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 1) return [];

  const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split(",").map(c => c.trim());
    const row = {};
    headers.forEach((h, idx) => row[h] = cols[idx] || "");
    rows.push(row);
  }

  return rows;
}

async function scrapePage(url) {
  if (!url) return { title: "", imageUrl: "", tags: [], kymSlug: "" };

  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return { title: "", imageUrl: "", tags: [], kymSlug: "" };

    const html = await res.text();

    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(" - Imgflip", "").trim() : "";

    const imageMatch = html.match(/property="og:image" content="([^"]+)"/i);
    const imageUrl = imageMatch ? imageMatch[1] : "";

    const tagMatches = html.matchAll(/href='\/(tag|meme)\/([^']+)'/g);
    const tags = [...tagMatches].map(m => m[2]).join(", ");

    const kymMatch = html.match(/knowyourmeme.com\/memes\/([^"\/]+)/i);
    const kymSlug = kymMatch ? kymMatch[1] : "";

    return { title, imageUrl, tags, kymSlug };
  } catch {
    return { title: "", imageUrl: "", tags: [], kymSlug: "" };
  }
}

function processTags(tags) {
  const mbti = tags.filter(t => MBTI_SET.has(t.toUpperCase()));
  let memeType = "";
  for (const t of tags) {
    if (!MBTI_SET.has(t.toUpperCase()) && !MEME_TYPE_BLOCKLIST.has(t.toLowerCase())) {
      memeType = t;
      break;
    }
  }
  memeType = memeType.replace(/-/g, " ");

  const keywords = tags.filter(t => {
    if (MBTI_SET.has(t.toUpperCase())) return false;
    if (t === memeType) return false;
    return true;
  }).map(k => k.replace(/-/g, " "));

  return { mbti, memeType, keywords };
}

async function fetchViewsForMeme(id) {
  const url = `https://imgflip.com/i/${id}`;
  const html = await fetchText(url);

  if (!html) return { views: 0, blocked: true };

  const head = html.slice(0, 6000).toLowerCase();
  if (head.includes("captcha") || head.includes("unusual traffic")) {
    return { views: 0, blocked: true };
  }

  const next = extractNextData(html);
  if (next) {
    let candidate = null;
    candidate = getDeep(next, ["props", "pageProps", "image", "views"]);
    if (candidate === null) candidate = getDeep(next, ["props", "pageProps", "data", "image", "views"]);
    if (candidate === null) candidate = getDeep(next, ["props", "pageProps", "image", "view_count"]);
    if (candidate === null) candidate = getDeep(next, ["props", "pageProps", "data", "image", "view_count"]);

    const v = toInt(candidate);
    if (Number.isFinite(v)) return { views: v, blocked: false };
  }

  const m1 = html.match(/"views"\s*:\s*(\d{1,12})/);
  if (m1) return { views: Number(m1[1]), blocked: false };

  const m2 = html.match(/([\d,]{1,15})\s+views/i);
  if (m2) return { views: Number(m2[1].replace(/,/g, "")), blocked: false };

  return { views: 0, blocked: false };
}

function getDeep(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || !(key in cur)) return null;
    cur = cur[key];
  }
  return cur;
}

function extractNextData(html) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { headers: IMGFLIP_HEADERS });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  }
}

const IMGFLIP_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://imgflip.com/"
};

const MBTI_TYPES = ["ESTP","ISTP","ESFP","ISFP","ESTJ","ISTJ","ESFJ","ISFJ","ENFP","INFP","ENFJ","INFJ","ENTJ","INTJ","ENTP","INTP"];
const MBTI_SET = new Set(MBTI_TYPES);
const MEME_TYPE_BLOCKLIST = new Set(["memes","mbti","myers briggs","personality"]);
