// Converts the Dehkhoda SQL dumps (DB/*.sql) into Yaad's compact offline format (www/data).
//
// Output:
//   meta.json                 counts, block table, shard count, stopwords
//   words.bin                 gzip text: one display headword per line, line i = entry i
//   phrases.bin               gzip text: one sub-entry phrase per line (e.g. «به یاد آوردن» inside «یاد»)
//   phrase-parents.bin        gzip Uint32 LE: parent entry id of each phrase line
//   m/<n>.bin                 gzip text blocks of meanings: records "pron \x1f body" joined by \x1e
//   t/<n>.bin                 gzip inverted-index shards for full-text (meaning) search
//
// Meaning markup (control chars instead of HTML, rendered by the app):
//   \n line break, \x01 new sense (◄), \x02..\x03 citation, \x04 sub-entry (♦),
//   \x05..\x06 highlighted phrase, \x0e..\x0f inline pronunciation
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { allRows } from './sqlparse.mjs';
import { tokenize, normalizeCompact } from '../www/js/normalize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'DB');
const OUT = path.join(ROOT, 'www', 'data');
const BLOCK_BYTES = 64 * 1024; // encoded size target of a meaning block
const STOP_DF = +(process.env.STOP_DF || 0.06); // tokens present in more than this fraction of entries are not indexed
const MAX_POSTINGS_TOKEN_POS = +(process.env.MAX_POS || 500); // only the first N tokens of an entry are indexed

const gz = (buf) => zlib.gzipSync(buf, { level: 9 });
const write = (rel, buf) => {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return buf.length;
};

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', zwnj: '‌' };
const decodeEntities = (s) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1));
    return ENT[e.toLowerCase()] ?? m;
  });
const persianDigits = (s) => s.replace(/[٠-٩]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 0x06f0));
const clean = (s) => persianDigits(decodeEntities(s.replace(/<\/?[a-zA-Z][^>]*>/g, ''))).replace(/\s+/g, ' ').trim();

function convert(word, html) {
  let m = html;
  const phrases = [];
  // Leading headword header (we show the headword ourselves).
  m = m.replace(/^\s*<span class="hlight">[^<]*<\/span>/, '');
  // Pronunciation: the headword's own one sits right at the start; later ones belong to
  // sub-entries and stay inline.
  let pron = '';
  m = m.replace(/<font color="DarkGreen"><b>([\s\S]*?)<\/font><\/b>/g, (_, inner, off) => {
    const t = clean(inner).replace(/^\[\s*|\s*\]$/g, '').trim();
    if (off < 8) {
      pron = t;
      return ' ';
    }
    return t ? `\x0e${t}\x0f` : ' ';
  });
  m = m.replace(/(<br\s*\/?>\s*)?<font color="Blue">◄<\/font>/gi, '\x01');
  m = m.replace(/<font color="HotPink">\s*♦\s*<\/font>/g, '\x04');
  m = m.replace(/<font color="Red">([\s\S]*?)<\/font>/g, (_, inner) => `\x02${clean(inner.replace(/<br\s*\/?>/gi, ' '))}\x03`);
  m = m.replace(/<span class="hlight" dir="[a-z]+">([^<]*)<\/span>/g, '$1');
  m = m.replace(/<span class="hlight">([^<]*)<\/span>/g, (match, inner, off, str) => {
    const t = clean(inner);
    if (!/[\p{L}\p{N}]/u.test(t)) return ` ${t} `;
    if (/^\s*؛/.test(str.slice(off + match.length, off + match.length + 8)) && t.length >= 2 && t.length <= 70) {
      phrases.push(t);
    }
    return `\x05${t}\x06`;
  });
  m = m.replace(/<br\s*\/?>/gi, '\n');
  m = m.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  m = persianDigits(decodeEntities(m));
  m = m
    .replace(/[ \t\r ]+/g, ' ')
    .replace(/ ?([\n\x01\x02\x03\x04\x05\x06]) ?/g, '$1')
    .replace(/\n*\x01\n*/g, '\x01')
    .replace(/\n{2,}/g, '\n')
    .replace(/^[\s\n]+|[\s\n]+$/g, '');
  return { pron: persianDigits(pron), body: m, phrases };
}

// Plain text of a converted body for indexing. Citations (poet/source) and short
// parentheticals — mostly source references such as «(منتهی الارب )» or grammar tags
// such as «(ع اِ)» — are left out: they are noise for meaning search.
const plain = (body) =>
  body
    .replace(/\x02[^\x03]*\x03/g, ' ')
    .replace(/\([^()\n]{0,40}\)/g, ' ')
    .replace(/[\x00-\x1f]/g, ' ');

