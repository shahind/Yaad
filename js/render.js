// Turns the compact meaning markup produced by tools/build-data.mjs into HTML / plain text.
//   \n line break, \x01 new sense, \x02..\x03 citation, \x04 sub-entry,
//   \x05..\x06 highlighted phrase, \x0e..\x0f inline pronunciation
import { normalizeCompact, termTester } from './normalize.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

const inline = (s) =>
  esc(s)
    .replace(/\x02([^\x03]*)\x03?/g, '<cite>$1</cite>')
    .replace(/\x05([^\x06]*)\x06?/g, '<b class="hl">$1</b>')
    .replace(/\x0e([^\x0f]*)\x0f?/g, '<span class="pron">[$1]</span>')
    .replace(/\x04/g, '<span class="sub">♦</span>');

const isCiteLine = (l) => /^\x02[^\x03]*\x03[\s.]*$/.test(l);

export function renderMeaning(body) {
  const lines = body.replace(/\x01/g, '\n\x01').split('\n').filter((l) => l.trim());
  // Lines directly above a citation-only line are verses (Dehkhoda quotes poetry that way).
  const verse = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!isCiteLine(lines[i])) continue;
    for (let j = i - 1, n = 0; j >= 0 && n < 8; j--, n++) {
      const l = lines[j];
      if (verse[j] || isCiteLine(l) || l.startsWith('\x01') || l.includes('\x04') || /[:：]\s*$/.test(l) || l.length > 140) break;
      verse[j] = true;
    }
  }
  let html = '';
  for (let i = 0; i < lines.length; i++) {
    if (verse[i]) {
      html += '<div class="verse">';
      while (i < lines.length && verse[i]) html += `<p>${inline(lines[i++])}</p>`;
      if (i < lines.length && isCiteLine(lines[i])) html += inline(lines[i]);
      else i--;
      html += '</div>';
      continue;
    }
    const l = lines[i];
    if (l.startsWith('\x01')) html += `<p class="sense">${inline(l.slice(1))}</p>`;
    else html += `<p>${inline(l)}</p>`;
  }
  return html;
}

export function meaningText(body) {
  return body
    .replace(/\x01/g, '\n• ')
    .replace(/\x02([^\x03]*)\x03?/g, '— $1')
    .replace(/\x0e([^\x0f]*)\x0f?/g, '[$1]')
    .replace(/\x04/g, '♦ ')
    .replace(/[\x00-\x09\x0b-\x1f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n /g, '\n')
    .trim();
}

// Wrap words of `root` whose normalized form is in `terms` with <mark>.
export function markTerms(root, terms) {
  if (!terms || !terms.length) return [];
  const test = termTester(terms);
  const marks = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const re = /[^\s.,;:!?()[\]«»"'،؛؟]+/g;
  for (const node of nodes) {
    const text = node.nodeValue;
    let m;
    let last = 0;
    let frag = null;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      if (!test(m[0])) continue;
      frag ??= document.createDocumentFragment();
      frag.append(text.slice(last, m.index));
      const mk = document.createElement('mark');
      mk.textContent = m[0];
      frag.append(mk);
      marks.push(mk);
      last = m.index + m[0].length;
    }
    if (frag) {
      frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }
  return marks;
}

// Highlight a query inside headword text (normalization-aware, best effort).
export function highlightWord(word, query) {
  const q = normalizeCompact(query);
  if (!q) return esc(word);
  // Map compact-normalized positions back to original characters.
  const map = [];
  let compact = '';
  for (let i = 0; i < word.length; i++) {
    const n = normalizeCompact(word[i]);
    for (const ch of n) {
      compact += ch;
      map.push(i);
    }
  }
  const at = compact.indexOf(q);
  if (at < 0) return esc(word);
  const s = map[at];
  let e = map[at + q.length - 1] + 1;
  while (e < word.length && !normalizeCompact(word[e]) && word[e] !== ' ') e++; // keep trailing diacritics
  return esc(word.slice(0, s)) + '<b>' + esc(word.slice(s, e)) + '</b>' + esc(word.slice(e));
}
