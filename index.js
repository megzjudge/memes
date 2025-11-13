// index.js
// Fetches feed from the Worker, renders sections, and builds your existing filter UI.
// Uses ?fresh=1 to keep view counts current each page load.
// The Meme Type now comes from the /memegenerator/... "recaption" link (Title Case).

document.addEventListener('DOMContentLoaded', () => {
  console.log(
    'Script loaded at',
    new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })
  );

  bootstrap().catch(err => {
    console.error('Bootstrap failed:', err);
    // Fallback: keep any hardcoded sections so the page still works
    initFilters();
  });
});

async function bootstrap() {
  const FEED_URL = 'https://rapid-math-6088.touch-97a.workers.dev/feed?fresh=1';

  // 1) Fetch feed from the Worker
  const res = await fetch(FEED_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);
  const payload = await res.json();
  const items = Array.isArray(payload.items) ? payload.items : [];

  console.log(`Loaded ${items.length} items from feed.`);

  // 2) Render sections (replace any static blocks)
  const main = document.querySelector('main');
  if (!main) throw new Error('<main> not found');
  main.innerHTML = '';

  const frag = document.createDocumentFragment();
  for (const item of items) {
    const section = document.createElement('section');
    section.className = 'content-section';

    const mbtiTypes = (item.mbti_types || []).map(t => String(t).toUpperCase());
    const typeList = mbtiTypes.length ? mbtiTypes.join(', ') : 'non-mbti';

    const memeType = (item.meme_type || item.meme_tag || '').toString();
    const memeTagLower = memeType.toLowerCase();
    const keywords = Array.isArray(item.keywords)
      ? item.keywords.join(',')
      : Array.isArray(item.tags)
      ? item.tags.join(',')
      : '';

    section.dataset.type = typeList;
    section.dataset.meme = memeTagLower;
    section.dataset.keywords = keywords;

    const title = escapeHtml(item.title || item.id || 'Untitled');
    const pageUrl = item.page_url || `https://imgflip.com/i/${item.id}`;
    const imageUrl = item.image_url || (item.id ? `https://i.imgflip.com/${item.id}.jpg` : '');
    const views = typeof item.views === 'number' ? item.views : null;

    section.innerHTML = `
      <div class="info-box">
        <div class="title-row">
          <h3>${title}</h3>
          <p class="image-links">
            <a href="${pageUrl}" target="_blank" rel="noopener">
              <img src="images/imgflip.svg" alt="Imgflip link">
            </a>
            ${
              memeTagLower
                ? `<a href="https://knowyourmeme.com/search?q=${encodeURIComponent(memeType)}" target="_blank" rel="noopener">
                     <img src="images/Know_Your_Meme.svg" alt="Know Your Meme">
                   </a>`
                : ''
            }
          </p>
          ${views !== null ? `<span class="view-count">${numberWithCommas(views)} views</span>` : ``}
        </div>
        <div class="section-buttons"></div>
      </div>
      <div class="image-container">
        <img src="${imageUrl}" alt="${title} Meme" loading="lazy">
      </div>
    `;

    frag.appendChild(section);
  }

  main.appendChild(frag);

  // 3) Build filters + per-section buttons
  initFilters();
}

// ---------------- Filter/UI logic (adapted from your original) ----------------