function varint(arr, n) {
  while (n >= 0x80) {
    arr.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  arr.push(n);
}

// ---------------------------------------------------------------------------
console.time('parse');
const rows = [];
for (const r of allRows(SRC)) rows.push(r);
rows.sort((a, b) => a.id - b.id);
console.timeEnd('parse');
console.log('entries', rows.length);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

console.time('convert');
const words = [];
const phraseTexts = [];
const phraseParents = [];
const blockStarts = [];
const bodies = new Array(rows.length);
const records = new Array(rows.length);
rows.forEach((r, id) => {
  const word = r.word.replace(/\s+/g, ' ').trim();
  words.push(word);
  const { pron, body, phrases } = convert(word, r.meaning);
  bodies[id] = body;
  records[id] = `${pron}\x1f${body}`;
  const seen = new Set([normalizeCompact(word)]);
  for (const p of phrases) {
    const k = normalizeCompact(p);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    phraseTexts.push(p);
    phraseParents.push(id);
  }
});

// Single-byte charset: the 255 most frequent code points get one byte each; anything
// else is written as 0xFF + 3-byte code point. Halves the size of Persian text before
// gzip and noticeably improves the compressed size too.
const freq = new Map([['\x1e', Infinity]]); // record separator is added between records
for (const rec of records) for (const ch of rec) freq.set(ch, (freq.get(ch) || 0) + 1);
const charset = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 255).map(([c]) => c);
const charIndex = new Map(charset.map((c, i) => [c, i]));
const encodeRecord = (rec, out) => {
  for (const ch of rec) {
    const i = charIndex.get(ch);
    if (i !== undefined) out.push(i);
    else {
      const cp = ch.codePointAt(0);
      out.push(255, cp >> 16, (cp >> 8) & 255, cp & 255);
    }
  }
};
let rawMeaningBytes = 0;
let packedBytes = 0;
let block = [];
const flushBlock = () => {
  if (!block.length) return;
  rawMeaningBytes += block.length;
  packedBytes += write(`m/${blockStarts.length - 1}.bin`, gz(Buffer.from(block)));
  block = [];
};
records.forEach((rec, id) => {
  if (!block.length) blockStarts.push(id);
  else block.push(charIndex.get('\x1e'));
  encodeRecord(rec, block);
  if (block.length >= BLOCK_BYTES) flushBlock();
});
flushBlock();
console.timeEnd('convert');

const wordsBytes = write('words.bin', gz(Buffer.from(words.join('\n'), 'utf8')));
const phrasesBytes = write('phrases.bin', gz(Buffer.from(phraseTexts.join('\n'), 'utf8')));
const pp = new Uint32Array(phraseParents);
const ppBytes = write('phrase-parents.bin', gz(Buffer.from(pp.buffer)));

// ---------------------------------------------------------------------------
// Full-text index. Score per (token, entry) = BM25 term weight × early-position boost,
// quantized to 4 bits. idf is applied at query time from the posting count.
console.time('index');
const N = rows.length;
const docTokens = new Array(N);
const docSyn = new Array(N); // tokens standing alone in a short segment: «… . یادگار .» = synonym
let totalLen = 0;
for (let id = 0; id < N; id++) {
  const toks = [];
  const syn = new Set();
  for (const seg of plain(bodies[id].replace(/\x01/g, '.')).split(/[.؛،:]/)) {
    const st = tokenize(seg);
    if (st.length && st.length <= 2 && toks.length < MAX_POSTINGS_TOKEN_POS) st.forEach((t) => syn.add(t));
    for (const t of st) toks.push(t);
  }
  docTokens[id] = toks;
  docSyn[id] = syn;
  totalLen += toks.length;
}
const avgLen = totalLen / N;
const df = new Map();
for (let id = 0; id < N; id++) {
  const seen = new Set(docTokens[id].slice(0, MAX_POSTINGS_TOKEN_POS));
  for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
}
const stop = new Set([...df].filter(([, c]) => c > N * STOP_DF).map(([t]) => t));
console.log('vocabulary', df.size, 'stopwords', stop.size);

