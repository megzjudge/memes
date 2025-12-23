import fs from "node:fs/promises";

const USERNAME = "mbtininja";
const LIST_URL = `https://imgflip.com/all/user-images/${USERNAME}?sort=latest`;

const OUT_FILE = "memes.csv";

// You said: scan last 14 submissions only
const SCAN_COUNT = 14;

const REQUEST_DELAY_MS = 175;

const IMGFLIP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: `https://imgflip.com/user/${USERNAME}`
};

const MBTI_TYPES = new Set([
  "ESTP","ISTP","ESFP","ISFP",
  "ESTJ","ISTJ","ESFJ","ISFJ",
  "ENFP","INFP","ENFJ","INFJ",
  "ENTJ","INTJ","ENTP","INTP"
]);

const MEME_TYPE_EXCLUDE = new Set([
  "mbti","myers briggs","myers-briggs","personality",
  "meme","memes","fun","fun stream","psychology"
]);

async function main() {
  // 1) Read existing CSV (if any)
  const existing = await readExistingCsv(OUT_FILE);
  const existingRows = existing.rows;            // array of row objects keyed by headers
  const headers = existing.headers.length ? existing.headers : [
    "ID","URL","IMAGE_URL","IS_GIF","TITLE","MEME_TYPE","KYM_SLUG","MBTI_TYPES","KEYWORDS","TAGS"
  ];

  // Figure out which header name we should write for the page URL column
  const urlHeader =
    headers.find(h => h === "URLS") ||
    headers.find(h => h === "URL")  ||
    "URL";

  // Use existing boolean style if present (TRUE/FALSE vs true/false)
  const boolStyleUpper = detectUpperBoolStyle(existingRows, "IS_GIF");

  // Build lookup sets and the current top-14 from the CSV (by position)
  const existingIdSet = new Set();
  for (const r of existingRows) {
    const id = String(r["ID"] ?? "").trim();
    if (id) existingIdSet.add(id);
  }

  const csvTopIds = existingRows
    .slice(0, SCAN_COUNT)
    .map(r => String(r["ID"] ?? "").trim())
    .filter(Boolean);

  // 2) Scrape the 14 latest IDs from Imgflip listing
  const listHtml = await fetchText(LIST_URL);
  if (!listHtml) {
    throw new Error("Failed to fetch Imgflip listing HTML (empty response).");
  }

  const listingIds = collectIdsFromListingHtml(listHtml)
    .map(x => x.id)
    .filter(Boolean)
    .slice(0, SCAN_COUNT);

  if (listingIds.length === 0) {
    throw new Error("No IDs found on Imgflip listing page.");
  }

  // 3) If top-14 already match, do nothing
  if (arraysEqual(csvTopIds, listingIds)) {
    console.log(`Top ${SCAN_COUNT} IDs match. No CSV changes needed.`);
    return;
  }

  // 4) Find new IDs (present in listing top-14, not anywhere in CSV)
  const newIds = listingIds.filter(id => !existingIdSet.has(id));

  // If nothing new, do nothing (covers re-ordering on Imgflip, etc.)
  if (newIds.length === 0) {
    console.log(
      `Top ${SCAN_COUNT} IDs differ, but no new IDs found (reorder-only). No CSV changes needed.`
    );
    return;
  }

  // 5) Fetch+parse only the new IDs and create new rows
  const newItems = [];
  for (const id of newIds) {
    const item = await fetchAndParseItem(id, "");
    if (item) newItems.push(item);
    await sleep(REQUEST_DELAY_MS);
  }

  // Convert parsed items into CSV row objects matching existing headers
  const newRows = newItems.map(it => itemToRow(it, headers, urlHeader, boolStyleUpper));

  // 6) Prepend new rows; leave existing rows untouched
  const finalRows = [...newRows, ...existingRows];

  // 7) Write out the CSV with the same headers (or default)
  const out = writeCsv(headers, finalRows);
  await fs.writeFile(OUT_FILE, out, "utf8");

  console.log(`Prepended ${newRows.length} new row(s) to ${OUT_FILE}.`);
}

// ----------------------- Listing extraction -----------------------
// Prefer /i/<id> links (stable), then fallback to CDN jpg/gif matches.
function collectIdsFromListingHtml(html) {
  if (!html) return [];
  const seen = new Set();
  const out = [];

  const linkRegex = /href=["']\/i\/([A-Za-z0-9]+)["']/gi;
  let m;
  while ((m = linkRegex.exec(html))) {
    const id = m[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, ext: "" });
  }

  const imgRegex = /(?:https?:)?\/\/i\.imgflip\.com\/([A-Za-z0-9]+)\.(jpg|gif)/gi;
  while ((m = imgRegex.exec(html))) {
    const id = m[1];
    const ext = (m[2] || "").toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, ext });
  }

  return out;
}

// ----------------------- Item fetch/parse -----------------------

