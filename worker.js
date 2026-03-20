// worker.js

export default {
  async fetch(request, env) {
    return new Response("This is the meme scraper Worker. Cron jobs run automatically.", {
      headers: { "Content-Type": "text/plain" }
    });
  },

  async scheduled(event, env, ctx) {
    const log = (msg) => console.log(`[${event.cron}] ${new Date().toISOString()} - ${msg}`);

    log("Cron started");

    const user = env.IMGFLIP_USER;
    const pass = env.IMGFLIP_PASS;

    if (!user || !pass) {
      log("ERROR: Missing IMGFLIP_USER or IMGFLIP_PASS secrets");
      return;
    }

    try {
      log("Logging in to Imgflip...");

      // Basic login flow (adapt from your old code)
      const loginRes = await fetch("https://imgflip.com/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0"
        },
        body: new URLSearchParams({
          username: user,
          password: pass
          // Add csrf_token if needed — fetch login page first to get it
        })
      });

      if (!loginRes.ok) throw new Error(`Login failed: ${loginRes.status}`);

      log("Login success - fetching latest memes...");

      // Fetch your target page
      const memesRes = await fetch("https://imgflip.com/all/user-images/mbtininja?sort=latest", {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      const html = await memesRes.text();

      // Your regex parsing here (adapt fetchLatestMemeItems)
      const items = []; // parse html for IDs/images

      log(`Found ${items.length} meme items`);

      // TODO: Compare to existing in KV, append new ones, put updated CSV
      // await env.MEMES_KV.put('memes.csv', updatedCsv);

      log("Update complete");
    } catch (err) {
      log(`ERROR: ${err.message || err}`);
    }
  }
};
