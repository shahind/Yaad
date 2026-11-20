// Converts the Dehkhoda SQL dumps (DB/*.sql) into Yaad's compact offline format (www/data).
//
// Output:
//   meta.json                 counts, block table, shard count, stopwords
//   words.txt                 gzip text: one display headword per line, line i = entry i
//   phrases.txt               gzip text: one sub-entry phrase per line (e.g. «به یاد آوردن» inside «یاد»)
//   phrase-parents.txt        gzip Uint32 LE: parent entry id of each phrase line
//   entry-tags.txt            gzip Uint64 LE: origin and grammar bits per entry
//   phrase-tags.txt           gzip Uint64 LE: each compound's own opening labels
//   m/<n>.txt                 gzip text blocks of meanings: records "pron \x1f body" joined by \x1e
//   sense-meta.txt            gzip JSON: ranges/labels for senses of labelled entries
//   s/<n>.txt                 gzip sparse token -> sense postings
//   r/<id>.txt                gzip delta-varint owners per named source
//   source-senses.txt, u/     compound owner scopes/postings not already in s/
//   t/<n>.txt                 gzip inverted-index shards for full-text (meaning) search
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
import { TAG_VERSION } from '../www/js/search-origin-grammar.js';
import { SENSE_VERSION, readOpeningTags, splitSenses } from '../www/js/search-subject-usage.js';
import { SOURCE_VERSION, SOURCE_TAGS, sourceOwners } from '../www/js/search-citations.js';
import { writeTokenShards, writeSourceIndex, TAG_COUNTS_VERSION, countTags, indexableMeaning as plain, scopedTokens } from './search-index.mjs';

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
      const opening = clean(str.slice(off + match.length, off + match.length + 1024));
      phrases.push({ word: t, tags: readOpeningTags(opening).mask });
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
const entryTags = new BigUint64Array(rows.length);
const phraseTags = [];
const senseRows = [];
const compoundRows = [];
let sourceCompoundEntries = 0;
const blockStarts = [];
const bodies = new Array(rows.length);
const records = new Array(rows.length);
const sourcePostings = SOURCE_TAGS.map(() => []);
let sourceScanMs = 0;
rows.forEach((r, id) => {
  const word = r.word.replace(/\s+/g, ' ').trim();
  words.push(word);
  const { pron, body, phrases } = convert(word, r.meaning);
  entryTags[id] = readOpeningTags(body).mask;
  bodies[id] = body;
  records[id] = `${pron}\x1f${body}`;
  const seen = new Set([normalizeCompact(word)]);
  const phraseIds = new Map([[normalizeCompact(word), -1]]);
  for (const p of phrases) {
    const k = normalizeCompact(p.word);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    phraseIds.set(k, phraseTexts.length);
    phraseTexts.push(p.word);
    phraseParents.push(id);
    phraseTags.push(p.tags);
  }
  const senses = splitSenses(body, phraseIds);
  const sourceStart = performance.now();
  let citedCompound = false;
  for (const [owner, sources] of sourceOwners(body, senses)) {
    if (owner < 0) continue;
    if (owner > 0) citedCompound = true;
    const sourceOwner = owner === 0 ? id : rows.length + owner - 1;
    for (const source of sources) sourcePostings[source].push(sourceOwner);
  }
  sourceScanMs += performance.now() - sourceStart;
  if (citedCompound) sourceCompoundEntries++;
  if (senses.some((sense) => sense.facets.length)) {
    for (const sense of senses) senseRows.push([id, sense.phrase, sense.start, sense.end, sense.facets]);
  } else if (senses.some((sense) => sense.phrase !== 0)) {
    for (const sense of senses) compoundRows.push([id, sense.phrase, sense.start, sense.end, sense.facets]);
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
  packedBytes += write(`m/${blockStarts.length - 1}.txt`, gz(Buffer.from(block)));
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

const wordsBytes = write('words.txt', gz(Buffer.from(words.join('\n'), 'utf8')));
const phrasesBytes = write('phrases.txt', gz(Buffer.from(phraseTexts.join('\n'), 'utf8')));
const pp = new Uint32Array(phraseParents);
const ppBytes = write('phrase-parents.txt', gz(Buffer.from(pp.buffer)));
const entryTagBytes = write('entry-tags.txt', gz(Buffer.from(entryTags.buffer)));
const phraseTagBytes = write('phrase-tags.txt', gz(Buffer.from(new BigUint64Array(phraseTags).buffer)));
const sourceWriteStart = performance.now();
const sourceIndex = writeSourceIndex(sourcePostings, (file, bytes) => write(file, gz(bytes)));
sourcePostings.length = 0;
console.log('source index', { bytes: sourceIndex.indexBytes, rawBytes: sourceIndex.rawBytes,
  postings: sourceIndex.postingCount, scanMs: Math.round(sourceScanMs), writeMs: Math.round(performance.now() - sourceWriteStart) });

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
const writeIndex = (file, bytes) => write(file, gz(bytes));
const { shardKeys, shardCount, indexBytes, postingCount } = writeTokenShards(postings, writeIndex);
console.log('index shards', shardCount, 'keys', shardKeys.length);
console.timeEnd('index');

// Only entries with subject/usage labels need a second set of postings. Keep all
// their senses, including unlabelled ones, so exclusion filters remain accurate.
function writeScopedIndex(scopeRows, directory) {
  const postings = new Map();
  let previousEntry = -1;
  let consumed = 0;
  for (let sense = 0; sense < scopeRows.length; sense++) {
    const [id, , start, end] = scopeRows[sense];
    if (id !== previousEntry) { previousEntry = id; consumed = 0; }
    const { tokens, skip } = scopedTokens(bodies[id].slice(start, end));
    const indexed = tokens.slice(skip, Math.max(skip, MAX_POSTINGS_TOKEN_POS - consumed));
    consumed += tokens.length;
    for (const token of new Set(indexed)) {
      if (stop.has(token)) continue;
      if (!postings.has(token)) postings.set(token, []);
      postings.get(token).push(sense, 0);
    }
  }
  return writeTokenShards(postings, writeIndex, directory);
}
const senseIndex = writeScopedIndex(senseRows, 's');
const senseMetaBytes = write('sense-meta.txt', gz(Buffer.from(JSON.stringify(senseRows))));
const compoundScopeStart = performance.now();
const compoundIndex = compoundRows.length ? writeScopedIndex(compoundRows, 'u') : { shardKeys: [], indexBytes: 0 };
const compoundMetaBytes = compoundRows.length ? write('source-senses.txt', gz(Buffer.from(JSON.stringify(compoundRows)))) : 0;
console.log('compound scopes', { rows: compoundRows.length, bytes: compoundIndex.indexBytes + compoundMetaBytes,
  postings: compoundIndex.postingCount || 0, buildMs: Math.round(performance.now() - compoundScopeStart) });

const tagCountStart = performance.now();
const tagCounts = countTags(entryTags, phraseTags, senseRows);
console.log('tag totals', { ms: Math.round(performance.now() - tagCountStart),
  metadataBytes: Buffer.byteLength(JSON.stringify({ tagCountsVersion: TAG_COUNTS_VERSION, tagCounts })) - 1 });

const meta = {
  version: 1,
  tagCountsVersion: TAG_COUNTS_VERSION,
  tagCounts,
  tagVersion: TAG_VERSION,
  sourceVersion: SOURCE_VERSION,
  compoundScopeVersion: 1,
  sourceCounts: sourceIndex.counts,
  sourceCompoundEntries,
  sourceSenseRows: compoundRows.length,
  sourceSenseShardKeys: compoundIndex.shardKeys,
  senseVersion: SENSE_VERSION,
  senseRows: senseRows.length,
  senseShardKeys: senseIndex.shardKeys,
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
const metaBytes = write('meta.json', Buffer.from(JSON.stringify(meta)));

const totalBytes = packedBytes + wordsBytes + phrasesBytes + ppBytes + entryTagBytes + phraseTagBytes
  + indexBytes + senseIndex.indexBytes + senseMetaBytes + sourceIndex.indexBytes
  + compoundIndex.indexBytes + compoundMetaBytes + metaBytes;
const mb = (n) => (n / 1048576).toFixed(2) + ' MiB';
console.log({
  phrases: phraseTexts.length,
  blocks: blockStarts.length,
  rawMeaning: mb(rawMeaningBytes),
  meanings: mb(packedBytes),
  words: mb(wordsBytes),
  phrasesFile: mb(phrasesBytes + ppBytes),
  tags: mb(entryTagBytes + phraseTagBytes),
  sources: mb(sourceIndex.indexBytes),
  compoundScopes: mb(compoundIndex.indexBytes + compoundMetaBytes),
  senses: senseRows.length,
  senseIndex: mb(senseIndex.indexBytes + senseMetaBytes),
  postings: postingCount,
  index: mb(indexBytes),
  metadata: mb(metaBytes),
  totalBytes,
  total: mb(totalBytes),
});
