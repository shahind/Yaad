import * as store from './store.js';
import { renderMeaning, meaningText, markTerms, markMatch, markLiteral, markRanges, highlightWord, esc } from './render.js';
import { copyText, shareText, isNative, isElectron, plugin } from './platform.js';
import { normalizeCompact, normalizeQuoted, quotedMatch, termTester } from './normalize.js';
import { parseSearchQuery, buildWordQuery, readSearchHelperBuilder, getSearchHelpers, adaptSearchHelperRule, canonicalizeSearchQuery, SEARCH_STRINGS, formatSearchString, SEARCH_FILTER_TAGS, SEARCH_SCOPES, hasTagFilters, separateSearchFilters } from './search-syntax.js';
import { ENTRY_TAGS, compatibleTagIndex } from './search-origin-grammar.js';
import { SENSE_TAGS, compatibleSenseIndex, readOpeningTags, splitSenses } from './search-subject-usage.js';
import { plainMeaning, compactMatches } from './search-match-text.js';
import { SOURCE_VERSION, SOURCE_TAGS, sourceOwners } from './search-citations.js';

// ------------------------------------------------------------------ worker RPC

const worker = new Worker(new URL('./search.worker.js', import.meta.url), { type: 'module' });
let rpcSeq = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const { id, result, error, progress } = e.data;
  const p = pending.get(id);
  if (!p) return;
  if (progress) {
    p.onProgress?.(progress);
    return;
  }
  pending.delete(id);
  error ? p.reject(new Error(error)) : p.resolve(result);
};
const call = (type, payload, onProgress) =>
  new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, type, payload });
  });

// ------------------------------------------------------------------ helpers

const $ = (sel, root = document) => root.querySelector(sel);
const fa = (n) => Number(n).toLocaleString('fa-IR');
const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
const el = {
  app: $('#app'),
  q: $('#q'),
  clear: $('#btn-clear'),
  status: $('#status'),
  results: $('#results'),
  home: $('#home'),
  side: $('#side-body'),
  view: $('#view'),
  sheet: $('#sheet'),
  backdrop: $('#sheet-backdrop'),
  toast: $('#toast'),
};

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1800);
}

const mobile = () => matchMedia('(max-width: 860px)').matches;
// Web version only: where to get the Android app.
const bazaarLink = () =>
  isNative || isElectron
    ? ''
    : `<br/><a class="store-link" href="https://cafebazaar.ir/app/com.shahinsoft.yaad" target="_blank" rel="noopener">دریافت نسخهٔ اندروید از کافه‌بازار</a>`;
const entryHref = (id, extra = '') => `#/e/${id}${extra}`;

// ------------------------------------------------------------------ theme & settings

