// discover-ids.mjs

import { fetchTextOrThrow, parseCsv, parseJsonArrayCell } from './utils.mjs';  // Assuming these utils exist in your project
import { extractDataFromPage } from './script.mjs';  // Assuming extractDataFromPage is your scraping function

const STATIC_FILE = "/memes.csv";  // Path to your CSV file
const IMGFLIP_PROFILE_URL = "https://imgflip.com/user/mbtininja";  // Example Imgflip profile URL

// Fetch the static CSV file, process it, and update missing fields by scraping data from Imgflip pages
async function fetchAndFillMissingData() {
  const staticText = await fetchTextOrThrow(STATIC_FILE);  // Fetch CSV content
  const staticRows = parseCsv(staticText, ",");  // Parse CSV into rows

  // Loop through the rows and check for missing fields (meme_type, title, etc.)
  for (let row of staticRows) {
    // If any required field is missing, attempt to extract data from the Imgflip page
    if (!row.meme_type || !row.title || !row.mbti_types || !row.kym_slug || row.is_gif === undefined) {
      const pageUrl = row.urls || row.url || `https://imgflip.com/i/${row.id}`;  // If no URL, fallback to Imgflip URL

      // Fetch the HTML content of the Imgflip page
      const pageHtml = await fetchPageHtml(pageUrl);

      // Extract necessary fields from the page
      const pageData = await extractDataFromPage(pageHtml);

      // Update missing fields in the row with the extracted data
      row.meme_type = row.meme_type || pageData.memeType;
      row.mbti_types = row.mbti_types || pageData.mbtiTypes;
      row.kym_slug = row.kym_slug || pageData.kymSlug;
      row.is_gif = row.is_gif !== undefined ? row.is_gif : pageData.isGif;
      row.title = row.title || pageData.title;
    }
  }

  // Return updated rows after filling missing data
  return staticRows;
}

// Function to fetch the HTML content of an Imgflip page
async function fetchPageHtml(url) {
  const res = await fetch(url);
  const html = await res.text();
  return html;
}

// Write the updated rows to CSV or process them further
async function writeUpdatedData() {
  const updatedRows = await fetchAndFillMissingData();

  // You can write the updatedRows back to a new CSV file or process as needed
  console.log(updatedRows);  // For debugging purposes, logging the updated rows
}

// Run the update process
writeUpdatedData().catch(err => console.error("Error updating data:", err));
