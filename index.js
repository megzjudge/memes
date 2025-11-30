// escapeHtml function definition
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, function(s) {
    switch (s) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      case "'": return "&#39;";
      default: return s;
    }
  });
}

// ------------ Imgflip icons (top of page) ------------
const IMGFLIP_PROFILE_URL = "https://imgflip.com/user/mbtininja";

const IMGFLIP_ICONS = [
  { id: 1,  file: "images/icon_1.svg",  label: "0" },
  { id: 2,  file: "images/icon_2.svg",  label: "250" },
  { id: 3,  file: "images/icon_3.svg",  label: "500" },
  { id: 4,  file: "images/icon_4.svg",  label: "1k" },
  { id: 5,  file: "images/icon_5.svg",  label: "2k" },
  { id: 6,  file: "images/icon_6.svg",  label: "3k" },
  { id: 7,  file: "images/icon_7.svg",  label: "5k" },
  { id: 8,  file: "images/icon_8.svg",  label: "7k" },
  { id: 9,  file: "images/icon_9.svg",  label: "8k" },
  { id: 10, file: "images/icon_10.svg", label: "10k" },
  { id: 11, file: "images/icon_11.svg", label: "15k" },
  { id: 12, file: "images/icon_12.svg", label: "20k" }, // current
  { id: 13, file: "images/icon_13.svg", label: "30k" }  // goal
];

// how many icons you currently own
const IMGFLIP_MAX_OWNED_ICON_ID = 12;
// which one is currently selected on Imgflip
const IMGFLIP_CURRENT_ICON_ID = 12;