const k1 = 1.2;
const b = 0.75;
const postings = new Map(); // token -> number[] (id, score, id, score...)
for (let id = 0; id < N; id++) {
  const toks = docTokens[id];
  const lim = Math.min(toks.length, MAX_POSTINGS_TOKEN_POS);
  const tf = new Map();
  const first = new Map();
  for (let i = 0; i < lim; i++) {
    const t = toks[i];
    if (stop.has(t)) continue;
    tf.set(t, (tf.get(t) || 0) + 1);
    if (!first.has(t)) first.set(t, i);
  }
  const L = toks.length;
  for (const [t, f] of tf) {
    const w = (f * (k1 + 1)) / (f + k1 * (1 - b + (b * L) / avgLen));
    const pos = first.get(t);
    const boost = (1 + 3 / (1 + pos / 6)) * (docSyn[id].has(t) ? 2.5 : 1);
    // 4-bit log-scale score, packed into the posting delta (decoded in search.worker.js).
    const q = Math.max(0, Math.min(15, Math.floor(Math.log2((w * boost) / 0.1) * 1.95)));
    let arr = postings.get(t);
    if (!arr) postings.set(t, (arr = []));
    arr.push(id, q);
  }
  docTokens[id] = null;
  docSyn[id] = null;
}

// Group tokens into shards by prefix, so a query can enumerate every indexed token that
// starts with a given prefix ("یاد" -> "یادگار", "یادآوری", …) by loading only a few files.
// A prefix group that is too large is split by its next character (a trie); small sibling
// groups are then packed together. meta.shardKeys maps each group prefix to its file.
const SHARD_BUDGET = 160 * 1024; // raw bytes per shard file
const enc = new TextEncoder();
const allTokens = [...postings.keys()].sort();
const encoded = allTokens.map((t) => {
  const arr = postings.get(t);
  const body = [];
  let prev = 0;
  for (let i = 0; i < arr.length; i += 2) {
    varint(body, (arr[i] - prev) * 16 + arr[i + 1]);
    prev = arr[i];
  }
  return { t, tb: enc.encode(t), body, count: arr.length / 2 };
});
const sizeOf = (e) => e.tb.length + e.body.length + 8;
const groups = []; // { key, from, to } over `encoded`, in sorted order
function partition(from, to, prefix) {
  let size = 0;
  for (let i = from; i < to; i++) size += sizeOf(encoded[i]);
  if (size <= SHARD_BUDGET || to - from <= 1) {
    groups.push({ key: prefix, from, to, size });
    return;
  }
  const depth = prefix.length;
  let i = from;
  if (encoded[i].t.length === depth) {
    groups.push({ key: prefix, from: i, to: i + 1, size: sizeOf(encoded[i]) });
    i++;
  }
  while (i < to) {
    const c = encoded[i].t[depth];
    let j = i;
    while (j < to && encoded[j].t[depth] === c) j++;
    partition(i, j, prefix + c);
    i = j;
  }
}
partition(0, encoded.length, '');

const shardKeys = [];
let indexBytes = 0;
let postingCount = 0;
let shardCount = 0;
for (let g = 0; g < groups.length; ) {
  const members = [];
  let size = 0;
  while (g < groups.length && (members.length === 0 || size + groups[g].size <= SHARD_BUDGET)) {
    size += groups[g].size;
    members.push(groups[g++]);
  }
  const head = [];
  const body = [];
  const n = members.reduce((a, m) => a + m.to - m.from, 0);
  varint(head, n);
  for (const m of members) {
    shardKeys.push([m.key, shardCount]);
    for (let i = m.from; i < m.to; i++) {
      const e = encoded[i];
      varint(head, e.tb.length);
      for (const x of e.tb) head.push(x);
      varint(head, e.count);
      varint(head, e.body.length);
      for (const x of e.body) body.push(x);
      postingCount += e.count;
    }
  }
  indexBytes += write(`t/${shardCount}.bin`, gz(Buffer.concat([Buffer.from(head), Buffer.from(body)])));
  shardCount++;
}
console.log('index shards', shardCount, 'keys', shardKeys.length);
console.timeEnd('index');

const meta = {
  version: 1,
  build: Date.now().toString(36),
  entries: N,
  phrases: phraseTexts.length,
  blockStarts,
  shards: shardCount,
  shardKeys,
  stopwords: [...stop],
  charset: charset.join(''),
  built: new Date().toISOString(),
};
write('meta.json', Buffer.from(JSON.stringify(meta)));

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
console.log({
  phrases: phraseTexts.length,
  blocks: blockStarts.length,
  rawMeaning: mb(rawMeaningBytes),
  meanings: mb(packedBytes),
  words: mb(wordsBytes),
  phrasesFile: mb(phrasesBytes + ppBytes),
  postings: postingCount,
  index: mb(indexBytes),
  total: mb(packedBytes + wordsBytes + phrasesBytes + ppBytes + indexBytes),
});
