// index.js

'use strict';

const WORKER_ORIGIN = 'https://rapid-math-6088.touch-97a.workers.dev';

const MBTI_TYPES = new Set([
  'ESTP', 'ISTP', 'ESFP', 'ISFP',
  'ESTJ', 'ISTJ', 'ESFJ', 'ISFJ',
  'ENFP', 'INFP', 'ENFJ', 'INFJ',
  'ENTJ', 'INTJ', 'ENTP', 'INTP'
]);

let allItems = [];
let allSections = [];
let currentFilters = {
  type: 'all',
  meme: 'all',
  keywords: 'all'
};
let sortMode = 'newest'; // 'newest' | 'oldest' | 'views'

document.addEventListener('DOMContentLoaded', () => {
  console.log('Script loaded at', new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }));

  setupImgflipIcons();

  bootstrap().catch(err => {
    console.error('Bootstrap failed:', err);
    showEmpty('No memes found.');
  });
});

// ---------------- bootstrap / fetch ----------------

async function bootstrap() {
  const main = document.querySelector('main');
  if (!main) return;

  showLoader(main);

  const params = new URLSearchParams(window.location.search);
  const isAdmin = params.get('admin') === '1';

  const feedUrl = isAdmin
    ? `${WORKER_ORIGIN}/feed?fresh=1`
    : `${WORKER_ORIGIN}/feed`;

  console.log('Fetching feed from', feedUrl);

  const res = await fetch(feedUrl);
  if (!res.ok) {
    throw new Error(`Feed HTTP ${res.status}`);
  }
  const data = await res.json();

  if (!data || !Array.isArray(data.items) || data.items.length === 0) {
    showEmpty('No memes found.');
    return;
  }

  allItems = data.items.slice();
  buildUiFromItems(allItems);
}

function showLoader(main) {
  main.innerHTML = '';
  const loader = document.createElement('div');
  loader.className = 'loader';
  main.appendChild(loader);
}

function showEmpty(msg) {
  const main = document.querySelector('main');
  if (!main) return;
  main.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = msg;
  p.style.padding = '1rem';
  main.appendChild(p);
}

// ---------------- build UI from items ----------------

function buildUiFromItems(items) {
  const main = document.querySelector('main');
  const typeContainer = document.getElementById('type-buttons');
  const memeContainer = document.getElementById('meme-buttons');
  const keywordContainer = document.getElementById('keywords-buttons');

  if (!main || !typeContainer || !memeContainer || !keywordContainer) {
    console.warn('Missing container(s) for filters or main');
    return;
  }

  main.innerHTML = '';

  const typeSet = new Set();
  const memeSet = new Set();
  const keywordSet = new Set();

  allSections = items.map((item, idx) => {
    const section = buildSection(item, idx);
    main.appendChild(section);

    if (item.mbti_types && item.mbti_types.length) {
      item.mbti_types.forEach(t => typeSet.add(t.toUpperCase()));
    } else {
      typeSet.add('NON-MBTI');
    }

    if (item.meme_type) {
      memeSet.add(item.meme_type.toLowerCase());
    }

    if (item.keywords && item.keywords.length) {
      item.keywords.forEach(kw => {
        const lower = kw.toLowerCase();
        if (!MBTI_TYPES.has(lower.toUpperCase())) {
          keywordSet.add(lower);
        }
      });
    }

    return section;
  });

  MBTI_TYPES.forEach(t => typeSet.add(t));
  typeSet.add('NON-MBTI');
  typeSet.add('All');

  createFilterButtons(typeContainer, Array.from(typeSet).sort(), 'type');
  createFilterButtons(memeContainer, Array.from(memeSet).sort(), 'meme');
  createFilterButtons(keywordContainer, Array.from(keywordSet).sort(), 'keywords');

  setupSortRow();

  currentFilters = { type: 'all', meme: 'all', keywords: 'all' };
  sortMode = 'newest';
  updateSortButtonsActive();
  applyFiltersAndSort();
}

// ---------------- section construction ----------------

