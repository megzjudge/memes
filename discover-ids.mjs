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

  if (mbti.length === 0) {
    console.warn("No MBTI types found in tags:", tags);
  }

  let memeType = "";
  for (const t of tags) {
    if (!MBTI_SET.has(t.toUpperCase()) && !MEME_TYPE_BLOCKLIST.has(t)) {
      memeType = t;
      break;
    }
  }

  if (!memeType) {
    console.warn("No valid meme type found in tags:", tags);
  }

  const keywords = tags.filter(t => {
    if (MBTI_SET.has(t.toUpperCase())) return false;
    if (t === memeType) return false;
    return true;
  });

  if (keywords.length === 0) {
    console.warn("No valid keywords found in tags:", tags);
  }

  return { mbti, memeType, keywords };
}

// Scrape the meme page from Imgflip
async function scrapePage(url) {
  if (!url) {
    console.error("Error: URL is undefined or empty.");
    return { title: "", imageUrl: "", tags: [], kymSlug: "" };
  }

  console.log(`Fetching data for URL: ${url}`);

  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0" }
    });

    if (!res.ok) {
      console.error(`Error: Failed to fetch URL ${url}. Status: ${res.status}`);
      return { title: "", imageUrl: "", tags: [], kymSlug: "" };
    }

    const html = await res.text();

    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1].replace(" - Imgflip", "").trim()) : "";

    if (!title) {
      console.error("Error: Failed to extract title from page.");
    }

    const imageMatch = html.match(/property="og:image" content="([^"]+)"/i);
    const imageUrl = imageMatch ? imageMatch[1] : "";

    if (!imageUrl) {
      console.error("Error: Failed to extract image URL from page.");
    }

    const tagMatches = [...html.matchAll(/class="tag".*?>(.*?)</g)];
    const tags = normalizeTags(tagMatches.map(m => m[1]));

    if (tags.length === 0) {
      console.error("Error: No tags found on the page.");
    }

    // Extract KnowYourMeme slug from link
    const kymMatch = html.match(/knowyourmeme.com\/memes\/([^"\/]+)/i);
    const kymSlug = kymMatch ? kymMatch[1] : "";

    return { title, imageUrl, tags, kymSlug };

  } catch (err) {
    console.error(`Error: Failed to fetch URL ${url}.`, err);
    return { title: "", imageUrl: "", tags: [], kymSlug: "" };
  }
}

// Scrape the meme template metadata (meme classification improvement)
async function scrapeTemplateMetadata(templateUrl) {
  console.log("Fetching template metadata", templateUrl);

  try {
    const res = await fetch(templateUrl, {
      headers: { "user-agent": "Mozilla/5.0" }
    });

    if (!res.ok) {
      console.error(`Error: Failed to fetch template URL ${templateUrl}. Status: ${res.status}`);
      return "";
    }

    const html = await res.text();

    // Template-specific meme metadata (meme category, name)
    const memeTypeMatch = html.match(/"meme_name":"(.*?)"/i);
    const memeType = memeTypeMatch ? decodeHtml(memeTypeMatch[1]) : "";

    return memeType;

  } catch (err) {
    console.error(`Error: Failed to fetch template URL ${templateUrl}.`, err);
    return "";
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

rows = normalizeHeaders(rows);  // Ensure all headers are uppercased

let processed = 0;

// Only process the last 14 rows
const last14Rows = rows.slice(-14);

console.log(`Processing ${last14Rows.length} rows`);

for (const row of last14Rows) {
  if (processed >= MAX_ROWS_PER_RUN) break;

  const needsUpdate =
    !row.IMAGE_URL ||    // Updated column names to match your CSV (all caps)
    !row.TITLE ||
    row.TITLE === row.ID ||
    !row.MEME_TYPE ||
    !row.KEYWORDS ||
    !row.TAGS ||
    !row.URLS;  // Make sure to check the 'URLS' column, as per your request

  if (!needsUpdate) continue;

  // **Debugging Log for GitHub Actions**
  console.log(`Processing row with ID: ${row.ID}`);
  console.log(`URLS column value: ${row.URLS}`);

  // Check if the URL is empty
  if (!row.URLS || row.URLS.trim() === "") {
    console.error(`Error: URLS is empty for row with ID: ${row.ID}`);
    continue;  // Skip this row if URL is empty
  }

  // Scrape meme page for data using the correct column name `URLS`
  const { title, imageUrl, tags, kymSlug } = await scrapePage(row.URLS);  // Using row.URLS

  // Check if the data was fetched
  if (!title || !imageUrl || tags.length === 0) {
    console.error(`Error: Failed to scrape data for row with ID: ${row.ID}`);
    continue;  // Skip the row if any important data is missing
  }

  // Log tags to verify their accuracy
  console.log("Scraped Tags for", row.TITLE, ": ", tags);

  // Process tags to extract MBTI types, meme type, and keywords
  const { mbti, memeType, keywords } = processTags(tags);

  // Log the processed data for tags, MBTI, and meme type
  console.log("Processed Data -> MBTI:", mbti, "MemeType:", memeType, "Keywords:", keywords);

  // Check for failure to extract MBTI types
  if (mbti.length === 0) {
    console.warn(`Warning: No MBTI types extracted for row with ID: ${row.ID}`);
  }

  // Check for failure to extract meme type
  if (!memeType) {
    console.warn(`Warning: No meme type extracted for row with ID: ${row.ID}`);
  }

  // Check for failure to extract keywords
  if (keywords.length === 0) {
    console.warn(`Warning: No keywords extracted for row with ID: ${row.ID}`);
  }

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
