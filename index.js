// index.js
// - Fetches all memes from the Worker.
// - Dynamically renders all <section class="content-section">.
// - MBTI chips: ENTP / ESTP / NON-MBTI (no "Type:").
// - Sort controls:
//   * Age toggle: default "Newest first", click → "Oldest first".
//   * Sort by views: highest views first when active.

const FEED_BASE = "https://rapid-math-6088.touch-97a.workers.dev";

let sections = [];
const currentFilters = {
  type: "all",
  meme: "all",
  keywords: "all"
};

let sortState = {
  mode: "age",        // "age" | "views"
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

// ---------------- fetch feed ----------------

async function fetchFeed() {
  const url = `${FEED_BASE}/feed?fresh=1`;
  console.log("Fetching feed from", url);
  const t0 = performance.now();
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Feed HTTP ${res.status}`);
  }
  const json = await res.json();
  const items = Array.isArray(json.items) ? json.items : [];
  const t1 = performance.now();
  console.log(`Got ${items.length} items in ${Math.round(t1 - t0)}ms`);
  return items;
}

// ---------------- rendering ----------------

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
    const keywordsArr = rawKeywords
      .map(k => String(k).toLowerCase().trim())
      .filter(Boolean);
    const keywordsStr = keywordsArr.join(",");

    section.dataset.type = typeList;
    section.dataset.meme = memeLower;
    section.dataset.keywords = keywordsStr;
    section.dataset.index = String(idx); // 0 = newest, increasing toward oldest
    const views = typeof item.views === "number" ? item.views : 0;
    section.dataset.views = String(views);

    const title = escapeHtml(item.title || item.id || "Untitled");
    const pageUrl = item.page_url || `https://imgflip.com/i/${item.id}`;
    const imageUrl =
      item.image_url || (item.id ? `https://i.imgflip.com/${item.id}.jpg` : "");

    section.innerHTML = `
      <div class="info-box">
        <div class="title-row">
          <h3>${title}</h3>
          <div class="meta-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span class="view-count">${views ? numberWithCommas(views) + " views" : ""}</span>
            <p class="image-links" style="display:flex;align-items:center;gap:8px;margin:0;">
              <a href="${pageUrl}" target="_blank" rel="noopener" title="Open on Imgflip">
                <img src="images/imgflip.svg" alt="Imgflip link">
              </a>
              ${
                memeLower
                  ? `<a href="https://knowyourmeme.com/search?q=${encodeURIComponent(memeType)}" target="_blank" rel="noopener" title="Search on Know Your Meme">
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
        <img src="${imageUrl}" alt="${title} Meme" loading="lazy">
      </div>
    `;

    const buttonsContainer = section.querySelector(".section-buttons");
    if (buttonsContainer) {
      const chipData = [];

      // type chips: ENTP / ESTP / NON-MBTI
      typeList
        .split(/[\s,]+/)
        .map(t => t.trim())
        .filter(Boolean)
        .forEach(t => {
          const T = t.toUpperCase();
          chipData.push({ type: "type", value: T, label: displayType(T) });
        });

      // meme type chip
      if (memeLower) {
        chipData.push({
          type: "meme",
          value: memeLower,
          label: memeType
        });
      }

      // keyword chips
      keywordsArr.forEach(kw => {
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
        btn.addEventListener("click", () => filterSections(d.type, d.value));
        buttonsContainer.appendChild(btn);
      });
    }

    frag.appendChild(section);
  });

  main.appendChild(frag);
  sections = Array.from(document.querySelectorAll(".content-section"));
}

// ---------------- sort controls ----------------

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
    filterContainer.appendChild(sortRow);
  }

  const sortButtonsContainer = document.getElementById("sort-buttons");
  if (!sortButtonsContainer) return;
  sortButtonsContainer.innerHTML = "";

  const ageBtn = document.createElement("button");
  ageBtn.id = "sort-age-btn";
  ageBtn.type = "button";
  ageBtn.textContent = "Newest first";
  ageBtn.addEventListener("click", () => {
    // clicking age always sets mode to "age"
    if (sortState.mode === "age") {
      // toggle direction
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
    // toggle between views and age (newest)
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
  // No need to call applySort() here: initial DOM order is newest-first already.
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
      if (vB !== vA) return vB - vA; // highest views first
      return idxA - idxB;           // tie-breaker: newest first
    } else {
      // age sort
      if (sortState.ageDirection === "newest") {
        // 0 = newest
        return idxA - idxB;
      } else {
        return idxB - idxA;
      }
    }
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

// ---------------- filters ----------------

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
        .forEach(k => keywordOptions.add(k));
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

    btn.addEventListener("click", () =>
      filterSections(filterType, btn.dataset.value)
    );
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

// ---------------- helpers ----------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
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
  return upper;
}
