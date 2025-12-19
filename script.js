
// ------------ Imgflip icons (top of page) ------------

const IMGFLIP_PROFILE_URL = "https://imgflip.com/user/mbtininja";

const IMGFLIP_ICONS = [
  { id: 1, file: "images/icon_1.svg", label: "0" },
  { id: 2, file: "images/icon_2.svg", label: "250" },
  { id: 3, file: "images/icon_3.svg", label: "500" },
  { id: 4, file: "images/icon_4.svg", label: "1k" },
  { id: 5, file: "images/icon_5.svg", label: "2k" },
  { id: 6, file: "images/icon_6.svg", label: "3k" },
  { id: 7, file: "images/icon_7.svg", label: "5k" },
  { id: 8, file: "images/icon_8.svg", label: "7k" },
  { id: 9, file: "images/icon_9.svg", label: "8k" },
  { id: 10, file: "images/icon_10.svg", label: "10k" },
  { id: 11, file: "images/icon_11.svg", label: "15k" },
  { id: 12, file: "images/icon_12.svg", label: "20k" }, // current
  { id: 13, file: "images/icon_13.svg", label: "30k" } // goal
];

const IMGFLIP_MAX_OWNED_ICON_ID = 12;
const IMGFLIP_CURRENT_ICON_ID = 12;

function setupImgflipIcons() {
  const currentContainer = document.getElementById("current-imgflip-icon");
  const rowContainer = document.getElementById("imgflip-icon-row");
  if (!currentContainer && !rowContainer) return;

  if (rowContainer) {
    const prefix = document.createElement("span");
    prefix.classList.add("imgflip-icon-prefix");
    prefix.textContent = "Views icon:";
    rowContainer.appendChild(prefix);
  }

  IMGFLIP_ICONS.forEach(icon => {
    const owned = icon.id <= IMGFLIP_MAX_OWNED_ICON_ID;
    const isCurrent = icon.id === IMGFLIP_CURRENT_ICON_ID;

    if (rowContainer) {
      const wrapper = document.createElement("div");
      wrapper.classList.add("imgflip-icon");

      if (owned && !isCurrent) wrapper.classList.add("owned");
      else if (!owned) wrapper.classList.add("locked");
      if (isCurrent) wrapper.classList.add("current");

      const link = document.createElement("a");
      link.href = IMGFLIP_PROFILE_URL;
      link.target = "_blank";
      link.rel = "noopener";

      const img = document.createElement("img");
      img.src = icon.file;
      img.alt = `Views threshold: ${icon.label}`;
      link.appendChild(img);

      wrapper.appendChild(link);

      const label = document.createElement("span");
      label.classList.add("imgflip-icon-label");
      label.textContent = icon.label;
      wrapper.appendChild(label);

      rowContainer.appendChild(wrapper);
    }

    if (isCurrent && currentContainer) {
      const link = document.createElement("a");
      link.href = IMGFLIP_PROFILE_URL;
      link.target = "_blank";
      link.rel = "noopener";

      const img = document.createElement("img");
      img.src = icon.file;
      img.alt = `Current views icon: ${icon.label}`;
      link.appendChild(img);

      currentContainer.appendChild(link);
    }
  });
}

// ------------ Meme feed + filters + sort ------------

const STATIC_FILE = "/memes.csv"; // CSV 10 columns
const DAILY_FILE = "/meme_daily_updates.csv"; // CSV 3 columns: id, urls, views

let sections = [];
const currentFilters = { type: "all", meme: "all", keywords: "all" };

let sortState = {
  mode: "age", // "age" | "views"
  ageDirection: "newest" // "newest" | "oldest"
};

const MBTI_TYPES = [
  "ESTP", "ISTP", "ESFP", "ISFP",
  "ESTJ", "ISTJ", "ESFJ", "ISFJ",
  "ENFP", "INFP", "ENFJ", "INFJ",
  "ENTJ", "INTJ", "ENTP", "INTP"
];
const MBTI_SET = new Set(MBTI_TYPES);

document.addEventListener("DOMContentLoaded", () => {
  console.log(
    "Script loaded at",
    new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" })
  );

  setupImgflipIcons();

  bootstrap().catch(err => {
    console.error("Bootstrap failed:", err);
    showEmpty("No memes found.");
  });
});

