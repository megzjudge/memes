import fs from "fs";
import fetch from "node-fetch";
import Papa from "papaparse";

const CSV_FILE = "memes.csv";
const MAX_ROWS_PER_RUN = 34;  // Process only the first 14 rows

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

  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0" }
    });

    const html = await res.text();

    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1].replace(" - Imgflip", "").trim()) : "";

    const imageMatch = html.match(/property="og:image" content="([^"]+)"/i);
    const imageUrl = imageMatch ? imageMatch[1] : "";

    // Extract tags using the correct format
    const tagMatches = [...html.matchAll(/href='\/tag\/([^']+)'/g)];
    const tags = normalizeTags(tagMatches.map(m => m[1]));

    // Log the raw tag data for debugging
    if (tags.length === 0) {
      console.error(`No tags found for ${url}. The HTML structure may have changed.`);
    }

    // Extract KnowYourMeme slug from link
    const kymMatch = html.match(/knowyourmeme.com\/memes\/([^"\/]+)/i);
    const kymSlug = kymMatch ? kymMatch[1] : "";

    return { title, imageUrl, tags, kymSlug };
  } catch (error) {
    console.error("Error fetching data for URL:", url, error);
    return { title: "", imageUrl: "", tags: [], kymSlug: "" };
  }
}

// Normalize CSV headers to upper case
function normalizeHeaders(rows) {
  const firstRow = rows[0];
  return rows.map(row => {
    const normalizedRow = {};
    for (const [key, value] of Object.entries(row)) {
      const normalizedKey = key.trim().toUpperCase();
      normalizedRow[normalizedKey] = value;
    }
    return normalizedRow;
  });
}

// Main CSV enrichment process
const csvText = fs.readFileSync(CSV_FILE, "utf8");
const parsed = Papa.parse(csvText, { header: true });
let rows = parsed.data;

rows = normalizeHeaders(rows);

let processed = 0;

for (const row of rows.slice(0, MAX_ROWS_PER_RUN)) {
  if (processed >= MAX_ROWS_PER_RUN) break;

  const needsUpdate =
    !row.IMAGE_URL ||
    !row.TITLE ||
    row.TITLE === row.ID ||
    !row.MEME_TYPE ||
    !row.KEYWORDS ||
    !row.TAGS ||
    !row.URLS;

  if (!needsUpdate) continue;

  // Scrape meme page for data
  const { title, imageUrl, tags, kymSlug } = await scrapePage(row.URLS);

  // Log tags to verify their accuracy
  console.log("Scraped Tags for", row.TITLE, ": ", tags);

  // Process tags to extract MBTI types, meme type, and keywords
  const { mbti, memeType, keywords } = processTags(tags);

  // Log the processed data for tags, MBTI, and meme type
  console.log("Processed Data -> MBTI:", mbti, "MemeType:", memeType, "Keywords:", keywords);

  // Only update if the data was found
  if (title) row.TITLE = title;
  if (imageUrl) row.IMAGE_URL = imageUrl;

  row.TAGS = JSON.stringify(tags);
  row.MBTI_TYPES = JSON.stringify(mbti);
  row.MEME_TYPE = memeType;
  row.KEYWORDS = JSON.stringify(keywords);

  if (kymSlug && !row.KYM_SLUG) {
    row.KYM_SLUG = kymSlug;
  }

  processed++;
}

// Write updated rows back to CSV
const newCsv = Papa.unparse(rows);
fs.writeFileSync(CSV_FILE, newCsv);

console.log("Rows processed:", processed);
console.log("CSV updated successfully!", rows.length, "rows");