function effectiveTheme() {
  const t = store.settings().theme;
  if (t !== 'system') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applySettings() {
  const s = store.settings();
  if (s.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = s.theme;
  document.documentElement.style.setProperty('--reading-scale', s.font);
  $('#btn-theme').innerHTML = icon(effectiveTheme() === 'dark' ? 'sun' : 'moon');
  const dark = effectiveTheme() === 'dark';
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#0d1420' : '#f4f6fa'));
  if (isNative) {
    const sb = plugin('StatusBar');
    sb?.setStyle?.({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {});
    sb?.setBackgroundColor?.({ color: dark ? '#0d1420' : '#f4f6fa' }).catch(() => {});
  }
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applySettings);

$('#btn-theme').addEventListener('click', () => {
  store.setSetting('theme', effectiveTheme() === 'dark' ? 'light' : 'dark');
  applySettings();
});

// ------------------------------------------------------------------ search

const PAGE = 40;
const HEAD_LIMIT = 400; // mirrors the worker cap
const headCount = (head) => (head.length >= HEAD_LIMIT ? `+${fa(HEAD_LIMIT)}` : fa(head.length));
const search = { q: '', text: '', mode: 'text', filters: {}, tagMatch: {}, head: [], meaning: [], terms: [], meaningTotal: 0, meaningLimited: false, seq: 0, shownHead: 0, shownMeaning: 0, meaningPending: false, meaningError: '', meaningNotice: '' };
const meaningCount = () => `${search.meaningLimited ? '+' : ''}${fa(search.meaningTotal)}`;
let meaningTimer;

el.q.addEventListener('input', () => runSearch(el.q.value));
el.clear.addEventListener('click', () => {
  el.q.value = '';
  runSearch('');
  el.q.focus();
});

async function runSearch(q) {
  try {
    const legacy = separateSearchFilters(q);
    if (hasTagFilters(legacy.filters)) {
      search.filters = legacy.filters;
      search.tagMatch = {};
      q = legacy.q;
      el.q.value = q;
    }
    const canonical = canonicalizeSearchQuery(q);
    if (canonical !== q) { q = canonical; el.q.value = q; }
  } catch { /* Query validation below reports incomplete input. */ }
  const seq = ++search.seq;
  const filters = { ...search.filters };
  const tagMatch = { ...search.tagMatch };
  const filterCount = SEARCH_FILTER_TAGS.filter((tag) => filters[tag.key] === 1 || filters[tag.key] === -1).length;
  $('#search-filter-bar').hidden = !filterCount;
  $('#btn-search-filters').textContent = `برچسب‌های فعال (${fa(filterCount)})`;
  search.q = q;
  el.clear.hidden = !q;
  el.q.removeAttribute('aria-invalid');
  clearTimeout(meaningTimer);
  search.head = [];
  search.meaning = [];
  search.terms = [];
  search.meaningTotal = 0;
  search.meaningLimited = false;
  search.meaningError = '';
  search.meaningNotice = '';
  el.results.innerHTML = '';
  let query;
  try {
    query = parseSearchQuery(q);
  } catch (error) {
    call('cancelSearch').catch(() => {});
    showSearchError(error);
    return;
  }
  search.mode = query.mode;
  search.text = query.text || '';
  search.highlightContext = query.mode === 'regex' || query.mode === 'scoped' ? encodeURIComponent(JSON.stringify([q,
    Object.fromEntries(Object.entries(filters).filter(([, state]) => state === 1 || state === -1)),
    Object.fromEntries(Object.entries(tagMatch).filter(([, mode]) => mode === 'all')),
  ])) : '';
  el.q.dir = query.mode === 'regex' || query.mode === 'scoped' ? 'ltr' : 'rtl';
  if (!filterCount && ((query.mode === 'text' && !normalizeCompact(query.text)) || (query.mode === 'exact' && !normalizeQuoted(query.text)))) {
    call('cancelSearch').catch(() => {});
    el.status.textContent = '';
    el.home.hidden = false;
    renderHome();
    return;
  }
  el.home.hidden = true;
  el.status.textContent = 'در حال جستجو…';
  const hasMeanings = query.mode !== 'scoped' || query.hasMeanings;
  if (query.mode === 'scoped' && hasMeanings) {
    call('cancelSearch').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (seq !== search.seq) return;
  }
  let response;
  try {
    response = await call('search', { q, filters, tagMatch }, query.mode === 'scoped' ? (progress) => {
      if (seq === search.seq) el.status.textContent = `جستجو در معنی‌ها: ${fa(progress.scanned)} از ${fa(progress.total)} بخش`;
    } : undefined);
  } catch (error) {
    if (seq === search.seq) showSearchError(error);
    return;
  }
  if (seq !== search.seq) return;
  const { head, ms } = response;
  search.head = head;
  search.meaningPending = hasMeanings;
  search.shownHead = 0;
  search.shownMeaning = 0;
  renderResults();
  el.status.textContent = `${headCount(head)} واژه · ${fa(Math.max(1, Math.round(ms)))} میلی‌ثانیه${hasMeanings && query.mode !== 'text' ? ' · جستجو در معنی‌ها…' : ''}`;
  if (!hasMeanings) return;
  // Meaning search loads shards or definition blocks; give fast typists a moment.
  meaningTimer = setTimeout(async () => {
    try {
      const exclude = head.filter((h) => !h.phrase && h.tier <= 1).map((h) => h.id);
      const r = await call('meanings', { q, filters, tagMatch, exclude, progress: query.mode !== 'text' }, (progress) => {
        if (seq !== search.seq) return;
        search.meaning.push(...progress.results);
        search.meaningTotal = progress.matched;
        if (search.meaning.length) {
          search.meaningPending = false;
          renderMeaningSection();
        }
        el.status.textContent = progress.stage === 'index'
          ? `${headCount(head)} واژه · جستجو در معنی‌ها: ${fa(progress.scanned)} از ${fa(progress.total)} بخش · ${fa(progress.matched)} نتیجه`
          : formatSearchString(SEARCH_STRINGS.progress.check, { head: headCount(head),
            stage: progress.stage === 'definitions' ? SEARCH_STRINGS.progress.definitions : SEARCH_STRINGS.progress.phrase,
            scanned: fa(progress.scanned), total: fa(progress.total), matched: fa(progress.matched) });
      });
      if (seq !== search.seq) return;
      search.meaning = r.results;
      search.terms = r.terms;
      search.meaningTotal = r.total || 0;
      search.meaningLimited = !!r.limited;
      search.meaningNotice = r.unindexed ? 'این عبارت واژهٔ قابل جستجو در معنی‌ها ندارد.'
        : r.unsupported ? 'این الگو در معنی‌ها اجرا نمی‌شود؛ آن را ساده‌تر کنید.'
          : r.candidateLimited ? 'عبارت فقط در هزار نتیجهٔ برتر بررسی می‌شود.' : '';
      search.meaningPending = false;
      renderMeaningSection();
      el.status.textContent = `${headCount(head)} واژه · ${meaningCount()} در معنی‌ها${query.mode === 'exact' ? ' · جستجوی عبارتی' : ''}`;
    } catch (error) {
      if (seq !== search.seq) return;
      search.meaningPending = false;
      search.meaningError = query.mode !== 'text'
        ? 'جستجوی معنی‌ها کامل نشد؛ نتیجه‌ها ممکن است ناقص باشند.'
        : 'جستجوی معنی‌ها ناموفق بود؛ دوباره تلاش کنید.';
      renderMeaningSection();
      el.status.textContent = search.meaningError;
    }
  }, query.mode === 'regex' ? 350 : head.length ? 180 : 60);
}

function showSearchError(error) {
  el.home.hidden = true;
  el.q.setAttribute('aria-invalid', 'true');
  el.status.textContent = error.message;
  el.results.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
}

function itemHTML(r, kind) {
  const terms = r.terms || search.terms;
  let href = r.range ? entryHref(r.id, `?s=${r.range.join(',')}${kind === 'm' && r.match ? `&r=${r.match.start},${r.match.end}` : search.mode === 'exact' ? `&q=${encodeURIComponent(search.text)}` : terms.length ? `&t=${encodeURIComponent(terms.join(' '))}${r.terms ? '&exact=1' : ''}` : ''}`) : r.phrase
    ? entryHref(r.id, `?p=${encodeURIComponent(r.w)}`)
    : kind === 'm'
      ? entryHref(r.id, r.match ? `?r=${r.match.start},${r.match.end}` : search.mode === 'exact' ? `?q=${encodeURIComponent(search.text)}` : `?t=${encodeURIComponent(terms.join(' '))}${r.terms ? '&exact=1' : ''}`)
      : entryHref(r.id);
  if (search.highlightContext) href += `${href.includes('?') ? '&' : '?'}h=${search.highlightContext}${r.phrase ? `&hw=${encodeURIComponent(r.w)}` : ''}`;
  const word = kind === 'h' ? highlightWord(r.w, search.text, r.match) : esc(r.w);
  const extra = r.phrase ? `<span class="tag">ترکیب</span><span class="item-parent">در «${esc(r.parent)}»</span>` : '';
  return `<a class="item" href="${href}" data-id="${r.id}" data-kind="${kind}" data-w="${esc(r.w)}" data-p="${r.phrase ? 1 : 0}"${r.terms ? ` data-t="${esc(r.terms.join(' '))}"` : ''}${r.range ? ` data-s="${r.range.join(',')}"` : ''}${r.snippet && !search.highlightContext ? ' data-obs="1"' : ''}>
    <div class="item-head"><span class="item-word">${word}</span><span class="item-pron">${r.snippet ? esc(r.snippet.pron) : ''}</span>${extra}</div>
    <div class="item-snippet">${r.snippet ? markMatch(r.snippet.text, r.snippet.matches || r.snippet.match) : ''}</div></a>`;
}

function renderResults() {
  const { head } = search;
  let html = '';
  if (head.length) {
    html += `<div class="section-title"><span>واژه‌ها</span><span class="count">${headCount(head)}</span></div><div class="card" id="head-list"></div>`;
  }
  html += `<div id="meaning-section"></div>`;
  el.results.innerHTML = html;
  el.side.scrollTop = 0;
  appendItems('h');
  renderMeaningSection();
  markCurrent();
}

function renderMeaningSection() {
  const sec = $('#meaning-section');
  if (!sec) return;
  if (search.meaningPending) {
    sec.innerHTML = search.head.length ? '' : `<div class="empty">در حال جستجو…</div>`;
    return;
  }
  if (search.meaningError && !search.meaning.length) {
    sec.innerHTML = `<div class="empty">${esc(search.meaningError)}</div>`;
    return;
  }
  if (search.meaningNotice && !search.meaning.length) {
    sec.innerHTML = `<div class="empty">${esc(search.meaningNotice)}</div>`;
    return;
  }
  if (!search.meaning.length) {
    sec.innerHTML = search.head.length
      ? ''
      : `<div class="empty">${icon('search')}<br/>چیزی یافت نشد.<br/><small>املای دیگری را بیازمایید.</small></div>`;
    return;
  }
  const list = $('#meaning-list', sec);
  if (list) {
    $('.count', sec).textContent = meaningCount();
    const more = $('.more', list);
    if (more) more.textContent = `نمایش بیشتر (${fa(search.meaning.length - search.shownMeaning)})`;
    else if (search.shownMeaning < search.meaning.length) appendItems('m');
    if (search.meaningError && !$('.meaning-search-error', sec)) {
      sec.insertAdjacentHTML('afterbegin', `<div class="empty meaning-search-error">${esc(search.meaningError)}</div>`);
    }
    if (search.meaningNotice && !$('.meaning-search-notice', sec)) {
      sec.insertAdjacentHTML('afterbegin', `<div class="empty meaning-search-notice">${esc(search.meaningNotice)}</div>`);
    }
    return;
  }
  sec.innerHTML = `${search.meaningNotice ? `<div class="empty meaning-search-notice">${esc(search.meaningNotice)}</div>` : ''}<div class="section-title"><span>در معنی‌ها</span><span class="count">${meaningCount()}</span></div><div class="card" id="meaning-list"></div>`;
  search.shownMeaning = 0;
  appendItems('m');
}

function appendItems(kind) {
  const list = $(kind === 'h' ? '#head-list' : '#meaning-list');
  if (!list) return;
  const arr = kind === 'h' ? search.head : search.meaning;
  const from = kind === 'h' ? search.shownHead : search.shownMeaning;
  const to = Math.min(arr.length, from + PAGE);
  list.querySelector('.more')?.remove();
  list.insertAdjacentHTML('beforeend', arr.slice(from, to).map((r) => itemHTML(r, kind)).join(''));
  if (kind === 'h') search.shownHead = to;
  else search.shownMeaning = to;
  if (to < arr.length) {
    list.insertAdjacentHTML('beforeend', `<button class="more" data-more="${kind}">نمایش بیشتر (${fa(arr.length - to)})</button>`);
    moreObserver.observe(list.lastElementChild);
  }
  list.querySelectorAll('.item:not([data-obs])').forEach((it) => {
    it.dataset.obs = 1;
    snippetObserver.observe(it);
  });
}

el.results.addEventListener('click', (e) => {
  const more = e.target.closest('[data-more]');
  if (more) appendItems(more.dataset.more);
});

const moreObserver = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      moreObserver.unobserve(en.target);
      if (en.target.isConnected) appendItems(en.target.dataset.more);
    }
  },
  { root: el.side, rootMargin: '400px' },
);

// Snippets are loaded lazily for visible rows, batched per frame.
const snippetCache = new Map();
let snippetQueue = [];
let snippetScheduled = false;
const snippetObserver = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      snippetObserver.unobserve(en.target);
      snippetQueue.push(en.target);
    }
    if (snippetQueue.length && !snippetScheduled) {
      snippetScheduled = true;
      requestAnimationFrame(flushSnippets);
    }
  },
  { root: el.side, rootMargin: '200px' },
);

async function flushSnippets() {
  snippetScheduled = false;
  const current = { ...search, filters: { ...search.filters }, tagMatch: { ...search.tagMatch } };
  const pattern = current.mode === 'regex' || current.mode === 'scoped';
  const items = snippetQueue.splice(0);
  const groups = { plain: [], terms: [] };
  for (const it of items) {
    if (it.isConnected) (it.dataset.kind === 'm' ? groups.terms : groups.plain).push(it);
  }
  const fill = async (its, terms, exact = false, literal = '') => {
    if (!its.length) return;
    const request = (it) => {
      const words = it.dataset.t ? it.dataset.t.split(' ') : terms;
      const range = it.dataset.s ? it.dataset.s.split(',').map(Number) : undefined;
      const key = `${it.dataset.id}|${exact ? 'exact' : 'text'}|${words.join(' ')}|${literal}|${it.dataset.s || ''}${pattern ? `|${current.seq}|${it.dataset.kind}|${it.dataset.w}` : ''}`;
      return { key, id: +it.dataset.id, terms: words, range, kind: it.dataset.kind, ...(it.dataset.p === '1' ? { word: it.dataset.w } : {}) };
    };
    const need = [...new Map(its.map(request).filter((row) => !snippetCache.has(row.key)).map((row) => [row.key, row])).values()];
    if (need.length) {
      let res;
      try {
        res = await call('snippets', { requests: need, exact, literal,
          ...(pattern ? { q: current.q, filters: current.filters, tagMatch: current.tagMatch } : {}) });
      } catch { return; }
      if (current.seq !== search.seq) return;
      for (const r of res) snippetCache.set(r.key, r);
      if (snippetCache.size > 3000) snippetCache.clear();
    }
    for (const it of its) {
      if (!it.isConnected || current.seq !== search.seq) continue;
      const row = request(it);
      const s = snippetCache.get(row.key);
      if (!s) continue;
      const sn = it.querySelector('.item-snippet');
      if (s.matches || s.match) sn.innerHTML = markMatch(s.text, s.matches || s.match);
      else {
        sn.textContent = s.text;
        if (row.terms.length) markTerms(sn, row.terms, exact);
      }
      if (s.headMatches) it.querySelector('.item-word').innerHTML = highlightWord(it.dataset.w, current.text, s.headMatches);
      if (s.pron && it.dataset.p !== '1') it.querySelector('.item-pron').textContent = s.pron;
    }
  };
  await Promise.all([fill(groups.plain, []), fill(groups.terms, current.terms, pattern, current.mode === 'exact' ? current.text : '')]);
}