function setupImgflipIcons() {
  const currentContainer = document.getElementById("current-imgflip-icon");
  const rowContainer = document.getElementById("imgflip-icon-row");
  if (!currentContainer && !rowContainer) return;

  // Prefix text: "Views icon:"
  if (rowContainer) {
    const prefix = document.createElement("span");
    prefix.classList.add("imgflip-icon-prefix");
    prefix.textContent = "Views icon:";
    rowContainer.appendChild(prefix);
  }

  IMGFLIP_ICONS.forEach(icon => {
    const owned = icon.id <= IMGFLIP_MAX_OWNED_ICON_ID;
    const isCurrent = icon.id === IMGFLIP_CURRENT_ICON_ID;

    // Icons row under the header text
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

    // The single current icon next to "@mbtininja"
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
const FEED_BASE = "https://rapid-math-6088.touch-97a.workers.dev";

let sections = [];
const currentFilters = { type: "all", meme: "all", keywords: "all" };
let sortState = { mode: "age", ageDirection: "newest" };

const MBTI_TYPES = [
  "ESTP","ISTP","ESFP","ISFP",
  "ESTJ","ISTJ","ESFJ","ISFJ",
  "ENFP","INFP","ENFJ","INFJ",
  "ENTJ","INTJ","ENTP","INTP"
];
const MBTI_SET = new Set(MBTI_TYPES);

document.addEventListener("DOMContentLoaded", () => {
  console.log("Script loaded at",
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
  if (!items.length) return showEmpty("No memes found.");
  renderSections(items);
  initSortControls();
  initFilters();
}

// ---------- fetch feed ----------
async function fetchFeed() {
  const url = `${FEED_BASE}/feed?fresh=1`;
  console.log("Fetching feed from", url);
  const t0 = performance.now();
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
  const json = await res.json();
  const items = Array.isArray(json.items) ? json.items : [];
  console.log(`Got ${items.length} items in ${Math.round(performance.now() - t0)}ms`);
  return items;
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

    const mbtiTypes = Array.isArray(item.mbti_types) ? item.mbti_types.map(t => String(t).toUpperCase()) : [];
    const typeList = mbtiTypes.length ? mbtiTypes.join(", ") : "NON-MBTI";

    const rawMemeType = item.meme_type || item.meme_tag || "";
    const memeType = String(rawMemeType);
    const memeLower = memeType.toLowerCase();

    const rawKeywords = Array.isArray(item.keywords) ? item.keywords : Array.isArray(item.tags) ? item.tags : [];
    let keywordsArr = rawKeywords.map(k => String(k).toLowerCase().trim()).filter(Boolean);
    keywordsArr = keywordsArr.filter(kw => !MBTI_SET.has(kw.toUpperCase()));

    if (rawKeywords.some(k => String(k).toLowerCase().trim() === "memes") && !keywordsArr.includes("memes")) {
      keywordsArr.push("memes");
    }

    const keywordsStr = keywordsArr.join(",");

    section.dataset.type = typeList;
    section.dataset.meme = memeLower;
    section.dataset.keywords = keywordsStr;
    section.dataset.index = String(idx);
    section.dataset.views = String(typeof item.views === "number" ? item.views : 0);

    const title = escapeHtml(item.title || item.id || "Untitled");
    const pageUrl = item.page_url || `https://imgflip.com/i/${item.id}`;
    const imageUrl = item.image_url || (item.id ? `https://i.imgflip.com/${item.id}.jpg` : "");

    section.innerHTML = `
      <div class="info-box">
        <div class="title-row">
          <h3>${title}</h3>
          <div class="meta-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span class="view-count">${item.views ? numberWithCommas(item.views) + " views" : ""}</span>
            <p class="image-links" style="display:flex;align-items:center;gap:8px;margin:0;">
              <a href="${pageUrl}" target="_blank" rel="noopener" title="Open on Imgflip">
                <img src="images/imgflip.svg" alt="Imgflip link">
              </a>
              ${memeLower ? `<a href="${FEED_BASE}/kym?name=${encodeURIComponent(memeType)}" target="_blank" rel="noopener" title="Open on Know Your Meme">
                <img src="images/kym.svg" alt="KYM link">
              </a>` : ""}
            </p>
          </div>
        </div>

        <p class="keywords">Keywords: ${keywordsArr.length ? escapeHtml(keywordsArr.join(", ")) : "none"}</p>
        <p class="type">${typeList}</p>
        <a href="${pageUrl}" target="_blank" rel="noopener">
          <img src="${imageUrl}" alt="${title}">
        </a>
      </div>
    `;

    frag.appendChild(section);
  });

  main.appendChild(frag);
}

// ---------- filters ----------
function initFilters() {
  const filtersDiv = document.getElementById("filters");
  if (!filtersDiv) return;

  const typesFilter = filtersDiv.querySelector("#type-filter");
  const memeFilter = filtersDiv.querySelector("#meme-filter");
  const keywordsFilter = filtersDiv.querySelector("#keywords-filter");

  if (typesFilter) {
    typesFilter.addEventListener("change", (event) => {
      currentFilters.type = event.target.value;
      filterItems();
    });
  }

  if (memeFilter) {
    memeFilter.addEventListener("change", (event) => {
      currentFilters.meme = event.target.value;
      filterItems();
    });
  }

  if (keywordsFilter) {
    keywordsFilter.addEventListener("change", (event) => {
      currentFilters.keywords = event.target.value;
      filterItems();
    });
  }
}

function filterItems() {
  const sections = document.querySelectorAll(".content-section");
  sections.forEach(section => {
    const matchesType = currentFilters.type === "all" || section.dataset.type.includes(currentFilters.type);
    const matchesMeme = currentFilters.meme === "all" || section.dataset.meme.includes(currentFilters.meme);
    const matchesKeywords = currentFilters.keywords === "all" || section.dataset.keywords.includes(currentFilters.keywords);

    if (matchesType && matchesMeme && matchesKeywords) {
      section.style.display = "";
    } else {
      section.style.display = "none";
    }
  });
}

// ---------- sorting ----------
function initSortControls() {
  const sortByAgeBtn = document.getElementById("sort-by-age");
  const sortByViewsBtn = document.getElementById("sort-by-views");

  if (sortByAgeBtn) {
    sortByAgeBtn.addEventListener("click", () => {
      sortState.mode = "age";
      sortState.ageDirection = sortState.ageDirection === "newest" ? "oldest" : "newest";
      sortFeed();
    });
  }

  if (sortByViewsBtn) {
    sortByViewsBtn.addEventListener("click", () => {
      sortState.mode = "views";
      sortFeed();
    });
  }
}

function sortFeed() {
  const sections = Array.from(document.querySelectorAll(".content-section"));
  sections.sort((a, b) => {
    const aValue = sortState.mode === "age" 
      ? parseInt(a.dataset.index, 10) 
      : parseInt(a.dataset.views, 10);
    const bValue = sortState.mode === "age" 
      ? parseInt(b.dataset.index, 10) 
      : parseInt(b.dataset.views, 10);

    if (sortState.mode === "age") {
      return sortState.ageDirection === "newest" ? bValue - aValue : aValue - bValue;
    } else {
      return bValue - aValue;
    }
  });

  const main = document.querySelector("main");
  if (main) {
    main.innerHTML = "";
    sections.forEach(section => main.appendChild(section));
  }
}

// utility function
function numberWithCommas(x) {
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

11 lines

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return (text || '').replace(/[&<>"']/g, function(m) { return map[m]; });
}
