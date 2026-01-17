/**
 * worker.js (Cloudflare Workers)
 *
 * Discovers latest Imgflip post IDs for a username and writes them to GitHub as JSON.
 *
 * Required secrets:
 * - IMGFLIP_USERNAME
 * - GITHUB_TOKEN
 * - GITHUB_OWNER
 * - GITHUB_REPO
 * - GITHUB_BRANCH
 * - GITHUB_PATH              (e.g. "latest_ids.json")
 *
 * Optional:
 * - TOP_N                    (default "14")
 * - IMGFLIP_TIMEOUT_MS       (default "15000")
 * - RUN_TOKEN                (if you want to protect the HTTP endpoint)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Optional: protect manual run
    if (env.RUN_TOKEN) {
      const token = url.searchParams.get("token") || "";
      if (token !== env.RUN_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    if (url.pathname === "/" || url.pathname === "/run") {
      const result = await runDiscoveryAndWrite(env);
      return json(result, result.ok ? 200 : 500);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDiscoveryAndWrite(env));
  },
};

function must(env, key) {
  const v = env[key];
  if (!v || !String(v).trim()) throw new Error(`Missing required env var: ${key}`);
  return String(v).trim();
}

function toInt(v, fallback) {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function runDiscoveryAndWrite(env) {
  try {
    const IMGFLIP_USERNAME = must(env, "IMGFLIP_USERNAME");

    const GITHUB_TOKEN = must(env, "GITHUB_TOKEN");
    const GITHUB_OWNER = must(env, "GITHUB_OWNER");
    const GITHUB_REPO = must(env, "GITHUB_REPO");
    const GITHUB_BRANCH = must(env, "GITHUB_BRANCH");
    const GITHUB_PATH = must(env, "GITHUB_PATH");

    const TOP_N = toInt(env.TOP_N, 14);
    const TIMEOUT_MS = toInt(env.IMGFLIP_TIMEOUT_MS, 15000);

    const ids = await discoverImgflipIds({ username: IMGFLIP_USERNAME, topN: TOP_N, timeoutMs: TIMEOUT_MS });

    if (ids.length < TOP_N) {
      throw new Error(`Discovery returned ${ids.length} IDs (need ${TOP_N}).`);
    }

    const payload = {
      username: IMGFLIP_USERNAME,
      top_n: TOP_N,
      ids,
      fetched_at: new Date().toISOString(),
      source: "imgflip",
    };

    const write = await upsertGithubFile({
      token: GITHUB_TOKEN,
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      branch: GITHUB_BRANCH,
      path: GITHUB_PATH,
      contentText: JSON.stringify(payload, null, 2) + "\n",
      message: `Update ${GITHUB_PATH} (${IMGFLIP_USERNAME})`,
    });

    return {
      ok: true,
      discovered: ids.length,
      top_n: TOP_N,
      github: {
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        branch: GITHUB_BRANCH,
        path: GITHUB_PATH,
        committed: write.committed,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: e?.message || String(e),
    };
  }
}

/**
 * Imgflip discovery
 *
 * Prefer HTML list page -> parse /i/<id> links
 * (In Workers, Imgflip often allows this more than GitHub Actions runners do.)
 *
 * If you later find a stable JSON endpoint, swap this function accordingly.
 */
async function discoverImgflipIds({ username, topN, timeoutMs }) {
  const listUrl = `https://imgflip.com/all/user-images/${encodeURIComponent(username)}?sort=latest`;

  const html = await fetchWithTimeout(listUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://imgflip.com/",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  }, timeoutMs);

  const text = await html.text();

  // Basic block detection
  const lower = text.slice(0, 8000).toLowerCase();
  if (
    lower.includes("checking your browser") ||
    lower.includes("just a moment") ||
    lower.includes("cf-challenge") ||
    lower.includes("attention required") ||
    lower.includes("cloudflare") ||
    lower.includes("captcha")
  ) {
    throw new Error("Imgflip appears blocked (bot protection/captcha).");
  }

  const ids = [];
  const re = /href="\/i\/([a-z0-9]+)"/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    ids.push(m[1]);
  }

  // de-dupe preserve order
  const seen = new Set();
  const uniq = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      uniq.push(id);
    }
    if (uniq.length >= topN) break;
  }

  return uniq;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort("timeout"), timeoutMs);
  try {
    const res = await fetch(url, { ...(init || {}), signal: ac.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`Fetch failed: ${url} status=${res.status}`);
    return res;
  } finally {
    clearTimeout(t);
  }
}

/**
 * GitHub Contents API upsert:
 * - GET existing file to retrieve sha (if exists)
 * - PUT content (create or update)
 */
async function upsertGithubFile({ token, owner, repo, branch, path, contentText, message }) {
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`;

  const headers = {
    Authorization: `token ${token}`,
    "User-Agent": "cf-worker-memes-discovery",
    Accept: "application/vnd.github+json",
  };

  // 1) Check if file exists (get sha)
  let sha = null;
  const getUrl = `${apiBase}?ref=${encodeURIComponent(branch)}`;
  const getRes = await fetch(getUrl, { headers, method: "GET" });

  if (getRes.status === 200) {
    const j = await getRes.json();
    if (j && j.sha) sha = j.sha;
  } else if (getRes.status === 404) {
    sha = null; // create
  } else {
    const txt = await getRes.text().catch(() => "");
    throw new Error(`GitHub GET contents failed. status=${getRes.status} body=${txt.slice(0, 300)}`);
  }

  // 2) PUT update/create
  const body = {
    message,
    content: toBase64(contentText),
    branch,
    ...(sha ? { sha } : {}),
  };

  const putRes = await fetch(apiBase, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!(putRes.status >= 200 && putRes.status < 300)) {
    const txt = await putRes.text().catch(() => "");
    throw new Error(`GitHub PUT contents failed. status=${putRes.status} body=${txt.slice(0, 300)}`);
  }

  return { committed: true };
}

// Cloudflare Workers supports btoa for ASCII; ensure UTF-8 safe base64
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // btoa expects binary string
  return btoa(bin);
}
