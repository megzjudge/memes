#!/usr/bin/env node
/**
 * update-memes.mjs
 *
 * Behavior:
 * - Reads memes.csv (if present)
 * - Scrapes the Imgflip page for the current top 14 meme IDs
 * - Compares those 14 IDs to the first 14 rows in memes.csv
 * - If identical -> no change
 * - If new IDs are present -> inserts only the missing ones at the top, keeping the other existing rows as-is
 * - For newly inserted rows, fetches per-meme page data and fills IMAGE_URL / IS_GIF / TITLE (best-effort)
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const CSV_PATH = path.resolve(process.cwd(), "memes.csv");

// Adjust if your “imgflip page” is something else (profile, tag page, etc).
// This should be the page that shows the newest items you want to track.
// Example: your user page, a tag page, a gallery page, etc.
const IMGFLIP_LIST_PAGE = process.env.IMGFLIP_LIST_PAGE || "https://imgflip.com/";

const TOP_N = 14;

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

function normalizeBool(v) {
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return "TRUE";
  return "FALSE";
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvLine(fields) {
  return fields.map(csvEscape).join(",");
}

function parseCSV(text) {
  // Simple CSV parser that handles quotes.
  // Returns { headers: string[], rows: string[][] }
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
  const data = rows.slice(1).filter((r) => r.some((x) => String(x ?? "").trim() !== ""));
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

function unique(arr) {
  return [...new Set(arr)];
}

function isBotBlockHtml(html) {
  const h = html.toLowerCase();
  return (
    h.includes("checking your browser") ||
    h.includes("just a moment") ||
    h.includes("cloudflare") ||
    h.includes("cf-challenge") ||
    h.includes("attention required") ||
    h.includes("please enable cookies")
  );
}

async function fetchText(url) {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      // These headers materially improve Imgflip/CF behavior in CI
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-AU,en;q=0.9,en-US;q=0.8",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });

  const text = await res.text();
  return { status: res.status, text, finalUrl: res.url };
}

async function headOk(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        Accept: "*/*",
        "Accept-Language": "en-AU,en;q=0.9,en-US;q=0.8",
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    return { url: res.url, contentType: ct };
  } catch {
    return null;
  }
}

function extractMetaContent(html, key) {
  // key can be property="og:image" or name="twitter:title" etc.
  // We’ll match both property= and name= variants.
  const re1 = new RegExp(
    `<meta\\s+[^>]*(?:property|name)="${key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}"[^>]*content="([^"]+)"[^>]*>`,
    "i"
  );
  const m1 = html.match(re1);
  if (m1?.[1]) return m1[1].trim();

  const re2 = new RegExp(
    `<meta\\s+[^>]*content="([^"]+)"[^>]*(?:property|name)="${key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}"[^>]*>`,
    "i"
  );
  const m2 = html.match(re2);
  if (m2?.[1]) return m2[1].trim();

  return "";
}

function extractTagsFromImgflipHtml(html) {
  // Best-effort: find /tags/<slug> links.
  const tags = [];
  const re = /href="\/tags\/([^"\/?#]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = decodeURIComponent(m[1]).trim();
    if (slug) tags.push(slug.replace(/-/g, " "));
  }
  return unique(tags);
}

async function getMemeDetails(id) {
  const pageUrl = `https://imgflip.com/i/${id}`;

  // 1) Try scraping the meme page
  try {
    const { status, text } = await fetchText(pageUrl);

    if (status >= 200 && status < 400 && text && !isBotBlockHtml(text)) {
      const ogImage = extractMetaContent(text, "og:image");
      const ogTitle = extractMetaContent(text, "og:title");
      const title =
        (ogTitle || "").replace(/\s*-\s*Imgflip\s*$/i, "").trim() || id;

      const imageUrl = ogImage || "";
      const isGif = imageUrl.toLowerCase().includes(".gif") ? "TRUE" : "FALSE";

      const tags = extractTagsFromImgflipHtml(text);

      return {
        id,
        pageUrl,
        imageUrl,
        isGif,
        title,
        tags,
        source: "page",
      };
    } else {
      warn(`Imgflip page fetch looked blocked or empty for ${id} (status=${status}). Falling back.`);
    }
  } catch (e) {
    warn(`Imgflip page fetch failed for ${id}. Falling back.`, e?.message || e);
  }

  // 2) Fallback: probe i.imgflip.com for a working asset
  // Try jpg -> png -> gif.
  const exts = ["jpg", "png", "gif"];
  for (const ext of exts) {
    const assetUrl = `https://i.imgflip.com/${id}.${ext}`;
    const ok = await headOk(assetUrl);
    if (ok) {
      const isGif = ext === "gif" || ok.contentType.toLowerCase().includes("gif") ? "TRUE" : "FALSE";
      return {
        id,
        pageUrl,
        imageUrl: ok.url || assetUrl,
        isGif,
        title: id,
        tags: [],
        source: "asset",
      };
    }
  }

  // 3) Worst-case: return minimal
  return {
    id,
    pageUrl,
    imageUrl: "",
    isGif: "FALSE",
    title: id,
    tags: [],
    source: "none",
  };
}

async function getTopIdsFromListPage() {
  const { status, text, finalUrl } = await fetchText(IMGFLIP_LIST_PAGE);
  if (!(status >= 200 && status < 400)) {
    die(`Failed to fetch IMGFLIP_LIST_PAGE (${IMGFLIP_LIST_PAGE}). status=${status}`);
  }
  if (!text || isBotBlockHtml(text)) {
    die(
      `List page appears blocked (Cloudflare/bot protection). ` +
        `Try setting IMGFLIP_LIST_PAGE to a different page or use a server-side accessible source. ` +
        `URL=${finalUrl}`
    );
  }

  // Extract IDs from /i/<id> links
  const ids = [];
  const re = /href="\/i\/([a-z0-9]+)"/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    ids.push(m[1]);
  }

  const uniqueIds = unique(ids);
  if (uniqueIds.length < TOP_N) {
    die(`Could only find ${uniqueIds.length} meme IDs on list page; need at least ${TOP_N}.`);
  }

  return uniqueIds.slice(0, TOP_N);
}

