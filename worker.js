// worker.js

//
// 📧 Email Helper
//
async function sendEmail(env, { subject, message }) {
  try {
    await env.EMAIL.send({
      from: env.ROUTING_EMAIL,
      to: env.ROUTING_EMAIL,
      subject,
      text: message
    });
    console.log(`Email sent from ${env.ROUTING_EMAIL} to ${env.ROUTING_EMAIL}`);
  } catch (err) {
    console.error("Email send failed:", err.message);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/run" || path === "/trigger") {
      ctx.waitUntil(
        (async () => {
          const fakeEvent = { cron: "manual-http-trigger" };
          await this.scheduled(fakeEvent, env, ctx);
        })()
      );

      return new Response(
        "Pipeline triggered — check Observability logs for progress",
        { status: 202 }
      );
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const cronId = event.cron;
    const startTime = new Date().toISOString();

    const log = (level, msg, data = {}) => {
      const logEntry = `[${cronId}] ${startTime} [${level}] ${msg}`;
      console.log(logEntry, data);
    };

    log("INFO", "Cron started");

    try {
      log("INFO", "Step 1: Discovering new memes");
      const newItems = await discoverNewMemes(env, log);
      log("INFO", `✅ Step 1 Complete: ${newItems.length} rows added`);

      log("INFO", "Step 2: Enriching new items");
      const editedCount = await enrichItems(env, newItems, log);
      log("INFO", `✅ Step 2 Complete: ${editedCount} rows edited`);

      log("INFO", "Waiting 10 seconds before Step 3...");
      await sleep(10000);

      log("INFO", "Step 3: Updating view counts");
      const updatedViewCount = await updateViewCounts(env, log);
      log("INFO", `✅ Step 3 Complete: ${updatedViewCount} rows edited`);

    } catch (err) {
      log("ERROR", "Pipeline failed", {
        message: err.message,
        stack: err.stack
      });
    }
  }
};

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

