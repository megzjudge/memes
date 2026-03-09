import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import fetch from "node:fetch"; // Add "node-fetch": "^3.3.2" to package.json if needed (for Node <18)

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

/**
 * Simple CSV parser that handles quotes.
 * Returns { headers: string[], rows: string[][] }
 * - Does not attempt to support multi-line quoted fields (not needed for your dataset)
 */
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

  // flush last
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
    warn(
      "CSV headers missing/mismatched; output will be rewritten with canonical headers."
    );
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
      // If file had headers, use them to map; otherwise assume canonical
      const obj = toRowObject(
        parsed.headers.length ? parsed.headers : headers,
        r
      );

      // Ensure all canonical headers exist
      const full = {};
      for (const h of headers) full[h] = obj[h] ?? "";
      return full;
    });

    return { headers, rows };
  } catch (e) {
    if (e && e.code === "ENOENT") return { headers: CSV_HEADERS, rows: [] };
    throw e;
  }
}

async function writeCsv(headers, rowObjects) {
  const lines = [];
  lines.push(csvLine(headers));
  for (const obj of rowObjects) {
    lines.push(csvLine(fromRowObject(headers, obj)));
  }
  lines.push(""); // trailing newline
  await fs.writeFile(CSV_PATH, lines.join("\n"), "utf8");
}

// New: sleep for delays
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// New: enrich a blank row with data from Imgflip page
async function enrichRow(row, id) {
  const url = `https://imgflip.com/i/${id}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html",
        Referer: "https://imgflip.com/"
      }
    });

    if (!res.ok) {
      warn(`Enrich failed for ${id}: HTTP ${res.status}`);
      return row; // keep default
    }

    const html = await res.text();
    const lower = html.toLowerCase();

    // Block check
    if (lower.includes("captcha") || lower.includes("just a moment") || lower.includes("cloudflare")) {
      warn(`Enrich blocked for ${id}`);
      return row;
    }

    // Title from <h1> or __NEXT_DATA__
    let title = id;
    const titleMatch = html.match(/<h1 class="base-title"[^>]*>([^<]+)<\/h1>/i); // more precise for Imgflip
    if (titleMatch) title = titleMatch[1].trim();
    else {
      const next = extractNextData(html);
      if (next) {
        title = getDeep(next, ["props", "pageProps", "image", "title"]) || id;
      }
    }
    row.TITLE = title;

    // IMAGE_URL and IS_GIF from og:image or main img src
    let imageUrl = `https://i.imgflip.com/${id}.jpg`;
    let isGif = "FALSE";
    const ogMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
    if (ogMatch) {
      imageUrl = ogMatch[1].trim();
      isGif = imageUrl.toLowerCase().endsWith('.gif') ? "TRUE" : "FALSE";
    } else {
      const imgMatch = html.match(/<img class="base-img" src="([^"]+)"/i);
      if (imgMatch) {
        imageUrl = imgMatch[1].trim();
        isGif = imageUrl.toLowerCase().endsWith('.gif') ? "TRUE" : "FALSE";
      }
    }
    row.IMAGE_URL = imageUrl;
    row.IS_GIF = isGif;

    // Optional: MEME_TYPE (rough from caption or known patterns)
    const typeMatch = html.match(/This is a\s+([^<]+)\s+template/i); // example pattern
    if (typeMatch) row.MEME_TYPE = typeMatch[1].trim();

    log(`Enriched ${id}: TITLE="${title}" | IMAGE_URL="${imageUrl}" | IS_GIF=${isGif} | MEME_TYPE="${row.MEME_TYPE}"`);

    await sleep(1000); // Delay to avoid rate-limit

  } catch (err) {
    warn(`Enrich error for ${id}: ${err.message}`);
  }

  return row;
}

// Updated makeBlankRowForId — now async and enriches
async function makeBlankRowForId(id) {
  const row = {};
  for (const h of CSV_HEADERS) row[h] = "";
  row.ID = id;
  row.URLS = `https://imgflip.com/i/${id}`;
  row.IMAGE_URL = `https://i.imgflip.com/${id}.jpg`; // fallback
  row.IS_GIF = "FALSE";
  row.TITLE = id;
  row.MEME_TYPE = "";
  row.KYM_SLUG = "";
  row.MBTI_TYPES = ""; // manual
  row.KEYWORDS = ""; // manual
  row.TAGS = ""; // manual

  // Enrich
  await enrichRow(row, id);

  return row;
}

// ... rest of the code (parseCSV, readExistingCsv, etc.) remains the same ...

async function main() {
  const topIds = await getTopIdsFromDiscovery();
  log(`Discovery OK: ${topIds.join(", ")}`);

  const { headers, rows: existingRows } = await readExistingCsv();

  // First 14 IDs in CSV
  const existingTop = existingRows
    .slice(0, TOP_N)
    .map((r) => String(r.ID || "").trim())
    .filter(Boolean);

  // If CSV already has the same top 14 in the same order, do nothing.
  const identical =
    existingTop.length === TOP_N &&
    existingTop.every((id, i) => id === topIds[i]);

  if (identical) {
    log("Top 14 IDs already match discovery. No changes needed.");
    process.exit(0);
  }

  // Determine missing IDs that are in discovery topIds but not in existingTop
  const missing = topIds.filter((id) => !existingTop.includes(id));

  if (missing.length === 0) {
    // Order changed but same set; update order by moving rows accordingly
    log("Same IDs but order changed. Reordering top 14 to match discovery.");

    const byId = new Map(
      existingRows.map((r) => [String(r.ID || "").trim(), r])
    );

    const newTopRows = await Promise.all(topIds.map(async (id) => byId.get(id) || await makeBlankRowForId(id)));

    // Keep the rest of the CSV as-is, excluding any IDs we already placed in top 14 (to avoid duplicates)
    const placed = new Set(topIds);
    const remainder = existingRows.filter(
      (r) => !placed.has(String(r.ID || "").trim())
    );

    await writeCsv(headers, [...newTopRows, ...remainder]);
    log(`Updated memes.csv (reordered top ${TOP_N}).`);
    process.exit(0);
  }

  log(`Missing new IDs (to insert at top): ${missing.join(", ")}`);

  // Create enriched rows for new IDs
  const newRows = await Promise.all(missing.map(async (id) => await makeBlankRowForId(id)));

  // Keep the existing top 14 rows, but only the ones that are still in discovery topIds
  const keepFromExistingTop = existingRows
    .slice(0, TOP_N)
    .filter((r) => topIds.includes(String(r.ID || "").trim()));

  // Construct final top 14 in discovery order
  const byId = new Map();
  for (const r of newRows) byId.set(String(r.ID).trim(), r);
  for (const r of keepFromExistingTop) byId.set(String(r.ID).trim(), r);

  const finalTop14 = topIds.map(
    (id) => byId.get(id) || makeBlankRowForId(id) // fallback sync, but shouldn't hit
  );

  // Remainder: keep everything below the original top 14 as-is,
  // but remove any IDs that now appear in finalTop14 to avoid duplicates.
  const finalTopSet = new Set(finalTop14.map((r) => String(r.ID || "").trim()));
  const remainder = existingRows
    .slice(TOP_N)
    .filter((r) => !finalTopSet.has(String(r.ID || "").trim()));

  await writeCsv(headers, [...finalTop14, ...remainder]);
  log(
    `Updated memes.csv: inserted ${missing.length} new enriched row(s) at the top; preserved remaining rows.`
  );
}

main().catch((e) => {
  die(e?.stack || e?.message || String(e));
});
