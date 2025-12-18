// ============================
// index.js (KV-config enabled)
// ============================

// ------------ Static defaults (safe fallback if /config fails) ------------

const FEED_BASE = "https://rapid-math-6088.touch-97a.workers.dev";

const DEFAULT_IMGFLIP_CONFIG = {
  profile_url: "https://imgflip.com/user/mbtininja",
  icons: [
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
  ],
  max_owned_icon_id: 12,
  current_icon_id: 12
};

// ------------ Meme feed + filters + sort (static) ------------

let sections = [];
const currentFilters = {
  type: "all",
  meme: "all",
  keywords: "all"
};

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

// ------------ Runtime config (fetched from Worker/KV) ------------

let runtimeConfig = {
  imgflip: { ...DEFAULT_IMGFLIP_CONFIG }
};

// ------------ Boot ------------

document.addEventListener("DOMContentLoaded", () => {
  console.log(
    "Script loaded at",
    new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" })
  );

  bootstrap().catch(err => {
    console.error("Bootstrap failed:", err);
    showEmpty("No memes found.");
  });
});

async function bootstrap() {
  // 1) Fetch KV-backed config (best-effort, with safe fallback)
  await loadRuntimeConfig();

  // 2) Render icons using runtime config
  setupImgflipIcons(runtimeConfig.imgflip);

  // 3) Fetch and render feed
  const items = await fetchFeed();
  if (!items.length) {
    showEmpty("No memes found.");
    return;
  }
  renderSections(items);
  initSortControls();
  initFilters();
}

// ---------- KV-backed config ----------

async function loadRuntimeConfig() {
  const url = `${FEED_BASE}/config`;
  try {
    const json = await fetchJson(url, { timeoutMs: 8000 });

    // Merge defensively to preserve defaults if fields are missing.
    const imgflip = (json && typeof json === "object" && json.imgflip) ? json.imgflip : {};
    runtimeConfig.imgflip = normalizeImgflipConfig(imgflip);

    console.log("Loaded /config OK");
  } catch (err) {
    console.warn("Config fetch failed; using defaults:", err);
    runtimeConfig.imgflip = { ...DEFAULT_IMGFLIP_CONFIG };
  }
}

function normalizeImgflipConfig(cfg) {
  const out = { ...DEFAULT_IMGFLIP_CONFIG };

  if (cfg && typeof cfg === "object") {
    if (typeof cfg.profile_url === "string" && cfg.profile_url.trim()) {
      out.profile_url = cfg.profile_url.trim();
    }

    if (Array.isArray(cfg.icons) && cfg.icons.length) {
      // Only keep well-formed icon objects
      const cleaned = cfg.icons
        .map(i => ({
          id: Number(i && i.id),
          file: String(i && i.file || "").trim(),
          label: String(i && i.label || "").trim()
        }))
        .filter(i => Number.isFinite(i.id) && i.id > 0 && i.file && i.label);

      if (cleaned.length) out.icons = cleaned;
    }

    if (Number.isFinite(Number(cfg.max_owned_icon_id))) {
      out.max_owned_icon_id = Number(cfg.max_owned_icon_id);
    }
    if (Number.isFinite(Number(cfg.current_icon_id))) {
      out.current_icon_id = Number(cfg.current_icon_id);
    }
  }

  return out;
}

// ------------ Imgflip icons (top of page) ------------