function buildSection(item, index) {
  const section = document.createElement('section');
  section.className = 'content-section';

  const types = (item.mbti_types && item.mbti_types.length)
    ? item.mbti_types.join(', ')
    : 'NON-MBTI';

  const memeTypeRaw = item.meme_type || '';
  const memeTypeAttr = memeTypeRaw.toLowerCase();
  const keywordsArr = item.keywords || [];
  const keywordsStr = keywordsArr.join(', ');

  section.dataset.type = types;
  section.dataset.meme = memeTypeAttr;
  section.dataset.keywords = keywordsStr.toLowerCase();
  section.dataset.index = String(index);
  section.dataset.views = String(item.views || 0);

  const infoBox = document.createElement('div');
  infoBox.className = 'info-box';

  const titleRow = document.createElement('div');
  titleRow.className = 'title-row';

  const h3 = document.createElement('h3');
  h3.textContent = item.title || item.id;
  titleRow.appendChild(h3);

  const metaRow = document.createElement('div');
  metaRow.className = 'meta-row';
  metaRow.style.display = 'flex';
  metaRow.style.alignItems = 'center';
  metaRow.style.justifyContent = 'space-between';
  metaRow.style.gap = '8px';

  const viewSpan = document.createElement('span');
  viewSpan.className = 'view-count';
  const views = item.views || 0;
  viewSpan.textContent = `${views.toLocaleString()} views` +
    (item.age_text ? ` • ${item.age_text}` : '');
  metaRow.appendChild(viewSpan);

  const linksP = document.createElement('p');
  linksP.className = 'image-links';
  linksP.style.display = 'flex';
  linksP.style.alignItems = 'center';
  linksP.style.gap = '8px';
  linksP.style.margin = '0';

  const imgflipLink = document.createElement('a');
  imgflipLink.href = item.page_url || `https://imgflip.com/i/${item.id}`;
  imgflipLink.target = '_blank';
  imgflipLink.rel = 'noopener';
  imgflipLink.title = 'Open on Imgflip';

  const imgflipImg = document.createElement('img');
  imgflipImg.src = 'images/imgflip.svg';
  imgflipImg.alt = 'Imgflip link';
  imgflipLink.appendChild(imgflipImg);
  linksP.appendChild(imgflipLink);

  if (item.meme_type) {
    const kymLink = document.createElement('a');
    const kymUrl = `${WORKER_ORIGIN}/kym?name=${encodeURIComponent(item.meme_type)}`;
    kymLink.href = kymUrl;
    kymLink.target = '_blank';
    kymLink.rel = 'noopener';
    kymLink.title = 'Open on Know Your Meme';

    const kymImg = document.createElement('img');
    kymImg.src = 'images/Know_Your_Meme.svg';
    kymImg.alt = 'Know Your Meme';
    kymLink.appendChild(kymImg);

    linksP.appendChild(kymLink);
  }

  metaRow.appendChild(linksP);
  titleRow.appendChild(metaRow);
  infoBox.appendChild(titleRow);

  const buttonsDiv = document.createElement('div');
  buttonsDiv.className = 'section-buttons';

  types.split(/,\s*/).forEach(t => {
    if (!t) return;
    const btn = document.createElement('button');
    btn.textContent = t === 'NON-MBTI' ? 'Non-MBTI' : t;
    btn.dataset.filterType = 'type';
    btn.dataset.value = t === 'NON-MBTI' ? 'NON-MBTI' : t.toUpperCase();
    buttonsDiv.appendChild(btn);
  });

  if (memeTypeRaw) {
    const btn = document.createElement('button');
    btn.textContent = memeTypeRaw;
    btn.dataset.filterType = 'meme';
    btn.dataset.value = memeTypeAttr;
    buttonsDiv.appendChild(btn);
  }

  keywordsArr.forEach(kw => {
    const lower = kw.toLowerCase();
    const btn = document.createElement('button');
    btn.textContent = kw;
    btn.dataset.filterType = 'keywords';
    btn.dataset.value = lower;
    buttonsDiv.appendChild(btn);
  });

  infoBox.appendChild(buttonsDiv);
  section.appendChild(infoBox);

  const imgContainer = document.createElement('div');
  imgContainer.className = 'image-container';
  const img = document.createElement('img');
  img.src = item.image_url;
  img.alt = `${item.title || item.id} Meme`;
  img.loading = 'lazy';
  imgContainer.appendChild(img);
  section.appendChild(imgContainer);

  buttonsDiv.addEventListener('click', evt => {
    const target = evt.target;
    if (!(target instanceof HTMLElement)) return;
    const filterType = target.dataset.filterType;
    const value = target.dataset.value;
    if (!filterType || !value) return;
    applyFilter(filterType, value);
  });

  return section;
}

