// discover-ids.mjs

import fs from "fs";
import fetch from "node-fetch";
import Papa from "papaparse";

const CSV_FILE = "memes.csv";
const MAX_ROWS_PER_RUN = 50;

const MBTI_TYPES = [
  "ESTP", "ISTP", "ESFP", "ISFP",
  "ESTJ", "ISTJ", "ESFJ", "ISFJ",
  "ENFP", "INFP", "ENFJ", "INFJ",
  "ENTJ", "INTJ", "ENTP", "INTP"
];

const MBTI_SET = new Set(MBTI_TYPES);

const MEME_TYPE_BLOCKLIST = new Set([
  "memes",
  "mbti",
  "myers briggs",
  "personality"
]);

// HTML decoding
function decodeHtml(str = "") {
  return str
    .replace(/&#039;/g, "'")    // Convert &#039; to '
    .replace(/&amp;/g, "&")      // Convert &amp; to &
    .replace(/&quot;/g, '"')     // Convert &quot; to "
    .replace(/&lt;/g, "<")       // Convert &lt; to <
    .replace(/&gt;/g, ">");      // Convert &gt; to >
}

// Normalize and deduplicate tags
function normalizeTags(tags) {
  return [...new Set(
    tags.map(t => t.toLowerCase().trim()).filter(Boolean)
  )];
}

// Process tags to detect MBTI, Meme Type, and Keywords
function processTags(tags) {
  const mbti = tags.filter(t => MBTI_SET.has(t.toUpperCase()));

  let memeType = "";
  for (const t of tags) {
    if (!MBTI_SET.has(t.toUpperCase()) && !MEME_TYPE_BLOCKLIST.has(t)) {
      memeType = t;
      break;
    }
  }

  const keywords = tags.filter(t => {
    if (MBTI_SET.has(t.toUpperCase())) return false;
    if (t === memeType) return false;
    return true;
  });

  return { mbti, memeType, keywords };
}

// Scrape the meme page from Imgflip
async function scrapePage(url) {
  if (!url) {
    console.error("Error: URL is undefined or empty.");
    return { title: "", imageUrl: "", tags: [], kymSlug: "" };
  }

  console.log("Fetching", url);

  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0" }
  });

  const html = await res.text();

  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  const title = titleMatch ? decodeHtml(titleMatch[1].replace(" - Imgflip", "").trim()) : "";

  const imageMatch = html.match(/property="og:image" content="([^"]+)"/i);
  const imageUrl = imageMatch ? imageMatch[1] : "";

  const tagMatches = [...html.matchAll(/class="tag".*?>(.*?)</g)];
  const tags = normalizeTags(tagMatches.map(m => m[1]));

  // Extract KnowYourMeme slug from link
  const kymMatch = html.match(/knowyourmeme.com\/memes\/([^"\/]+)/i);
  const kymSlug = kymMatch ? kymMatch[1] : "";

  return { title, imageUrl, tags, kymSlug };
}

// Scrape the meme template metadata (meme classification improvement)
async function scrapeTemplateMetadata(templateUrl) {
  console.log("Fetching template metadata", templateUrl);

  const res = await fetch(templateUrl, {
    headers: { "user-agent": "Mozilla/5.0" }
  });

  const html = await res.text();

  // Template-specific meme metadata (meme category, name)
  const memeTypeMatch = html.match(/"meme_name":"(.*?)"/i);
  const memeType = memeTypeMatch ? decodeHtml(memeTypeMatch[1]) : "";

  return memeType;
}

// Main CSV enrichment process
const csvText = fs.readFileSync(CSV_FILE, "utf8");
const parsed = Papa.parse(csvText, { header: true });
const rows = parsed.data;

let processed = 0;

for (const row of rows) {
  if (processed >= MAX_ROWS_PER_RUN) break;

  const needsUpdate =
    !row.image_url ||
    !row.title ||
    row.title === row.id ||
    !row.meme_type ||
    !row.keywords ||
    !row.tags ||
    !row.urls;  // Check if the URL is missing

  if (!needsUpdate) continue;

  // Scrape meme page for data
  const { title, imageUrl, tags, kymSlug } = await scrapePage(row.urls);

  // Process tags to extract MBTI types, meme type, and keywords
  const { mbti, memeType, keywords } = processTags(tags);

  // Try to scrape the template page for better meme type detection
  const templateUrl = `https://imgflip.com/memegenerator/${row.meme_name}`;
  const templateMemeType = await scrapeTemplateMetadata(templateUrl);

  // Prefer template-based meme type if available
  const finalMemeType = templateMemeType || memeType;

  if (title) row.title = title;
  if (imageUrl) row.image_url = imageUrl;

  row.tags = JSON.stringify(tags);
  row.mbti_types = JSON.stringify(mbti);
  row.meme_type = finalMemeType;
  row.keywords = JSON.stringify(keywords);

  if (kymSlug && !row.kym_slug) {
    row.kym_slug = kymSlug;
  }

  processed++;
}

// Write updated rows back to CSV
const newCsv = Papa.unparse(rows);
fs.writeFileSync(CSV_FILE, newCsv);

console.log("Rows processed:", processed);
console.log("CSV updated successfully!", rows.length, "rows");
