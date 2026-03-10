import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const TOP_N = 14;

const CSV_PATH = path.resolve(process.cwd(), "memes.csv");
const DISCOVERY_PATH = path.resolve(
  process.cwd(),
  process.env.DISCOVERY_PATH || "latest_ids.json"
);

const CSV_HEADERS = [
  "ID",
  "URLS",
  "IMAGE_URL",
  "IS_GIF",
  "TITLE",
  "MEME_TYPE",
  "KYM_SLUG",
  "MBTI_TYPES",
  "KEYWORDS",
  "TAGS",
];

// Known GIF IDs from your confirmation
const KNOWN_GIFS = new Set(["ajpoyw", "ah7dcs"]);

function log(...args) {
  console.log(...args);
}

function warn(...args) {
  console.warn(...args);
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function unique(arr) {
  return [...new Set(arr)];
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
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      continue;
    }

    if (c === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      continue;
    }

    if (c === "\r") continue;

    field += c;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return { headers: [], rows: [] };

  const headers = rows[0].map((h) => String(h ?? "").trim());
  const data = rows
    .slice(1)
    .filter((r) => r.some((x) => String(x ?? "").trim() !== ""));

  return { headers, rows: data };
}

function toRowObject(headers, row) {
  const obj = {};
  for (let i = 0; i < headers.length; i++) obj[headers[i]] = row[i] ?? "";
  return obj;
}

function fromRowObject(headers, obj) {
  return headers.map((h) => obj[h] ?? "");
}

function ensureHeaders(parsedHeaders) {
  const normalized = (parsedHeaders || []).map((h) => String(h ?? "").trim());
  const ok =
    normalized.length === CSV_HEADERS.length &&
    normalized.every((h, i) => h === CSV_HEADERS[i]);

  if (!ok) {
    warn("CSV headers missing/mismatched; rewriting with canonical headers.");
    return CSV_HEADERS;
  }
  return normalized;
}

async function readExistingCsv() {
  try {
    const text = await fs.readFile(CSV_PATH, "utf8");
    const parsed = parseCSV(text);
    const headers = ensureHeaders(parsed.headers);

    const rows = parsed.rows.map((r) => {
      const obj = toRowObject(parsed.headers.length ? parsed.headers : headers, r);
      const full = {};
      for (const h of headers) full[h] = obj[h] ?? "";
      return full;
    });

    return { headers, rows };
  } catch (e) {
    if (e.code === "ENOENT") return { headers: CSV_HEADERS, rows: [] };
    throw e;
  }
}

async function writeCsv(headers, rowObjects) {
  const lines = [];
  lines.push(csvLine(headers));
  for (const obj of rowObjects) {
    lines.push(csvLine(fromRowObject(headers, obj)));
  }
  lines.push("");
  await fs.writeFile(CSV_PATH, lines.join("\n"), "utf8");
}

// Sleep helper
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Enrich row with title, image_url, is_gif, meme_type from page
async function enrichRow(row, id) {
  const url = `https://imgflip.com/i/${id}`;
  try {
    log(`Enriching ${id}...`);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: "https://imgflip.com/"
      }
    });

    if (!res.ok) {
      warn(`Enrich failed for ${id}: HTTP ${res.status}`);
      return row;
    }

    const html = await res.text();
    const lower = html.toLowerCase();

    if (lower.includes("captcha") || lower.includes("just a moment") || lower.includes("cloudflare")) {
      warn(`Enrich blocked for ${id} (captcha/cloudflare detected)`);
      return row;
    }

    // TITLE from <h1 class="base-title"> (most reliable on Imgflip)
    const titleMatch = html.match(/<h1 class="base-title"[^>]*>([^<]+)<\/h1>/i);
    if (titleMatch && titleMatch[1].trim()) {
      row.TITLE = titleMatch[1].trim();
    } else {
      // Fallback: any <h1>
      const genericTitleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      if (genericTitleMatch) row.TITLE = genericTitleMatch[1].trim();
    }

    // IMAGE_URL from og:image (best) or main image
    const ogMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
    if (ogMatch && ogMatch[1].trim()) {
      row.IMAGE_URL = ogMatch[1].trim();
      row.IS_GIF = row.IMAGE_URL.toLowerCase().endsWith('.gif') ? "TRUE" : "FALSE";
    } else {
      const imgMatch = html.match(/<img[^>]+src=["']([^"']+\.(jpg|jpeg|gif|png))["']/i);
      if (imgMatch) {
        row.IMAGE_URL = imgMatch[1].trim();
        row.IS_GIF = row.IMAGE_URL.toLowerCase().endsWith('.gif') ? "TRUE" : "FALSE";
      }
    }

    // MEME_TYPE from common caption pattern
    const typeMatch = html.match(/This is a\s+([^<]+?)\s+(meme|template)/i);
    if (typeMatch && typeMatch[1].trim()) {
      row.MEME_TYPE = typeMatch[1].trim();
    }

    log(`Success for ${id}: TITLE="${row.TITLE}", IMAGE_URL="${row.IMAGE_URL}", IS_GIF=${row.IS_GIF}, MEME_TYPE="${row.MEME_TYPE}"`);

    await sleep(2000); // 2s delay to avoid rate-limit/captcha

  } catch (err) {
    warn(`Enrich error for ${id}: ${err.message}`);
  }

  return row;
}