function initFilters() {
  const sections = document.querySelectorAll('.content-section');
  console.log('Found sections:', sections.length, 'Details:', Array.from(sections).map(s => ({
    outerHTML: s.outerHTML.slice(0, 100),
    dataset: s.dataset
  })));

  const containers = {
    type: document.getElementById('type-buttons'),
    meme: document.getElementById('meme-buttons'),
    keywords: document.getElementById('keywords-buttons')
  };
  console.log(
    'Container status:',
    Object.fromEntries(
      Object.entries(containers).map(([k, v]) => [k, v ? 'Present' : 'Missing'])
    )
  );

  const types = new Set();
  const keywordsSet = new Set();
  const memes = new Set();

  sections.forEach((section, idx) => {
    console.log(`Processing section ${idx + 1} data:`, section.dataset);
    if (section.dataset.type) {
      const typeStr = section.dataset.type.toString().toUpperCase().trim();
      typeStr.split(/[\s,]+/).forEach(t => {
        const trimmedT = t.trim();
        if (trimmedT) types.add(trimmedT);
      });
    }
    if (section.dataset.keywords) {
      const keywordsStr = section.dataset.keywords.toString().toLowerCase().trim();
      const keywordsArray = keywordsStr
        .split(',')
        .map(kw => kw.trim())
        .filter(kw => kw.length > 0);
      keywordsArray.forEach(kw => keywordsSet.add(kw));
    }
    if (section.dataset.meme) {
      const memeStr = section.dataset.meme.toString().toLowerCase().trim();
      if (memeStr) memes.add(memeStr);
    }

    const buttonsContainer = section.querySelector('.section-buttons');
    if (buttonsContainer) {
      const buttonData = [];
      if (section.dataset.type) {
        const typeStr = section.dataset.type.trim();
        typeStr.split(/[\s,]+/).forEach(t => {
          const tTrimmed = t.trim();
          if (tTrimmed) {
            const typeUpper = tTrimmed.toUpperCase();
            buttonData.push({ type: 'type', value: typeUpper, label: `Type: ${typeUpper}` });
          }
        });
      }
      if (section.dataset.meme) {
        const memeStr = section.dataset.meme.toLowerCase().trim();
        if (memeStr) {
          // Display the meme type in Title Case for buttons
          const memeLabel = memeStr.split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
          buttonData.push({ type: 'meme', value: memeStr, label: memeLabel });
        }
      }
      if (section.dataset.keywords) {
        const keywordsStr = section.dataset.keywords.toLowerCase().trim();
        const keywordsArray = keywordsStr
          .split(',')
          .map(kw => kw.trim())
          .filter(kw => kw.length > 0);
        keywordsArray.forEach(kw => {
          if (kw) {
            buttonData.push({ type: 'keywords', value: kw, label: kw });
          }
        });
      }

      if (buttonData.length) {
        buttonsContainer.innerHTML = '';
        buttonData.forEach(data => {
          const button = document.createElement('button');
          button.textContent = data.label;
          button.dataset.filterType = data.type;
          button.dataset.value = data.value;
          button.addEventListener('click', () => filterSections(data.type, data.value));
          buttonsContainer.appendChild(button);
        });
      }
    }
  });

  const mbtiTypes = new Set([
    'ESTP','ISTP','ESFP','ISFP','ESTJ','ISTJ','ESFJ','ISFJ',
    'ENFP','INFP','ENFJ','INFJ','ENTJ','INTJ','ENTP','INTP'
  ]);
  mbtiTypes.forEach(t => types.add(t));
  types.add('non-mbti');
  types.add('All');

  const sortedTypes = [...types].sort();
  const sortedKeywords = [...keywordsSet].sort();
  const sortedMemes = [...memes].sort();

  function createButtons(container, values, filterType) {
    if (container) {
      const allButton = document.createElement('button');
      allButton.textContent = 'All';
      allButton.dataset.filterType = filterType;
      allButton.dataset.value = 'all';
      allButton.addEventListener('click', () => filterSections(filterType, 'all'));
      container.replaceChildren(allButton);

      values.forEach(value => {
        if (value && typeof value === 'string') {
          const button = document.createElement('button');
          const displayText =
            filterType === 'type'
              ? value === 'non-mbti' || value === 'All'
                ? value
                : value.toUpperCase()
              : value.split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
          button.textContent = displayText;
          button.dataset.filterType = filterType;
          button.dataset.value = value;
          button.addEventListener('click', () => filterSections(filterType, value));
          container.appendChild(button);
        }
      });
    }
  }

  createButtons(containers.type, sortedTypes, 'type');
  createButtons(containers.meme, sortedMemes, 'meme');
  createButtons(containers.keywords, sortedKeywords, 'keywords');

  let currentFilters = { type: 'all', meme: 'all', keywords: 'all' };

  function filterSections(filterType, value) {
    console.log(`Filtering ${filterType} with value:`, value);
    currentFilters[filterType] = value === currentFilters[filterType] ? 'all' : value;
    console.log('Current filters:', currentFilters);

    // Update button active states for this filter type
    document.querySelectorAll(`button[data-filter-type="${filterType}"]`).forEach(btn => {
      const btnValue = btn.dataset.value;
      const isActive = btnValue === currentFilters[filterType] && currentFilters[filterType] !== 'all';
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', isActive);
    });

    const mbtiTypesSet = new Set([
      'ESTP','ISTP','ESFP','ISFP','ESTJ','ISTJ','ESFJ','ISFJ',
      'ENFP','INFP','ENFJ','INFJ','ENTJ','INTJ','ENTP','INTP'
    ]);

    sections.forEach(section => {
      section.classList.remove('hidden');
      const activeFilter = Object.entries(currentFilters).find(([_, val]) => val !== 'all');
      let matches = !activeFilter;
      let sectionValue = '';

      if (activeFilter) {
        const [activeType, activeValue] = activeFilter;

        if (activeType === 'type') {
          sectionValue = section.dataset.type ? section.dataset.type.toUpperCase().trim() : '';
          if (activeValue === 'non-mbti') {
            matches = !sectionValue.split(/[\s,]+/).some(t => mbtiTypesSet.has(t));
          } else if (activeValue === 'All') {
            matches = true;
          } else {
            matches = sectionValue.split(/[\s,]+/).includes(activeValue);
          }
        } else if (activeType === 'meme') {
          sectionValue = section.dataset.meme ? section.dataset.meme.toLowerCase().trim() : '';
          matches = sectionValue === activeValue;
        } else if (activeType === 'keywords') {
          sectionValue = section.dataset.keywords ? section.dataset.keywords.toLowerCase().trim() : '';
          const keywordsArray = sectionValue
            .split(',')
            .map(kw => kw.trim())
            .filter(kw => kw.length > 0);
          if (activeValue && activeValue.includes(' ')) {
            matches = keywordsArray.some(kw => kw === activeValue);
          } else if (activeValue) {
            matches = keywordsArray.some(kw => kw.includes(activeValue));
          } else {
            matches = false;
          }
        }
        console.log(`Checking ${activeType}='${activeValue}' against section value='${sectionValue}': ${matches}`);
      }

      section.classList.toggle('hidden', !matches);
    });
  }

  // Initialize all filters to 'all'
  Object.keys(currentFilters).forEach(filter => filterSections(filter, 'all'));
}

// ---------------- Utilities ----------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

function numberWithCommas(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x);
  return n.toLocaleString('en-US');
}
