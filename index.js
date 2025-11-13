// script.js
// Admin/utility script for memes.mbti.ninja
// - Manually refresh the Cloudflare Worker KV feed
// - Pull a fresh feed (to update view counts) and preview items
// - Optional single-item view if ?id=<imgflipId> is present

(() => {
  const FEED_BASE = 'https://rapid-math-6088.touch-97a.workers.dev';

  document.addEventListener('DOMContentLoaded', () => {
    wireControls();
    const id = getQueryParam('id');
    if (id) {
      showSingle(id).catch(err => log('Single-item load failed: ' + err.message));
    } else {
      // Optional: auto-load a small fresh preview
      loadFreshPreview(12).catch(err => log('Fresh preview failed: ' + err.message));
    }
  });

  async function refreshKV() {
    const t0 = performance.now();
    const res = await fetch(`${FEED_BASE}/refresh`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const t1 = performance.now();
    log(`Refreshed KV with ${json.items?.length ?? 0} items in ${fmtMs(t1 - t0)} (source=${json.source || 'manual'})`);
    renderList(json.items || []);
    return json.items || [];
  }

  async function loadFreshPreview(limit = 30) {
    const t0 = performance.now();
    const res = await fetch(`${FEED_BASE}/feed?fresh=1`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const items = Array.isArray(json.items) ? json.items.slice(0, limit) : [];
    const t1 = performance.now();
    log(`Loaded fresh feed: ${items.length} items in ${fmtMs(t1 - t0)} (source=${json.source || 'fresh'})`);
    renderList(items);
    return items;
  }

  async function loadFromKV(limit = 60) {
    const t0 = performance.now();
    const res = await fetch(`${FEED_BASE}/feed`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const items = Array.isArray(json.items) ? json.items.slice(0, limit) : [];
    const t1 = performance.now();
    log(`Loaded cached feed: ${items.length} items in ${fmtMs(t1 - t0)} (source=${json.source || 'kv'})`);
    renderList(items);
    return items;
  }

  async function showSingle(id) {
    // Try to find the item in a fresh feed first (ensures latest views).
    let items = await loadFreshPreview(100);
    let item = items.find(x => x.id === id);
    if (!item) {
      // Fallback to KV (which may contain older items if not in fresh window)
      items = await loadFromKV(200);
      item = items.find(x => x.id === id);
    }
    if (!item) {
      throw new Error(`Item ${id} not found in feed. If it’s very old, run /refresh then reload.`);
    }
    renderList([item]);
    scrollIntoView('#list');
  }

  // -------------------- UI wiring --------------------

  function wireControls() {
    bindClick('#btn-refresh', async (btn) => {
      toggleBusy(btn, true);
      try { await refreshKV(); } finally { toggleBusy(btn, false); }
    });

    bindClick('#btn-fresh', async (btn) => {
      toggleBusy(btn, true);
      try { await loadFreshPreview(30); } finally { toggleBusy(btn, false); }
    });

    bindClick('#btn-kv', async (btn) => {
      toggleBusy(btn, true);
      try { await loadFromKV(60); } finally { toggleBusy(btn, false); }
    });

    // Basic search by title/keyword/meme type
    bindInput('#search', (val) => {
      filterRendered(val);
    });
  }

  function renderList(items) {
    const host = document.querySelector('#list');
    if (!host) return;

    if (!Array.isArray(items)) items = [];
    const html = items.map(renderCard).join('') || `<p class="muted">No items.</p>`;
    host.innerHTML = html;
    wireCardFilters(host);
  }

  function renderCard(item) {
    const title = escapeHtml(item.title || item.id || 'Untitled');
    const img = escapeAttr(item.image_url || (item.id ? `https://i.imgflip.com/${item.id}.jpg` : ''));
    const page = escapeAttr(item.page_url || (item.id ? `https://imgflip.com/i/${item.id}` : '#'));
    const meme = (item.meme_type || item.meme_tag || '').toString().toLowerCase();
    const keywords = (Array.isArray(item.keywords) ? item.keywords : (Array.isArray(item.tags) ? item.tags : []))
      .map(k => String(k).toLowerCase());
    const types = (item.mbti_types || []).map(t => String(t).toUpperCase());
    const views = Number.isFinite(item.views) ? item.views : null;

    const chips = [
      meme && `<button class="chip" data-filter="meme" data-value="${escapeAttr(meme)}">${escapeHtml(meme)}</button>`,
      ...types.map(t => `<button class="chip" data-filter="type" data-value="${escapeAttr(t)}">${escapeHtml(t)}</button>`),
      ...keywords.map(k => `<button class="chip" data-filter="kw" data-value="${escapeAttr(k)}">${escapeHtml(k)}</button>`)
    ].filter(Boolean).join(' ');

    return `
      <article class="card" data-id="${escapeAttr(item.id || '')}"
               data-meme="${escapeAttr(meme)}"
               data-types="${escapeAttr(types.join(','))}"
               data-keywords="${escapeAttr(keywords.join(','))}">
        <header class="row">
          <h3 class="title">${title}</h3>
          ${views !== null ? `<span class="views">${numberWithCommas(views)} views</span>` : ``}
        </header>
        <a class="image" href="${page}" target="_blank" rel="noopener">
          <img loading="lazy" src="${img}" alt="${title} Meme">
        </a>
        <footer class="row wrap">
          <a class="icon" href="${page}" target="_blank" rel="noopener" title="Open on Imgflip">
            <img src="images/imgflip.svg" alt="Imgflip">
          </a>
          ${meme ? `<a class="icon" href="https://knowyourmeme.com/search?q=${encodeURIComponent(meme)}" target="_blank" rel="noopener" title="Search on KnowYourMeme">
            <img src="images/Know_Your_Meme.svg" alt="Know Your Meme">
          </a>` : ``}
          <div class="chips">${chips}</div>
        </footer>
      </article>
    `;
  }

  function wireCardFilters(root) {
    root.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const type = btn.getAttribute('data-filter');
        const val = btn.getAttribute('data-value');
        const search = document.querySelector('#search');
        if (!search) return;
        if (type === 'type') search.value = `type:${val}`;
        else if (type === 'meme') search.value = `meme:${val}`;
        else search.value = val;
        filterRendered(search.value);
      });
    });
  }

  function filterRendered(query) {
    const q = (query || '').toLowerCase().trim();
    const cards = document.querySelectorAll('#list .card');
    if (!q) {
      cards.forEach(el => el.style.display = '');
      setCount(cards.length);
      return;
    }

    // Basic syntax:
    //   "foo" (matches title/keywords/meme)
    //   "type:ENTP"
    //   "meme:drake hotline bling"
    let predicate;
    if (q.startsWith('type:')) {
      const v = q.slice(5).toUpperCase();
      predicate = el => (el.getAttribute('data-types') || '').split(',').includes(v);
    } else if (q.startsWith('meme:')) {
      const v = q.slice(5).trim();
      predicate = el => (el.getAttribute('data-meme') || '') === v;
    } else {
      predicate = el => {
        const title = (el.querySelector('.title')?.textContent || '').toLowerCase();
        const meme = (el.getAttribute('data-meme') || '').toLowerCase();
        const kws = (el.getAttribute('data-keywords') || '').toLowerCase();
        return title.includes(q) || meme.includes(q) || kws.includes(q);
      };
    }

    let shown = 0;
    cards.forEach(el => {
      const ok = predicate(el);
      el.style.display = ok ? '' : 'none';
      if (ok) shown++;
    });
    setCount(shown);
  }

  function setCount(n) {
    const el = document.querySelector('#count');
    if (el) el.textContent = String(n);
  }

  // -------------------- small DOM helpers --------------------

  function bindClick(sel, handler) {
    const el = document.querySelector(sel);
    if (!el) return;
    el.addEventListener('click', async () => {
      try { await handler(el); } catch (e) { log(String(e)); }
    });
  }

  function bindInput(sel, handler) {
    const el = document.querySelector(sel);
    if (!el) return;
    el.addEventListener('input', () => handler(el.value));
  }

  function toggleBusy(btn, on) {
    if (!btn) return;
    btn.disabled = !!on;
    btn.setAttribute('aria-busy', on ? 'true' : 'false');
    if (on) btn.dataset._text = btn.textContent;
    btn.textContent = on ? 'Working…' : (btn.dataset._text || btn.textContent);
  }

  function log(msg) {
    const out = document.querySelector('#status');
    if (out) {
      const time = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
      out.innerHTML = `[${time}] ${escapeHtml(msg)}<br>` + out.innerHTML;
    } else {
      console.log('[script.js]', msg);
    }
  }

  function scrollIntoView(sel) {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function getQueryParam(k) {
    const u = new URL(window.location.href);
    return u.searchParams.get(k);
  }

  function fmtMs(ms) {
    return `${Math.round(ms)}ms`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function numberWithCommas(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return String(x);
    return n.toLocaleString('en-US');
  }
})();
