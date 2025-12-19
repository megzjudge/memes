console.log("JS BOOT: file loaded", new Date().toISOString());

const STATIC_FILE = "/memes.csv";               // JSONL (one JSON object per line)
const DAILY_FILE  = "/meme_daily_updates.csv";  // CSV: id,page_url,views

async function fetchFeed() {
  const [staticText, dailyText] = await Promise.all([
    fetchTextOrThrow(STATIC_FILE),
    fetchTextOrThrow(DAILY_FILE)
  ]);

  const staticItems = parseJsonLines(staticText);
  const dailyRows = parseCsv(dailyText, ",");

  const dailyMap = new Map();
  for (const r of dailyRows) {
    const id = String(r.id || "").trim();
    if (!id) continue;
    dailyMap.set(id, r);
  }

  const merged = staticItems.map(s => {
    const id = String(s?.id || "").trim();
    const d = dailyMap.get(id);

    const views = d && d.views !== undefined && d.views !== null
      ? Number(String(d.views).trim())
      : 0;

    return {
      ...s,
      views: Number.isFinite(views) ? views : 0
    };
  });

  console.log(`Loaded ${merged.length} items (static=${staticItems.length}, daily=${dailyRows.length})`);
  return merged;
}

async function fetchTextOrThrow(path) {
  const res = await fetch(path, { headers: { accept: "text/plain" } });
  const ct = res.headers.get("content-type") || "";
  console.log("Fetch", path, "->", res.status, ct);
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return res.text();
}

// memes.csv = JSONL
function parseJsonLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

// meme_daily_updates.csv = CSV
function parseCsv(text, delimiter = ",") {
  const lines = String(text)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0], delimiter).map(h => h.trim().toLowerCase());
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

// Minimal CSV splitter (supports quoted fields)
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
