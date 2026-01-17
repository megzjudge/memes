#!/usr/bin/env node
/**
 * update-memes.mjs
 *
 * Behavior:
 * - Reads memes.csv (if present)
 * - Discovers the current top 14 meme IDs via Imgflip AJAX JSON feed (preferred)
 *   - Optional fallback: scrape HTML list pages if JSON is unavailable
 * - Compares those 14 IDs to the first 14 rows in memes.csv
 * - If identical -> no change
 * - If new IDs are present -> inserts only the missing ones at the top, keeping other existing rows as-is
 * - For newly inserted rows, fetches per-meme page data and fills IMAGE_URL / IS_GIF / TITLE (best-effort)
 *
 * CI behavior:
 * - If discovery is blocked/unavailable, exits 0 (does not fail the workflow)
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const CSV_PATH = path.resolve(process.cwd(), "memes.csv");

const IMGFLIP_USERNAME = process.env.IMGFLIP_USERNAME || "mbtininja";

// Prefer JSON feed; allow override
const IMGFLIP_AJAX_URL =
  process.env.IMGFLIP_AJAX_URL ||
  `https://imgflip.com/ajax_get_user_images?username=${encodeURIComponent(
    IMGFLIP_USERNAME
  )}&sort=latest&page=1`;

// Optional HTML fallback candidates (only used if AJAX fails)
const IMGFLIP_LIST_PAGE =
  process.env.IMGFLIP_LIST_PAGE ||
  `https://imgflip.com/m/fun/user-images/${encodeURIComponent(IMGFLIP_USERNAME)}?page=1`;

const TOP_N = 14;

const CANDIDATE_LIST_PAGES = [
  IMGFLIP_LIST_PAGE,
  `https://imgflip.com/all/user-images/${encodeURIComponent(IMGFLIP_USERNAME)}?sort=latest`,
  `https://imgflip.com/user/${encodeURIComponent(IMGFLIP_USERNAME)}`,
];

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

const FETCH_HEADERS_HTML = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-AU,en;q=0.9,en-US;q=0.8",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  Referer: "https://imgflip.com/",
};

const FETCH_HEADERS_JSON = {
  ...FETCH_HEADERS_HTML,
  Accept: "application/json,text/plain,*/*",
};

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

function unique(arr) {
  return [...new Set(arr)];
}

function isBotBlockHtml(html) {
  const h = String(html || "").toLowerCase();
  return (
    h.includes("checking your browser") ||
    h.includes("just a moment") ||
    h.includes("cloudflare") ||
    h.includes("cf-challenge") ||
    h.includes("attention required") ||
    h.includes("please enable cookies") ||
    h.includes("captcha") ||
    h.includes("unusual traffic")
  );
}

async function fetchText(url, headers = FETCH_HEADERS_HTML) {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers,
    });
    const text = await res.text();
    return { status: res.status, text, finalUrl: res.url };
  } catch (e) {
    return { status: 0, text: "", finalUrl: url, error: e?.message || String(e) };
  }
}

async function fetchJson(url) {
  const out = await fetchText(url, FETCH_HEADERS_JSON);
  if (!out.text) return { ...out, data: null };
  try {
    return { ...out, data: JSON.parse(out.text) };
  } catch {
    return { ...out, data: null };
  }
}