// Keyboard navigation in results.
el.q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = el.results.querySelector('.item');
    if (first) {
      location.hash = first.getAttribute('href');
      if (mobile()) el.q.blur();
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    el.results.querySelector('.item')?.focus();
  } else if (e.key === 'Escape') {
    el.clear.click();
  }
});
el.results.addEventListener('keydown', (e) => {
  const it = e.target.closest('.item');
  if (!it) return;
  const items = [...el.results.querySelectorAll('.item')];
  const i = items.indexOf(it);
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    items[i + 1]?.focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    (items[i - 1] || el.q).focus();
  }
});
document.addEventListener('keydown', (e) => {
  if (!el.sheet.hidden) return;
  if (e.key === '/' && document.activeElement !== el.q && !e.target.closest('input,textarea')) {
    e.preventDefault();
    el.q.focus();
    el.q.select();
  }
});

// ------------------------------------------------------------------ home

let randomWord = null;
async function renderHome() {
  const hist = store.getState().history;
  el.home.innerHTML = `
    <div class="hero" id="hero">
      <div class="hero-label">${icon('shuffle')} واژهٔ کاتوره</div>
      <div class="hero-word" id="hero-word">…</div>
      <div class="hero-text" id="hero-text"></div>
      <div class="hero-actions"><button class="chip-btn" id="hero-next">${icon('shuffle')} واژهٔ دیگر</button></div>
    </div>
    ${
      hist.length
        ? `<div class="section-title"><span>${'دیده‌شده‌های اخیر'}</span><button class="link-btn" id="clear-hist">پاک کردن</button></div>
           <div class="chips">${hist
             .slice(0, 24)
             .map((h) => `<a href="${entryHref(h.id)}">${esc(h.w)}</a>`)
             .join('')}</div>`
        : ''
    }
    <div class="stats" id="stats"></div>`;
  $('#hero').addEventListener('click', (e) => {
    if (e.target.closest('#hero-next')) {
      e.stopPropagation();
      loadRandom();
    } else if (randomWord != null) location.hash = entryHref(randomWord);
  });
  $('#clear-hist')?.addEventListener('click', () => {
    store.clearHistory();
    renderHome();
  });
  if (stats) $('#stats').innerHTML = `${fa(stats.entries)} مدخل · ${fa(stats.phrases)} ترکیب<br/>کاملاً آفلاین${bazaarLink()}`;
  if (randomWord == null) loadRandom();
  else showRandom();
}

async function loadRandom() {
  randomWord = await call('random');
  showRandom();
}

async function showRandom() {
  const e = await call('entry', { id: randomWord });
  if (!$('#hero-word')) return;
  $('#hero-word').textContent = e.word;
  $('#hero-text').textContent = meaningText(e.body).replace(/\n/g, ' ').slice(0, 300);
}

// ------------------------------------------------------------------ entry view

let current = null;

function markCurrent() {
  el.results.querySelectorAll('.item.current').forEach((x) => x.classList.remove('current'));
  if (current) el.results.querySelectorAll(`.item[data-id="${current.id}"]`).forEach((x) => x.classList.add('current'));
}