function setupImgflipIcons(imgflipCfg) {
  const currentContainer = document.getElementById("current-imgflip-icon");
  const rowContainer = document.getElementById("imgflip-icon-row");
  if (!currentContainer && !rowContainer) return;

  // Clear existing (in case bootstrap ever reruns)
  if (currentContainer) currentContainer.innerHTML = "";
  if (rowContainer) rowContainer.innerHTML = "";

  const profileUrl = imgflipCfg && imgflipCfg.profile_url
    ? imgflipCfg.profile_url
    : DEFAULT_IMGFLIP_CONFIG.profile_url;

  const icons = (imgflipCfg && Array.isArray(imgflipCfg.icons))
    ? imgflipCfg.icons
    : DEFAULT_IMGFLIP_CONFIG.icons;

  const maxOwned = Number.isFinite(Number(imgflipCfg && imgflipCfg.max_owned_icon_id))
    ? Number(imgflipCfg.max_owned_icon_id)
    : DEFAULT_IMGFLIP_CONFIG.max_owned_icon_id;

  const currentId = Number.isFinite(Number(imgflipCfg && imgflipCfg.current_icon_id))
    ? Number(imgflipCfg.current_icon_id)
    : DEFAULT_IMGFLIP_CONFIG.current_icon_id;

  // Prefix text: "Views icon:"
  if (rowContainer) {
    const prefix = document.createElement("span");
    prefix.classList.add("imgflip-icon-prefix");
    prefix.textContent = "Views icon:";
    rowContainer.appendChild(prefix);
  }

  icons.forEach(icon => {
    const owned = icon.id <= maxOwned;
    const isCurrent = icon.id === currentId;

    // Icons row under the header text
    if (rowContainer) {
      const wrapper = document.createElement("div");
      wrapper.classList.add("imgflip-icon");

      // owned but NOT current → strike
      if (owned && !isCurrent) {
        wrapper.classList.add("owned");
      } else if (!owned) {
        wrapper.classList.add("locked");
      }
      if (isCurrent) {
        wrapper.classList.add("current");
      }

      const link = document.createElement("a");
      link.href = profileUrl;
      link.target = "_blank";
      link.rel = "noopener";

      const img = document.createElement("img");
      img.src = icon.file;
      img.alt = `Views threshold: ${icon.label}`;
      link.appendChild(img);

      wrapper.appendChild(link);

      // numeric label only (no "icon" word)
      const label = document.createElement("span");
      label.classList.add("imgflip-icon-label");
      label.textContent = icon.label;
      wrapper.appendChild(label);

      rowContainer.appendChild(wrapper);
    }

    // The single current icon next to "@mbtininja"
    if (isCurrent && currentContainer) {
      const link = document.createElement("a");
      link.href = profileUrl;
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

// ---------- fetch feed ----------

async function fetchFeed() {
  // Allow forcing fresh from the page URL without editing the file:
  // /index.html?fresh=1
  const pageParams = new URLSearchParams(window.location.search);
  const forceFresh = pageParams.get("fresh") === "1";

  const url = forceFresh
    ? `${FEED_BASE}/feed?fresh=1`
    : `${FEED_BASE}/feed`;

  console.log("Fetching feed from", url);
  const t0 = performance.now();

  const json = await fetchJson(url, {
    timeoutMs: 12000,
    headers: { accept: "application/json" }
  });

  const items = Array.isArray(json && json.items) ? json.items : [];
  const t1 = performance.now();
  console.log(`Got ${items.length} items in ${Math.round(t1 - t0)}ms`);
  return items;
}

// ---------- rendering ----------

function showEmpty(msg) {
  const main = document.querySelector("main");
  if (!main) return;
  main.innerHTML = `<div class="empty"><p>${escapeHtml(msg)}</p></div>`;
}

function renderSections(items) {
  const main = document.querySelector("main");
  if (!main) throw new Error("<main> not found");

  // ---- Local normalizer + placeholder detector (scoped to renderSections) ----

  function isPlaceholderItem(item) {
    const id = String(item?.id || "").trim();
    const title = String(item?.title || "").trim();
    const memeType = String(item?.meme_type || item?.meme_tag || "").trim();

    const mbti = Array.isArray(item?.mbti_types) ? item.mbti_types : [];
    const kw = Array.isArray(item?.keywords) ? item.keywords : [];
    const tags = Array.isArray(item?.tags) ? item.tags : [];
    const ageText = String(item?.age_text || "").trim();

    // Tuneable "KV stub" signature:
    // - title is empty OR equals id
    // - no memeType, no chips, no age, no kym slug
    return (
      id &&
      (title === "" || title.toLowerCase() === id.toLowerCase()) &&
      memeType === "" &&
      mbti.length === 0 &&
      kw.length === 0 &&
      tags.length === 0 &&
      ageText === "" &&
      item?.kym_slug == null
    );
  }

  function normalizeItem(item) {
    const id = String(item?.id || "").trim();
    const placeholder = isPlaceholderItem(item);

    const pageUrl = (item && item.page_url)
      ? String(item.page_url)
      : (id ? `https://imgflip.com/i/${id}` : "");

    const imageUrl = (item && item.image_url)
      ? String(item.image_url)
      : (id ? `https://i.imgflip.com/${id}.jpg` : "");

    const rawMemeType = String(item?.meme_type || item?.meme_tag || "").trim();
    const memeType = placeholder ? "" : rawMemeType;
    const memeLower = memeType ? memeType.toLowerCase() : "";

    // Title: do NOT present "title == id" as meaningful
    let titleRaw = String(item?.title || "").trim();
    if (!titleRaw || titleRaw.toLowerCase() === id.toLowerCase()) {
      titleRaw = memeType || id || "Untitled";
    }

    // Views: prefer future-proof 24h field if Worker adds it
    const views =
      typeof item?.views_24h === "number" ? item.views_24h :
      typeof item?.views === "number" ? item.views :
      0;

    const showViews = !placeholder && Number.isFinite(views) && views > 0;

    // MBTI types (keep only valid types)
    const mbtiTypes = placeholder
      ? []
      : (Array.isArray(item?.mbti_types)
          ? item.mbti_types
              .map(t => String(t).toUpperCase())
              .filter(t => MBTI_SET.has(t))
          : []);

    const typeList = mbtiTypes.length ? mbtiTypes.join(", ") : "NON-MBTI";

    // Keywords/tags: if placeholder, do not fabricate chips
    const rawKeywords = placeholder
      ? []
      : (Array.isArray(item?.keywords)
          ? item.keywords
          : Array.isArray(item?.tags)
          ? item.tags
          : []);

    let keywordsArr = rawKeywords
      .map(k => String(k).toLowerCase().trim())
      .filter(Boolean);

    // Remove anything that is actually an MBTI type
    keywordsArr = keywordsArr.filter(kw => !MBTI_SET.has(kw.toUpperCase()));

    // Ensure "memes" is always present if tag "memes" exists
    const hasMemesTag = rawKeywords.some(
      k => String(k).toLowerCase().trim() === "memes"
    );
    if (hasMemesTag && !keywordsArr.includes("memes")) {
      keywordsArr.push("memes");
    }

    const keywordsStr = keywordsArr.join(",");

    // Stable-ish age sorting:
    // Prefer a real timestamp if Worker provides one; otherwise fall back to idx order.
    const ts =
      (item && item.created_at) ? Date.parse(item.created_at) :
      (item && item.scraped_at) ? Date.parse(item.scraped_at) :
      (item && item.timestamp) ? Number(item.timestamp) :
      NaN;

    return {
      id,
      placeholder,
      pageUrl,
      imageUrl,
      memeType,
      memeLower,
      titleRaw,
      views,
      showViews,
      typeList,
      mbtiTypes,
      keywordsArr,
      keywordsStr,
      ts
    };
  }

  // ---- Render ----

  main.innerHTML = "";
  const frag = document.createDocumentFragment();

  items.forEach((item, idx) => {
    const n = normalizeItem(item);

    const section = document.createElement("section");
    section.className = "content-section";

    section.dataset.type = n.typeList;
    section.dataset.meme = n.memeLower;
    section.dataset.keywords = n.keywordsStr;

    if (Number.isFinite(n.ts)) section.dataset.ts = String(n.ts);
    section.dataset.index = String(idx); // fallback: 0 = newest (server order)
    section.dataset.views = String(Number.isFinite(n.views) ? n.views : 0);

    const title = escapeHtml(n.titleRaw);

    section.innerHTML = `
      <div class="info-box">
        <div class="title-row">
          <h3>${title}</h3>
          <div class="meta-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span class="view-count">${n.showViews ? escapeHtml(numberWithCommas(n.views) + " views") : ""}</span>
            <p class="image-links" style="display:flex;align-items:center;gap:8px;margin:0;">
              <a href="${n.pageUrl}" target="_blank" rel="noopener" title="Open on Imgflip">
                <img src="images/imgflip.svg" alt="Imgflip link">
              </a>
              ${
                n.memeLower
                  ? `<a href="${FEED_BASE}/kym?name=${encodeURIComponent(n.memeType)}" target="_blank" rel="noopener" title="Open on Know Your Meme">
                       <img src="images/Know_Your_Meme.svg" alt="Know Your Meme">
                     </a>`
                  : ""
              }
            </p>
          </div>
        </div>
        <div class="section-buttons"></div>
      </div>
      <div class="image-container">
        <img src="${n.imageUrl}" alt="${title} Meme" loading="lazy">
      </div>
    `;

    const buttonsContainer = section.querySelector(".section-buttons");
    if (buttonsContainer) {
      const chipData = [];

      // MBTI type chips
      n.typeList
        .split(/[\s,]+/)
        .map(t => t.trim())
        .filter(Boolean)
        .forEach(t => {
          const T = t.toUpperCase();
          chipData.push({ type: "type", value: T, label: displayType(T) });
        });

      // Meme type chip (skip for placeholder)
      if (n.memeLower) {
        chipData.push({
          type: "meme",
          value: n.memeLower,
          label: n.memeType
        });
      }

      // Keyword chips (skip for placeholder by construction)
      n.keywordsArr.forEach(kw => {
        chipData.push({
          type: "keywords",
          value: kw,
          label: kw
        });
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

        if (d.type === "type") {
          btn.classList.add("chip-type");
        } else if (d.type === "meme") {
          btn.classList.add("chip-meme");
        }

        btn.addEventListener("click", () => filterSections(d.type, d.value));
        buttonsContainer.appendChild(btn);
      });
    }

    frag.appendChild(section);
  });

  main.appendChild(frag);
  sections = Array.from(document.querySelectorAll(".content-section"));
}

// ---------- sort controls (top) ----------

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
    if (firstRow) {
      filterContainer.insertBefore(sortRow, firstRow);
    } else {
      filterContainer.appendChild(sortRow);
    }
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
      if (vB !== vA) return vB - vA; // high views first
      return idxA - idxB;
    }

    // mode === "age"
    const tsA = Number(a.dataset.ts || NaN);
    const tsB = Number(b.dataset.ts || NaN);

    // Prefer timestamps when present; fall back to server order (idx).
    if (Number.isFinite(tsA) && Number.isFinite(tsB)) {
      return sortState.ageDirection === "newest"
        ? (tsB - tsA) // larger ts = newer
        : (tsA - tsB);
    }

    // Fallback: 0 = newest (server order)
    return sortState.ageDirection === "newest"
      ? (idxA - idxB)
      : (idxB - idxA);
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

// ---------- filters ----------

function initFilters() {
  sections = Array.from(document.querySelectorAll(".content-section"));

  const typeButtonsContainer = document.getElementById("type-buttons");
  const memeButtonsContainer = document.getElementById("meme-buttons");
  const keywordButtonsContainer = document.getElementById("keywords-buttons");

  const typeOptions = new Set();
  const memeOptions = new Set();
  const keywordOptions = new Set();

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
    if (memeStr) memeOptions.add(memeStr);

    const kwStr = (section.dataset.keywords || "").toLowerCase().trim();
    if (kwStr) {
      kwStr
        .split(",")
        .map(k => k.trim())
        .filter(Boolean)
        .forEach(k => {
          const upper = k.toUpperCase();
          // do NOT include MBTI types as global keyword filters
          if (MBTI_SET.has(upper)) return;
          keywordOptions.add(k);
        });
    }
  });

  MBTI_TYPES.forEach(t => typeOptions.add(t));

  if (sections.some(s => (s.dataset.type || "").toUpperCase().includes("NON-MBTI"))) {
    typeOptions.add("NON-MBTI");
  }

  buildFilterButtons(typeButtonsContainer, Array.from(typeOptions).sort(), "type");
  buildFilterButtons(memeButtonsContainer, Array.from(memeOptions).sort(), "meme");
  buildFilterButtons(keywordButtonsContainer, Array.from(keywordOptions).sort(), "keywords");
}

function buildFilterButtons(container, values, filterType) {
  if (!container) return;

  container.innerHTML = "";

  const allBtn = document.createElement("button");
  allBtn.textContent = "All";
  allBtn.dataset.filterType = filterType;
  allBtn.dataset.value = "all";
  allBtn.addEventListener("click", () => filterSections(filterType, "all"));
  container.appendChild(allBtn);

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

    btn.addEventListener("click", () => filterSections(filterType, btn.dataset.value));
    container.appendChild(btn);
  });
}

function filterSections(filterType, value) {
  if (!sections || !sections.length) {
    sections = Array.from(document.querySelectorAll(".content-section"));
  }

  currentFilters[filterType] =
    value === currentFilters[filterType] ? "all" : value;

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

        if (fVal.includes(" ")) {
          matches = kws.some(kw => kw === fVal);
        } else {
          matches = kws.some(kw => kw.includes(fVal));
        }
      }

      if (!matches) break;
    }

    section.classList.toggle("hidden", !matches);
  });
}

// ---------- helpers ----------

async function fetchJson(url, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 10000;
  const headers = opts.headers && typeof opts.headers === "object" ? opts.headers : { accept: "application/json" };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Proper escaping (prevents HTML injection in innerHTML templates)
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  return upper;
}