function extractIdsFromHtml(html) {
  const ids = [];
  const re =
    /(?:href=")?https?:\/\/imgflip\.com\/i\/([a-z0-9]+)|href="\/i\/([a-z0-9]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    ids.push(m[1] || m[2]);
  }
  return unique(ids);
}

function extractIdsFromJsonAnyShape(data) {
  // Extremely robust: stringify the JSON and look for /i/<id>
  // Avoids having to guess payload shape.
  const s = JSON.stringify(data || {});
  const ids = [];
  const re = /\/i\/([a-z0-9]+)/gi;
  let m;
  while ((m = re.exec(s)) !== null) ids.push(m[1]);
  return unique(ids);
}

async function headOk(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: {
        "User-Agent": FETCH_HEADERS_HTML["User-Agent"],
        Accept: "*/*",
        "Accept-Language": FETCH_HEADERS_HTML["Accept-Language"],
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
  const esc = key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

  const re1 = new RegExp(
    `<meta\\s+[^>]*(?:property|name)="${esc}"[^>]*content="([^"]+)"[^>]*>`,
    "i"
  );
  const m1 = html.match(re1);
  if (m1 && m1[1]) return m1[1].trim();

  const re2 = new RegExp(
    `<meta\\s+[^>]*content="([^"]+)"[^>]*(?:property|name)="${esc}"[^>]*>`,
    "i"
  );
  const m2 = html.match(re2);
  if (m2 && m2[1]) return m2[1].trim();

  return "";
}

function extractTagsFromImgflipHtml(html) {
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

  // 1) Scrape meme page
  try {
    const { status, text } = await fetchText(pageUrl, FETCH_HEADERS_HTML);

    if (status >= 200 && status < 400 && text && !isBotBlockHtml(text)) {
      const ogImage = extractMetaContent(text, "og:image");
      const ogTitle = extractMetaContent(text, "og:title");
      const title =
        (ogTitle || "").replace(/\s*-\s*Imgflip\s*$/i, "").trim() || id;

      const imageUrl = ogImage || "";
      const isGif = imageUrl.toLowerCase().includes(".gif") ? "TRUE" : "FALSE";
      const tags = extractTagsFromImgflipHtml(text);

      return { id, pageUrl, imageUrl, isGif, title, tags, source: "page" };
    } else {
      warn(
        `Imgflip page fetch looked blocked or empty for ${id} (status=${status}). Falling back.`
      );
    }
  } catch (e) {
    warn(`Imgflip page fetch failed for ${id}. Falling back.`, e?.message || e);
  }

  // 2) Fallback: probe assets
  for (const ext of ["jpg", "png", "gif"]) {
    const assetUrl = `https://i.imgflip.com/${id}.${ext}`;
    const ok = await headOk(assetUrl);
    if (ok) {
      const isGif =
        ext === "gif" || ok.contentType.toLowerCase().includes("gif")
          ? "TRUE"
          : "FALSE";
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

  return { id, pageUrl, imageUrl: "", isGif: "FALSE", title: id, tags: [], source: "none" };
}

async function getTopIdsPreferAjax() {
  log(`Trying AJAX feed: ${IMGFLIP_AJAX_URL}`);
  const { status, data, text, error } = await fetchJson(IMGFLIP_AJAX_URL);

  if (status >= 200 && status < 400 && data) {
    const ids = extractIdsFromJsonAnyShape(data);
    log(`AJAX feed returned JSON. Found ${ids.length} candidate IDs.`);
    if (ids.length >= TOP_N) return ids.slice(0, TOP_N);
    warn(`AJAX feed JSON but only ${ids.length} IDs; need ${TOP_N}.`);
  } else {
    if (text && isBotBlockHtml(text)) warn(`AJAX feed appears blocked (status=${status}).`);
    else warn(`AJAX feed failed (status=${status})${error ? ` err=${error}` : ""}.`);
  }

  // Optional fallback: HTML list scraping (best-effort)
  warn("Falling back to HTML list pages (best-effort)...");
  for (const url of CANDIDATE_LIST_PAGES) {
    log(`Trying list page: ${url}`);
    const { status: s, text: t, finalUrl } = await fetchText(url, FETCH_HEADERS_HTML);

    if (!(s >= 200 && s < 400)) {
      warn(`List page failed. status=${s} url=${finalUrl}`);
      continue;
    }
    if (!t || isBotBlockHtml(t)) {
      warn(`List page blocked or empty. url=${finalUrl}`);
      continue;
    }

    const ids = extractIdsFromHtml(t);
    if (ids.length >= TOP_N) {
      log(`List page OK: found ${ids.length} IDs on ${finalUrl}`);
      return ids.slice(0, TOP_N);
    }
    warn(`Only found ${ids.length} IDs on ${finalUrl}; need ${TOP_N}.`);
  }

  return [];
}

function ensureHeaders(parsedHeaders) {
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
  for (const obj of rowObjects) lines.push(csvLine(fromRowObject(headers, obj)));
  lines.push("");
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
  return tags.join(", ");
}

async function main() {
  const topIds = await getTopIdsPreferAjax();

  if (!topIds.length) {
    log("Could not discover top IDs (blocked/unavailable). Skipping update without failing workflow.");
    process.exit(0);
  }

  log(`Top ${TOP_N} IDs: ${topIds.join(", ")}`);

  const { headers, rows: existingRows } = await readExistingCsv();
  // Best-effort enrichment pass for existing top rows even if discovery is blocked.
  // This helps fill IMAGE_URL / TITLE for rows that currently only have ID.
  const ENRICH_LIMIT = Number(process.env.ENRICH_LIMIT || 25);

  let enrichedCount = 0;
  for (let i = 0; i < Math.min(existingRows.length, ENRICH_LIMIT); i++) {
    const r = existingRows[i];
    const id = String(r.ID || "").trim();
    if (!id) continue;

    const needsImage = !String(r.IMAGE_URL || "").trim();
    const needsTitle = !String(r.TITLE || "").trim() || String(r.TITLE).trim() === id;

    if (!needsImage && !needsTitle) continue;

    const details = await getMemeDetails(id);

    if (needsImage && details.imageUrl) r.IMAGE_URL = details.imageUrl;
    if (needsTitle && details.title) r.TITLE = details.title;

    // Keep URLs normalized
    r.URLS = r.URLS || details.pageUrl || `https://imgflip.com/i/${id}`;

    // Normalize boolean
    r.IS_GIF = normalizeBool(details.isGif);

    // Only fill tags if empty (don’t overwrite curated values)
    if (!String(r.TAGS || "").trim() && details.tags && details.tags.length) {
      r.TAGS = tagsToCsvString(details.tags);
    }

    enrichedCount++;
    log(`Enriched ${id}: title="${r.TITLE}" image="${r.IMAGE_URL}" gif=${r.IS_GIF}`);
  }

  if (enrichedCount > 0) {
    await writeCsv(headers, existingRows);
    log(`Enriched ${enrichedCount} row(s) in-place near the top of memes.csv.`);
  }

  const existingTop = existingRows
    .slice(0, TOP_N)
    .map((r) => String(r.ID || "").trim())
    .filter(Boolean);

  const identical =
    existingTop.length === TOP_N && existingTop.every((id, i) => id === topIds[i]);

  if (identical) {
    log("Top 14 IDs already match. No changes needed.");
    process.exit(0);
  }

  const missing = topIds.filter((id) => !existingTop.includes(id));

  if (missing.length === 0) {
    log("Same IDs but order changed. Reordering top 14 to match discovered order.");

    const byId = new Map(existingRows.map((r) => [String(r.ID || "").trim(), r]));
    const newTopRows = topIds.map((id) => byId.get(id) || makeBlankRowForId(id));

    const placed = new Set(topIds);
    const remainder = existingRows.filter((r) => !placed.has(String(r.ID || "").trim()));

    await writeCsv(headers, [...newTopRows, ...remainder]);
    log(`Updated memes.csv (reordered top ${TOP_N}).`);
    process.exit(0);
  }

  log(`Missing new IDs (to insert at top): ${missing.join(", ")}`);

  const newRows = [];
  for (const id of missing) {
    const blank = makeBlankRowForId(id);
    const details = await getMemeDetails(id);

    blank.URLS = details.pageUrl;
    blank.IMAGE_URL = details.imageUrl || "";
    blank.IS_GIF = normalizeBool(details.isGif);
    blank.TITLE = details.title || id;

    if (details.tags && details.tags.length) blank.TAGS = tagsToCsvString(details.tags);

    newRows.push(blank);

    log(
      `Fetched ${id}: source=${details.source} title="${blank.TITLE}" image="${blank.IMAGE_URL}" gif=${blank.IS_GIF}`
    );
  }

  const keepFromExistingTop = existingRows
    .slice(0, TOP_N)
    .filter((r) => topIds.includes(String(r.ID || "").trim()));

  const byId = new Map();
  for (const r of newRows) byId.set(String(r.ID).trim(), r);
  for (const r of keepFromExistingTop) byId.set(String(r.ID).trim(), r);

  const finalTop14 = topIds.map((id) => byId.get(id) || makeBlankRowForId(id));

  const finalTopSet = new Set(finalTop14.map((r) => String(r.ID || "").trim()));
  const remainder = existingRows
    .slice(TOP_N)
    .filter((r) => !finalTopSet.has(String(r.ID || "").trim()));

  await writeCsv(headers, [...finalTop14, ...remainder]);
  log(`Updated memes.csv: inserted ${missing.length} new row(s) at the top; preserved remaining rows.`);
}

main().catch((e) => {
  die(e?.stack || e?.message || String(e));
});
