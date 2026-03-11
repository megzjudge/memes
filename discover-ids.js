const fs = require('fs').promises;

async function main() {
  const username = "mbtininja";
  const url = `https://imgflip.com/user-images/${encodeURIComponent(username)}?sort=latest`;

  console.log("Fetching:", url);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html",
      Referer: "https://imgflip.com/"
    }
  });

  if (!res.ok) {
    console.error(`Fetch failed: ${res.status}`);
    process.exit(1);
  }

  const html = await res.text();
  console.log("HTML length:", html.length);

  const ids = [];
  const re = /href="\/i\/([a-z0-9]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    ids.push(m[1]);
  }

  const uniqueIds = [...new Set(ids)];
  console.log("Found IDs:", uniqueIds);

  if (uniqueIds.length < 5) {
    console.warn("Too few IDs found - possible block");
    process.exit(0);
  }

  const payload = {
    username,
    fetched_at: new Date().toISOString(),
    source: url,
    ids: uniqueIds.slice(0, 14)  // top 14 newest
  };

  await fs.writeFile("latest_ids.json", JSON.stringify(payload, null, 2) + "\n");
  console.log("Wrote latest_ids.json");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