async function showEntry(id, params) {
  const e = await call('entry', { id });
  if (!e) return showPlaceholder();
  current = e;
  store.addHistory(e);
  const fav = store.isFav(e.id);
  const inLists = store.listsWith(e.id).filter((l) => l !== store.FAV).length;
  const opening = readOpeningTags(e.body);
  const senses = splitSenses(e.body);
  const facets = new Set(senses.filter((sense) => sense.phrase === 0).flatMap((sense) => sense.facets));
  const tags = [
    ...ENTRY_TAGS.filter((tag) => opening.mask & tag.bit),
    ...SENSE_TAGS.filter((tag) => !tag.aliasOf && facets.has(tag.id)),
  ];
  const cited = sourceOwners(e.body, senses).get(0) || new Set();
  el.view.innerHTML = `
    <article class="entry">
      <div class="entry-top">
        <button class="icon-btn back-btn" data-act="back" aria-label="بازگشت">${icon('back')}</button>
        <div class="spacer"></div>
        <button class="icon-btn" data-act="font" aria-label="اندازهٔ متن" title="اندازهٔ متن">${icon('text')}</button>
        <a class="icon-btn" href="${e.id > 0 ? entryHref(e.id - 1) : '#/'}" aria-label="مدخل پیشین" title="مدخل پیشین">${icon('back')}</a>
        <a class="icon-btn" href="${e.next != null ? entryHref(e.id + 1) : '#/'}" aria-label="مدخل پسین" title="مدخل پسین">${icon('next')}</a>
      </div>
      <header class="entry-head">
        <h1 class="entry-word">${esc(e.word)}</h1>
        ${e.pron || tags.length ? `<div class="entry-labels">
          ${e.pron ? `<div class="entry-pron">${esc(e.pron)}</div>` : ''}
          ${tags.length ? `<div class="entry-tags">${tags.map((tag) => `<span class="entry-tag">${esc(tag.label)}</span>`).join('')}</div>` : ''}
        </div>` : ''}
        ${cited.size ? `<details class="entry-sources"><summary>یادکردها (${fa(cited.size)})</summary>
          <div class="entry-tags">${SOURCE_TAGS.filter((source) => cited.has(source.id)).map((source) => `<span class="entry-tag">${esc(source.label)}</span>`).join('')}</div>
        </details>` : ''}
        <div class="entry-actions">
          <button class="action ${fav ? 'on' : ''}" data-act="fav">${icon('star')}<span>برگزیده</span></button>
          <button class="action ${inLists ? 'on' : ''}" data-act="lists">${icon('list-plus')}<span>فهرست‌ها${inLists ? ` (${fa(inLists)})` : ''}</span></button>
          <button class="action" data-act="copy">${icon('copy')}<span>رونوشت</span></button>
          <button class="action" data-act="share">${icon('share')}<span>هم‌رسانی</span></button>
        </div>
      </header>
      <div class="meaning" id="meaning">${renderMeaning(e.body)}</div>
      <nav class="entry-nav">
        ${e.prev != null ? `<a href="${entryHref(e.id - 1)}">${icon('back')}<span><small>پیشین</small> ${esc(e.prev)}</span></a>` : '<span></span>'}
        ${e.next != null ? `<a class="next" href="${entryHref(e.id + 1)}"><span><small>پسین</small> ${esc(e.next)}</span>${icon('next')}</a>` : '<span></span>'}
      </nav>
    </article>`;
  el.view.scrollTop = 0;
  const meaning = $('#meaning');
  let focus = null;
  let detailed = false;
  if (params.has('h')) {
    try {
      const [q, filters, tagMatch] = JSON.parse(params.get('h'));
      const highlights = await call('highlights', { id: e.id, q, filters, tagMatch, word: params.get('hw') || undefined });
      if (!meaning.isConnected) return;
      focus = markRanges(meaning, highlights.matches)[0];
      const heading = highlights.word === e.word ? $('.entry-word', el.view)
        : [...meaning.querySelectorAll('b.hl')].find((node) => normalizeCompact(node.textContent) === normalizeCompact(highlights.word));
      if (heading) {
        heading.innerHTML = highlightWord(heading.textContent, '', highlights.headMatches);
        if (!focus && highlights.headMatches.length) focus = heading;
      }
      detailed = true;
    } catch { /* Keep the original match available if extra highlighting fails. */ }
  }
  if (!detailed && /^\d+,\d+$/.test(params.get('s') || '')) {
    const [start, end] = params.get('s').split(',').map(Number);
    const text = plainMeaning(e.body.slice(start, end));
    const test = termTester((params.get('t') || '').split(' ').filter(Boolean), params.get('exact') === '1');
    const literal = /^\d+,\d+$/.test(params.get('r') || '')
      ? Object.fromEntries(params.get('r').split(',').map((value, index) => [index ? 'end' : 'start', Number(value)]))
      : params.get('q') ? quotedMatch(text, normalizeQuoted(params.get('q'))) : null;
    const found = literal ? null : [...text.matchAll(/[^\s.,;:!?()[\]«»"'،؛؟]+/g)].find((match) => test(match[0]));
    const at = literal?.start ?? found?.index ?? 0;
    const needle = literal ? text.slice(literal.start, literal.end) : found?.[0] || text.slice(0, 160);
    if (!literal && params.get('t')) {
      const matches = [];
      for (const match of text.matchAll(/[^\s.,;:!?()[\]«»"'،؛؟]+/g)) {
        if (test(match[0])) matches.push({ part: 0, match: { start: match.index, end: match.index + match[0].length } });
        if (matches.length === 200) break;
      }
      focus = markRanges(meaning, compactMatches(e.body, [{ text, range: [start, end] }], matches))[0];
    } else focus = markLiteral(meaning, needle, plainMeaning(e.body.slice(0, start)) + text.slice(0, at))[0];
  } else if (!detailed && params.get('p')) {
    // Opened from a sub-entry phrase: scroll to it.
    const target = normalizeCompact(params.get('p'));
    focus = [...meaning.querySelectorAll('b.hl')].find((b) => normalizeCompact(b.textContent) === target);
    if (focus) {
      const mk = document.createElement('mark');
      focus.replaceWith(mk);
      mk.append(focus);
      focus = mk;
    }
  } else if (!detailed && /^\d+,\d+$/.test(params.get('r') || '')) {
    const [start, end] = params.get('r').split(',').map(Number);
    const text = plainMeaning(e.body);
    const needle = text.slice(start, Math.min(end, start + 200));
    focus = markLiteral(meaning, needle, text.slice(0, start))[0];
  } else if (!detailed && params.get('q')) {
    const text = plainMeaning(e.body);
    const match = quotedMatch(text, normalizeQuoted(params.get('q')));
    if (match) focus = markLiteral(meaning, text.slice(match.start, match.end), text.slice(0, match.start))[0];
  } else if (!detailed && params.get('t')) {
    focus = markTerms(meaning, params.get('t').split(' ').filter(Boolean), params.get('exact') === '1')[0];
  }
  if (focus) {
    focus.classList.add('focus');
    requestAnimationFrame(() => focus.scrollIntoView({ block: 'center' }));
  }
  markCurrent();
}

el.view.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'back') history.length > 1 ? history.back() : (location.hash = '#/');
  if (!current && act !== 'back') return;
  if (act === 'fav') {
    const on = store.toggleInList(store.FAV, current);
    btn.classList.toggle('on', on);
    
    toast(on ? 'به برگزیده‌ها افزوده شد' : 'از برگزیده‌ها برداشته شد');
  } else if (act === 'lists') openListsSheet(current);
  else if (act === 'copy') {
    await copyText(entryText(current));
    toast('معنی رونوشت شد');
  } else if (act === 'share') {
    const text = entryText(current, 3500);
    const r = await shareText(current.word, text);
    if (r === 'copied') toast('متن برای هم‌رسانی رونوشت شد');
  } else if (act === 'font') openSettings(true);
});

// Double-click a word in a meaning to look it up.
el.view.addEventListener('dblclick', (e) => {
  if (!e.target.closest('.meaning')) return;
  const s = String(getSelection()).trim();
  if (s && s.length < 40) {
    el.q.value = s;
    runSearch(s);
    if (mobile()) location.hash = '#/';
  }
});

function entryText(e, max = Infinity) {
  let body = meaningText(e.body);
  if (body.length > max) body = body.slice(0, max).replace(/\s+\S*$/, '') + ' …';
  return `${e.word}${e.pron ? ` [${e.pron}]` : ''}\n\n${body}\n\n— لغت‌نامهٔ دهخدا · یاد`;
}

function showPlaceholder() {
  current = null;
  el.view.innerHTML = `<div class="placeholder"><div><img src="icons/mark.png" alt=""/><p>واژه‌ای را جستجو کنید</p></div></div>`;
  markCurrent();
}

// ------------------------------------------------------------------ lists

function showLists() {
  current = null;
  const ls = store.lists();
  el.view.innerHTML = `
    <section class="page">
      <div class="entry-top" style="margin:-18px -22px 0">
        <button class="icon-btn back-btn" data-act="back" aria-label="بازگشت">${icon('back')}</button>
        <div class="spacer"></div>
        <button class="btn" id="new-list">${icon('plus')} فهرست تازه</button>
      </div>
      <h2>فهرست‌های من</h2>
      <div class="card">
        ${ls
          .map(
            (l) => `<a class="list-row" href="#/lists/${l.id}">
              <span class="list-icon">${icon(l.id === store.FAV ? 'star' : 'bookmarks')}</span>
              <span class="grow"><div class="name">${esc(l.name)}</div><div class="sub">${fa(l.items.length)} واژه</div></span>
              ${icon('next')}</a>`,
          )
          .join('')}
      </div>
    </section>`;
  $('#new-list').addEventListener('click', () => {
    promptSheet('فهرست تازه', '', 'ساختن', (name) => {
      const id = store.createList(name);
      location.hash = `#/lists/${id}`;
    });
  });
  markCurrent();
}

function showList(lid) {
  const l = store.getList(lid);
  if (!l) return showLists();
  current = null;
  el.view.innerHTML = `
    <section class="page">
      <div class="entry-top" style="margin:-18px -22px 0">
        <a class="icon-btn" href="#/lists" aria-label="فهرست‌ها">${icon('back')}</a>
        <div class="spacer"></div>
        ${
          l.id !== store.FAV
            ? `<button class="icon-btn" data-list="rename" title="تغییر نام">${icon('edit')}</button>
               <button class="icon-btn" data-list="delete" title="حذف فهرست">${icon('trash')}</button>`
            : ''
        }
        <button class="icon-btn" data-list="share" title="هم‌رسانی فهرست">${icon('share')}</button>
      </div>
      <h2>${esc(l.name)}</h2>
      ${
        l.items.length
          ? `<div class="card">${l.items
              .map(
                (it) => `<div class="list-row" data-open="${it.id}">
                  <span class="grow"><div class="name">${esc(it.w)}</div></span>
                  <button class="icon-btn" data-remove="${it.id}" aria-label="برداشتن">${icon('x')}</button></div>`,
              )
              .join('')}</div>`
          : `<div class="empty">${icon(l.id === store.FAV ? 'star' : 'bookmarks')}<br/>این فهرست هنوز خالی است.<br/><small>از صفحهٔ هر واژه آن را به فهرست بیفزایید.</small></div>`
      }
    </section>`;
  el.view.onclick = async (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      e.stopPropagation();
      store.removeFromList(lid, +rm.dataset.remove);
      return showList(lid);
    }
    const open = e.target.closest('[data-open]');
    if (open) location.hash = entryHref(open.dataset.open);
    const act = e.target.closest('[data-list]')?.dataset.list;
    if (act === 'rename') promptSheet('تغییر نام فهرست', l.name, 'ذخیره', (n) => (store.renameList(lid, n), showList(lid)));
    if (act === 'delete') confirmSheet(`فهرست «${l.name}» حذف شود؟`, () => (store.deleteList(lid), (location.hash = '#/lists')));
    if (act === 'share') {
      const text = `${l.name}\n\n${l.items.map((i) => '• ' + i.w).join('\n')}\n\n— یاد`;
      if ((await shareText(l.name, text)) === 'copied') toast('فهرست رونوشت شد');
    }
  };
}

// ------------------------------------------------------------------ sheets

let sheetFocusReturn;
function openSheet(html, onReady) {
  if (el.sheet.hidden) sheetFocusReturn = document.activeElement;
  el.sheet.classList.remove('search-sheet');
  el.sheet.onkeydown = null;
  el.sheet.removeAttribute('aria-labelledby');
  el.sheet.innerHTML = html;
  el.sheet.hidden = false;
  el.backdrop.hidden = false;
  onReady?.(el.sheet);
}
function closeSheet() {
  const wasOpen = !el.sheet.hidden;
  el.sheet.hidden = true;
  el.backdrop.hidden = true;
  el.sheet.innerHTML = '';
  el.sheet.classList.remove('search-sheet');
  el.sheet.onkeydown = null;
  if (wasOpen && sheetFocusReturn?.isConnected) sheetFocusReturn.focus({ preventScroll: true });
}
el.backdrop.addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => e.key === 'Escape' && !el.sheet.hidden && closeSheet());

function promptSheet(title, value, okLabel, onOk) {
  openSheet(
    `<h3>${esc(title)}</h3><input class="text-input" id="sheet-input" value="${esc(value)}" maxlength="60"/>
     <div class="sheet-row"><button class="btn" id="sheet-ok">${esc(okLabel)}</button><button class="btn ghost" id="sheet-cancel">انصراف</button></div>`,
    (s) => {
      const input = $('#sheet-input', s);
      setTimeout(() => input.focus(), 50);
      const ok = () => {
        if (!input.value.trim()) return input.focus();
        closeSheet();
        onOk(input.value);
      };
      $('#sheet-ok', s).onclick = ok;
      input.onkeydown = (e) => e.key === 'Enter' && ok();
      $('#sheet-cancel', s).onclick = closeSheet;
    },
  );
}