async function bootstrap() {
  const items = await fetchFeed();
  if (!items.length) {
    showEmpty("No memes found.");
    return;
  }
  renderSections(items);
  initSortControls();
  initFilters();
}

// ---------- fetch + merge from CSVs ----------

async function fetchFeed() {
  const [staticText, dailyText] = await Promise.all([
    fetchTextOrThrow(STATIC_FILE),
    fetchTextOrThrow(DAILY_FILE)
  ]);

  const staticRows = parseCsv(staticText, ","); // headers required
  const dailyRows = parseCsv(dailyText, ",");

  // Views map: id -> views
  const dailyMap = new Map();
  for (const r of dailyRows) {
    const id = String(r.id || r.meme_id || r.image_id || "").trim();
    if (!id) continue;

    const viewsNum = Number(String(r.views ?? "").replace(/,/g, "").trim());
    dailyMap.set(id, Number.isFinite(viewsNum) ? viewsNum : 0);
  }

  const staticItems = staticRows
    .map(r => csvRowToMemeItem(r))
    .filter(Boolean);

  const merged = staticItems.map(s => {
    const v = dailyMap.get(String(s.id).trim());
    return { ...s, views: Number.isFinite(v) ? v : 0 };
  });

  console.log(
    `Loaded ${merged.length} items from CSV files (static=${staticRows.length}, daily=${dailyRows.length})`
  );

  return merged;
}

async function fetchTextOrThrow(path) {
  const res = await fetch(path, { headers: { accept: "text/plain" } });
  const ct = res.headers.get("content-type") || "";
  console.log("Fetch", path, "->", res.status, ct);
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return res.text();
}

function csvRowToMemeItem(r) {
  // memes.csv headers (yours are uppercase but parser lowercases them):
  // id, urls, image_url, is_gif, title, meme_type, kym_slug, mbti_types, keywords, tags

  const id = String(r.id || r.meme_id || r.image_id || "").trim();
  if (!id) return null;

  const page_url = String(r.urls || r.url || "").trim() || `https://imgflip.com/i/${id}`;
  const image_url = String(r.image_url || "").trim() || `https://i.imgflip.com/${id}.jpg`;

  const is_gif = parseBool(r.is_gif);

  const title = String(r.title || "").trim() || id;
  const meme_type = String(r.meme_type || "").trim();
  const kym_slug = String(r.kym_slug || "").trim();

  const mbti_types = parseJsonArrayCell(r.mbti_types).map(x => String(x).toUpperCase());
  const keywords = parseJsonArrayCell(r.keywords).map(x => String(x).toLowerCase().trim()).filter(Boolean);
  const tags = parseJsonArrayCell(r.tags).map(x => String(x).toLowerCase().trim()).filter(Boolean);

  return {
    id,
    page_url,
    image_url,
    is_gif,
    title,
    meme_type,
    kym_slug,
    mbti_types,
    keywords,
    tags
  };
}

function parseBool(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

function parseJsonArrayCell(v) {
  // Your cells may be:
  // - JSON arrays: ["memes","adhd"]
  // - plain comma lists: memes, adhd
  let s = String(v ?? "").trim();
  if (!s) return [];

  // strip outer quotes if they somehow remain after CSV parsing
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    s = s.slice(1, -1).trim();
  }

  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return s
      .split(",")
      .map(x => x.trim())
      .filter(Boolean);
  }
}

// ---------- CSV parser (quote-aware) ----------

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

// ---------- rendering ----------

function showEmpty(msg) {
  const main = document.querySelector("main");
  if (!main) return;
  main.innerHTML = `<div class="empty"><p>${msg}</p></div>`;
}

