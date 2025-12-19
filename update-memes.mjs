import fs from "node:fs/promises";

const USERNAME = "mbtininja";
const LIST_URL = `https://imgflip.com/all/user-images/${USERNAME}?sort=latest`;

const OUT_FILE = "memes.csv";

// You said “first page only” and mentioned 14.
const LIST_MAX_IDS = 14;

// Total cap for your archive (optional; raise if you want)
const MAX_ITEMS = 5000;

// gentle pacing
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
  const existing = await readJsonLines(OUT_FILE);
  const existingIds = new Set(
    existing.map(x => String(x?.id || "").trim()).filter(Boolean)
  );

  const html = await fetchText(LIST_URL);
  const page1Ids = collectIdsFromListingHtml(html).slice(0, LIST_MAX_IDS);

  if (!page1Ids.length) {
    console.log("No IDs found on listing page. No update performed.");
    return;
  }

  const newIds = page1Ids.filter(id => !existingIds.has(id));

  if (!newIds.length) {
    console.log("No new memes found.");
    return;
  }

  console.log(`Found ${newIds.length} new meme(s): ${newIds.join(", ")}`);

  const newItems = [];
  for (const id of newIds) {
    const item = await fetchAndParseItem(id);
    if (item) newItems.push(item);
    await sleep(REQUEST_DELAY_MS);
  }

  // Prepend new items (newest-first already) then keep old ones
  const merged = [...newItems, ...existing].slice(0, MAX_ITEMS);

  // Write atomically: temp file then rename
  const tmp = `${OUT_FILE}.tmp`;
  await writeJsonLines(tmp, merged);
  await fs.rename(tmp, OUT_FILE);

  console.log(`Updated ${OUT_FILE}: prepended ${newItems.length} new item(s). Total: ${merged.length}.`);
}

// ------------------------- JSONL IO -------------------------

async function readJsonLines(path) {
  try {
    const raw = await fs.readFile(path, "utf8");
    return raw
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => safeParseJsonLine(l))
      .filter(Boolean);
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
}

function safeParseJsonLine(line) {
  // tolerate common copy/paste artifacts
  const normalized = line
    .replace(/\t+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/\bTRUE\b/g, "true")
    .replace(/\bFALSE\b/g, "false")
    .replace(/,\s*$/, "");

  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

async function writeJsonLines(path, items) {
  const lines = items.map(x => JSON.stringify(x));
  await fs.writeFile(path, lines.join("\n") + "\n", "utf8");
}

// ------------------------- Scrape / parse -------------------------

function collectIdsFromListingHtml(html) {
  if (!html) return [];
  const seen = new Set();
  const ids = [];

  const imgRegex = /(?:https?:)?\/\/i\.imgflip\.com\/([A-Za-z0-9]+)\.(?:jpg|png|gif|webp)/g;
  let m;
  while ((m = imgRegex.exec(html))) {
    const id = m[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function fetchAndParseItem(id) {
  const pageUrl = `https://imgflip.com/i/${id}`;
  const html = await fetchText(pageUrl);
  if (!html) return minimalItem(id);

  const next = extractNextData(html);
  const image = extractImageFromNext(next);
  if (!image) return minimalItem(id);

  return parseFromJson(image, id, pageUrl);
}

function extractNextData(html) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
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
  item.page_url = pageUrl;

  item.title = (obj.title && String(obj.title).trim()) ? String(obj.title).trim() : id;

  const rawUrl = obj.url || obj.image_url || "";
  if (rawUrl) {
    const u = String(rawUrl).startsWith("//") ? "https:" + rawUrl : String(rawUrl);
    item.image_url = u;
    item.is_gif = u.toLowerCase().endsWith(".gif");
  }

  const created = obj.created_at || obj.created || obj.createdAt || obj.submitted_at || "";
  const createdTs = Date.parse(String(created));
  if (Number.isFinite(createdTs)) item.created_ts = createdTs;

  const tagsRaw = Array.isArray(obj.tags) ? obj.tags : [];
  const tags = tagsRaw.map(t => String(t).toLowerCase().trim()).filter(Boolean);
  item.tags = tags;

  // meme_type
  let memeType = "";
  if (obj.template?.name) memeType = String(obj.template.name).replace(/ meme$/i, "").trim();
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

  // mbti_types + keywords
  const mbti = [];
  const keywords = [];
  for (const t of tags) {
    const upper = t.toUpperCase();
    if (MBTI_TYPES.has(upper)) { mbti.push(upper); continue; }
    if (item.meme_type && t === item.meme_type.toLowerCase()) continue;
    keywords.push(t);
  }
  item.mbti_types = unique(mbti.length ? mbti : ["non-mbti"]);
  item.keywords = unique(keywords);

  // per your rule: leave KYM blank
  item.kym_slug = "";

  return item;
}

function minimalItem(id) {
  return {
    id,
    page_url: `https://imgflip.com/i/${id}`,
    image_url: `https://i.imgflip.com/${id}.jpg`,
    is_gif: false,
    title: id,
    meme_type: "",
    kym_slug: "",
    mbti_types: ["non-mbti"],
    keywords: [],
    tags: [],
    created_ts: 0
  };
}

// ------------------------- HTTP -------------------------

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

// ------------------------- utils -------------------------

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