function confirmSheet(msg, onOk) {
  openSheet(
    `<h3>${esc(msg)}</h3><div class="sheet-row"><button class="btn danger" id="sheet-ok">حذف</button><button class="btn ghost" id="sheet-cancel">انصراف</button></div>`,
    (s) => {
      $('#sheet-ok', s).onclick = () => (closeSheet(), onOk());
      $('#sheet-cancel', s).onclick = closeSheet;
    },
  );
}

const TAG_GROUPS = [
  ['origin', 'ریشه'], ['kind', 'نوع واژه'], ['subject', 'موضوع'],
  ['usage', 'کاربرد'], ['source', 'یادکرد'],
];
let tagCounts = {};
let tagCountsRequest;

function tagChoicesHTML(modes) {
  return `<section class="tag-selection" aria-labelledby="tag-selection-title">
    <div class="tag-selection-heading"><h4 id="tag-selection-title">برچسب‌های فعال <span id="tag-selection-count"></span></h4>
      <button class="link-btn" type="button" id="tag-filter-reset">پاک کردن</button></div>
    <div class="selected-filters" id="selected-filters"></div>
    <p class="search-guide">✓ داشتن، × نداشتن؛ برای لغو، دوباره بزنید.</p>
    <div class="tag-browser-toolbar"><label class="field-label" for="tag-filter-query">یافتن برچسب
      <input class="text-input" id="tag-filter-query" type="search" placeholder="برچسب یا یادکرد…" autocomplete="off" spellcheck="false" />
    </label>
    <div class="tag-categories" role="group" aria-label="دسته‌های برچسب">
      ${[['all', 'همه'], ...TAG_GROUPS].map(([group, label]) => `<button type="button" class="tag-category" data-tag-category="${group}" aria-pressed="${group === 'all'}">${label}<span data-category-count="${group}" hidden></span></button>`).join('')}
    </div></div>
    <p class="tag-count-note">شمار کل واژه‌ها و ترکیب‌ها؛ — یعنی نامشخص.</p>
    <p class="search-guide" id="tag-filter-empty" role="status" hidden>برچسبی پیدا نشد.</p>
    ${TAG_GROUPS.map(([group, label]) => `<fieldset class="tag-filter-group" data-tag-group="${group}">
      <legend>${label}</legend>
      <label class="tag-mode field-label">داشتن برچسب‌ها
        <select class="text-input" data-tag-mode="${group}"><option value="any"${modes[group] !== 'all' ? ' selected' : ''}>دست‌کم یکی</option><option value="all"${modes[group] === 'all' ? ' selected' : ''}>همهٔ انتخاب‌ها</option></select>
      </label>
      <div class="tag-filter-grid">${SEARCH_FILTER_TAGS.filter((tag) => tag.group === group).map((tag) => `<div class="tag-filter" data-tag-row="${tag.key}" role="group" aria-labelledby="tag-label-${tag.key}">
        <span class="tag-filter-label" id="tag-label-${tag.key}">${esc(tag.label)} <bdi class="tag-filter-count" data-tag-count="${tag.key}">(—)</bdi></span>
        <span class="tag-filter-actions"><button type="button" data-tag="${tag.key}" data-tag-state="1" aria-pressed="false" aria-label="داشتن برچسب ${esc(tag.label)}" title="داشتن این برچسب">✓</button><button type="button" data-tag="${tag.key}" data-tag-state="-1" aria-pressed="false" aria-label="نداشتن برچسب ${esc(tag.label)}" title="نداشتن این برچسب">×</button></span>
      </div>`).join('')}</div>
    </fieldset>`).join('')}
  </section>`;
}

function bindTagChoices(sheet, filters, modes, onChange) {
  let category = 'all';
  const query = $('#tag-filter-query', sheet);
  const selection = $('#selected-filters', sheet);
  const choices = SEARCH_FILTER_TAGS.map((tag) => ({
    tag, row: sheet.querySelector(`[data-tag-row="${tag.key}"]`),
    names: [tag.label, ...(tag.names || []), tag.code || ''].map(normalizeCompact),
  }));
  const filterChoices = () => {
    const text = normalizeCompact(query.value);
    let total = 0;
    for (const [group] of TAG_GROUPS) {
      let visible = 0;
      for (const choice of choices) {
        if (choice.tag.group !== group) continue;
        choice.row.hidden = (category !== 'all' && category !== group) || !!text && !choice.names.some((name) => name.includes(text));
        if (!choice.row.hidden) visible++;
      }
      sheet.querySelector(`[data-tag-group="${group}"]`).hidden = !visible;
      total += visible;
    }
    $('#tag-filter-empty', sheet).hidden = !!total;
    sheet.querySelectorAll('[data-tag-category]').forEach((button) => button.setAttribute('aria-pressed', button.dataset.tagCategory === category));
  };
  const drawCounts = () => {
    for (const { tag, row } of choices) {
      const count = tagCounts[tag.key];
      $('[data-tag-count]', row).textContent = `(${Number.isInteger(count) ? fa(count) : '—'})`;
    }
  };
  const draw = () => {
    const active = SEARCH_FILTER_TAGS.filter((tag) => filters[tag.key] === 1 || filters[tag.key] === -1);
    $('#tag-selection-count', sheet).textContent = `(${fa(active.length)})`;
    $('#search-tab-tag-count', sheet).textContent = active.length ? fa(active.length) : '';
    $('#search-tab-tag-count', sheet).hidden = !active.length;
    $('#tag-filter-reset', sheet).disabled = !active.length;
    selection.hidden = !active.length;
    selection.innerHTML = active.map((tag) => `<button class="selected-filter" type="button" data-remove-tag="${tag.key}" data-state="${filters[tag.key]}" aria-label="برداشتن شرط ${filters[tag.key] === 1 ? 'داشتن' : 'نداشتن'} ${esc(tag.label)}"><span>${filters[tag.key] === 1 ? '✓' : '×'} ${esc(tag.label)}</span><span aria-hidden="true">×</span></button>`).join('');
    sheet.querySelectorAll('[data-tag-mode]').forEach((select) => {
      select.value = modes[select.dataset.tagMode] || 'any';
    });
    sheet.querySelectorAll('[data-category-count]').forEach((badge) => {
      const count = active.filter((tag) => badge.dataset.categoryCount === 'all' || tag.group === badge.dataset.categoryCount).length;
      badge.hidden = !count;
      badge.textContent = fa(count);
    });
    for (const { tag, row } of choices) {
      row.dataset.state = filters[tag.key] || 0;
      row.querySelectorAll('[data-tag-state]').forEach((button) => button.setAttribute('aria-pressed', filters[tag.key] === +button.dataset.tagState));
    }
  };
  query.addEventListener('input', filterChoices);
  query.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      choices.find((choice) => !choice.row.hidden)?.row.querySelector('button').focus();
    }
  });
  sheet.querySelectorAll('[data-tag-category]').forEach((button) => {
    button.onclick = () => { category = button.dataset.tagCategory; filterChoices(); $('.search-builder-body', sheet).scrollTop = 0; };
  });
  sheet.querySelectorAll('[data-tag]').forEach((button) => {
    button.onclick = () => {
      const key = button.dataset.tag;
      const state = +button.dataset.tagState;
      if (filters[key] === state) delete filters[key];
      else filters[key] = state;
      draw();
      onChange();
    };
  });
  selection.onclick = (event) => {
    const button = event.target.closest('[data-remove-tag]');
    if (!button) return;
    delete filters[button.dataset.removeTag];
    draw();
    (selection.querySelector('button') || $('#search-tab-tags', sheet)).focus();
    onChange();
  };
  $('#tag-filter-reset', sheet).onclick = () => {
    for (const key of Object.keys(filters)) delete filters[key];
    for (const key of Object.keys(modes)) delete modes[key];
    query.value = '';
    filterChoices();
    draw();
    onChange();
  };
  sheet.querySelectorAll('[data-tag-mode]').forEach((select) => {
    select.onchange = () => { modes[select.dataset.tagMode] = select.value; onChange(); };
  });
  draw();
  drawCounts();
  if (!tagCountsRequest) tagCountsRequest = call('filterCounts').then((data) => { tagCounts = data.counts; }).catch(() => { tagCountsRequest = null; });
  const form = $('#search-builder', sheet);
  tagCountsRequest.then(() => { if ($('#search-builder', sheet) === form) drawCounts(); });
}

const syntaxHTML = (text) => `<bdi dir="ltr"><code>${esc(text)}</code></bdi>`;
const SEARCH_NOTATION = Object.fromEntries(Object.entries({
  start: '^', end: '$', prefixExample: '^یاد', delimiter: '/', backslash: '\\',
  wildcardOne: '?', wildcardMany: '*', wildcardExample: 'ک?اب',
}).map(([key, text]) => [key, syntaxHTML(text)]));
const searchGuideHTML = (text) => formatSearchString(esc(text), SEARCH_NOTATION);

