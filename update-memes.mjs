import fs from "node:fs/promises";

const USERNAME = "mbtininja";
const LIST_URL = `https://imgflip.com/all/user-images/${USERNAME}?sort=latest`;

const OUT_FILE = "memes.csv";
const MAX_ITEMS = 200;
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
  const html = await fetchText(LIST_URL);
  const ids = collectIdsFromListingHtml(html).slice(0, MAX_ITEMS);

  const items = [];
  for (const id of ids) {
    const item = await fetchAndParseItem(id);
    if (item) items.push(item);
    await sleep(REQUEST_DELAY_MS);
  }

  const header = [
    "ID","URL","IMAGE_URL","IS_GIF","TITLE","MEME_TYPE","KYM_SLUG",
    "MBTI_TYPES","KEYWORDS","TAGS"
  ];

  const rows = items.map(it => {
    const mbtiCell = (it.mbti_types || []).join(", ");
    const kwCell   = (it.keywords || []).join(", ");
    const tagCell  = (it.tags || []).join(", ");

    return [
      it.id || "",
      it.page_url || "",
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

  console.log(`Wrote ${items.length} items to ${OUT_FILE}`);
}

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

function minimalItem(id) {
  return {
    id,
    url: `https://imgflip.com/i/${id}`,
    image_url: `https://i.imgflip.com/${id}.jpg`,
    is_gif: false,
    title: id,
    meme_type: "",
    kym_slug: "",
    mbti_types: [],
    keywords: [],
    tags: []
  };
}

async function fetchText(url) {
  const res = await fetch(url, { headers: IMGFLIP_HEADERS });
  if (!res.ok) return "";
  const text = await res.text();
  const head = text.slice(0, 4000).toLowerCase();
  if (head.includes("captcha") || head.includes("unusual traffic")) return "";
  return text;
}

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

function csvEscape(value) {
  const s = String(value ?? "");
  // Quote if it contains comma, quote, or newline
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