function renderSections(items) {
  const main = document.querySelector("main");
  if (!main) throw new Error("<main> not found");

  main.innerHTML = "";
  const frag = document.createDocumentFragment();

  items.forEach((item, idx) => {
    const section = document.createElement("section");
    section.className = "content-section";

    const mbtiTypes = Array.isArray(item.mbti_types)
      ? item.mbti_types.map(t => String(t).toUpperCase())
      : [];
    const typeList = mbtiTypes.length ? mbtiTypes.join(", ") : "NON-MBTI";

    const rawMemeType = item.meme_type || item.meme_tag || "";
    const memeType = String(rawMemeType);
    const memeLower = memeType.toLowerCase();

    const rawKeywords = Array.isArray(item.keywords)
      ? item.keywords
      : Array.isArray(item.tags)
        ? item.tags
        : [];

    let keywordsArr = rawKeywords
      .map(k => String(k).toLowerCase().trim())
      .filter(Boolean);

    keywordsArr = keywordsArr.filter(kw => !MBTI_SET.has(kw.toUpperCase()));

    const hasMemesTag = rawKeywords.some(
      k => String(k).toLowerCase().trim() === "memes"
    );
    if (hasMemesTag && !keywordsArr.includes("memes")) {
      keywordsArr.push("memes");
    }

    const keywordsStr = keywordsArr.join(",");

    section.dataset.type = typeList;
    section.dataset.meme = memeLower;
    section.dataset.keywords = keywordsStr;

    // "age" sorting fallback is listing order (idx). No created_ts stored in CSV currently.
    section.dataset.index = String(idx);

    const views = typeof item.views === "number" ? item.views : 0;
    section.dataset.views = String(views);

    const titleRaw = item.title || item.id || "Untitled";
    const title = escapeHtml(titleRaw);

    const pageUrl = item.page_url ? String(item.page_url) : `https://imgflip.com/i/${item.id}`;
    const imageUrl = item.image_url ? String(item.image_url) : (item.id ? `https://i.imgflip.com/${item.id}.jpg` : "");

    const viewLabel = views > 0 ? `${numberWithCommas(views)} views` : "Views pending";

    section.innerHTML = `
      <div class="info-box">
        <div class="title-row">
          <h3>${title}</h3>
          <div class="meta-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span class="view-count">${escapeHtml(viewLabel)}</span>
            <p class="image-links" style="display:flex;align-items:center;gap:8px;margin:0;">
              <a href="${pageUrl}" target="_blank" rel="noopener" title="Open on Imgflip">
                <img src="images/imgflip.svg" alt="Imgflip link">
              </a>
            </p>
          </div>
        </div>
        <div class="section-buttons"></div>
      </div>
      <div class="image-container">
        <img src="${imageUrl}" alt="${title} Meme" loading="lazy">
      </div>
    `;

    const buttonsContainer = section.querySelector(".section-buttons");
    if (buttonsContainer) {
      const chipData = [];

      typeList
        .split(/[\s,]+/)
        .map(t => t.trim())
        .filter(Boolean)
        .forEach(t => {
          const T = t.toUpperCase();
          chipData.push({ type: "type", value: T, label: displayType(T) });
        });

      if (memeLower) {
        chipData.push({ type: "meme", value: memeLower, label: memeType });
      }

      keywordsArr.forEach(kw => {
        chipData.push({ type: "keywords", value: kw, label: kw });
      });

      const seen = new Set();
      chipData.forEach(d => {
        const key = `${d.type}:${d.value}`;
        if (seen.has(key)) return;
        seen.add(key);

        const btn = document.createElement("button");
        btn.textContent = d.label;
        btn.dataset.filterType = d.type;
        btn.dataset.value = d.value;

        if (d.type === "type") btn.classList.add("chip-type");
        else if (d.type === "meme") btn.classList.add("chip-meme");

        btn.addEventListener("click", () => filterSections(d.type, d.value));
        buttonsContainer.appendChild(btn);
      });
    }

    frag.appendChild(section);
  });

  main.appendChild(frag);
  sections = Array.from(document.querySelectorAll(".content-section"));
}

// ---------- sort controls ----------

