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

  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) {
      console.error(`Failed to fetch ${url}: ${res.statusText}`);
      return { title: "", imageUrl: "", tags: [], kymSlug: "" };
    }

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
  } catch (err) {
    console.error(`Error fetching URL ${url}: ${err.message}`);
    return { title: "", imageUrl: "", tags: [], kymSlug: "" };
  }
}

// Scrape the meme template metadata (meme classification improvement)
async function scrapeTemplateMetadata(templateUrl) {
  console.log("Fetching template metadata", templateUrl);

  try {
    const res = await fetch(templateUrl, { headers: { "user-agent": "Mozilla/5.0" } });
    const html = await res.text();

    // Template-specific meme metadata (meme category, name)
    const memeTypeMatch = html.match(/"meme_name":"(.*?)"/i);
    const memeType = memeTypeMatch ? decodeHtml(memeTypeMatch[1]) : "";

    return memeType;
  } catch (err) {
    console.error(`Error fetching template metadata for ${templateUrl}: ${err.message}`);
    return "";
  }
}

// Normalize CSV headers to upper case
function normalizeHeaders(rows) {
  return rows.map(row => {
    const normalizedRow = {};
    for (const [key, value] of Object.entries(row)) {
      const normalizedKey = key.trim().toUpperCase().replace(/[^a-zA-Z0-9_]/g, "_");  // Removes special characters
      normalizedRow[normalizedKey] = value;
    }
    return normalizedRow;
  });
}

// Main CSV enrichment process
const csvText = fs.readFileSync(CSV_FILE, "utf8");
const parsed = Papa.parse(csvText, { header: true });
let rows = parsed.data;

rows = normalizeHeaders(rows);  // Ensure all headers are uppercased

// Get the last 14 rows
const last14Rows = rows.slice(-14);  // This ensures you're only working with the last 14 rows

let processed = 0;

for (const row of last14Rows) {
  if (processed >= MAX_ROWS_PER_RUN) break;

  const needsUpdate =
    !row.IMAGE_URL ||    // Updated column names to match your CSV (all caps)
    !row.TITLE ||
    row.TITLE === row.ID ||
    !row.MEME_TYPE ||
    !row.KEYWORDS ||
    !row.TAGS ||
    !row.URLS;  // Check if the URL is missing

  if (!needsUpdate) continue;

  // Scrape meme page for data
  const { title, imageUrl, tags, kymSlug } = await scrapePage(row.URLS);

  // Log tags to verify their accuracy
  console.log("Scraped Tags for", row.TITLE, ": ", tags);

  // Process tags to extract MBTI types, meme type, and keywords
  const { mbti, memeType, keywords } = processTags(tags);

  // Log the processed data for tags, MBTI, and meme type
  console.log("Processed Data -> MBTI:", mbti, "MemeType:", memeType, "Keywords:", keywords);

  // Try to scrape the template page for better meme type detection
  const templateUrl = row.MEME_TYPE ? `https://imgflip.com/memegenerator/${row.MEME_TYPE}` : '';
  const templateMemeType = templateUrl ? await scrapeTemplateMetadata(templateUrl) : "";

  // Prefer template-based meme type if available
  const finalMemeType = templateMemeType || memeType;

  // Only update if the data was found
  if (title) row.TITLE = title;
  if (imageUrl) row.IMAGE_URL = imageUrl;

  row.TAGS = JSON.stringify(tags);
  row.MBTI_TYPES = JSON.stringify(mbti);
  row.MEME_TYPE = finalMemeType;
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
