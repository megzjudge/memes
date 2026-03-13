const fs = require("fs");
const Papa = require("papaparse");
const fetch = require("node-fetch");
const git = require("simple-git")();

const CSV_FILE = "memes.csv";
const MAX_ROWS_PER_RUN = 100; // Define how many rows to process per run
const GITHUB_REPO_URL = "https://github.com/megzjudge/memes";

// Helper function to log changes
const logRowChanges = (row) => {
  console.log(`Row ${row.ID} needs an update:`, row);
};

// Read the CSV file and parse it into rows
const parseCSV = () => {
  const fileContent = fs.readFileSync(CSV_FILE, "utf8");
  return Papa.parse(fileContent, { header: true }).data;
};

// Fetch data for a meme from the given URL
const fetchMemeData = async (url) => {
  const response = await fetch(url);
  const html = await response.text();

  // Extract tags from the page (you can customize this part depending on the structure of the page)
  const matches = html.match(/<meta name="keywords" content="([^"]+)"/);
  const tags = matches ? matches[1].split(",") : [];
  
  return tags;
};

// Process rows from CSV and check for updates
const processMemeData = async (rows) => {
  let processed = 0;

  for (const row of rows.slice(0, MAX_ROWS_PER_RUN)) {
    if (processed >= MAX_ROWS_PER_RUN) break;

    // Check the 'needsUpdate' condition for each row
    const needsUpdate =
      !row.IMAGE_URL ||
      !row.TITLE ||
      row.TITLE === row.ID ||
      !row.MEME_TYPE ||
      !row.KEYWORDS ||
      !row.TAGS ||
      !row.URLS;

    // Debug: Log the row and whether it needs an update
    if (needsUpdate) {
      logRowChanges(row); // Log why it needs an update
    } else {
      console.log(`Row ${row.ID} does not need an update.`);
    }

    if (needsUpdate) continue;  // Skip rows that don't need an update

    // Fetch the meme data (tags)
    const tags = await fetchMemeData(row.URLS);

    // Update the row with new tags
    row.TAGS = JSON.stringify(tags);

    processed++;
  }

  return rows;
};

// Save updated data back to CSV file
const saveCSV = (rows) => {
  const newCsv = Papa.unparse(rows);

  // Log the new CSV content to compare
  console.log("New CSV content (first 200 chars):", newCsv.slice(0, 200));

  const originalCsv = fs.readFileSync(CSV_FILE, "utf8");

  // Only save if there are changes
  if (originalCsv !== newCsv) {
    fs.writeFileSync(CSV_FILE, newCsv, "utf8");
    console.log("Changes detected. Updating CSV.");
    git.add(CSV_FILE).commit("Auto-update memes.csv with latest meme data").push();
  } else {
    console.log("No new meme data discovered.");
  }
};

// Main function to discover and update memes
const discoverMemes = async () => {
  // Read the CSV
  const rows = parseCSV();

  // Process meme data
  const updatedRows = await processMemeData(rows);

  // Save updated data back to CSV if there are changes
  saveCSV(updatedRows);
};

// Run the discovery process
discoverMemes().catch(console.error);