function initSortControls() {
  const filterContainer = document.querySelector(".filter-container");
  if (!filterContainer) return;

  let sortRow = document.querySelector(".sort-row");
  if (!sortRow) {
    sortRow = document.createElement("div");
    sortRow.className = "filter-row sort-row";
    sortRow.innerHTML = `
      <h4>Sort:</h4>
      <div id="sort-buttons"></div>
    `;

    const firstRow = filterContainer.querySelector(".filter-row");
    if (firstRow) filterContainer.insertBefore(sortRow, firstRow);
    else filterContainer.appendChild(sortRow);
  }

  const sortButtonsContainer = document.getElementById("sort-buttons");
  if (!sortButtonsContainer) return;
  sortButtonsContainer.innerHTML = "";

  const ageBtn = document.createElement("button");
  ageBtn.id = "sort-age-btn";
  ageBtn.type = "button";
  ageBtn.textContent = "Newest first";
  ageBtn.addEventListener("click", () => {
    if (sortState.mode === "age") {
      sortState.ageDirection =
        sortState.ageDirection === "newest" ? "oldest" : "newest";
    } else {
      sortState.mode = "age";
      sortState.ageDirection = "newest";
    }
    updateSortButtonsUI();
    applySort();
  });

  const viewsBtn = document.createElement("button");
  viewsBtn.id = "sort-views-btn";
  viewsBtn.type = "button";
  viewsBtn.textContent = "Sort by views";
  viewsBtn.addEventListener("click", () => {
    if (sortState.mode === "views") {
      sortState.mode = "age";
      sortState.ageDirection = "newest";
    } else {
      sortState.mode = "views";
    }
    updateSortButtonsUI();
    applySort();
  });

  sortButtonsContainer.appendChild(ageBtn);
  sortButtonsContainer.appendChild(viewsBtn);

  updateSortButtonsUI();
}

function applySort() {
  const main = document.querySelector("main");
  if (!main) return;
  const nodes = Array.from(main.querySelectorAll(".content-section"));
  if (!nodes.length) return;

  const sorted = [...nodes].sort((a, b) => {
    const idxA = Number(a.dataset.index || 0);
    const idxB = Number(b.dataset.index || 0);

    if (sortState.mode === "views") {
      const vA = Number(a.dataset.views || 0);
      const vB = Number(b.dataset.views || 0);
      if (vB !== vA) return vB - vA;
      return idxA - idxB;
    }

    // Age sort: since we don't have created_ts in CSV, fallback to listing order
    return sortState.ageDirection === "newest" ? (idxA - idxB) : (idxB - idxA);
  });

  sorted.forEach(node => main.appendChild(node));
}