async function fetchAndParseItem(id, extFromList) {
  const pageUrl = `https://imgflip.com/i/${id}`;
  const html = await fetchText(pageUrl);
  if (!html) return minimalItem(id, extFromList);

  const next = extractNextData(html);
  const image = extractImageFromNext(next);
  if (!image) return minimalItem(id, extFromList);

  return parseFromJson(image, id, pageUrl);
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

function parseFromJson(obj, id, pageUrl) {
  const item = minimalItem(id);
  item.url = pageUrl;

  item.title = (obj.title && String(obj.title).trim()) ? String(obj.title).trim() : id;

  const rawUrl = obj.url || obj.image_url || "";
  if (rawUrl) {
    const u = String(rawUrl).startsWith("//") ? "https:" + rawUrl : String(rawUrl);
    item.image_url = u;
    item.is_gif = u.toLowerCase().endsWith(".gif");
  }

  const tagsRaw = Array.isArray(obj.tags) ? obj.tags : [];
  const tags = tagsRaw
    .map(t => String(t).toLowerCase().trim())
    .filter(Boolean);
  item.tags = tags;

  let memeType = "";
  if (obj.template?.name) {
    memeType = String(obj.template.name).replace(/ meme$/i, "").trim();
  }
  if (!memeType) {
    for (const t of tags) {
      const upper = t.toUpperCase();
      if (MBTI_TYPES.has(upper)) continue;
      if (MEME_TYPE_EXCLUDE.has(t)) continue;
      memeType = t;
      break;
    }
  }
  item.meme_type = memeType ? toTitleCase(memeType) : "";

  const mbti = [];
  const keywords = [];
  for (const t of tags) {
    const upper = t.toUpperCase();
    if (MBTI_TYPES.has(upper)) {
      mbti.push(upper);
      continue;
    }
    if (item.meme_type && t === item.meme_type.toLowerCase()) continue;
    keywords.push(t);
  }

  item.mbti_types = unique(mbti);
  item.keywords = unique(keywords);

  // keep blank as requested
  item.kym_slug = "";

  return item;
}

function minimalItem(id, extFromList) {
  const ext = (extFromList || "").toLowerCase();
  const isGif = ext === "gif";

  return {
    id,
    url: `https://imgflip.com/i/${id}`,
    image_url: "",
    is_gif: isGif,
    title: id,
    meme_type: "",
    kym_slug: "",
    mbti_types: [],
    keywords: [],
    tags: []
  };
}

async function fetchText(url) {
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

// ----------------------- CSV read/write -----------------------

async function readExistingCsv(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = parseCsvKeepHeader(text, ",");
    return parsed;
  } catch {
    return { headers: [], rows: [] };
  }
}

function parseCsvKeepHeader(text, delimiter) {
  const lines = String(text)
    .split(/\r?\n/)
    .filter(l => l.length > 0);

  if (lines.length < 2) return { headers: [], rows: [] };

  const headers = splitCsvLine(lines[0], delimiter).map((h, idx) => {
    let hh = String(h || "");
    if (idx === 0) hh = hh.replace(/^\uFEFF/, "");
    return hh.trim();
  });

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i], delimiter);
    if (!cols.length) continue;

    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cols[j] !== undefined ? cols[j] : "";
    }
    rows.push(row);
  }

  return { headers, rows };
}

function splitCsvLine(line, delimiter) {
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

function writeCsv(headers, rows) {
  const headerLine = headers.map(csvEscape).join(",");
  const lines = [headerLine];

  for (const r of rows) {
    const cols = headers.map(h => csvEscape(r?.[h] ?? ""));
    lines.push(cols.join(","));
  }

  return lines.join("\n") + "\n";
}

function itemToRow(item, headers, urlHeader, boolStyleUpper) {
  const boolStr = (b) => {
    const v = b ? "true" : "false";
    return boolStyleUpper ? v.toUpperCase() : v;
  };

  const mbtiCell = (item.mbti_types || []).join(", ");
  const kwCell   = (item.keywords || []).join(", ");
  const tagCell  = (item.tags || []).join(", ");

  const row = {};
  for (const h of headers) row[h] = "";

  row["ID"] = item.id || "";
  row[urlHeader] = item.url || "";

  if (headers.includes("IMAGE_URL")) row["IMAGE_URL"] = item.image_url || "";
  if (headers.includes("IS_GIF")) row["IS_GIF"] = boolStr(!!item.is_gif);
  if (headers.includes("TITLE")) row["TITLE"] = item.title || "";
  if (headers.includes("MEME_TYPE")) row["MEME_TYPE"] = item.meme_type || "";
  if (headers.includes("KYM_SLUG")) row["KYM_SLUG"] = item.kym_slug || "";

  if (headers.includes("MBTI_TYPES")) row["MBTI_TYPES"] = mbtiCell;
  if (headers.includes("KEYWORDS")) row["KEYWORDS"] = kwCell;
  if (headers.includes("TAGS")) row["TAGS"] = tagCell;

  return row;
}

function detectUpperBoolStyle(rows, key) {
  for (const r of rows) {
    const v = String(r?.[key] ?? "").trim();
    if (v === "TRUE" || v === "FALSE") return true;
    if (v === "true" || v === "false") return false;
  }
  // Default to lowercase if we can't infer
  return false;
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (String(a[i]) !== String(b[i])) return false;
  }
  return true;
}

// ----------------------- misc -----------------------

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function unique(arr) { return Array.from(new Set(arr)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toTitleCase(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