function ruleGroupsHTML(groups) {
  return groups.map((group, gi) => `<fieldset class="search-rule-group" data-group="${gi}">
    <legend>گروه ${fa(gi + 1)}</legend>
    <div class="search-group-tools">
      <label for="group-match-${gi}">شرط‌های گروه</label>
      <select class="text-input" id="group-match-${gi}" data-group-match>
        <option value="all"${group.match === 'all' ? ' selected' : ''}>همهٔ شرط‌ها</option>
        <option value="any"${group.match === 'any' ? ' selected' : ''}>دست‌کم یک شرط</option>
      </select>
      <button class="link-btn" type="button" data-remove-group${groups.length === 1 ? ' disabled' : ''}>حذف گروه</button>
    </div>
    ${group.rules.map((rule, ri) => {
      const helpers = getSearchHelpers(rule.scope);
      const helper = helpers.find(([kind]) => kind === rule.kind);
      const numeric = ['length', 'min-length', 'max-length'].includes(rule.kind);
      const hint = helper[3] || '';
      const hintId = `rule-hint-${gi}-${ri}`;
      return `<div class="search-rule-row" data-rule="${ri}">
        <label class="field-label search-rule-scope" for="rule-scope-${gi}-${ri}">جای جستجو
          <select class="text-input" id="rule-scope-${gi}-${ri}" data-rule-scope>${SEARCH_SCOPES.map(([scope, label]) => `<option value="${scope}"${scope === (rule.scope || 'both') ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>
        </label>
        <label class="field-label" for="rule-kind-${gi}-${ri}">نوع شرط
          <select class="text-input" id="rule-kind-${gi}-${ri}" data-rule-kind>${helpers.map(([kind, label]) => `<option value="${kind}"${kind === rule.kind ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>
        </label>
        <label class="field-label" for="rule-value-${gi}-${ri}"><span data-rule-label>${esc(numeric ? SEARCH_STRINGS.controls.length : SEARCH_STRINGS.controls.text)}</span>
          <input class="text-input" id="rule-value-${gi}-${ri}" data-rule-value value="${esc(rule.value)}" placeholder="${esc(helper[2])}" inputmode="${numeric ? 'numeric' : 'text'}" dir="${numeric || rule.kind === 'regex' || rule.kind === 'length-range' ? 'ltr' : 'rtl'}" aria-describedby="${hint ? hintId + ' ' : ''}search-builder-error" autocomplete="off" spellcheck="false" />
        </label>
        <button class="icon-btn search-remove-rule" type="button" data-remove-rule aria-label="حذف شرط ${fa(ri + 1)} از گروه ${fa(gi + 1)}">${icon('x')}</button>
        <p class="search-guide" id="${hintId}" data-rule-hint${hint ? '' : ' hidden'}>${searchGuideHTML(hint)}</p>
      </div>`;
    }).join('')}
    <button class="link-btn" type="button" data-add-rule>+ افزودن شرط</button>
  </fieldset>`).join('');
}

function openSearchHelp(tab) {
  let initialTab = tab || 'tags';
  let groups = [{ match: 'all', rules: [{ kind: 'contains', value: '' }] }];
  let match = 'any';
  let flags = 'u';
  const filters = { ...search.filters };
  const tagMatch = { ...search.tagMatch };
  let original = el.q.value;
  let originalInvalid = false;
  try {
    original = canonicalizeSearchQuery(original);
    const current = readSearchHelperBuilder(original);
    if (original.trim()) { groups = current.groups; match = current.match; }
    if (current.query.mode === 'regex' || current.query.mode === 'scoped') {
      flags = current.query.flags;
      if (!tab) initialTab = 'pattern';
    }
  } catch {
    originalInvalid = true;
    if (!tab) initialTab = 'pattern';
  }
  const originalPattern = JSON.stringify([groups, match, flags]);
  openSheet(
    `<header class="search-sheet-header">
       <h3 id="search-help-title" tabindex="-1">جستجوی پیشرفته</h3>
       <button class="icon-btn" id="search-close-header" type="button" aria-label="بستن">${icon('x')}</button>
     </header>
     <form id="search-builder" class="search-builder">
       <div class="search-tabs" role="tablist" aria-label="بخش‌های جستجوی پیشرفته">
         <button type="button" role="tab" id="search-tab-tags" data-search-tab="tags" aria-controls="search-panel-tags" aria-selected="true">برچسب‌ها <span id="search-tab-tag-count" hidden></span></button>
         <button type="button" role="tab" id="search-tab-pattern" data-search-tab="pattern" aria-controls="search-panel-pattern" aria-selected="false" tabindex="-1">ساخت الگو</button>
         <button type="button" role="tab" id="search-tab-help" data-search-tab="help" aria-controls="search-panel-help" aria-selected="false" tabindex="-1">راهنما</button>
       </div>
       <div class="search-builder-body">
         <section id="search-panel-tags" role="tabpanel" aria-labelledby="search-tab-tags">${tagChoicesHTML(tagMatch)}</section>
         <section id="search-panel-pattern" role="tabpanel" aria-labelledby="search-tab-pattern" hidden>
           <p class="search-guide">${esc(SEARCH_STRINGS.guide.builder)}</p>
           <p class="search-guide">جای هر شرط را جدا برگزینید؛ مانند <bdi dir="ltr"><code>${esc(SEARCH_STRINGS.guide.scopedExample)}</code></bdi>. شرط‌های معنی می‌توانند در واژه‌های جداگانهٔ همان مدخل یا ترکیب پیدا شوند.</p>
           <div class="search-builder-actions"><button class="btn ghost" type="button" id="search-add-group">+ افزودن گروه</button><button class="link-btn" type="button" id="search-clear-rules">${esc(SEARCH_STRINGS.controls.clearRules)}</button></div>
           <div class="search-group-join" id="search-group-join" hidden>
             <label class="field-label" for="search-group-match">رابطهٔ گروه‌ها</label>
             <select class="text-input" id="search-group-match"><option value="any">دست‌کم یک گروه</option><option value="all">همهٔ گروه‌ها</option></select>
           </div>
           <div id="search-rule-groups"></div>
           <label class="search-case-option"><input type="checkbox" id="search-ignore-case"${flags.includes('i') ? ' checked' : ''}/> حروف بزرگ و کوچک لاتین یکسان باشند</label>
         </section>
         <section id="search-panel-help" role="tabpanel" aria-labelledby="search-tab-help" hidden>
           <h4>عبارت و الگو</h4>
           <p class="search-guide">عبارت: <bdi dir="ltr"><code>«یاد»</code></bdi>؛ الگو: <bdi dir="ltr"><code>/^یاد/</code></bdi>. هر دو در واژه‌ها، ترکیب‌ها و معنی‌ها جستجو می‌شوند.</p>
           <p class="search-guide">${esc(SEARCH_STRINGS.guide.completeWords)}</p>
           <p class="search-guide">${esc(SEARCH_STRINGS.guide.meaningWords)}</p>
           <p class="search-guide">${searchGuideHTML(SEARCH_STRINGS.guide.meaningPatterns)}</p>
           <h4>برچسب‌ها و یادکردها</h4>
           <p class="search-guide">برای هر برچسب، هر واژه یا ترکیب یک بار شمرده می‌شود. شمارها با جستجو یا انتخاب برچسب تغییر نمی‌کنند.</p>
           <p class="search-guide">در هر دسته، «دست‌کم یکی» کافی است؛ برای الزام همه، «همهٔ انتخاب‌ها» را برگزینید. دسته‌ها با هم ترکیب می‌شوند.</p>
           <p class="search-guide">ریشه و نوع واژه از آغاز توضیح خوانده می‌شوند. موضوع و کاربرد باید در یک معنی باشند؛ × معنی‌های بدون آن برچسب را می‌یابد. ترکیب‌ها برچسب‌های خودشان را دارند.</p>
           <p class="search-guide">یادکرد در کل مدخل یا ترکیب جستجو می‌شود؛ هر معنی لزوماً از آن اثر نیست. یادکردهای ترکیب از واژهٔ اصلی جدا هستند.</p>
           <p class="search-guide">همین نوشته در نوار جستجو قرار می‌گیرد؛ برچسب‌ها جداگانه اعمال می‌شوند.</p>
           <details class="search-reference"><summary>نشانه‌های الگو</summary>
       <dl>${SEARCH_STRINGS.guide.regexSymbols.map(([symbol, description]) => `<dt>${syntaxHTML(symbol)}</dt><dd>${searchGuideHTML(description)}</dd>`).join('')}</dl>
     </details>
         </section>
       </div>
       <footer class="search-builder-footer">
         <label class="field-label" for="search-preview">نوشتهٔ جستجو</label>
         <output class="search-preview" id="search-preview" dir="rtl"></output>
         <p class="search-builder-error" id="search-builder-error" aria-live="polite"></p>
         <div class="sheet-row"><button class="btn" id="search-apply" type="submit">جستجو</button><button class="btn ghost" id="search-help-close" type="button">بستن</button></div>
       </footer>
     </form>`,
    (sheet) => {
      sheet.setAttribute('aria-labelledby', 'search-help-title');
      sheet.classList.add('search-sheet');
      const tabs = [...sheet.querySelectorAll('[data-search-tab]')];
      const selectTab = (name) => {
        for (const button of tabs) {
          const selected = button.dataset.searchTab === name;
          button.setAttribute('aria-selected', selected);
          button.tabIndex = selected ? 0 : -1;
          $(`#${button.getAttribute('aria-controls')}`, sheet).hidden = !selected;
        }
        $('.search-builder-body', sheet).scrollTop = 0;
      };
      tabs.forEach((button) => { button.onclick = () => selectTab(button.dataset.searchTab); });
      sheet.onkeydown = (event) => {
        const tab = event.target.closest('[data-search-tab]');
        if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
            : (tabs.indexOf(tab) + (event.key === 'ArrowLeft' ? 1 : -1) + tabs.length) % tabs.length;
          selectTab(tabs[index].dataset.searchTab);
          tabs[index].focus();
        }
        if (event.key === 'Tab') {
          const controls = [...sheet.querySelectorAll('button:not(:disabled), input, select:not(:disabled), summary, [tabindex="0"]')]
            .filter((node) => node.tabIndex >= 0 && node.getClientRects().length);
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && (event.target === first || event.target.id === 'search-help-title')) {
            event.preventDefault(); last.focus();
          } else if (!event.shiftKey && event.target === last) {
            event.preventDefault(); first.focus();
          }
        }
      };
      $('#search-close-header', sheet).onclick = closeSheet;
      const container = $('#search-rule-groups', sheet);
      const join = $('#search-group-join', sheet);
      const joinSelect = $('#search-group-match', sheet);
      const preview = $('#search-preview', sheet);
      const error = $('#search-builder-error', sheet);
      const apply = $('#search-apply', sheet);
      const ignoreCase = $('#search-ignore-case', sheet);
      let built = '';
      const update = () => {
        const rules = groups.flatMap((group) => group.rules)
          .filter((rule) => rule.kind === 'exact' ? rule.value.length : rule.value.trim());
        const caseFlags = rules.map((rule) => (rule.flags || flags).includes('i'));
        ignoreCase.checked = caseFlags.length ? caseFlags.every(Boolean) : flags.includes('i');
        ignoreCase.indeterminate = caseFlags.some(Boolean) && !ignoreCase.checked;
        const unchanged = JSON.stringify([groups, match, flags]) === originalPattern;
        const preserveOriginal = unchanged || originalInvalid && !rules.length;
        try {
          built = preserveOriginal ? original : buildWordQuery(groups, match, flags, originalInvalid ? '' : original);
          const query = parseSearchQuery(built);
          preview.textContent = built || (hasTagFilters(filters) ? 'جستجو فقط با برچسب‌ها' : '');
          preview.dir = query.mode === 'regex' || query.mode === 'scoped' ? 'ltr' : 'auto';
          error.textContent = '';
          apply.disabled = false;
        } catch (e) {
          built = '';
          preview.textContent = preserveOriginal && originalInvalid ? original : '…';
          preview.dir = preserveOriginal && originalInvalid && original.startsWith('/') ? 'ltr' : 'auto';
          const hasInput = preserveOriginal && originalInvalid || rules.length;
          error.textContent = hasInput ? e.message : '';
          apply.disabled = true;
        }
      };
      const draw = () => {
        container.innerHTML = ruleGroupsHTML(groups);
        join.hidden = groups.length < 2;
        joinSelect.value = match;
      };
      const focusRule = (gi, ri) => $(`#rule-value-${gi}-${ri}`, sheet)?.focus();
      const refreshRule = (row, rule) => {
        const helpers = getSearchHelpers(rule.scope);
        const helper = helpers.find(([kind]) => kind === rule.kind);
        $('[data-rule-kind]', row).innerHTML = helpers.map(([kind, label]) => `<option value="${kind}"${kind === rule.kind ? ' selected' : ''}>${esc(label)}</option>`).join('');
        const input = $('[data-rule-value]', row);
        const numeric = ['length', 'min-length', 'max-length'].includes(rule.kind);
        input.value = rule.value;
        input.placeholder = helper[2];
        input.inputMode = numeric ? 'numeric' : 'text';
        input.dir = numeric || rule.kind === 'regex' || rule.kind === 'length-range' ? 'ltr' : 'rtl';
        $('[data-rule-label]', row).textContent = numeric ? SEARCH_STRINGS.controls.length : SEARCH_STRINGS.controls.text;
        const hint = $('[data-rule-hint]', row);
        hint.innerHTML = searchGuideHTML(helper[3] || '');
        hint.hidden = !helper[3];
        input.setAttribute('aria-describedby', `${helper[3] ? hint.id + ' ' : ''}search-builder-error`);
      };
      container.addEventListener('input', (event) => {
        const input = event.target.closest('[data-rule-value]');
        if (!input) return;
        const gi = +input.closest('[data-group]').dataset.group;
        const ri = +input.closest('[data-rule]').dataset.rule;
        groups[gi].rules[ri].value = input.value;
        update();
      });
      container.addEventListener('change', (event) => {
        const gi = +event.target.closest('[data-group]').dataset.group;
        if (event.target.matches('[data-group-match]')) groups[gi].match = event.target.value;
        else if (event.target.matches('[data-rule-scope]')) {
          const row = event.target.closest('[data-rule]');
          const ri = +row.dataset.rule;
          const rule = adaptSearchHelperRule(groups[gi].rules[ri], event.target.value, flags);
          groups[gi].rules[ri] = rule;
          refreshRule(row, rule);
        } else if (event.target.matches('[data-rule-kind]')) {
          const row = event.target.closest('[data-rule]');
          const rule = groups[gi].rules[+row.dataset.rule];
          rule.kind = event.target.value;
          refreshRule(row, rule);
        }
        update();
      });
      container.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        const gi = +button.closest('[data-group]').dataset.group;
        if (button.matches('[data-add-rule]')) {
          groups[gi].rules.push({ kind: 'contains', value: '', scope: groups[gi].rules.at(-1)?.scope || 'both' });
          draw();
          focusRule(gi, groups[gi].rules.length - 1);
        } else if (button.matches('[data-remove-rule]')) {
          const ri = +button.closest('[data-rule]').dataset.rule;
          groups[gi].rules.splice(ri, 1);
          if (!groups[gi].rules.length) groups[gi].rules.push({ kind: 'contains', value: '' });
          draw();
          focusRule(gi, Math.min(ri, groups[gi].rules.length - 1));
        } else if (button.matches('[data-remove-group]') && groups.length > 1) {
          groups.splice(gi, 1);
          draw();
          focusRule(Math.min(gi, groups.length - 1), 0);
        }
        update();
      });
      joinSelect.onchange = () => {
        match = joinSelect.value;
        update();
      };
      $('#search-add-group', sheet).onclick = () => {
        groups.push({ match: 'all', rules: [{ kind: 'contains', value: '' }] });
        draw();
        focusRule(groups.length - 1, 0);
        update();
      };
      $('#search-clear-rules', sheet).onclick = () => {
        groups = [{ match: 'all', rules: [{ kind: 'contains', value: '' }] }];
        match = 'any';
        original = '';
        originalInvalid = false;
        draw();
        focusRule(0, 0);
        update();
      };
      ignoreCase.onchange = () => {
        const previousFlags = flags;
        const suffix = ignoreCase.checked ? 'i' : '';
        flags = previousFlags.replace(/i/g, '') + suffix;
        for (const group of groups) for (const rule of group.rules) {
          const next = (rule.flags || previousFlags).replace(/i/g, '') + suffix;
          if (next === flags) delete rule.flags;
          else rule.flags = next;
        }
        update();
      };
      bindTagChoices(sheet, filters, tagMatch, update);
      $('#search-builder', sheet).addEventListener('submit', (event) => {
        event.preventDefault();
        if (apply.disabled) return;
        const q = built;
        search.filters = { ...filters };
        search.tagMatch = { ...tagMatch };
        closeSheet();
        el.q.value = q;
        runSearch(el.q.value);
        el.q.focus();
      });
      $('#search-help-close', sheet).onclick = closeSheet;
      draw();
      update();
      selectTab(initialTab);
      $('#search-help-title', sheet).focus({ preventScroll: true });
    },
  );
}
$('#btn-search-help').addEventListener('click', () => openSearchHelp());
$('#btn-search-filters').addEventListener('click', () => openSearchHelp('tags'));
$('#btn-clear-filters').addEventListener('click', () => {
  search.filters = {};
  search.tagMatch = {};
  runSearch(el.q.value);
});

