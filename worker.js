/**
 * Cloudflare Worker: discover latest Imgflip IDs and write to GitHub as latest_ids.json
 *
 * Env vars required (Wrangler secrets recommended):
 * - IMGFLIP_USERNAME         (e.g. "mbtininja")
 * - GITHUB_TOKEN             (repo contents write)
 * - GITHUB_OWNER             (e.g. "megzjudge")
 * - GITHUB_REPO              (e.g. "memes")
 * - GITHUB_BRANCH            (e.g. "main")
 * - GITHUB_PATH              (e.g. "latest_ids.json")
 *
 * Optional:
 * - TOP_N                    (default 14)
 * - IMGFLIP_TIMEOUT_MS       (default 15000)
 */

const DEFAULT_TOP_N = 14;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDiscoveryAndWrite(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Basic health check
    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    // Optional manual trigger: /run?token=...
    // You can lock it down with an env secret RUN_TOKEN if you want.
    if (url.pathname === "/run") {
      const required = env.RUN_TOKEN ? String(env.RUN_TOKEN) : "";
      const provided = url.searchParams.get("token") || "";
      if (required && provided !== required) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      const result = await runDiscoveryAndWrite(env);
      return json({ ok: true, result });
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};

async function runDiscoveryAndWrite(env) {
  const TOP_N = toInt(env.TOP_N, DEFAULT_TOP_N);
  const username = must(env.IMGFLIP_USERNAME, "IMGFLIP_USERNAME");

  const ids = await discoverLatestIds({ username, TOP_N, env });
  if (ids.length < TOP_N) {
    // Hard fail: you said "REQUIRE discovery".
    // If you prefer "do not fail", change this to return with ok:false and do not write.
    throw new Error(`Discovery failed: got ${ids.length} IDs, need ${TOP_N}`);
  }

  const payload = {
    username,
    generated_at: new Date().toISOString(),
    ids: ids.slice(0, TOP_N),
    top_n: TOP_N,
    source: "cloudflare-worker",
  };

  const owner = must(env.GITHUB_OWNER, "GITHUB_OWNER");
  const repo = must(env.GITHUB_REPO, "GITHUB_REPO");
  const branch = must(env.GITHUB_BRANCH, "GITHUB_BRANCH");
  const path = must(env.GITHUB_PATH, "GITHUB_PATH");
  const token = must(env.GITHUB_TOKEN, "GITHUB_TOKEN");

  const res = await githubUpsertFile({
    owner,
    repo,
    branch,
    path,
    token,
    contentText: JSON.stringify(payload, null, 2) + "\n",
    commitMessage: `Update ${path} (discovery)`,
  });

  return { ids: payload.ids, github: res };
}

/**
 * DISCOVERY
 * Strategy order:
 *  A) Try a few JSON/ajax endpoints (GET/POST variations).
 *  B) If JSON fails, fall back to HTML pages and regex /i/<id>.
 */
async function discoverLatestIds({ username, TOP_N, env }) {
  const timeoutMs = toInt(env.IMGFLIP_TIMEOUT_MS, 15000);

  // A) JSON/AJAX attempts (best-effort; Imgflip may change these)
  const ajaxCandidates = [
    // Your original guess (often 404 in GH runner, but may work from CF)
    {
      label: "ajax_get_user_images GET",
      url: `https://imgflip.com/ajax_get_user_images?username=${encodeURIComponent(
        username
      )}&sort=latest&page=1`,
      method: "GET",
      headers: { Accept: "application/json,text/plain,*/*" },
    },
    // Some sites require POST for ajax endpoints
    {
      label: "ajax_get_user_images POST form",
      url: `https://imgflip.com/ajax_get_user_images`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json,text/plain,*/*",
      },
      body: new URLSearchParams({
        username,
        sort: "latest",
        page: "1",
      }).toString(),
    },
  ];

  for (const c of ajaxCandidates) {
    const out = await fetchWithTimeout(c.url, {
      method: c.method,
      headers: {
        "User-Agent": ua(),
        "Accept-Language": "en-AU,en;q=0.9,en-US;q=0.8",
        Referer: "https://imgflip.com/",
        ...c.headers,
      },
      body: c.body,
    }, timeoutMs);

    if (!out.ok) continue;

    const text = await out.text();
    const ids = extractIdsFromJsonOrText(text);

    if (ids.length >= TOP_N) return ids.slice(0, TOP_N);
  }

  // B) HTML fallbacks
  const htmlCandidates = [
    `https://imgflip.com/m/fun/user-images/${encodeURIComponent(username)}?page=1`,
    `https://imgflip.com/all/user-images/${encodeURIComponent(username)}?sort=latest`,
    `https://imgflip.com/user/${encodeURIComponent(username)}`,
  ];

  for (const url of htmlCandidates) {
    const out = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": ua(),
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-AU,en;q=0.9,en-US;q=0.8",
          Referer: "https://imgflip.com/",
        },
      },
      timeoutMs
    );

    if (!out.ok) continue;
    const html = await out.text();
    if (looksBlocked(html)) continue;

    const ids = extractIdsFromHtml(html);
    if (ids.length >= TOP_N) return ids.slice(0, TOP_N);
  }

  return [];
}

function extractIdsFromJsonOrText(text) {
  // Robust: parse JSON if possible; otherwise regex the raw text for /i/<id>
  let ids = [];

  try {
    const j = JSON.parse(text);
    const s = JSON.stringify(j);
    ids = ids.concat(regexIdsFromString(s));
  } catch {
    ids = ids.concat(regexIdsFromString(text));
  }

  return uniq(ids);
}

function extractIdsFromHtml(html) {
  return uniq(regexIdsFromString(html));
}

function regexIdsFromString(s) {
  const ids = [];
  const re = /\/i\/([a-z0-9]{4,12})/gi;
  let m;
  while ((m = re.exec(String(s))) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

function looksBlocked(html) {
  const h = String(html || "").toLowerCase();
  return (
    h.includes("checking your browser") ||
    h.includes("just a moment") ||
    h.includes("cloudflare") ||
    h.includes("cf-challenge") ||
    h.includes("attention required") ||
    h.includes("captcha") ||
    h.includes("unusual traffic")
  );
}

/**
 * GITHUB: upsert file via Contents API
 */
async function githubUpsertFile({
  owner,
  repo,
  branch,
  path,
  token,
  contentText,
  commitMessage,
}) {
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
    path
  )}`;

  // 1) Get SHA if file exists
  let sha = null;
  {
    const getUrl = `${apiBase}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(getUrl, {
      headers: githubHeaders(token),
    });

    if (res.status === 200) {
      const j = await res.json();
      sha = j && j.sha ? String(j.sha) : null;
    } else if (res.status === 404) {
      sha = null;
    } else {
      const t = await safeText(res);
      throw new Error(`GitHub GET failed (${res.status}): ${t}`);
    }
  }

  // 2) PUT new content
  const body = {
    message: commitMessage,
    content: base64Encode(contentText),
    branch,
  };
  if (sha) body.sha = sha;

  const putRes = await fetch(apiBase, {
    method: "PUT",
    headers: {
      ...githubHeaders(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!putRes.ok) {
    const t = await safeText(putRes);
    throw new Error(`GitHub PUT failed (${putRes.status}): ${t}`);
  }

  const out = await putRes.json();
  return {
    committed: true,
    path,
    branch,
    commit_sha: out?.commit?.sha || null,
    content_sha: out?.content?.sha || null,
  };
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": "cf-worker-memes-discovery",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Utilities
 */
function must(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`Missing required env var: ${name}`);
  return s;
}

function toInt(v, fallback) {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function uniq(arr) {
  return [...new Set((arr || []).map((x) => String(x).trim()).filter(Boolean))];
}

function ua() {
  // Keep it boring and consistent
  return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return new Response("", { status: 0 });
  } finally {
    clearTimeout(id);
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function base64Encode(str) {
  // Cloudflare Workers: btoa handles Latin1; TextEncoder->binary->btoa for UTF-8
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
