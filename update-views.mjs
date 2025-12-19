// update-views.mjs
import fs from "node:fs/promises";

const MEMES_FILE = "memes.csv";
const DAILY_FILE = "meme_daily_updates.csv";

// Be gentle. 316 pages with 350ms delay is ~2-4 minutes depending on network.
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 350);

const IMGFLIP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function main() {
  const memesText = await fs.readFile(MEMES_FILE, "utf8");
  const memesRows = parseCsv(memesText, ","); // expects headers
  if (!memesRows.length) throw new Error("memes.csv parsed 0 rows");

  // Existing daily (tsv) is optional
  let existingDaily = [];
  try {
    const dailyText = await fs.readFile(DAILY_FILE, "utf8");
    existingDaily = parseTsv(dailyText);
  } catch {
    existingDaily = [];
  }

  const existingMap = new Map();
  for (const r of existingDaily) {
    const id = String(r.id || "").trim();
    if (!id) continue;
    const v = Number(String(r.views ?? "").trim());
    existingMap.set(id, Number.isFinite(v) ? v : 0);
  }

  // Build ordered list from memes.csv (top to bottom)
  // Your header is "urls" (per console), but tolerate "url" too.
  const ordered = memesRows
    .map(r => {
      const id = String(r.id || "").trim();
      if (!id) return null;
      const urls = String(r.urls || r.url || "").trim() || `https://imgflip.com/i/${id}`;
      return { id, urls };
    })
    .filter(Boolean);

  console.log(`Will update views for ${ordered.length} items...`);

  let updatedCount = 0;
  for (let i = 0; i < ordered.length; i++) {
    const { id, urls } = ordered[i];

    // If you want to “force pull the first go”, do NOT skip zeros.
    // If you later want to reduce load, you can skip recently updated, etc.
    const html = await fetchText(urls);
    const views = extractViews(html);

    if (views !== null) {
      existingMap.set(id, views);
      updatedCount++;
      console.log(`[${i + 1}/${ordered.length}] ${id} -> ${views}`);
    } else {
      // Keep whatever we had
      const prev = existingMap.get(id) ?? 0;
      console.log(`[${i + 1}/${ordered.length}] ${id} -> (no parse; keep ${prev})`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  // Write TSV (no quotes, stable + simple)
  const outLines = ["id\turls\tviews"];
  for (const { id, urls } of ordered) {
    const v = existingMap.get(id) ?? 0;
    outLines.push(`${id}\t${urls}\t${Number.isFinite(v) ? v : 0}`);
  }
  outLines.push("");

  await fs.writeFile(DAILY_FILE, outLines.join("\n"), "utf8");
  console.log(`Wrote ${DAILY_FILE}. Updated parsed views for ${updatedCount}/${ordered.length}.`);
}

// --- scraping helpers ---

async function fetchText(url) {
  const res = await fetch(url, { headers: IMGFLIP_HEADERS });
  if (!res.ok) return "";

  const text = await res.text();
  const head = text.slice(0, 4000).toLowerCase();
  if (head.includes("captcha") || head.includes("unusual traffic")) {
    console.warn("Captcha / unusual traffic detected; returning empty for", url);
    return "";
  }
  return text;
}

function extractViews(html) {
  if (!html) return null;

  // Example line on page: "603 views • 1 upvote • Made by ..."
  const m = html.match(/(\d[\d,]*)\s+views\b/i);
  if (!m) return null;

  const n = Number(String(m[1]).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// --- parsers ---

function parseTsv(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const headers = lines[0].split("\t").map((h, idx) => {
    let hh = String(h ?? "");
    if (idx === 0) hh = hh.replace(/^\uFEFF/, "");
    return hh.trim().toLowerCase();
  });

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    if (!cols.length) continue;
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = cols[j] ?? "";
    out.push(row);
  }
  return out;
}

// Quote-aware CSV (same logic style you already use in the browser)
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
    for (let j = 0; j < headers.length; j++) row[headers[j]] = cols[j] ?? "";
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

main().catch(err => {
  console.error(err);
  process.exit(1);
});
