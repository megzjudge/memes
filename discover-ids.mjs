// discover-ids.mjs

import fs from "fs/promises";

const STATIC_FILE = "./memes.csv";
const OUTPUT_FILE = "./latest_ids.json";

// Simple CSV parser
function parseCsv(text) {
  const lines = text.trim().split("\n");
  const headers = lines.shift().split(",");

  return lines.map(line => {
    const values = line.split(",");
    const obj = {};
    headers.forEach((h, i) => {
      obj[h.trim()] = values[i] ? values[i].trim() : "";
    });
    return obj;
  });
}

// Fetch HTML from a page
async function fetchPageHtml(url) {
  try {
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Failed to fetch ${url} (${res.status})`);
    }

    return await res.text();
  } catch (err) {
    console.error(`Error fetching ${url}`, err);
    return null;
  }
}

// Basic page extraction (lightweight fallback)
function extractDataFromPage(html) {
  if (!html) return {};

  const titleMatch = html.match(/<title>(.*?)<\/title>/i);

  return {
    title: titleMatch ? titleMatch[1].replace(" - Imgflip", "").trim() : "",
    memeType: "",
    mbtiTypes: "",
    kymSlug: "",
    isGif: html.includes(".gif")
  };
}

// Main logic
async function fetchAndFillMissingData() {
  const staticText = await fs.readFile(STATIC_FILE, "utf8");
  const rows = parseCsv(staticText);

  for (const row of rows) {

    const needsData =
      !row.meme_type ||
      !row.title ||
      !row.mbti_types ||
      !row.kym_slug ||
      row.is_gif === "";

    if (!needsData) continue;

    const pageUrl =
      row.urls ||
      row.url ||
      `https://imgflip.com/i/${row.id}`;

    console.log(`Fetching ${pageUrl}`);

    const html = await fetchPageHtml(pageUrl);
    const pageData = extractDataFromPage(html);

    row.meme_type = row.meme_type || pageData.memeType;
    row.mbti_types = row.mbti_types || pageData.mbtiTypes;
    row.kym_slug = row.kym_slug || pageData.kymSlug;
    row.is_gif = row.is_gif || pageData.isGif;
    row.title = row.title || pageData.title;

    await new Promise(r => setTimeout(r, 1500)); // polite rate limit
  }

  return rows;
}

// Write results
async function writeUpdatedData() {
  try {
    const updatedRows = await fetchAndFillMissingData();

    await fs.writeFile(
      OUTPUT_FILE,
      JSON.stringify(updatedRows, null, 2)
    );

    console.log(`Saved ${updatedRows.length} rows to ${OUTPUT_FILE}`);
  } catch (err) {
    console.error("Update failed:", err);
    process.exit(1);
  }
}

// Run
writeUpdatedData();
