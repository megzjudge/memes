// discover-ids.mjs
import fs from "fs/promises";
import path from "path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

const CSV_PATH = path.resolve("./memes.csv");

// Helper: fetch page HTML
async function fetchPageHtml(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
    return await res.text();
  } catch (err) {
    console.error(`Error fetching ${url}:`, err);
    return null;
  }
}

// Extract meme data from HTML / page JS
function extractDataFromPage(html) {
  if (!html) return {};

  const title = html.match(/<title>(.*?)<\/title>/i)?.[1]?.replace(" - Imgflip", "").trim() || "";
  const memeType = html.match(/"memeType":"(.*?)"/)?.[1] || "";
  const kymSlug = html.match(/"kymSlug":"(.*?)"/)?.[1] || "";
  const mbtiTypes = html.match(/"mbtiTypes":"(.*?)"/)?.[1] || "";
  const keywords = html.match(/"keywords":"(.*?)"/)?.[1] || "";
  const tags = html.match(/"tags":"(.*?)"/)?.[1] || "";
  const isGif = html.includes(".gif") ? "TRUE" : "FALSE";

  return { TITLE: title, MEME_TYPE: memeType, KYM_SLUG: kymSlug, MBTI_TYPES: mbtiTypes, KEYWORDS: keywords, TAGS: tags, IS_GIF: isGif };
}

// Main logic
async function fetchAndFillMissingData() {
  const fileContent = await fs.readFile(CSV_PATH, "utf-8");
  const rows = parse(fileContent, { columns: true, skip_empty_lines: true });
  let updatedCount = 0;

  for (const row of rows) {
    const needsUpdate =
      !row.IMAGE_URL ||
      !row.TITLE ||
      !row.MEME_TYPE ||
      !row.MBTI_TYPES ||
      !row.KEYWORDS ||
      !row.TAGS ||
      row.TITLE === row.ID;

    if (!needsUpdate) continue;

    const pageUrl = row.URLS || `https://imgflip.com/i/${row.ID}`;
    console.log(`Fetching ${pageUrl}`);

    const html = await fetchPageHtml(pageUrl);
    if (!html) continue;

    const pageData = extractDataFromPage(html);

    // Fill missing or placeholder values
    row.TITLE = !row.TITLE || row.TITLE === row.ID ? pageData.TITLE : row.TITLE;
    row.MEME_TYPE = row.MEME_TYPE || pageData.MEME_TYPE;
    row.MBTI_TYPES = row.MBTI_TYPES || pageData.MBTI_TYPES;
    row.KEYWORDS = row.KEYWORDS || pageData.KEYWORDS;
    row.TAGS = row.TAGS || pageData.TAGS;
    row.KYM_SLUG = row.KYM_SLUG || pageData.KYM_SLUG;
    row.IS_GIF = row.IS_GIF || pageData.IS_GIF;

    // IMAGE_URL fallback from ID
    if (!row.IMAGE_URL && row.ID) {
      row.IMAGE_URL = `https://i.imgflip.com/${row.ID}.jpg`;
    }

    updatedCount++;
    await new Promise(r => setTimeout(r, 1500)); // polite rate limit
  }

  console.log(`Rows updated: ${updatedCount}`);
  return rows;
}

// Write updated CSV
async function writeUpdatedCsv() {
  try {
    const updatedRows = await fetchAndFillMissingData();
    const csvOutput = stringify(updatedRows, { header: true });
    await fs.writeFile(CSV_PATH, csvOutput, "utf-8");
    console.log(`CSV updated successfully! (${updatedRows.length} rows)`);
  } catch (err) {
    console.error("Update failed:", err);
    process.exit(1);
  }
}

// Run
writeUpdatedCsv();
