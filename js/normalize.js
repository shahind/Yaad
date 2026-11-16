// Persian text normalization shared by the data builder (Node) and the app (browser/worker).
// Everything that is compared during search goes through these functions, so build and
// runtime must use exactly the same tables.

// Char-code lookup table: 0 = delete, 32 = separator (space), otherwise mapped code.
const T = new Uint16Array(65536);
for (let c = 0; c < 65536; c++) T[c] = c;

const setMap = (from, to) => {
  for (const ch of from) T[ch.charCodeAt(0)] = typeof to === 'number' ? to : to.charCodeAt(0);
};

// Unify Arabic/Persian letter variants.
setMap('يىئۍېےۓ', 'ی');
setMap('كڪ', 'ک');
setMap('ةۀەہھ', 'ه');
setMap('أإآٱٲٳ', 'ا');
setMap('ؤ', 'و');
// Digits (Arabic-Indic and Persian) -> ASCII.
for (let i = 0; i < 10; i++) {
  T[0x0660 + i] = 48 + i;
  T[0x06f0 + i] = 48 + i;
}
// Latin upper -> lower.
for (let c = 65; c <= 90; c++) T[c] = c + 32;
// Diacritics, tatweel, hamza, superscript alef, zero-width marks: delete.
for (let c = 0x064b; c <= 0x065f; c++) T[c] = 0;
for (const c of [0x0670, 0x0640, 0x0621, 0x200d, 0x200e, 0x200f, 0xfeff, 0x00ad]) T[c] = 0;
// Spaces, ZWNJ and punctuation: separator.
for (const c of [0x09, 0x0a, 0x0d, 0x20, 0xa0, 0x200c, 0x200b]) T[c] = 32;
for (const ch of '.,;:!?()[]{}<>«»"\'`/\\|-_=+*&^%$#@~،؛؟٪٫٬…–—‐ـ•♦◄') T[ch.charCodeAt(0)] = 32;
T[0x0640] = 0; // tatweel is deleted, not a separator

export const NORM_TABLE = T;

/**
 * Normalize to "spaced" form: unified letters, no diacritics, words separated by single spaces.
 * Newlines are preserved when keepNewlines is true (used to normalize whole word lists at once).
 */
export function normalizeSpaced(s, keepNewlines = false) {
  let out = '';
  let buf = [];
  let lastSpace = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (keepNewlines && c === 10) {
      if (buf.length && buf[buf.length - 1] === 32) buf.pop();
      buf.push(10);
      lastSpace = true;
    } else {
      const m = T[c];
      if (m === 0) continue;
      if (m === 32) {
        if (!lastSpace) { buf.push(32); lastSpace = true; }
      } else {
        buf.push(m);
        lastSpace = false;
      }
    }
    if (buf.length > 8192) {
      out += String.fromCharCode.apply(null, buf);
      buf = [];
    }
  }
  if (buf.length && buf[buf.length - 1] === 32) buf.pop();
  out += String.fromCharCode.apply(null, buf);
  return out.startsWith(' ') ? out.slice(1) : out;
}

/** Compact form: like spaced but with all separators removed. Used for headword matching. */
export function normalizeCompact(s) {
  return normalizeSpaced(s).replace(/ /g, '');
}

/** Split text into normalized search tokens (ZWNJ joins, other separators split). */
export function tokenize(s) {
  // ZWNJ inside a word joins the parts ("می‌رود" -> "میرود"); everything else separates.
  return normalizeSpaced(s.replace(/\u200c/g, '')).split(' ').filter((t) => t.length > 1);
}

/**
 * Returns a word tester for query terms: 2 = exact token match, 1 = prefix match
 * (terms of 3+ letters, mirroring meaning search), 0 = no match.
 */
export function termTester(terms) {
  const set = new Set(terms);
  const prefixes = terms.filter((t) => t.length >= 3);
  return (word) => {
    const t = normalizeCompact(word.replace(/\u200c/g, ''));
    if (!t) return 0;
    if (set.has(t)) return 2;
    for (const p of prefixes) if (t.startsWith(p)) return 1;
    return 0;
  };
}
