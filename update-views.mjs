import fs from "node:fs/promises";

const MEMES_FILE = "memes.csv";
const OUT_FILE = "meme_daily_updates.csv";

const REQUEST_DELAY_MS = 250;
const MAX_ITEMS = 350;
const STOP_ON_BLOCKED = 8;

const IMGFLIP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://imgflip.com/"
};

async function main() {
  const memesText = await fs.readFile(MEMES_FILE, "utf8");
  const memesRows = parseCsv(memesText, ",");

  if (!memesRows.length) {
    throw new Error("No rows found in " + MEMES_FILE);
  }

  const memes = memesRows
    .map(r => {
      const id = pick(r, ["id", "ID", "meme_id", "image_id"]);
      const urls = pick(r, ["urls", "url", "URLS", "URL"]);
      if (!id) return null;
      return {
        id: String(id).trim(),
        urls: String(urls || ("https://imgflip.com/i/" + id)).trim()
      };
    })
    .filter(Boolean)
    .slice(0, MAX_ITEMS);

  let existingMap = new Map();
  try {
    const outText = await fs.readFile(OUT_FILE, "utf8");
    const outRows = parseCsv(outText, ",");
    for (const r of outRows) {
      const id = String(pick(r, ["id", "ID"]) || "").trim();
      if (!id) continue;
      const raw = pick(r, ["views", "VIEWS"]);
      const v = Number(String(raw || "").replace(/,/g, "").trim());
      existingMap.set(id, Number.isFinite(v) ? v : 0);
    }
  } catch {}

  console.log("Loaded " + memes.length + " meme IDs from " + MEMES_FILE);
  console.log("Loaded " + existingMap.size + " existing view values from " + OUT_FILE + " (if present)");

  let blockedCount = 0;
  let updated = 0;

  const results = [];

  for (let i = 0; i < memes.length; i++) {
    const id = memes[i].id;
    const urls = memes[i].urls;

    const out = await fetchViewsForMeme(id);
    const views = out.views;
    const blocked = out.blocked;

    if (blocked) {
      blockedCount++;
      const fallback = existingMap.has(id) ? existingMap.get(id) : 0;
      results.push({ id, urls, views: fallback });
      console.log("[" + (i + 1) + "/" + memes.length + "] " + id + " BLOCKED -> keep " + fallback);

      if (blockedCount >= STOP_ON_BLOCKED) {
        console.log("Stopping early: blocked " + blockedCount + " times.");
        break;
      }
    } else {
      const v = Number.isFinite(views) ? views : 0;
      results.push({ id, urls, views: v });
      if (v !== (existingMap.has(id) ? existingMap.get(id) : 0)) updated++;
      console.log("[" + (i + 1) + "/" + memes.length + "] " + id + " views=" + v);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  const lines = [];
  lines.push(["ID", "URLS", "VIEWS"].join(","));
  for (const r of results) {
    lines.push([csvEscape(r.id), csvEscape(r.urls), String(r.views)].join(","));
  }
  await fs.writeFile(OUT_FILE, lines.join("\n") + "\n", "utf8");

  console.log("Wrote " + results.length + " rows to " + OUT_FILE);
  console.log("Changed view counts for " + updated + " rows (vs previous file)");
  console.log("Blocked/captcha rows encountered: " + blockedCount);
}

async function fetchViewsForMeme(id) {
  const url = "https://imgflip.com/i/" + id;
  const html = await fetchText(url);

  if (!html) return { views: 0, blocked: true };

  const head = html.slice(0, 6000).toLowerCase();
  if (head.includes("captcha") || head.includes("unusual traffic")) {
    return { views: 0, blocked: true };
  }

  const next = extractNextData(html);
  if (next) {
    // Try several common shapes without optional chaining
    let candidate = null;

    candidate = getDeep(next, ["props", "pageProps", "image", "views"]);
    if (candidate === null) candidate = getDeep(next, ["props", "pageProps", "data", "image", "views"]);
    if (candidate === null) candidate = getDeep(next, ["props", "pageProps", "image", "view_count"]);
    if (candidate === null) candidate = getDeep(next, ["props", "pageProps", "data", "image", "view_count"]);

    const v = toInt(candidate);
    if (Number.isFinite(v)) return { views: v, blocked: false };
  }

  // Fallback 1
  {
    const m = html.match(/"views"\s*:\s*(\d{1,12})/);
    if (m) return { views: Number(m[1]), blocked: false };
  }

  // Fallback 2
  {
    const m = html.match(/([\d,]{1,15})\s+views/i);
    if (m) return { views: Number(m[1].replace(/,/g, "")), blocked: false };
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function toInt(x) {
  if (x === null || x === undefined) return NaN;
  const n = Number(String(x).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : NaN;
}

function csvEscape(s) {
  const v = String(s || "");
  if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

function pick(obj, keys) {
  if (!obj) return "";
  for (const k of keys) {
    const key = String(k).toLowerCase();
    if (obj[key] !== undefined) return obj[key];
    if (obj[k] !== undefined) return obj[k];
  }
  return "";
}

function parseCsv(text, delimiter) {
  const lines = String(text)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0], delimiter).map((h, idx) => {
    let hh = String(h || "");
    if (idx === 0) hh = hh.replace(/^\uFEFF/, "");
    return hh.trim().toLowerCase();
  });

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i], delimiter);
    if (!cols.length) continue;

    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cols[j] !== undefined ? cols[j] : "";
    }
    out.push(row);
  }
  return out;
}

function splitCsvLine(line, delimiter) {
  const s = String(line);
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (ch === '"') {
      const next = s[i + 1];
      if (inQuotes && next === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && ch === delimiter) {
      out.push(cur);
      cur = "";
      continue;
    }

    cur += ch;
  }

  out.push(cur);
  return out.map(x => x.trim());
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
