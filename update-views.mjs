import fs from "node:fs/promises";

const STATIC_FILE = "memes.csv";
const OUT_FILE = "meme_daily_updates.csv";

const UPDATE_NEWEST_N = 500;   // set to Infinity to do all
const CONCURRENCY = 2;
const REQUEST_DELAY_MS = 175;

const IMGFLIP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://imgflip.com/"
};

async function main() {
  const staticItems = await readJsonLines(STATIC_FILE);
  const ids = staticItems.map(x => String(x?.id || "").trim()).filter(Boolean);

  if (!ids.length) {
    console.log("No ids found in memes.csv; nothing to update.");
    return;
  }

  const prior = await readJsonLines(OUT_FILE);
  const priorMap = new Map(
    prior.filter(x => x && x.id).map(x => [String(x.id).trim(), x])
  );

  const targetIds = (UPDATE_NEWEST_N === Infinity) ? ids : ids.slice(0, UPDATE_NEWEST_N);

  console.log(`Updating views for ${targetIds.length} meme(s)...`);

  const outMap = new Map(priorMap);
  let idx = 0;

  async function worker() {
    while (idx < targetIds.length) {
      const my = idx++;
      const id = targetIds[my];
      const page_url = `https://imgflip.com/i/${id}`;

      const priorRow = outMap.get(id) || { id, page_url, views: 0 };
      const views = await fetchViews(id);

      if (Number.isFinite(views)) {
        outMap.set(id, { id, page_url, views });
      } else {
        outMap.set(id, {
          id,
          page_url,
          views: Number.isFinite(Number(priorRow.views)) ? Number(priorRow.views) : 0
        });
      }

      await sleep(REQUEST_DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // output in memes.csv order (newest first)
  const finalRows = ids.map(id => {
    const row = outMap.get(id) || { id, page_url: `https://imgflip.com/i/${id}`, views: 0 };
    return {
      id,
      page_url: row.page_url || `https://imgflip.com/i/${id}`,
      views: Number.isFinite(Number(row.views)) ? Number(row.views) : 0
    };
  });

  const tmp = `${OUT_FILE}.tmp`;
  await writeJsonLines(tmp, finalRows);
  await fs.rename(tmp, OUT_FILE);

  console.log(`Wrote ${finalRows.length} rows to ${OUT_FILE}`);
}

async function fetchViews(id) {
  const url = `https://imgflip.com/i/${id}`;
  const html = await fetchText(url);
  if (!html) return NaN;

  const next = extractNextData(html);
  const image = extractImageFromNext(next);

  if (image) {
    const v = coerceViews(image);
    if (Number.isFinite(v)) return v;
  }

  const m = html.match(/([0-9][0-9,]*)\s+views/i);
  if (m && m[1]) {
    const v = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(v)) return v;
  }

  return NaN;
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { headers: IMGFLIP_HEADERS });
    if (!res.ok) return "";
    const text = await res.text();
    const head = text.slice(0, 4000).toLowerCase();
    if (head.includes("captcha") || head.includes("unusual traffic")) return "";
    return text;
  } catch {
    return "";
  }
}

function extractNextData(html) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function extractImageFromNext(next) {
  const img =
    next?.props?.pageProps?.image ||
    next?.props?.pageProps?.data?.image ||
    next?.props?.pageProps?.props?.image ||
    null;
  return img && typeof img === "object" ? img : null;
}

function coerceViews(imageObj) {
  const candidates = [
    imageObj.views,
    imageObj.ensighten_views,
    imageObj.view_count,
    imageObj.viewCount
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

// JSONL helpers
async function readJsonLines(path) {
  try {
    const raw = await fs.readFile(path, "utf8");
    return raw
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => safeParseJsonLine(l))
      .filter(Boolean);
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
}

function safeParseJsonLine(line) {
  const normalized = line
    .replace(/\t+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/\bTRUE\b/g, "true")
    .replace(/\bFALSE\b/g, "false")
    .replace(/,\s*$/, "");
  try { return JSON.parse(normalized); } catch { return null; }
}

async function writeJsonLines(path, items) {
  const lines = items.map(x => JSON.stringify(x));
  await fs.writeFile(path, lines.join("\n") + "\n", "utf8");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
  console.error(err);
  process.exit(1);
});
