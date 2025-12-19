import fs from "node:fs/promises";

const IN_FILE = "memes.csv";                 // JSONL, produced by update-memes.mjs
const OUT_FILE = "meme_daily_updates.csv";   // CSV: id,page_url,views

const REQUEST_DELAY_MS = 175; // gentle pacing; adjust if needed
const MAX_IDS = 5000;         // safety cap, should match your static cap

const IMGFLIP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://imgflip.com/"
};

async function main() {
  const staticItems = await readJsonLines(IN_FILE);
  const items = staticItems.slice(0, MAX_IDS);

  if (!items.length) {
    await fs.writeFile(OUT_FILE, "id,page_url,views\n", "utf8");
    console.log(`No items in ${IN_FILE}. Wrote empty ${OUT_FILE}.`);
    return;
  }

  const rows = [];
  rows.push(["id", "page_url", "views"]);

  for (const it of items) {
    const id = String(it?.id || "").trim();
    if (!id) continue;

    const pageUrl = it?.page_url ? String(it.page_url).trim() : `https://imgflip.com/i/${id}`;

    const views = await fetchViewsOnly(id);
    rows.push([id, pageUrl, String(views)]);

    await sleep(REQUEST_DELAY_MS);
  }

  const csv = rows.map(r => r.map(csvEscape).join(",")).join("\n") + "\n";
  await fs.writeFile(OUT_FILE, csv, "utf8");
  console.log(`Wrote ${rows.length - 1} rows to ${OUT_FILE}`);
}

async function readJsonLines(path) {
  let raw = "";
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return [];
  }

  return raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

async function fetchViewsOnly(id) {
  const url = `https://imgflip.com/i/${id}`;
  const html = await fetchHtml(url);
  if (!html) return 0;

  // Prefer __NEXT_DATA__ extraction
  const next = extractNextData(html);
  const image = extractImageFromNext(next);
  if (image) {
    const v = coerceViews(image);
    if (Number.isFinite(v)) return v;
  }

  // Fallback: regex like "12,345 views"
  const m = html.match(/([0-9][0-9,]*)\s+views/i);
  if (m && m[1]) {
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }

  return 0;
}

async function fetchHtml(url) {
  try {
    const res = await fetch(url, { headers: IMGFLIP_HEADERS });
    if (!res.ok) return "";
    const text = await res.text();

    const head = text.slice(0, 4000).toLowerCase();
    if (head.includes("captcha") || head.includes("unusual traffic")) return "";

    return text;
  } catch {
    return "";
  }
}

function extractNextData(html) {
  const match = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/
  );
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function extractImageFromNext(next) {
  const img =
    next?.props?.pageProps?.image ||
    next?.props?.pageProps?.data?.image ||
    next?.props?.pageProps?.props?.image ||
    null;

  return img && typeof img === "object" ? img : null;
}

function coerceViews(imageObj) {
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

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
