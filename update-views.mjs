import fs from "node:fs/promises";

const STATIC_FILE = "memes.csv";
const OUT_FILE = "meme_daily_updates.csv";

// tune these
const CONCURRENCY = 3;         // keep low to avoid bot detection
const REQUEST_DELAY_MS = 175;  // gentle pacing per worker
const RETRIES = 3;
const RETRY_DELAY_MS = 900;

const IMGFLIP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://imgflip.com/"
};

async function main() {
  const staticCsv = await fs.readFile(STATIC_FILE, "utf8");
  const staticRows = parseCsv(staticCsv, ",");

  // Expect headers like ID, URL, etc (your parser lowercases them)
  // We try common header names.
  const ids = staticRows
    .map(r => ({
      id: String(r.id || r.meme_id || r.image_id || r["column 1"] || "").trim(),
      url: String(r.url || r.urls || r.page_url || r.link || "").trim()
    }))
    .filter(x => x.id);

  if (!ids.length) {
    throw new Error(`No IDs found in ${STATIC_FILE}. Check header names and delimiter.`);
  }

  console.log(`Loaded ${ids.length} ids from ${STATIC_FILE}`);

  const results = await mapWithConcurrency(ids, CONCURRENCY, async (row, idx) => {
    const id = row.id;
    const url = row.url || `https://imgflip.com/i/${id}`;

    const views = await fetchViewsOnly(id);
    await sleep(REQUEST_DELAY_MS);

    if (views === null) {
      console.log(`[${idx + 1}/${ids.length}] ${id} -> (no parse) keeping 0`);
      return { id, url, views: 0 };
    }

    console.log(`[${idx + 1}/${ids.length}] ${id} -> ${views}`);
    return { id, url, views };
  });

  // Write daily CSV with headers expected by your frontend parser
  const lines = [];
  lines.push(["id", "url", "views"].join(","));

  for (const r of results) {
    // Ensure commas and quotes are safe
    const id = csvCell(r.id);
    const url = csvCell(r.url);
    const views = Number.isFinite(Number(r.views)) ? String(Number(r.views)) : "0";
    lines.push([id, url, views].join(","));
  }

  await fs.writeFile(OUT_FILE, lines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${results.length} rows to ${OUT_FILE}`);
}

// -------------------- views scraping --------------------

async function fetchViewsOnly(id) {
  const url = `https://imgflip.com/i/${id}`;

  const html = await fetchHtml(url);
  if (!html) return null;

  const next = extractNextData(html);
  const image = extractImageFromNext(next);

  // Preferred: NextJS data object
  if (image) {
    const views = coerceViews(image);
    if (Number.isFinite(views)) return views;
  }

  // Fallback: loose text pattern like "12,345 views"
  const m = html.match(/([0-9][0-9,]*)\s+views/i);
  if (m && m[1]) {
    const v = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(v)) return v;
  }

  return null;
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
  return (
    next?.props?.pageProps?.image ||
    next?.props?.pageProps?.data?.image ||
    next?.props?.pageProps?.props?.image ||
    null
  );
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

async function fetchHtml(url) {
  const res = await fetchWithRetry(url, {}, RETRIES, RETRY_DELAY_MS);
  if (!res.ok) return "";

  const text = await res.text();
  const head = text.slice(0, 4000).toLowerCase();
  if (head.includes("captcha") || head.includes("unusual traffic")) return "";
  return text;
}

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

      if (attempt === retries) return res;
      await sleep(delay * attempt);
    } catch {
      if (attempt === retries) throw new Error(`fetch failed: ${url}`);
      await sleep(delay * attempt);
    }
  }

  throw new Error("Max retries exceeded");
}

// -------------------- CSV parsing --------------------
// NOTE: this is intentionally the same style as your frontend: header-based + quote-aware.

function parseCsv(text, delimiter = ",") {
  const lines = String(text)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0], delimiter).map((h, idx) => {
    let hh = String(h ?? "");
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

function splitCsvLine(line, delimiter = ",") {
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

function csvCell(v) {
  const s = String(v ?? "");
  // Quote if needed
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// -------------------- concurrency helpers --------------------

async function mapWithConcurrency(items, concurrency, fn) {
  const out = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
