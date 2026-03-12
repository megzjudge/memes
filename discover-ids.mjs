// discover-ids.mjs

import fs from "fs/promises";
import path from "path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

// Path to your CSV
const CSV_PATH = path.resolve("./memes.csv");

// Simple function to fetch a page
async function fetchPageHtml(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
    return await res.text();
  } catch (err) {
    console.error(`Error fetching ${url}`, err);
    return null;
  }
}

// Extract meme data from HTML / page content
function extractDataFromPage(html) {
  if (!html) return {};

  return {
    TITLE: html.match(/<title>(.*?)<\/title>/i)?.[1].replace(" - Imgflip", "").trim() || "",
    MEME_TYPE: html.match(/"memeType":"(.*?)"/)?.[1] || "",
    KYM_SLUG: html.match(/"kymSlug":"(.*?)"/)?.[1] || "",
    MBTI_TYPES: html.match(/"mbtiTypes":"(.*?)"/)?.[1] || "",
    IS_GIF: html.includes(".gif") ? "true" : "false",
  };
}

// Main logic
async function fetchAndFillMissingData() {
  const fileContent = await fs.readFile(CSV_PATH, "utf-8");
  const rows = parse(fileContent, { columns: true, skip_empty_lines: true });

  for (const row of rows) {
    const needsData =
      !row.MEME_TYPE ||
      !row.TITLE ||
      !row.MBTI_TYPES ||
      !row.KYM_SLUG ||
      row.IS_GIF === "";

    if (!needsData) continue;

    const pageUrl = row.URLS || `https://imgflip.com/i/${row.ID}`;
    console.log(`Fetching ${pageUrl}`);

    const html = await fetchPageHtml(pageUrl);
    const pageData = extractDataFromPage(html);

    row.MEME_TYPE = row.MEME_TYPE || pageData.MEME_TYPE;
    row.MBTI_TYPES = row.MBTI_TYPES || pageData.MBTI_TYPES;
    row.KYM_SLUG = row.KYM_SLUG || pageData.KYM_SLUG;
    row.IS_GIF = row.IS_GIF || pageData.IS_GIF;
    row.TITLE = row.TITLE || pageData.TITLE;

    // Polite rate limit
    await new Promise(r => setTimeout(r, 1500));
  }

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
