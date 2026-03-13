import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import fetch from "node-fetch";  // Fetch used for web scraping

const TOP_N = 14; // still used as "desired top size", but not enforced

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

// Known GIF IDs (from your earlier confirmation)
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

function makeBlankRowForId(id) {
  const row = {};
  for (const h of CSV_HEADERS) row[h] = "";
  row.ID = id;
  row.URLS = `https://imgflip.com/i/${id}`;
  row.IMAGE_URL = `https://i.imgflip.com/${id}.${KNOWN_GIFS.has(id) ? "gif" : "jpg"}`;
  row.IS_GIF = KNOWN_GIFS.has(id) ? "TRUE" : "FALSE";
  row.TITLE = id; // fallback
  row.MEME_TYPE = "";
  row.KYM_SLUG = "";
  row.MBTI_TYPES = "";
  row.KEYWORDS = "";
  row.TAGS = "";
  return row;
}

// Scrape the meme page from Imgflip
async function getMemeIdsFromUserPage() {
  const userPageUrl = "https://imgflip.com/all/user-images/mbtininja?sort=latest";
  const res = await fetch(userPageUrl);
  const html = await res.text();

  // Scrape meme IDs from the page
  const idMatches = [...html.matchAll(/href="\/i\/([^"]+)"/g)];
  const ids = idMatches.map(match => match[1]);
  return ids;
}

async function main() {
  const topIds = await getMemeIdsFromUserPage();

  const { headers, rows: existingRows } = await readExistingCsv();

  const existingTop = existingRows
    .slice(0, TOP_N)
    .map((r) => String(r.ID || "").trim())
    .filter(Boolean);

  const identical =
    existingTop.length === topIds.length &&
    existingTop.every((id, i) => id === topIds[i]);

  if (identical) {
    log("Current top matches discovery. No changes needed.");
    process.exit(0);
  }

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
    process.exit(0);
  }

  log(`Found ${missing.length} missing IDs to insert at top: ${missing.join(", ")}`);

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
