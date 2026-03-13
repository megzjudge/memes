import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import fetch from "node-fetch";

const TOP_N = 14; // Top number of memes to track

const CSV_PATH = path.resolve(process.cwd(), "memes.csv");

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

// Known GIF IDs (add more if you have specific meme formats)
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

// Parse CSV data to rows
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
  const data = rows.slice(1).filter((r) => r.some((x) => String(x ?? "").trim() !== ""));
  return { headers, rows: data };
}

// Convert rows into objects based on CSV headers
function toRowObject(headers, row) {
  const obj = {};
  for (let i = 0; i < headers.length; i++) obj[headers[i]] = row[i] ?? "";
  return obj;
}

// Make a blank row for a given meme ID
function makeBlankRowForId(id) {
  const row = {};
  for (const h of CSV_HEADERS) row[h] = "";
  row.ID = id;
  row.URLS = `https://imgflip.com/i/${id}`;
  row.IMAGE_URL = `https://i.imgflip.com/${id}.${KNOWN_GIFS.has(id) ? "gif" : "jpg"}`;
  row.IS_GIF = KNOWN_GIFS.has(id) ? "TRUE" : "FALSE";
  row.TITLE = id; // Fallback title
  row.MEME_TYPE = "";
  row.KYM_SLUG = "";
  row.MBTI_TYPES = "";
  row.KEYWORDS = "";
  row.TAGS = "";
  return row;
}

// Scrape meme IDs from Imgflip's user page
async function getMemeIdsFromUserPage() {
  const userPageUrl = "https://imgflip.com/all/user-images/mbtininja?sort=latest";
  const res = await fetch(userPageUrl);
  const html = await res.text();

  // Regex to find meme IDs on the page (this matches 'href="/i/ID"')
  const idMatches = [...html.matchAll(/href="\/i\/([^"]+)"/g)];
  const ids = idMatches.map(match => match[1]);
  return ids;
}

// Read existing memes.csv to check for existing meme IDs
async function readExistingCsv() {
  try {
    const text = await fs.readFile(CSV_PATH, "utf8");
    const parsed = parseCSV(text);
    const headers = parsed.headers;
    const rows = parsed.rows.map((r) => toRowObject(headers, r));
    return { headers, rows };
  } catch (e) {
    if (e.code === "ENOENT") return { headers: CSV_HEADERS, rows: [] };
    throw e;
  }
}

// Write updated data to memes.csv
async function writeCsv(headers, rowObjects) {
  const lines = [];
  lines.push(rowObjects.map(csvEscape).join(","));
  for (const obj of rowObjects) {
    lines.push(Object.values(obj).join(","));
  }
  await fs.writeFile(CSV_PATH, lines.join("\n"), "utf8");
}

// Escape CSV fields
function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  const topIds = await getMemeIdsFromUserPage();  // Get meme IDs from the page
  const { headers, rows: existingRows } = await readExistingCsv();  // Read existing CSV

  // Extract current top meme IDs from the existing CSV (up to TOP_N)
  const existingTop = existingRows
    .slice(0, TOP_N)
    .map((r) => String(r.ID || "").trim())
    .filter(Boolean);

  // Check if the top IDs are identical
  const identical =
    existingTop.length === topIds.length &&
    existingTop.every((id, i) => id === topIds[i]);

  if (identical) {
    log("Current top matches discovery. No changes needed.");
    return;
  }

  // Find which memes are missing from the CSV
  const missing = topIds.filter((id) => !existingTop.includes(id));

  if (missing.length === 0) {
    log("Same IDs but different order. Reordering top to match discovery.");
    const byId = new Map(existingRows.map((r) => [String(r.ID || "").trim(), r]));

    const newTopRows = topIds.map((id) => byId.get(id) || makeBlankRowForId(id));

    const placed = new Set(topIds);
    const remainder = existingRows.filter(
      (r) => !placed.has(String(r.ID || "").trim())
    );

    await writeCsv(headers, [...newTopRows, ...remainder]);
    log(`Reordered top ${topIds.length} rows in memes.csv.`);
    return;
  }

  log(`Found ${missing.length} missing IDs to insert at top: ${missing.join(", ")}`);

  // Create new rows for missing meme IDs
  const newRows = missing.map((id) => makeBlankRowForId(id));

  const keepFromExistingTop = existingRows
    .slice(0, TOP_N)
    .filter((r) => topIds.includes(String(r.ID || "").trim()));

  const byId = new Map();
  for (const r of newRows) byId.set(String(r.ID).trim(), r);
  for (const r of keepFromExistingTop) byId.set(String(r.ID).trim(), r);

  const finalTop = topIds.map(
    (id) => byId.get(id) || makeBlankRowForId(id)
  );

  const finalTopSet = new Set(finalTop.map((r) => String(r.ID || "").trim()));
  const remainder = existingRows
    .slice(TOP_N)
    .filter((r) => !finalTopSet.has(String(r.ID || "").trim()));

  await writeCsv(headers, [...finalTop, ...remainder]);
  log(
    `Updated memes.csv: inserted ${missing.length} new row(s) at the top; preserved remaining rows.`
  );
}

main().catch((e) => {
  die(e?.stack || e?.message || String(e));
});
