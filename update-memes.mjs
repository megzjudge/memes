import fs from "node:fs/promises";

const USERNAME = "mbtininja";
const LIST_URL = `https://imgflip.com/all/user-images/${USERNAME}?sort=latest`;

const OUT_FILE = "memes.csv";
const MAX_ITEMS = 200;
const REQUEST_DELAY_MS = 175;

// Refuse to overwrite a large existing file with a tiny scrape result
const MIN_EXPECTED_ENTRIES_WHEN_EXISTING = 50;

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
  // 1) Load existing file (if present) so we only add/merge, never wipe out
  const existingMap = await readExistingCsvMap(OUT_FILE);

  const html = await fetchText(LIST_URL);
  const entries = collectIdsFromListingHtml(html).slice(0, MAX_ITEMS);

  // Safety: if we already have a file and suddenly scrape very few items, do not overwrite.
  if (existingMap.size > 0 && entries.length < MIN_EXPECTED_ENTRIES_WHEN_EXISTING) {
    throw new Error(
      `Sanity check failed: only ${entries.length} entries found, but existing ${OUT_FILE} has ${existingMap.size} rows. Refusing to overwrite.`
    );
  }

  const items = [];
  for (const { id, ext } of entries) {
    const item = await fetchAndParseItem(id, ext);
    if (item) items.push(item);
    await sleep(REQUEST_DELAY_MS);
  }

  // 2) Merge: new items first, then existing items not already included
  const merged = [];
  const seen = new Set();

  for (const it of items) {
    if (!it?.id) continue;
    const id = String(it.id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(it);
  }

  // Convert existing CSV rows back to the same object shape you write out
  for (const [id, r] of existingMap.entries()) {
    if (seen.has(id)) continue;

    merged.push({
      id,
      url: String(r.URL ?? r.url ?? "").trim() || `https://imgflip.com/i/${id}`,
      image_url: String(r.IMAGE_URL ?? r.image_url ?? "").trim(),
      is_gif: String(r.IS_GIF ?? r.is_gif ?? "").trim().toLowerCase() === "true",
      title: String(r.TITLE ?? r.title ?? "").trim() || id,
      meme_type: String(r.MEME_TYPE ?? r.meme_type ?? "").trim(),
      kym_slug: String(r.KYM_SLUG ?? r.kym_slug ?? "").trim(),
      mbti_types: splitCsvCell(r.MBTI_TYPES ?? r.mbti_types),
      keywords: splitCsvCell(r.KEYWORDS ?? r.keywords),
      tags: splitCsvCell(r.TAGS ?? r.tags)
    });
  }

  // 3) Hard cap so file doesn't grow
  const finalItems = merged.slice(0, MAX_ITEMS);

  const header = [
    "ID","URL","IMAGE_URL","IS_GIF","TITLE","MEME_TYPE","KYM_SLUG",
    "MBTI_TYPES","KEYWORDS","TAGS"
  ];

  const rows = finalItems.map(it => {
    const mbtiCell = (it.mbti_types || []).join(", ");
    const kwCell   = (it.keywords || []).join(", ");
    const tagCell  = (it.tags || []).join(", ");

    return [
      it.id || "",
      it.url || "",
      it.image_url || "",
      it.is_gif ? "true" : "false",
      it.title || "",
      it.meme_type || "",
      it.kym_slug || "",
      mbtiCell,
      kwCell,
      tagCell
    ].map(csvEscape).join(",");
  });

  const out = [header.join(","), ...rows].join("\n") + "\n";
  await fs.writeFile(OUT_FILE, out, "utf8");

  const carried = Math.max(0, finalItems.length - items.length);
  console.log(`Wrote ${finalItems.length} items to ${OUT_FILE} (fetched=${items.length}, carried_over=${carried})`);
}

// --- Listing extraction ---
// Updated: prefer /i/<id> links (stable), then fall back to CDN jpg/gif matches.
function collectIdsFromListingHtml(html) {
  if (!html) return [];
  const seen = new Set();
  const out = [];

  // Primary: link-based extraction
  const linkRegex = /href=["']\/i\/([A-Za-z0-9]+)["']/gi;
  let m;
  while ((m = linkRegex.exec(html))) {
    const id = m[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, ext: "" });
  }

  // Fallback: CDN image URLs (jpg/gif)
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
    // remove meme_type from keywords (if it matches)
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

// --- Existing CSV merge helpers ---

async function readExistingCsvMap(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const rows = parseCsv(text, ",");
    const map = new Map();
    for (const r of rows) {
      const id = String(pick(r, ["ID", "id"]) || "").trim();
      if (!id) continue;
      map.set(id, r);
    }
    return map;
  } catch {
    return new Map();
  }
}

function parseCsv(text, delimiter) {
  const lines = String(text)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0], delimiter).map((h, idx) => {
    let hh = String(h || "");
    if (idx === 0) hh = hh.replace(/^\uFEFF/, "");
    return hh.trim();
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

function pick(obj, keys) {
  if (!obj) return "";
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
  }
  return "";
}

function splitCsvCell(v) {
  return String(v ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

// --- misc ---

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