// ---------------- filter buttons ----------------

function createFilterButtons(container, values, filterType) {
  if (!container) return;
  container.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.textContent = 'All';
  allBtn.dataset.filterType = filterType;
  allBtn.dataset.value = 'all';
  allBtn.addEventListener('click', () => applyFilter(filterType, 'all'));
  container.appendChild(allBtn);

  values.forEach(value => {
    if (!value) return;
    if (filterType === 'type' && (value === 'All' || value === 'ALL')) return;

    const btn = document.createElement('button');
    let label = value;

    if (filterType === 'type') {
      if (value === 'NON-MBTI') {
        label = 'Non-MBTI';
      } else {
        label = value.toUpperCase();
      }
      btn.dataset.value = value.toUpperCase();
    } else {
      label = value;
      btn.dataset.value = value;
    }

    btn.textContent = label;
    btn.dataset.filterType = filterType;
    btn.addEventListener('click', () => applyFilter(filterType, btn.dataset.value));
    container.appendChild(btn);
  });
}

// ---------------- sort row ----------------

function setupSortRow() {
  const filterContainer = document.querySelector('.filter-container');
  if (!filterContainer) return;

  let row = document.querySelector('.filter-row.sort-row');
  if (!row) {
    row = document.createElement('div');
    row.className = 'filter-row sort-row';

    const h4 = document.createElement('h4');
    h4.textContent = 'Sort:';
    row.appendChild(h4);

    const holder = document.createElement('div');
    holder.id = 'sort-buttons';
    row.appendChild(holder);

    filterContainer.appendChild(row);
  }

  const sortButtons = document.getElementById('sort-buttons');
  if (!sortButtons) return;
  sortButtons.innerHTML = '';

  const modes = [
    { mode: 'newest', label: 'Newest first' },
    { mode: 'oldest', label: 'Oldest first' },
    { mode: 'views', label: 'Sort by views' }
  ];

  modes.forEach(m => {
    const btn = document.createElement('button');
    btn.textContent = m.label;
    btn.dataset.mode = m.mode;
    btn.addEventListener('click', () => {
      if (sortMode === m.mode) return;
      sortMode = m.mode;
      updateSortButtonsActive();
      applyFiltersAndSort();
    });
    sortButtons.appendChild(btn);
  });
}