async function makeBlankRowForId(id) {
  const row = {};
  for (const h of CSV_HEADERS) row[h] = "";
  row.ID = id;
  row.URLS = `https://imgflip.com/i/${id}`;
  row.IMAGE_URL = `https://i.imgflip.com/${id}.jpg`; // fallback so images always load
  row.IS_GIF = KNOWN_GIFS.has(id) ? "TRUE" : "FALSE";
  row.TITLE = id; // fallback
  row.MEME_TYPE = "";
  row.KYM_SLUG = "";
  row.MBTI_TYPES = "";
  row.KEYWORDS = "";
  row.TAGS = "";

  // Enrich
  await enrichRow(row, id);

  return row;
}

async function getTopIdsFromDiscovery() {
  const raw = await fs.readFile(DISCOVERY_PATH, "utf8");
  const j = JSON.parse(raw);

  const idsRaw =
    Array.isArray(j?.ids) ? j.ids :
    Array.isArray(j?.latest_ids) ? j.latest_ids :
    Array.isArray(j) ? j : [];

  const ids = unique(idsRaw.map((x) => String(x).trim()).filter(Boolean));

  if (ids.length < TOP_N) {
    die(`Discovery required: ${path.basename(DISCOVERY_PATH)} has ${ids.length} IDs (need ${TOP_N}).`);
  }

  return ids.slice(0, TOP_N);
}

async function main() {
  const topIds = await getTopIdsFromDiscovery();
  log(`Discovery OK: ${topIds.join(", ")}`);

  const { headers, rows: existingRows } = await readExistingCsv();

  const existingTop = existingRows
    .slice(0, TOP_N)
    .map((r) => String(r.ID || "").trim())
    .filter(Boolean);

  const identical =
    existingTop.length === TOP_N &&
    existingTop.every((id, i) => id === topIds[i]);

  if (identical) {
    log("Top 14 IDs already match discovery. No changes needed.");
    process.exit(0);
  }

  const missing = topIds.filter((id) => !existingTop.includes(id));

  if (missing.length === 0) {
    log("Same IDs but order changed. Reordering top 14 to match discovery.");

    const byId = new Map(existingRows.map((r) => [String(r.ID || "").trim(), r]));

    const newTopRows = await Promise.all(
      topIds.map(async (id) => byId.get(id) || await makeBlankRowForId(id))
    );

    const placed = new Set(topIds);
    const remainder = existingRows.filter(
      (r) => !placed.has(String(r.ID || "").trim())
    );

    await writeCsv(headers, [...newTopRows, ...remainder]);
    log(`Updated memes.csv (reordered top ${TOP_N}).`);
    process.exit(0);
  }

  log(`Missing new IDs (to insert at top): ${missing.join(", ")}`);

  const newRows = await Promise.all(
    missing.map(async (id) => await makeBlankRowForId(id))
  );

  const keepFromExistingTop = existingRows
    .slice(0, TOP_N)
    .filter((r) => topIds.includes(String(r.ID || "").trim()));

  const byId = new Map();
  for (const r of newRows) byId.set(String(r.ID).trim(), r);
  for (const r of keepFromExistingTop) byId.set(String(r.ID).trim(), r);

  const finalTop14 = topIds.map(
    (id) => byId.get(id) || makeBlankRowForId(id)
  );

  const finalTopSet = new Set(finalTop14.map((r) => String(r.ID || "").trim()));
  const remainder = existingRows
    .slice(TOP_N)
    .filter((r) => !finalTopSet.has(String(r.ID || "").trim()));

  await writeCsv(headers, [...finalTop14, ...remainder]);
  log(
    `Updated memes.csv: inserted/enriched ${missing.length} new row(s) at the top; preserved remaining rows.`
  );
}

main().catch((e) => {
  die(e?.stack || e?.message || String(e));
});
