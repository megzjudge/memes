// discover-ids.mjs

// Importing utility functions and scraping helper functions
import { fetchTextOrThrow, parseCsv, parseJsonArrayCell } from './utils.mjs';  // Assuming these utils exist in your project
import { extractDataFromPage } from './script.mjs';  // Assuming extractDataFromPage is your scraping function

const STATIC_FILE = "/memes.csv";  // Path to your CSV file (make sure the file is in the correct path)
const IMGFLIP_PROFILE_URL = "https://imgflip.com/user/mbtininja";  // Example Imgflip profile URL

// Fetch the static CSV file, process it, and update missing fields by scraping data from Imgflip pages
async function fetchAndFillMissingData() {
  // Fetch the CSV file
  const staticText = await fetchTextOrThrow(STATIC_FILE);  // Assuming `fetchTextOrThrow` is defined in utils.mjs
  const staticRows = parseCsv(staticText, ",");  // Assuming `parseCsv` is defined in utils.mjs

  // Loop through the rows and check for missing fields (meme_type, title, etc.)
  for (let row of staticRows) {
    // Check if any required fields are missing
    if (!row.meme_type || !row.title || !row.mbti_types || !row.kym_slug || row.is_gif === undefined) {
      // Construct the Imgflip page URL if not provided
      const pageUrl = row.urls || row.url || `https://imgflip.com/i/${row.id}`;

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

  // Return the updated rows after filling in the missing data
  return staticRows;
}

// Function to fetch the HTML content of an Imgflip page
async function fetchPageHtml(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch page: ${url}`);
    }
    const html = await res.text();
    return html;
  } catch (err) {
    console.error(`Error fetching HTML for ${url}:`, err);
    throw err; // Rethrow the error after logging
  }
}

// Write the updated rows to CSV or process them further
async function writeUpdatedData() {
  try {
    const updatedRows = await fetchAndFillMissingData();

    // You can write the updatedRows back to a new CSV file or process as needed
    console.log(updatedRows);  // For debugging purposes, logging the updated rows
  } catch (err) {
    console.error("Error updating data:", err);
  }
}

// Run the update process
writeUpdatedData();
