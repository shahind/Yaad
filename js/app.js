import * as store from './store.js';
import { renderMeaning, meaningText, markTerms, highlightWord, esc } from './render.js';
import { copyText, shareText, isNative, isElectron, plugin } from './platform.js';
import { normalizeCompact } from './normalize.js';

// ------------------------------------------------------------------ worker RPC

const worker = new Worker(new URL('./search.worker.js', import.meta.url), { type: 'module' });
let rpcSeq = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const { id, result, error } = e.data;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  error ? p.reject(new Error(error)) : p.resolve(result);
};
const call = (type, payload) =>
  new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    pending.set(id, { resolve, reject });
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
const search = { q: '', head: [], meaning: [], terms: [], meaningTotal: 0, seq: 0, shownHead: 0, shownMeaning: 0, meaningPending: false };
let meaningTimer;

el.q.addEventListener('input', () => runSearch(el.q.value));
el.clear.addEventListener('click', () => {
  el.q.value = '';
  runSearch('');
  el.q.focus();
});

async function runSearch(q) {
  const seq = ++search.seq;
  search.q = q;
  el.clear.hidden = !q;
  clearTimeout(meaningTimer);
  if (!normalizeCompact(q)) {
    search.head = [];
    search.meaning = [];
    el.results.innerHTML = '';
    el.status.textContent = '';
    el.home.hidden = false;
    renderHome();
    return;
  }
  el.home.hidden = true;
  const { head, ms } = await call('search', { q });
  if (seq !== search.seq) return;
  search.head = head;
  search.meaning = [];
  search.terms = [];
  search.meaningPending = true;
  search.shownHead = 0;
  search.shownMeaning = 0;
  renderResults();
  el.status.textContent = `${headCount(head)} واژه · ${fa(Math.max(1, Math.round(ms)))} میلی‌ثانیه`;
  // Meaning search fetches index shards; give fast typists a moment.
  meaningTimer = setTimeout(async () => {
    const exclude = head.filter((h) => !h.phrase && h.tier <= 1).map((h) => h.id);
    const r = await call('meanings', { q, exclude });
    if (seq !== search.seq) return;
    search.meaning = r.results;
    search.terms = r.terms;
    search.meaningTotal = r.total || 0;
    search.meaningPending = false;
    renderMeaningSection();
    el.status.textContent = `${headCount(head)} واژه · ${fa(r.total || 0)} در متن معنی‌ها`;
  }, head.length ? 180 : 60);
}

function itemHTML(r, kind) {
  const href = r.phrase
    ? entryHref(r.id, `?p=${encodeURIComponent(r.w)}`)
    : kind === 'm'
      ? entryHref(r.id, `?t=${encodeURIComponent(search.terms.join(' '))}`)
      : entryHref(r.id);
  const word = kind === 'h' ? highlightWord(r.w, search.q) : esc(r.w);
  const extra = r.phrase ? `<span class="tag">ترکیب</span><span class="item-parent">در «${esc(r.parent)}»</span>` : '';
  return `<a class="item" href="${href}" data-id="${r.id}" data-kind="${kind}" data-p="${r.phrase ? 1 : 0}">
    <div class="item-head"><span class="item-word">${word}</span><span class="item-pron"></span>${extra}</div>
    <div class="item-snippet"></div></a>`;
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
  if (!search.meaning.length) {
    sec.innerHTML = search.head.length
      ? ''
      : `<div class="empty">${icon('search')}<br/>چیزی یافت نشد.<br/><small>املای دیگری را بیازمایید.</small></div>`;
    return;
  }
  sec.innerHTML = `<div class="section-title"><span>در متن معنی‌ها</span><span class="count">${fa(search.meaningTotal)}</span></div><div class="card" id="meaning-list"></div>`;
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
  const items = snippetQueue.splice(0);
  const groups = { plain: [], terms: [] };
  for (const it of items) (it.dataset.kind === 'm' ? groups.terms : groups.plain).push(it);
  const fill = async (its, terms) => {
    if (!its.length) return;
    const key = (id) => `${id}|${terms.join(' ')}`;
    const need = [...new Set(its.map((it) => +it.dataset.id).filter((id) => !snippetCache.has(key(id))))];
    if (need.length) {
      const res = await call('snippets', { ids: need, terms });
      for (const r of res) snippetCache.set(key(r.id), r);
      if (snippetCache.size > 3000) snippetCache.clear();
    }
    for (const it of its) {
      const s = snippetCache.get(key(+it.dataset.id));
      if (!s) continue;
      const sn = it.querySelector('.item-snippet');
      sn.textContent = s.text;
      if (terms.length) markTerms(sn, terms);
      if (s.pron && it.dataset.p !== '1') it.querySelector('.item-pron').textContent = s.pron;
    }
  };
  await Promise.all([fill(groups.plain, []), fill(groups.terms, search.terms)]);
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
      <div class="hero-label">${icon('shuffle')} واژهٔ تصادفی</div>
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
  if (stats) $('#stats').innerHTML = `${fa(stats.entries)} مدخل · ${fa(stats.phrases)} ترکیب<br/>کاملاً آفلاین`;
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
        ${e.pron ? `<div class="entry-pron">${esc(e.pron)}</div>` : ''}
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
  if (params.get('p')) {
    // Opened from a sub-entry phrase: scroll to it.
    const target = normalizeCompact(params.get('p'));
    focus = [...meaning.querySelectorAll('b.hl')].find((b) => normalizeCompact(b.textContent) === target);
    if (focus) {
      const mk = document.createElement('mark');
      focus.replaceWith(mk);
      mk.append(focus);
      focus = mk;
    }
  } else if (params.get('t')) {
    focus = markTerms(meaning, params.get('t').split(' ').filter(Boolean))[0];
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

function openSheet(html, onReady) {
  el.sheet.innerHTML = html;
  el.sheet.hidden = false;
  el.backdrop.hidden = false;
  onReady?.(el.sheet);
}
function closeSheet() {
  el.sheet.hidden = true;
  el.backdrop.hidden = true;
  el.sheet.innerHTML = '';
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
       کلید «/» برای جستجو · دوبار کلیک روی هر واژه در متن معنی برای جستجوی آن.
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
  const files = ['data/words.bin', 'data/phrases.bin', 'data/phrase-parents.bin'];
  for (let i = 0; i < meta.blockStarts.length; i++) files.push(`data/m/${i}.bin`);
  for (let i = 0; i < meta.shards; i++) files.push(`data/t/${i}.bin`);
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
  }
  el.app.classList.toggle('show-main', main);
  $('#btn-lists').classList.toggle('active', parts[0] === 'lists');
}
window.addEventListener('hashchange', route);
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