function openListsSheet(entry) {
  const draw = () => {
    const ls = store.lists();
    openSheet(
      `<h3>افزودن «${esc(entry.word)}» به فهرست</h3>
       ${ls
         .map(
           (l) => `<div class="opt ${store.inList(l.id, entry.id) ? 'on' : ''}" data-lid="${l.id}">
             <span class="check">${icon('check')}</span><span class="grow">${esc(l.name)}</span><small>${fa(l.items.length)}</small></div>`,
         )
         .join('')}
       <div class="sheet-row"><input class="text-input" id="new-list-name" placeholder="نام فهرست تازه" maxlength="60"/><button class="btn" id="new-list-add">${icon('plus')}</button></div>
       <div class="sheet-row"><button class="btn ghost" id="sheet-done" style="flex:1">بستن</button></div>`,
      (s) => {
        s.querySelectorAll('[data-lid]').forEach((o) => {
          o.onclick = () => {
            store.toggleInList(o.dataset.lid, entry);
            o.classList.toggle('on', store.inList(o.dataset.lid, entry.id));
          };
        });
        const add = () => {
          const name = $('#new-list-name', s).value.trim();
          if (!name) return;
          const id = store.createList(name);
          store.toggleInList(id, entry);
          draw();
        };
        $('#new-list-add', s).onclick = add;
        $('#new-list-name', s).onkeydown = (e) => e.key === 'Enter' && add();
        $('#sheet-done', s).onclick = () => {
          closeSheet();
          if (current && current.id === entry.id) refreshEntryActions();
        };
      },
    );
  };
  draw();
}

