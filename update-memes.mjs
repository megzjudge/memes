import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const TOP_N = 14; // only used for logging / deciding how many to fetch, not for forcing top-N anymore

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

async function readExistingCsv() {
  try {
    const text = await fs.readFile(CSV_PATH, "utf8");
    const parsed = parseCSV(text);
    return {
      headers: parsed.headers.length ? parsed.headers : CSV_HEADERS,
      rows: parsed.rows.map(r => toRowObject(parsed.headers, r)),
      idSet: new Set(parsed.rows.map(r => String(r[0] ?? "").trim()).filter(Boolean)) // ID is first column
    };
  } catch (e) {
    if (e.code === "ENOENT") {
      return { headers: CSV_HEADERS, rows: [], idSet: new Set() };
    }
    throw e;
  }
}

async function appendNewRows(headers, newRowObjects) {
  const lines = [];

  // Read existing content exactly as-is (to preserve formatting/line endings)
  let existingContent = "";
  try {
    existingContent = await fs.readFile(CSV_PATH, "utf8");
  } catch {}

  if (existingContent.trim() === "") {
    // File was empty or new → write headers + new rows
    lines.push(csvLine(headers));
  } else {
    lines.push(existingContent.trimEnd()); // keep original, just ensure no double trailing newline
  }

  for (const obj of newRowObjects) {
    lines.push(csvLine(fromRowObject(headers, obj)));
  }

  const finalContent = lines.join("\n") + "\n"; // ensure single trailing newline
  await fs.writeFile(CSV_PATH, finalContent, "utf8");
}

function makeBlankRowForId(id) {
  const row = {};
  for (const h of CSV_HEADERS) row[h] = "";
  row.ID = id;
  row.URLS = `https://imgflip.com/i/${id}`;
  row.IMAGE_URL = `https://i.imgflip.com/${id}.${KNOWN_GIFS.has(id) ? "gif" : "jpg"}`;
  row.IS_GIF = KNOWN_GIFS.has(id) ? "TRUE" : "FALSE";
  row.TITLE = id; // fallback
  return row;
}

async function fetchLatestMemeIds() {
  const url = "https://imgflip.com/all/user-images/mbtininja?sort=latest";

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const html = await res.text();

    const matches = html.matchAll(/href\s*=\s*["']?\/i\/([a-z0-9]{6,8})["']?/gi);
    const ids = [...new Set(Array.from(matches, m => m[1]))];

    if (ids.length === 0) {
      warn("No meme IDs found in HTML.");
      process.exit(0);
    }

    log(
      `Fetched ${ids.length} unique latest IDs (showing first ${TOP_N}): ${ids.slice(0, TOP_N).join(", ")}`
    );
    log(
      "Note: Only safe/public memes are visible in anonymous fetches. NSFW-flagged content is hidden unless logged in with NSFW enabled."
    );

    return ids;
  } catch (err) {
    console.error("Failed to fetch/scrape Imgflip:", err.message || err);
    process.exit(1);
  }
}

async function main() {
  const latestIds = await fetchLatestMemeIds();

  const { headers, rows: existingRows, idSet } = await readExistingCsv();

  // Find IDs that are truly new (not anywhere in the CSV yet)
  const newIds = latestIds.filter(id => !idSet.has(id));

  if (newIds.length === 0) {
    log("No new memes found → no changes needed.");
    process.exit(0);
  }

  log(`Found ${newIds.length} new meme ID(s): ${newIds.join(", ")}`);

  const newRows = newIds.map(makeBlankRowForId);

  // Append them at the top by writing existing content + new rows
  await appendNewRows(headers, newRows);

  log(`Appended ${newIds.length} new row(s) to the top of memes.csv (manual edits preserved).`);
}

main().catch((e) => {
  die(e?.stack || e?.message || String(e));
});
