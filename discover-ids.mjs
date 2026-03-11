import fs from 'fs/promises';

async function fetchWithRetry(url, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`Attempt ${attempt}/${maxRetries} fetching: ${url}`);

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "Referer": "https://imgflip.com/",
          "Connection": "keep-alive",
          "Upgrade-Insecure-Requests": "1",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-origin"
        }
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} - ${res.statusText}`);
      }

      const text = await res.text();
      console.log("HTML length:", text.length);
      console.log("First 500 chars:", text.slice(0, 500));

      const lower = text.toLowerCase();
      if (lower.includes("just a moment") || lower.includes("cf-challenge") || lower.includes("captcha") || lower.includes("attention required")) {
        console.warn("Cloudflare/Imgflip challenge detected on attempt " + attempt);
        await new Promise(r => setTimeout(r, 5000)); // 5s wait before retry
        continue;
      }

      return text;
    } catch (err) {
      console.error(`Fetch error on attempt ${attempt}: ${err.message}`);
      await new Promise(r => setTimeout(r, 3000)); // 3s wait before next try
    }
  }

  throw new Error("All retries failed - likely blocked by Imgflip/Cloudflare");
}

async function main() {
  const username = "mbtininja";
  const url = `https://imgflip.com/user-images/${encodeURIComponent(username)}?sort=latest`;

  let html;
  try {
    html = await fetchWithRetry(url);
  } catch (err) {
    console.error("Final fetch failed:", err.message);
    process.exit(1);
  }

  const ids = [];
  const re = /href="\/i\/([a-z0-9]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    ids.push(m[1]);
  }

  const uniqueIds = [...new Set(ids)];
  console.log("Raw IDs found:", ids.length);
  console.log("Unique IDs:", uniqueIds);

  if (uniqueIds.length < 5) {
    console.warn("Too few IDs found - possible block or page structure changed");
    process.exit(0);
  }

  const payload = {
    username,
    fetched_at: new Date().toISOString(),
    source: url,
    ids: uniqueIds.slice(0, 14) // top 14 newest
  };

  await fs.writeFile("latest_ids.json", JSON.stringify(payload, null, 2) + "\n");
  console.log("Successfully wrote latest_ids.json with", payload.ids.length, "IDs");
}

main().catch(err => {
  console.error("Script failed:", err.message);
  process.exit(1);
});