function refreshEntryActions() {
  const fav = store.isFav(current.id);
  const n = store.listsWith(current.id).filter((l) => l !== store.FAV).length;
  const f = el.view.querySelector('[data-act="fav"]');
  const l = el.view.querySelector('[data-act="lists"]');
  if (f) {
    f.classList.toggle('on', fav);

  }
  if (l) {
    l.classList.toggle('on', n > 0);
    l.querySelector('span').textContent = `فهرست‌ها${n ? ` (${fa(n)})` : ''}`;
  }
}

const FONT_SIZES = [
  [0.9, 'کوچک'],
  [1, 'معمولی'],
  [1.15, 'بزرگ'],
  [1.3, 'خیلی بزرگ'],
];

function openSettings() {
  const s = store.settings();
  const canCache = 'serviceWorker' in navigator && 'caches' in window && !isNative && !isElectron && location.protocol.startsWith('http');
  openSheet(
    `<h3>تنظیمات</h3>
     <div class="field-label">پوسته</div>
     <div class="seg" id="seg-theme">${[
       ['system', 'خودکار'],
       ['light', 'روشن'],
       ['dark', 'تیره'],
     ]
       .map(([v, t]) => `<button data-v="${v}" class="${s.theme === v ? 'on' : ''}">${t}</button>`)
       .join('')}</div>
     <div class="field-label">اندازهٔ متن معنی</div>
     <div class="seg" id="seg-font">${FONT_SIZES.map(([v, t]) => `<button data-v="${v}" class="${s.font === v ? 'on' : ''}">${t}</button>`).join('')}</div>
     ${
       canCache
         ? `<div class="field-label">استفادهٔ آفلاین در مرورگر</div>
            <button class="btn ghost" id="dl-all" style="width:100%">بارگیری همهٔ داده‌ها (حدود ۵۶ مگابایت)</button>
            <div class="progress" id="dl-progress" hidden><span></span></div>`
         : ''
     }
     <div class="about">
       <b>یاد</b> — لغت‌نامهٔ دهخدا، سریع، سبک و بی‌نیاز از اینترنت.<br/>
       ${stats ? `${fa(stats.entries)} مدخل و ${fa(stats.phrases)} ترکیب.` : ''}<br/>
       کلید «/» برای جستجو · دوبار کلیک روی هر واژه در متن معنی برای جستجوی آن.${bazaarLink()}
     </div>
     <div class="sheet-row"><button class="btn ghost" id="sheet-done" style="flex:1">بستن</button></div>`,
    (sh) => {
      $('#seg-theme', sh).onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        store.setSetting('theme', b.dataset.v);
        applySettings();
        sh.querySelectorAll('#seg-theme button').forEach((x) => x.classList.toggle('on', x === b));
      };
      $('#seg-font', sh).onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        store.setSetting('font', +b.dataset.v);
        applySettings();
        sh.querySelectorAll('#seg-font button').forEach((x) => x.classList.toggle('on', x === b));
      };
      $('#dl-all', sh)?.addEventListener('click', downloadAll);
      $('#sheet-done', sh).onclick = closeSheet;
    },
  );
}
$('#btn-settings').addEventListener('click', () => openSettings());

// Web only: fill the service-worker cache with every data file.
async function downloadAll() {
  const btn = $('#dl-all');
  const bar = $('#dl-progress');
  btn.disabled = true;
  bar.hidden = false;
  const meta = await fetch('data/meta.json', { cache: 'no-cache' }).then((r) => r.json());
  const files = ['data/words.txt', 'data/phrases.txt', 'data/phrase-parents.txt'];
  if (compatibleTagIndex(meta.tagVersion)) files.push('data/entry-tags.txt', 'data/phrase-tags.txt');
  if (compatibleSenseIndex(meta.senseVersion)) {
    files.push('data/sense-meta.txt');
    for (const id of new Set(meta.senseShardKeys.map(([, id]) => id))) files.push(`data/s/${id}.txt`);
  }
  if (meta.sourceVersion === SOURCE_VERSION) {
    for (let id = 0; id < meta.sourceCounts.length; id++) files.push(`data/r/${id}.txt`);
    if (meta.sourceSenseRows) files.push('data/source-senses.txt');
    for (const id of new Set(meta.sourceSenseShardKeys.map(([, id]) => id))) files.push(`data/u/${id}.txt`);
  }
  for (let i = 0; i < meta.blockStarts.length; i++) files.push(`data/m/${i}.txt`);
  for (let i = 0; i < meta.shards; i++) files.push(`data/t/${i}.txt`);
  for (let i = 0; i < files.length; i++) files[i] += `?v=${meta.build}`;
  const cache = await caches.open('yaad-data-v1');
  let done = 0;
  const next = async () => {
    while (files.length) {
      const f = files.pop();
      if (!(await cache.match(f))) {
        const res = await fetch(f);
        if (res.ok) await cache.put(f, res);
      }
      done++;
      bar.firstElementChild.style.width = `${(100 * done) / (done + files.length)}%`;
    }
  };
  try {
    await Promise.all(Array.from({ length: 6 }, next));
    btn.textContent = 'همهٔ داده‌ها برای استفادهٔ آفلاین ذخیره شد ✓';
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'خطا در بارگیری؛ دوباره تلاش کنید';
  }
}

// ------------------------------------------------------------------ routing

function route() {
  const hash = location.hash.slice(1) || '/';
  const [path, qs] = hash.split('?');
  const params = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  el.view.onclick = null;
  closeSheet();
  let main = true;
  if (parts[0] === 'e' && parts[1] != null) showEntry(+parts[1], params);
  else if (parts[0] === 'lists' && parts[1]) showList(parts[1]);
  else if (parts[0] === 'lists') showLists();
  else {
    main = false;
    showPlaceholder();
    // Look-ups from other apps (e.g. Doost): #/?q=word[&go=1]
    if (params.get('q')) lookupFromOutside(params.get('q'), params.get('go') === '1');
  }
  el.app.classList.toggle('show-main', main);
  $('#btn-lists').classList.toggle('active', parts[0] === 'lists');
}
window.addEventListener('hashchange', route);

// Shows the results for a word sent by another app; with `go`, opens the exact headword too.
// The query leaves the URL first so going back from the entry doesn't repeat the look-up.
async function lookupFromOutside(q, go) {
  history.replaceState(null, '', '#/');
  el.q.value = q;
  await runSearch(q);
  const exact = search.head.find((h) => h.tier === 0 && !h.phrase);
  if (go && exact) location.hash = entryHref(exact.id);
}

// Native app: yaad://search?q=word (from Doost or any other app), on launch or while running.
function handleLaunchUrls() {
  if (!isNative) return;
  const App = plugin('App');
  const open = (url) => {
    try {
      const q = new URL(url).searchParams.get('q');
      if (q) lookupFromOutside(q, false); // show the results; the user picks the entry
    } catch (e) {
      /* not a look-up link */
    }
  };
  App?.addListener?.('appUrlOpen', (e) => open(e.url));
  App?.getLaunchUrl?.()
    .then((r) => r?.url && open(r.url))
    .catch(() => {});
}

store.onChange(() => {
  if (!el.home.hidden && !search.q) renderHome();
});

// ------------------------------------------------------------------ start

let stats = null;
applySettings();
call('init')
  .then((s) => {
    stats = s;
    $('#splash').classList.add('hide');
    setTimeout(() => $('#splash').remove(), 400);
    renderHome();
    route();
    handleLaunchUrls();
    if (!mobile()) el.q.focus();
    // Web: drop cached data files from older dictionary builds.
    if ('caches' in window && !isNative && !isElectron) {
      caches
        .open('yaad-data-v1')
        .then((c) => c.keys().then((keys) => keys.forEach((k) => !k.url.endsWith(`v=${s.build}`) && !k.url.endsWith('meta.json') && c.delete(k))))
        .catch(() => {});
    }
  })
  .catch((err) => {
    $('#splash').innerHTML = `<p style="padding:20px;text-align:center">بارگذاری داده‌ها ناموفق بود.<br/><small>${esc(err.message)}</small></p>`;
  });

if ('serviceWorker' in navigator && location.protocol === 'https:' && !isNative && !isElectron) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Android hardware back button (Capacitor): go back in history, exit at the root.
if (isNative) {
  const App = plugin('App');
  App?.addListener?.('backButton', () => {
    if (!el.sheet.hidden) return closeSheet();
    if (location.hash && location.hash !== '#/') history.back();
    else App.exitApp();
  });
}
