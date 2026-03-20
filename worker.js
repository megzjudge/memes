// worker.js

export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const cronId = event.cron;
    const startTime = new Date().toISOString();

    const log = (level, msg, data = {}) => {
      const prefix = `[${cronId}] ${startTime} [${level}]`;
      console.log(`${prefix} ${msg}`, data);
    };

    log("INFO", "Cron started");

    const user = env.IMGFLIP_USER;
    const pass = env.IMGFLIP_PASS;

    if (!user || !pass) {
      log("ERROR", "Missing credentials", {
        hasUser: !!user,
        hasPass: !!pass
      });
      return;
    }

    try {
      log("INFO", "1. Starting update-memes step (login + fetch page)");
      await runUpdateMemes(env, user, pass);

      log("INFO", "2. Starting update-fill step");
      await runUpdateFill(env);

      log("INFO", "3. Starting update-views step");
      await runUpdateViews(env);

      log("INFO", "All three steps completed successfully");
    } catch (err) {
      log("ERROR", "Scheduled task failed - full sequence aborted", {
        message: err.message,
        stack: err.stack,
        cron: cronId,
        timestamp: new Date().toISOString()
      });
    }
  }
};

// ======================
// Enhanced logging helper
// ======================
function log(level, msg, data = {}) {
  const timestamp = new Date().toISOString();
  const prefix = `[${level}] ${timestamp}`;
  console.log(`${prefix} ${msg}`, data);
}

// ======================
// Step 1: update-memes.mjs logic
// ======================
async function runUpdateMemes(env, user, pass) {
  try {
    log("INFO", "Fetching login page for CSRF");

    const loginPageRes = await fetch("https://imgflip.com/login", {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    log("DEBUG", "Login page response received", {
      status: loginPageRes.status,
      statusText: loginPageRes.statusText,
      headers: Object.fromEntries(loginPageRes.headers)
    });

    if (!loginPageRes.ok) {
      const text = await safeGetText(loginPageRes);
      throw new Error(`Login page fetch failed: ${loginPageRes.status} - ${text.slice(0, 500)}`);
    }

    const loginPageHtml = await loginPageRes.text();
    const csrfMatch = loginPageHtml.match(/name="csrf_token" value="([^"]+)"/);
    const csrf = csrfMatch ? csrfMatch[1] : null;

    if (!csrf) {
      throw new Error("CSRF token not found in login page HTML");
    }

    log("INFO", "CSRF token extracted successfully", { csrfPreview: csrf.substring(0, 15) + "..." });

    log("INFO", "Sending login POST");

    const loginRes = await fetch("https://imgflip.com/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0",
        "Cookie": loginPageRes.headers.get("set-cookie") || ""
      },
      body: new URLSearchParams({
        username: user,
        password: pass,
        csrf_token: csrf
      })
    });

    log("DEBUG", "Login POST response", {
      status: loginRes.status,
      redirected: loginRes.redirected,
      url: loginRes.url
    });

    if (!loginRes.ok) {
      const errorText = await safeGetText(loginRes);
      throw new Error(`Login POST failed: ${loginRes.status} - ${errorText.slice(0, 500)}`);
    }

    log("INFO", "Login successful - fetching latest memes page");

    const memesRes = await fetch("https://imgflip.com/all/user-images/mbtininja?sort=latest", {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!memesRes.ok) {
      throw new Error(`Memes page fetch failed: ${memesRes.status}`);
    }

    const html = await memesRes.text();
    log("INFO", "Memes page fetched", { length: html.length });

    // TODO: regex parsing
    const items = []; // parse html here
    log("INFO", "Parsed meme items", { count: items.length });

    // TODO: KV storage for next steps
    // await env.MEMES_KV.put("latest_meme_data", JSON.stringify(items));

    return items;
  } catch (err) {
    log("ERROR", "update-memes step failed", {
      message: err.message,
      stack: err.stack,
      step: "runUpdateMemes"
    });
    throw err; // re-throw so outer catch can log full sequence failure
  }
}

// ======================
// Step 2: update-fill.mjs
// ======================
async function runUpdateFill(env) {
  try {
    log("INFO", "Starting fill/discover step");

    // Example: read from previous step
    // const previous = await env.MEMES_KV.get("latest_meme_data");
    // ... process ...

    log("INFO", "Fill step complete");
  } catch (err) {
    log("ERROR", "update-fill step failed", {
      message: err.message,
      stack: err.stack,
      step: "runUpdateFill"
    });
    throw err;
  }
}

// ======================
// Step 3: update-views.mjs
// ======================
async function runUpdateViews(env) {
  try {
    log("INFO", "Starting views update step");

    // Example: read enriched data
    // const filled = await env.MEMES_KV.get("filled_data");
    // ... update views ...

    log("INFO", "Views update complete");
  } catch (err) {
    log("ERROR", "update-views step failed", {
      message: err.message,
      stack: err.stack,
      step: "runUpdateViews"
    });
    throw err;
  }
}

// ======================
// Safe text reader (prevents text() errors from crashing log)
// ======================
async function safeGetText(response) {
  try {
    return await response.text();
  } catch {
    return "Response body could not be read";
  }
}