function updateSortButtonsUI() {
  const ageBtn = document.getElementById("sort-age-btn");
  const viewsBtn = document.getElementById("sort-views-btn");

  if (ageBtn) {
    ageBtn.textContent =
      sortState.ageDirection === "newest" ? "Newest first" : "Oldest first";
    const active = sortState.mode === "age";
    ageBtn.classList.toggle("active", active);
    ageBtn.setAttribute("aria-pressed", active ? "true" : "false");
  }

  if (viewsBtn) {
    const active = sortState.mode === "views";
    viewsBtn.classList.toggle("active", active);
    viewsBtn.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

// ---------- filters (with frequency-weighted sizing + color weighting) ----------

function initFilters() {
  sections = Array.from(document.querySelectorAll(".content-section"));

  const typeButtonsContainer = document.getElementById("type-buttons");
  const memeButtonsContainer = document.getElementById("meme-buttons");
  const keywordButtonsContainer = document.getElementById("keywords-buttons");

  const typeOptions = new Set();

  // counts for weighting font-size + color
  const memeCounts = new Map();    // meme_type -> count
  const keywordCounts = new Map(); // keyword -> count

  sections.forEach(section => {
    const typeStr = (section.dataset.type || "").trim();
    if (typeStr) {
      typeStr
        .split(/[\s,]+/)
        .map(t => t.trim())
        .filter(Boolean)
        .forEach(t => typeOptions.add(t.toUpperCase()));
    }

    const memeStr = (section.dataset.meme || "").toLowerCase().trim();
    if (memeStr) memeCounts.set(memeStr, (memeCounts.get(memeStr) || 0) + 1);

    const kwStr = (section.dataset.keywords || "").toLowerCase().trim();
    if (kwStr) {
      kwStr
        .split(",")
        .map(k => k.trim())
        .filter(Boolean)
        .forEach(k => {
          const upper = k.toUpperCase();
          if (MBTI_SET.has(upper)) return;
          keywordCounts.set(k, (keywordCounts.get(k) || 0) + 1);
        });
    }
  });

  MBTI_TYPES.forEach(t => typeOptions.add(t));

  if (sections.some(s => (s.dataset.type || "").toUpperCase().includes("NON-MBTI"))) {
    typeOptions.add("NON-MBTI");
  }

  if (sections.some(s => {
    const secVal = (s.dataset.type || "").toUpperCase().trim();
    const secTypes = secVal
      .split(/[\s,]+/)
      .map(t => t.trim())
      .filter(Boolean);
    return secTypes.some(t => MBTI_SET.has(t));
  })) {
    typeOptions.add("ANY-MBTI");
  }

  const typeValues = Array.from(typeOptions);
  const orderedTypeValues = [
    ...(typeValues.includes("ANY-MBTI") ? ["ANY-MBTI"] : []),
    ...MBTI_TYPES,
    ...(typeValues.includes("NON-MBTI") ? ["NON-MBTI"] : [])
  ];

  buildFilterButtons(typeButtonsContainer, orderedTypeValues, "type");
  buildFilterButtons(memeButtonsContainer, Array.from(memeCounts.keys()).sort(), "meme", memeCounts);
  buildFilterButtons(keywordButtonsContainer, Array.from(keywordCounts.keys()).sort(), "keywords", keywordCounts);
}

function buildFilterButtons(container, values, filterType, countsMap) {
  if (!container) return;

  container.innerHTML = "";

  const allBtn = document.createElement("button");
  allBtn.textContent = "All";
  allBtn.dataset.filterType = filterType;
  allBtn.dataset.value = "all";
  allBtn.addEventListener("click", () => filterSections(filterType, "all"));
  container.appendChild(allBtn);

  // If we have counts, compute min/max once for consistent scaling + coloring
  let minC = Infinity;
  let maxC = -Infinity;
  if (countsMap instanceof Map) {
    for (const v of countsMap.values()) {
      if (v < minC) minC = v;
      if (v > maxC) maxC = v;
    }
    if (!Number.isFinite(minC) || !Number.isFinite(maxC)) {
      minC = 0;
      maxC = 0;
    }
  }

  values.forEach(val => {
    if (!val || typeof val !== "string") return;
    const btn = document.createElement("button");
    btn.dataset.filterType = filterType;

    if (filterType === "type") {
      const upper = val.toUpperCase();
      btn.dataset.value = upper;
      btn.textContent = displayType(upper);
    } else if (filterType === "meme") {
      btn.dataset.value = val;
      btn.textContent = toTitleCase(val);
    } else {
      btn.dataset.value = val;
      btn.textContent = val;
    }

    // Frequency-weighted font sizing + color (meme + keywords only)
    if (countsMap instanceof Map) {
      const count = countsMap.get(val) || 0;

      const size = scaleFontSizeFromMinMax(count, minC, maxC);
      btn.style.fontSize = `${size}rem`;
      btn.title = `${btn.textContent} (${count})`;

      const { bg, border } = colorForCountFromMinMax(count, minC, maxC);
      btn.style.backgroundColor = bg;
      btn.style.borderColor = border;
    }

    btn.addEventListener("click", () => filterSections(filterType, btn.dataset.value));
    container.appendChild(btn);
  });
}

function filterSections(filterType, value) {
  if (!sections || !sections.length) {
    sections = Array.from(document.querySelectorAll(".content-section"));
  }

  currentFilters[filterType] = value === currentFilters[filterType] ? "all" : value;

  document
    .querySelectorAll(`button[data-filter-type="${filterType}"]`)
    .forEach(btn => {
      const isActive =
        btn.dataset.value === currentFilters[filterType] &&
        currentFilters[filterType] !== "all";
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    });

  sections.forEach(section => {
    let matches = true;

    for (const [fType, fVal] of Object.entries(currentFilters)) {
      if (fVal === "all") continue;

      if (fType === "type") {
        const secVal = (section.dataset.type || "").toUpperCase().trim();
        const secTypes = secVal
          .split(/[\s,]+/)
          .map(t => t.trim())
          .filter(Boolean);

        if (fVal === "NON-MBTI") {
          matches = !secTypes.some(t => MBTI_SET.has(t));
        } else if (fVal === "ANY-MBTI") {
          matches = secTypes.some(t => MBTI_SET.has(t));
        } else {
          matches = secTypes.includes(fVal);
        }
      } else if (fType === "meme") {
        const secVal = (section.dataset.meme || "").toLowerCase().trim();
        matches = secVal === fVal;
      } else if (fType === "keywords") {
        const secVal = (section.dataset.keywords || "").toLowerCase().trim();
        const kws = secVal
          .split(",")
          .map(k => k.trim())
          .filter(Boolean);
        if (fVal.includes(" ")) matches = kws.some(kw => kw === fVal);
        else matches = kws.some(kw => kw.includes(fVal));
      }

      if (!matches) break;
    }

    section.classList.toggle("hidden", !matches);
  });
}

// ---------- helpers ----------

function escapeHtml(s) {
  return String(s).replace(/&(amp|lt|gt|quot|#39);/g, c => {
    switch (c) {
      case "&amp;": return "&";
      case "&lt;": return "<";
      case "&gt;": return ">";
      case "&quot;": return '"';
      case "&#39;": return "'";
      default: return c;
    }
  });
}

function numberWithCommas(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x);
  return n.toLocaleString("en-US");
}

function toTitleCase(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function displayType(upper) {
  if (upper === "NON-MBTI") return "Non-MBTI";
  if (upper === "ANY-MBTI") return "Any MBTI";
  return upper;
}

// ---- sizing + color weighting helpers ----

// scales font size based on frequency with a log curve (stable across huge ranges)
function scaleFontSizeFromMinMax(count, minC, maxC) {
  const MIN = 0.80; // rem
  const MAX = 1.15; // rem

  if (!Number.isFinite(minC) || !Number.isFinite(maxC) || minC === maxC) {
    return (MIN + MAX) / 2;
  }

  const logMin = Math.log(minC + 1);
  const logMax = Math.log(maxC + 1);
  const t = (Math.log(count + 1) - logMin) / (logMax - logMin);

  return MIN + clamp01(t) * (MAX - MIN);
}

// Color mapping:
// Base (mid) color is #5e3b83
// - least used => lighter
// - most used  => darker
function colorForCountFromMinMax(count, minC, maxC) {
  const BASE = "#5e3b83";

  if (!Number.isFinite(minC) || !Number.isFinite(maxC) || minC === maxC) {
    return { bg: BASE, border: shadeColor(BASE, -0.18) };
  }

  const logMin = Math.log(minC + 1);
  const logMax = Math.log(maxC + 1);
  const t = (Math.log(count + 1) - logMin) / (logMax - logMin); // 0..1
  const x = clamp01(t);

  // x=0 => lighter, x=1 => darker
  const shade = 0.35 - 0.55 * x; // +0.35 (light) down to ~ -0.20 (dark)

  const bg = shadeColor(BASE, shade);
  const border = shadeColor(BASE, shade - 0.18);
  return { bg, border };
}

// Mix color toward white (t > 0) or black (t < 0), t in [-1..+1]
function shadeColor(hex, t) {
  const { r, g, b } = hexToRgb(hex);
  const tt = clamp(t, -1, 1);

  if (tt >= 0) {
    return rgbToHex(
      r + (255 - r) * tt,
      g + (255 - g) * tt,
      b + (255 - b) * tt
    );
  }

  const k = Math.abs(tt);
  return rgbToHex(r * (1 - k), g * (1 - k), b * (1 - k));
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function hexToRgb(hex) {
  const h = String(hex).replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const n = parseInt(full, 16);
  return {
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255
  };
}

function rgbToHex(r, g, b) {
  const to = v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

// Backward-compatible function (kept so nothing breaks if referenced elsewhere)
function scaleFontSize(count, countsMap) {
  if (!(countsMap instanceof Map)) return 1.0;

  let minC = Infinity;
  let maxC = -Infinity;
  for (const v of countsMap.values()) {
    if (v < minC) minC = v;
    if (v > maxC) maxC = v;
  }

  if (!Number.isFinite(minC) || !Number.isFinite(maxC)) {
    minC = 0;
    maxC = 0;
  }

  return scaleFontSizeFromMinMax(count, minC, maxC);
}