function ensureHeaders(parsedHeaders) {
  // If file is empty or has different headers, we still output canonical headers.
  const normalized = (parsedHeaders || []).map((h) => String(h ?? "").trim());
  const ok =
    normalized.length === CSV_HEADERS.length &&
    normalized.every((h, i) => h === CSV_HEADERS[i]);

  if (!ok) {
    warn("CSV headers missing/mismatched; output will be rewritten with canonical headers.");
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
      // Ensure all headers exist
      const full = {};
      for (const h of headers) full[h] = obj[h] ?? "";
      return full;
    });
    return { headers, rows };
  } catch (e) {
    if (e?.code === "ENOENT") {
      return { headers: CSV_HEADERS, rows: [] };
    }
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

function makeBlankRowForId(id) {
  const row = {};
  for (const h of CSV_HEADERS) row[h] = "";
  row.ID = id;
  row.URLS = `https://imgflip.com/i/${id}`;
  row.IMAGE_URL = "";
  row.IS_GIF = "FALSE";
  row.TITLE = id;
  row.MEME_TYPE = "";
  row.KYM_SLUG = "";
  row.MBTI_TYPES = "";
  row.KEYWORDS = "";
  row.TAGS = "";
  return row;
}

function tagsToCsvString(tags) {
  // Keep as a single CSV field with comma+space separation
  return tags.join(", ");
}

async function main() {
  log(`Using list page: ${IMGFLIP_LIST_PAGE}`);

  const topIds = await getTopIdsFromListPage();
  log(`Top ${TOP_N} IDs on page: ${topIds.join(", ")}`);

  const { headers, rows: existingRows } = await readExistingCsv();

  // First 14 IDs in CSV
  const existingTop = existingRows.slice(0, TOP_N).map((r) => String(r.ID || "").trim()).filter(Boolean);

  // If CSV already has the same top 14 in the same order, do nothing.
  const identical =
    existingTop.length === TOP_N &&
    existingTop.every((id, i) => id === topIds[i]);

  if (identical) {
    log("Top 14 IDs already match. No changes needed.");
    process.exit(0);
  }

  // Determine missing IDs that are in page topIds but not in existingTop
  const missing = topIds.filter((id) => !existingTop.includes(id));
  if (missing.length === 0) {
    // Order changed but same set; update order by moving rows accordingly
    log("Same IDs but order changed. Reordering top 14 to match page.");

    const byId = new Map(existingRows.map((r) => [String(r.ID || "").trim(), r]));
    const newTopRows = topIds.map((id) => byId.get(id) || makeBlankRowForId(id));

    // Keep the rest of the CSV as-is, excluding any IDs we already placed in top 14 (to avoid duplicates)
    const placed = new Set(topIds);
    const remainder = existingRows.filter((r) => !placed.has(String(r.ID || "").trim()));

    const out = [...newTopRows, ...remainder];
    await writeCsv(headers, out);
    log(`Updated memes.csv (reordered top ${TOP_N}).`);
    process.exit(0);
  }

  log(`Missing new IDs (to insert at top): ${missing.join(", ")}`);

  // Build new rows for missing IDs with page-derived details
  const newRows = [];
  for (const id of missing) {
    const blank = makeBlankRowForId(id);
    const details = await getMemeDetails(id);

    blank.URLS = details.pageUrl;
    blank.IMAGE_URL = details.imageUrl || "";
    blank.IS_GIF = normalizeBool(details.isGif);
    blank.TITLE = details.title || id;

    if (details.tags?.length) {
      // Place tags into TAGS column; user rules around MBTI/keywords can be applied later if needed
      blank.TAGS = tagsToCsvString(details.tags);
    }

    // Leave other fields blank for new rows unless you want additional enrichment.
    newRows.push(blank);

    log(`Fetched ${id}: source=${details.source} title="${blank.TITLE}" image="${blank.IMAGE_URL}" gif=${blank.IS_GIF}`);
  }

  // Keep the existing top 14 rows, but only the ones that are still in page topIds (to preserve the “other 12 as is” logic)
  const keepFromExistingTop = existingRows
    .slice(0, TOP_N)
    .filter((r) => topIds.includes(String(r.ID || "").trim()));

  // Now construct final top 14:
  // - new rows for missing IDs in the page order
  // - plus the kept existing rows (in the page order)
  const byId = new Map();
  for (const r of newRows) byId.set(String(r.ID).trim(), r);
  for (const r of keepFromExistingTop) byId.set(String(r.ID).trim(), r);

  const finalTop14 = topIds.map((id) => byId.get(id) || makeBlankRowForId(id));

  // Remainder: keep everything below the original top 14 as-is,
  // but remove any IDs that now appear in finalTop14 to avoid duplicates.
  const finalTopSet = new Set(finalTop14.map((r) => String(r.ID || "").trim()));
  const remainder = existingRows.slice(TOP_N).filter((r) => !finalTopSet.has(String(r.ID || "").trim()));

  const out = [...finalTop14, ...remainder];

  await writeCsv(headers, out);
  log(`Updated memes.csv: inserted ${missing.length} new row(s) at the top; preserved remaining rows.`);
}

main().catch((e) => {
  die(e?.stack || e?.message || String(e));
});
