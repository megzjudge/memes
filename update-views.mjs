// update-views.mjs
import fs from "node:fs/promises";

const MEMES_FILE = "memes.csv";
const OUT_FILE = "meme_daily_updates.csv";

const CONCURRENCY = 2;          // keep low to avoid bot detection
const REQUEST_DELAY_MS = 250;   // pacing between requests
const RETRIES = 3;

const IMGFLIP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://imgflip.com/"
};

async function main() {
  const memesText = await fs.readFile(MEMES_FILE, "utf8");
  const memesRows = parseCsv(memesText, ",");

  if (!memesRows.length) {
    console.error(`No rows found in ${MEMES_FILE}.`);
    process.exit(1);
  }

  // Build the list of ids + urls from memes.csv
  const targets = memesRows
    .map(r => {
      const id = pick(r, ["id", "ID", "meme_id", "image_id"]);
      const urls = pick(r, ["urls", "url", "URL", "page_url"]);
      const idClean = String(id || "").trim();
      if (!idClean) return null;

      const urlClean =
        String(urls || "").trim() || `https://imgflip.com/i/${idClean}`;

      return { id: idClean, urls: urlClean };
    })
    .filter(Boolean);

  if (!targets.length) {
    console.error(`Could not find any usable ids in ${MEMES_FILE}.`);
    process.exit(1);
  }

  // Load prior daily updates so we can preserve views on failures
  const priorMap = await loadPriorViews(OUT_FILE);

  console.log(`Loaded ${targets.length} ids from ${MEMES_FILE}.`);
  console.log(`Loaded ${priorMap.size} prior view rows from ${OUT_FILE} (if present).`);

  const out = new Array(targets.length);

  let idx = 0;
  async function worker() {
    while (idx < targets.length) {
      const i = idx++;
      const t = targets[i];

      const prior = priorMap.get(t.id);
      const priorViews =
        prior && Number.isFinite(Number(prior.views)) ? Number(prior.views) : 0;

      const fetched = await fetchViewsWithRetry(t.id);
      const views =
        fetched.ok && Number.isFinite(fetched.views)
          ? fetched.views
          : priorViews;

      out[i] = { id: t.id, urls: t.urls, views };

      await sleep(REQUEST_DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const lines = [
    "id,urls,views",
    ...out
      .filter(Boolean)
      .map(r => `${csvCell(r.id)},${csvCell(r.urls)},${csvCell(String(r.views ?? 0))}`)
  ].join("\n") + "\n";

  await fs.writeFile(OUT_FILE, lines, "utf8");

  const changedCount = out.filter(r => {
    const p = priorMap.get(r.id);
    const pv = p ? Number(p.views) : 0;
    return Number(r.views) !== Number(pv);
  }).length;

  console.log(`Wrote ${out.length} rows to ${OUT_FILE}. Changed views for ${changedCount} ids.`);
}

function pick(row, keys) {
  for (const k of keys) {
    if (row && Object.prototype.hasOwnProperty.call(row, String(k).toLowerCase())) {
      return row[String(k).toLowerCase()];
    }
    // also try exact key if caller passed already-lowercased row keys
    if (row && Object.prototype.hasOwnProperty.call(row, k)) return row[k];
  }
  return "";
}

async function loadPriorViews(path) {
  try {
    const txt = await fs.readFile(path, "utf8");
    const rows = parseCsv(txt, ",");
    const map = new Map();
    for (const r of rows) {
      const id = String(pick(r, ["id", "meme_id", "image_id"])).trim();
      if (!id) continue;
      const views = Number(String(pick(r, ["views"])).trim());
      map.set(id, { id, views: Number.isFinite(views) ? views : 0 });
    }
    return map;
  } catch {
    return new Map();
  }
}

// -------------------- fetching + parsing --------------------

async function fetchViewsWithRetry(id) {
  const url = `https://imgflip.com/i/${id}`;

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: IMGFLIP_HEADERS
      });

      if (!res.ok) {
        if ((res.status === 429 || res.status === 503) && attempt < RETRIES) {
          await sleep(700 * attempt);
          continue;
        }
        return { ok: false };
      }

      const html = await res.text();

      // bot/captcha guard
      const head = html.slice(0, 5000).toLowerCase();
      if (head.includes("captcha") || head.includes("unusual traffic")) {
        return { ok: false };
      }

      const views = extractViews(html);
      if (Number.isFinite(views)) return { ok: true, views };

      // If parse fails, do not retry too aggressively; still retry a couple of times
      if (attempt < RETRIES) {
        await sleep(500 * attempt);
        continue;
      }

      return { ok: false };
    } catch {
      if (attempt < RETRIES) {
        await sleep(700 * attempt);
        continue;
      }
      return { ok: false };
    }
  }

  return { ok: false };
}

function extractViews(html) {
  // 1) Prefer __NEXT_DATA__ JSON
  const next = extractNextData(html);
  const image = extractImageFromNext(next);

  // Try common-ish view count keys
  if (image && typeof image === "object") {
    const candidates = [
      image.views,
      image.view_count,
      image.viewCount,
      image.ensighten_views
    ];
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
  }

  // 2) Conservative regex fallback: "12,345 views"
  const m = html.match(/([0-9][0-9,]*)\s+views/i);
  if (m && m[1]) {
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }

  return NaN;
}

function extractNextData(html) {
  const match = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractImageFromNext(next) {
  return (
    next?.props?.pageProps?.image ||
    next?.props?.pageProps?.data?.image ||
    next?.props?.pageProps?.props?.image ||
    null
  );
}

// -------------------- CSV utils --------------------

function parseCsv(text, delimiter = ",") {
  const lines = String(text)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0], delimiter).map((h, idx) => {
    let hh = String(h ?? "");
    if (idx === 0) hh = hh.replace(/^\uFEFF/, "");
    return hh.trim().toLowerCase();
  });

  const out = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i], delimiter);
    if (!cols.length) continue;

    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cols[j] !== undefined ? cols[j] : "";
    }
    out.push(row);
  }

  return out;
}

function splitCsvLine(line, delimiter = ",") {
  const s = String(line);
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (ch === '"') {
      const next = s[i + 1];
      if (inQuotes && next === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && ch === delimiter) {
      out.push(cur);
      cur = "";
      continue;
    }

    cur += ch;
  }

  out.push(cur);
  return out.map(x => x.trim());
}

function csvCell(s) {
  const v = String(s ?? "");
  // quote if it contains commas/quotes/newlines
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