function updateSortButtonsActive() {
  const sortButtons = document.querySelectorAll('#sort-buttons button');
  sortButtons.forEach(btn => {
    const mode = btn.dataset.mode;
    const active = mode === sortMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

// ---------------- filtering & sorting ----------------

function applyFilter(filterType, value) {
  const current = currentFilters[filterType];

  if (value !== 'all' && current === value) {
    currentFilters[filterType] = 'all';
  } else {
    Object.keys(currentFilters).forEach(k => {
      currentFilters[k] = (k === filterType) ? value : 'all';
    });
  }

  document.querySelectorAll(`.filter-container button[data-filter-type="${filterType}"]`)
    .forEach(btn => {
      const v = btn.dataset.value;
      const active = v === currentFilters[filterType] && currentFilters[filterType] !== 'all';
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

  document.querySelectorAll(`.section-buttons button[data-filter-type="${filterType}"]`)
    .forEach(btn => {
      const v = btn.dataset.value;
      const active = v === currentFilters[filterType] && currentFilters[filterType] !== 'all';
      btn.classList.toggle('active', active);
    });

  applyFiltersAndSort();
}

function applyFiltersAndSort() {
  if (!allSections || !allSections.length) return;

  const activeEntry = Object.entries(currentFilters).find(([, val]) => val !== 'all');

  allSections.forEach(section => {
    let show = true;

    if (activeEntry) {
      const [filterType, value] = activeEntry;

      if (filterType === 'type') {
        const sectionType = (section.dataset.type || '').toUpperCase();
        if (value === 'NON-MBTI') {
          show = !sectionType.split(/[\s,]+/).some(t => MBTI_TYPES.has(t));
        } else {
          show = sectionType.split(/[\s,]+/).includes(value);
        }
      } else if (filterType === 'meme') {
        const sectionMeme = (section.dataset.meme || '').toLowerCase().trim();
        show = sectionMeme === value.toLowerCase();
      } else if (filterType === 'keywords') {
        const sectionKeywords = (section.dataset.keywords || '').toLowerCase();
        const tokens = sectionKeywords.split(',').map(s => s.trim()).filter(Boolean);
        const v = value.toLowerCase();
        if (v.includes(' ')) {
          show = tokens.some(t => t === v);
        } else {
          show = tokens.some(t => t.includes(v));
        }
      }
    }

    section.classList.toggle('hidden', !show);
  });

  const main = document.querySelector('main');
  if (!main) return;

  const sorted = Array.from(allSections);
  sorted.sort((a, b) => {
    if (sortMode === 'views') {
      const va = parseInt(a.dataset.views || '0', 10);
      const vb = parseInt(b.dataset.views || '0', 10);
      return vb - va;
    }
    const ia = parseInt(a.dataset.index || '0', 10);
    const ib = parseInt(b.dataset.index || '0', 10);
    return sortMode === 'oldest' ? ia - ib : ib - ia;
  });

  sorted.forEach(sec => main.appendChild(sec));
}

// ---------------- Imgflip icons row ----------------

function setupImgflipIcons() {
  const header = document.querySelector('header');
  if (!header) return;

  let infoP = document.getElementById('current-imgflip-icon');
  if (!infoP) {
    infoP = document.createElement('p');
    infoP.id = 'current-imgflip-icon';
    infoP.className = 'art-process';
    header.appendChild(infoP);
  }

  const currentIconIndex = 12; // update manually if you change it on Imgflip

  infoP.innerHTML = `Views icon: <a href="https://imgflip.com/user/mbtininja" target="_blank" rel="noopener">@mbtininja on Imgflip</a>`;

  let row = document.getElementById('imgflip-icon-row');
  if (!row) {
    row = document.createElement('div');
    row.id = 'imgflip-icon-row';
    row.className = 'imgflip-icon-row';
    header.appendChild(row);
  }
  row.innerHTML = '';

  const thresholds = [
    0, 250, 500, 1000, 2000, 3000, 5000,
    7000, 8000, 10000, 15000, 20000, 30000
  ];

  thresholds.forEach((value, idx) => {
    const iconIndex = idx + 1;
    const wrapper = document.createElement('div');
    wrapper.className = 'imgflip-icon';

    if (iconIndex <= currentIconIndex) {
      wrapper.classList.add('owned');
    } else {
      wrapper.classList.add('locked');
    }
    if (iconIndex === currentIconIndex) {
      wrapper.classList.add('current');
    }

    const img = document.createElement('img');
    img.src = `images/icon_${iconIndex}.svg`;
    img.alt = `Icon ${iconIndex}`;
    img.addEventListener('click', () => {
      window.open('https://imgflip.com/user/mbtininja', '_blank', 'noopener');
    });

    const label = document.createElement('span');
    label.className = 'imgflip-icon-label';
    label.textContent = value >= 1000 ? `${value / 1000}k` : `${value}`;

    wrapper.appendChild(img);
    wrapper.appendChild(label);
    row.appendChild(wrapper);
  });
}