//
// ✅ STEP 1: Discover New Memes (with cookie check and test email)
//
async function discoverNewMemes(env, log) {
  try {
    const cookie = env.IMGFLIP_COOKIE;
    if (!cookie) {
      log("ERROR", "Missing IMGFLIP_COOKIE");
      await sendEmail(env, {
        subject: "❌ Imgflip Cookie Missing",
        message: "No IMGFLIP_COOKIE found in secrets — update immediately."
      });
      return [];
    }

    log("DEBUG", "Testing Imgflip cookie...");

    const res = await fetch("https://imgflip.com/", {
      headers: {
        ...IMGFLIP_HEADERS,
        "Cookie": cookie
      }
    });

    const html = await res.text();

    const isLoggedIn =
      html.includes("/logout") ||
      html.includes("u-menu") ||
      html.includes("rootkey");

    if (!isLoggedIn) {
      log("ERROR", "Cookie appears to be expired or invalid");
      await sendEmail(env, {
        subject: "❌ Imgflip Cookie Expired",
        message: "Your Imgflip cookie is no longer valid. Please refresh it."
      });
      return [];
    }

    log("INFO", "✅ Cookie is valid — sending test email");
    await sendEmail(env, {
      subject: "✅ Imgflip Cookie OK",
      message: "Cookie is working and authenticated successfully."
    });

    // Continue scraping memes
    log("INFO", "Fetching memes page...");

    const pageRes = await fetch(
      "https://imgflip.com/all/user-images/mbtininja?sort=latest",
      {
        headers: {
          ...IMGFLIP_HEADERS,
          "Cookie": cookie
        }
      }
    );

    const pageHtml = await pageRes.text();
    log("DEBUG", `Memes page fetched (${pageHtml.length} bytes)`);

    const items = [];
    const seen = new Set();
    const regex =
      /href\s*=\s*["']?\/(i|gif)\/([a-z0-9]{6,8})["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["']/gi;

    let match;
    while ((match = regex.exec(pageHtml)) !== null) {
      const id = match[2];
      const imageUrl = match[3];
      if (!seen.has(id)) {
        seen.add(id);
        items.push({ id, imageUrl });
      }
    }

    log("DEBUG", `Found ${items.length} memes`);

    // Existing CSV fetch/update
    let existingCsv = await fetchGitHubFile(env, "memes.csv", log);
    const existingIds = new Set();
    if (existingCsv) {
      const lines = existingCsv.split("\n");
      for (let i = 1; i < lines.length; i++) {
        const id = lines[i].split(",")[0]?.trim();
        if (id) existingIds.add(id);
      }
    }

    const trulyNew = items.filter(x => !existingIds.has(x.id));
    log("INFO", `Found ${trulyNew.length} new memes`);

    if (trulyNew.length > 0) {
      let baseCsv = (existingCsv || "ID,URLS,IMAGE_URL,IS_GIF,TITLE,MEME_TYPE,KYM_SLUG,MBTI_TYPES,KEYWORDS,TAGS\n").trimEnd() + "\n";
      
      let newRows = trulyNew.map(item => {
        const isGif = item.imageUrl.includes(".gif");
        return csvLine([
          item.id,
          `https://imgflip.com/${isGif ? "gif" : "i"}/${item.id}`,
          item.imageUrl,
          isGif ? "TRUE" : "FALSE",
          item.id,
          "", "", "", "", ""
        ]);
      }).join("\n") + "\n";
      
      const existingWithoutHeader = baseCsv.split("\n").slice(1).join("\n");
      const updatedCsv = newRows + existingWithoutHeader + "\n";
      
      await updateGitHubFile(env, "memes.csv", updatedCsv, log);
      log("INFO", `Added ${trulyNew.length} new rows at top`);

      await updateGitHubFile(env, "memes.csv", updatedCsv, log);
      log("INFO", `Added ${trulyNew.length} rows`);
    }

    return trulyNew;

  } catch (err) {
    log("ERROR", "discoverNewMemes failed", err);
    await sendEmail(env, {
      subject: "❌ Imgflip Worker Error",
      message: `Error during cookie test:\n\n${err.message}`
    });
    return [];
  }
}

// Step 2: Enrich / fill (only last 2, skip upload if no changes)
async function enrichItems(env, newItems, log) {
  try {
    log("DEBUG", "Fetching memes.csv from GitHub...");
    let csvText = await fetchGitHubFile(env, "memes.csv", log);
    let rows = parseCSV(csvText);
    log("DEBUG", `Parsed ${rows.length} rows`);

    rows.forEach(r => {
      r.id = String(r.id || "").trim().replace(/^["']|["']$/g, "");
    });
    rows.sort((a, b) => b.id.localeCompare(a.id));
    
    let targetRows;
    
    if (newItems && newItems.length > 0) {
      const newIds = new Set(newItems.map(n => n.id));
      targetRows = rows.filter(r => newIds.has(r.id)).slice(0, 5);
    } else {
      targetRows = rows.slice(0, 2);
    }
    
    if (targetRows.length === 0) return 0;
    
    log("INFO", `Enriching: ${targetRows.map(r => r.id).join(", ")}`);

    let editedCount = 0;
    let hasChanges = false;

    for (const row of targetRows) {
      const item = { id: row.id };
      const url = `https://imgflip.com/i/${item.id}`;
      log("DEBUG", `Scraping ${url}...`);
      const { title, imageUrl, tags, memeType, kymSlug } = await scrapePage(url);

      let changes = 0;

      if (title && title !== row.title) {
        row.title = title;
        changes++;
      }
      if (imageUrl && imageUrl !== row.image_url) {
        row.image_url = imageUrl;
        changes++;
      }
      if (kymSlug && kymSlug !== row.kym_slug) {
        row.kym_slug = kymSlug;
        changes++;
      }
      if (memeType && memeType !== row.meme_type) {
        row.meme_type = memeType;
        changes++;
      }
      if (tags && tags !== row.tags) {
        row.tags = tags;
        changes++;
      }

      const { mbti, keywords } = processTags(tags.split(", "), memeType);

      if (mbti.join(",") !== row.mbti_types) {
        row.mbti_types = mbti.join(",");
        changes++;
      }
      if (keywords.join(",").replace(/-/g, " ") !== row.keywords) {
        row.keywords = keywords.join(",").replace(/-/g, " ");
        changes++;
      }

      if (changes > 0) {
        editedCount++;
        hasChanges = true;
        log("DEBUG", `Updated ${item.id} (${changes} changes)`);
      }
      await sleep(250);
    }

    if (!hasChanges) {
      log("INFO", "No changes — skipping upload");
      return editedCount;
    }

    // Clean list fields before save
    rows.forEach(r => {
      ['mbti_types', 'keywords', 'tags'].forEach(field => {
        let val = String(r[field] || "").trim();
        if (val.startsWith('"') && val.endsWith('"')) {
          val = val.slice(1, -1).trim();
        }
        val = val.replace(/""/g, '"');
        val = val.split(',').map(t => t.trim()).filter(Boolean).join(', ');
        r[field] = val;
      });
    });

    const updatedCsv = "ID,URLS,IMAGE_URL,IS_GIF,TITLE,MEME_TYPE,KYM_SLUG,MBTI_TYPES,KEYWORDS,TAGS\n" +
      rows.map(r => csvLine([
        r.id,
        r.urls,
        r.image_url,
        r.is_gif,
        r.title,
        r.meme_type,
        r.kym_slug,
        r.mbti_types,
        r.keywords,
        r.tags
      ])).join("\n");

    log("DEBUG", `Uploading updated CSV (${updatedCsv.length} bytes)`);
    await updateGitHubFile(env, "memes.csv", updatedCsv, log);
    log("DEBUG", "Uploaded successfully");

    log("INFO", `Edited ${editedCount} rows`);
    return editedCount;
  } catch (err) {
    log("ERROR", "enrichItems failed", err);
    throw err;
  }
}

// Step 3: Update views (full pass)
async function updateViewCounts(env, log) {
  try {
    log("DEBUG", "Fetching memes.csv...");
    let csvText = await fetchGitHubFile(env, "memes.csv", log);
    let rows = parseCSV(csvText);
    log("DEBUG", `Parsed ${rows.length} rows`);

    rows.forEach(r => {
      r.id = String(r.id || "").trim().replace(/^["']|["']$/g, "");
    });

    log("INFO", `Processing ALL ${rows.length} memes...`);

    const REQUEST_DELAY_MS = 250;
    let blockedCount = 0;
    let updatedCount = 0;
    const results = [];

    log("DEBUG", "Fetching meme-views.csv...");
    let existingViewCsv = await fetchGitHubFile(env, "meme-views.csv", log);
    const existingViews = new Map();
    if (existingViewCsv) {
      const viewRows = parseCSV(existingViewCsv);
      viewRows.forEach(r => {
        if (r.id) existingViews.set(r.id, parseInt(r.views) || 0);
      });
      log("DEBUG", `Loaded ${existingViews.size} existing views`);
    }

    for (const row of rows) {
      const id = row.id;
      if (!id) continue;

      const { views, blocked } = await fetchViewsForMeme(id);

      if (blocked) {
        blockedCount++;
        const fallback = parseInt(row.views || "0", 10) || 0;
        results.push({ id, views: fallback });
        log("DEBUG", `Blocked on ${id}, fallback: ${fallback}`);
        if (blockedCount >= 8) {
          log("WARN", `Block limit (${blockedCount}) reached`);
          break;
        }
        await sleep(1500);
      } else {
        results.push({ id, views });
        const prev = existingViews.get(id) || 0;
        if (views !== prev) {
          updatedCount++;
          log("DEBUG", `Changed ${id}: ${prev} → ${views}`);
        }
      }

      await sleep(REQUEST_DELAY_MS);
    }

    if (results.length === 0) {
      log("INFO", "No memes processed");
      return updatedCount;
    }

    const dailyCsv = "ID,URLS,VIEWS\n" + results.map(r =>
      csvLine([r.id, `https://imgflip.com/i/${r.id}`, r.views])
    ).join("\n");

    const current = await fetchGitHubFile(env, "meme-views.csv", log);
    if (dailyCsv.trim() === current.trim()) {
      log("INFO", "No view changes — skipping upload");
    } else {
      await updateGitHubFile(env, "meme-views.csv", dailyCsv, log);
    }

    log("INFO", `Updated ${updatedCount} rows (out of ${results.length})`);
    return updatedCount;
  } catch (err) {
    log("ERROR", "updateViewCounts failed", err);
    throw err;
  }
}

// ======================
// Shared helpers
// ======================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function csvEscape(value) {
  let s = String(value ?? "").trim();

  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    const inner = s.slice(1, -1);
    if (!inner.includes('"') || inner.includes('""')) {
      s = inner.trim();
    }
  }

  s = s.replace(/""/g, '"');

  if (/[,\n\r"]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }

  return s;
}

function csvLine(fields) {
  return fields.map(csvEscape).join(",");
}

function parseCSV(text) {
  if (typeof text !== 'string') return [];

  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 1) return [];

  const headers = parseLine(lines[0]).map(h => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseLine(line);
    const row = {};
    headers.forEach((h, idx) => row[h] = (cols[idx] || "").trim());
    rows.push(row);
  }

  return rows;
}

function parseLine(line, delimiter = ",") {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current);
  return result.map(x => x.trim().replace(/^["']|["']$/g, ""));
}

// -----------------------
// Scrape + Tag Processing
// -----------------------

async function scrapePage(url) {
  if (!url) return { title: "", imageUrl: "", tags: "", memeType: "", kymSlug: "" };

  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return { title: "", imageUrl: "", tags: "", memeType: "", kymSlug: "" };

    const html = await res.text();

    const title = html.match(/<title>(.*?)<\/title>/i)?.[1]?.replace(" - Imgflip", "").trim() ?? "";

    const imageUrl = html.match(/property="og:image" content="([^"]+)"/i)?.[1] ?? "";

    const tagMatches = [...html.matchAll(/href=['"]\/(tag|meme)\/([^'"]+)['"]/g)];

    let memeType = "";
    const tagList = [];

    tagMatches.forEach(m => {
      const type = m[1];
      const name = m[2]
        .trim()
        .replace(/[+-]/g, " ")
        .replace(/\s+/g, " ");

      if (type === "meme") {
        memeType = name;
      } else {
        tagList.push(name);
      }
    });

    if (!tagList.includes("memes") && !memeType.toLowerCase().includes("meme")) {
      tagList.unshift("memes");
    }

    const tags = tagList.join(", ");

    const kymSlug = html.match(/knowyourmeme\.com\/memes\/([^"\/]+)/i)?.[1] ?? "";

    return { title, imageUrl, tags, memeType, kymSlug };
  } catch (err) {
    console.error(`scrapePage failed for ${url}:`, err.message);
    return { title: "", imageUrl: "", tags: "", memeType: "", kymSlug: "" };
  }
}

function processTags(tags, memeType) {
  const mbti = tags.filter(t => MBTI_SET.has(t.toUpperCase()));
  memeType = memeType || "";
  const keywords = tags.filter(t => {
    if (MBTI_SET.has(t.toUpperCase())) return false;
    if (t === memeType) return false;
    return true;
  }).map(k => k.replace(/[+-]/g, " ").replace(/\s+/g, " "));

  // Ensure memeType is included in keywords
  if (memeType && !keywords.includes(memeType)) keywords.unshift(memeType);

  return { mbti, memeType, keywords };
}

// -----------------------
// View Count Helpers
// -----------------------

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
    let candidate = getDeep(next, ["props", "pageProps", "image", "views"]);
    if (candidate === null) candidate = getDeep(next, ["props", "pageProps", "data", "image", "views"]);
    if (candidate === null) candidate = getDeep(next, ["props", "pageProps", "image", "view_count"]);
    if (candidate === null) candidate = getDeep(next, ["props", "pageProps", "data", "image", "view_count"]);

    const v = toInt(candidate);
    if (Number.isFinite(v)) return { views: v, blocked: false };
  }

  const m1 = html.match(/"views"\s*:\s*(\d{1,12})/);
  if (m1) return { views: Number(m1[1]), blocked: false };

  const m2 = html.match(/([\d,]{1,15})\s+views/i);
  if (m2 && m2[1]) {
    const cleanViews = m2[1].replace(/,/g, "");
    return { views: Number(cleanViews), blocked: false };
  }

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
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA["'][^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { headers: IMGFLIP_HEADERS });
    if (!res.ok) return "";
    return await res.text();
  } catch { return ""; }
}

function toInt(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return parseInt(value, 10);
  return 0;
}

// -----------------------
// GitHub Helpers
// -----------------------

async function fetchGitHubFile(env, filename, log) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;

  if (!owner || !repo || !token) {
    log("WARN", `GitHub credentials missing for ${filename}`);
    return "";
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filename}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "Cloudflare-Worker",
          Accept: "application/vnd.github.v3.raw"
        }
      }
    );

    if (!res.ok) {
      if (res.status === 404) return "";
      throw new Error(`GitHub fetch failed: ${res.status}`);
    }

    return await res.text();
  } catch (err) {
    log("ERROR", `Failed to fetch ${filename}`, { message: err.message });
    return "";
  }
}

async function updateGitHubFile(env, filename, content, log) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;

  if (!owner || !repo || !token) {
    log("WARN", `GitHub credentials missing for ${filename}`);
    return;
  }

  try {
    const getRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filename}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "Cloudflare-Worker",
          Accept: "application/vnd.github+json"
        }
      }
    );

    let sha = null;
    if (getRes.ok) {
      const fileData = await getRes.json();
      sha = fileData.sha;
    }

    const putRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filename}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "Cloudflare-Worker",
          Accept: "application/vnd.github+json"
        },
        body: JSON.stringify({
          message: `Update ${filename} via Worker`,
          content: utf8ToBase64(content),
          sha
        })
      }
    );

    if (!putRes.ok) {
      const error = await putRes.json();
      log("ERROR", `GitHub upload failed for ${filename}`, { status: putRes.status, error });
      return;
    }

    log("INFO", `Synced ${filename} to GitHub`);
  } catch (err) {
    log("ERROR", `Failed to update ${filename}`, { message: err.message });
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
