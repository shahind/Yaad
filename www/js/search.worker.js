// Search worker: owns all dictionary data so the UI thread never blocks.
//
// Headword search runs over two in-memory lists (entries and sub-entry phrases), each kept
// as one "compact" normalized string so a query is a handful of native indexOf scans.
// Meaning search uses a sharded inverted index; only the shards of the query's tokens are
// fetched. Meaning blocks are fetched on demand and kept in a small LRU cache.
import { normalizeCompact, normalizeSpaced, tokenize, termTester } from './normalize.js';

const DATA = new URL('../data/', import.meta.url);
const HEAD_LIMIT = 400; // max headword results per query
const MEANING_LIMIT = 1000; // max meaning results per query
const BLOCK_CACHE = 48;
const SHARD_CACHE = 64;

let meta;
let charTable; // Uint16Array byte -> UTF-16 code unit
let words; // list of entries
let phrases; // list of sub-entry phrases
let phraseParents;
let stop;
const blockCache = new Map();
const shardCache = new Map();

// ---------------------------------------------------------------------------
// Loading

async function gunzipBytes(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return u8; // already decoded by the transport
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { gunzip } = await import('./inflate.js');
  return gunzip(u8);
}

async function fetchBin(path) {
  // ?v=<build> keeps HTTP/service-worker caches consistent across data rebuilds.
  const res = await fetch(new URL(`${path}?v=${meta.build}`, DATA));
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return gunzipBytes(await res.arrayBuffer());
}

const utf8 = new TextDecoder();

// Builds the searchable structure for a list of display strings (one per line).
function buildList(text) {
  const display = text.split('\n');
  const spaced = normalizeSpaced(text, true);
  const n = spaced.length;
  // compact = "\n" + keys joined by "\n" + "\n"; boundary marks word starts.
  const codes = new Uint16Array(n + 2);
  const boundary = new Uint8Array(n + 2);
  const lineStart = new Uint32Array(display.length + 1);
  let o = 0;
  let line = 0;
  codes[o++] = 10;
  lineStart[line++] = o;
  let wordStart = true;
  for (let i = 0; i < n; i++) {
    const c = spaced.charCodeAt(i);
    if (c === 10) {
      codes[o++] = 10;
      lineStart[line++] = o;
      wordStart = true;
    } else if (c === 32) {
      wordStart = true;
    } else {
      if (wordStart) boundary[o] = 1;
      wordStart = false;
      codes[o++] = c;
    }
  }
  codes[o++] = 10;
  lineStart[line] = o; // sentinel: start of the (non-existent) next line
  let compact = '';
  for (let i = 0; i < o; i += 8192) compact += String.fromCharCode.apply(null, codes.subarray(i, Math.min(o, i + 8192)));
  return { display, compact, boundary, lineStart, count: display.length };
}

async function init() {
  meta = await fetch(new URL('meta.json', DATA), { cache: 'no-cache' }).then((r) => r.json());
  const [w, p, pp] = await Promise.all([
    fetchBin('words.bin'),
    fetchBin('phrases.bin'),
    fetchBin('phrase-parents.bin'),
  ]);
  charTable = new Uint16Array(256);
  for (let i = 0; i < meta.charset.length; i++) charTable[i] = meta.charset.charCodeAt(i);
  stop = new Set(meta.stopwords);
  words = buildList(utf8.decode(w));
  phrases = buildList(utf8.decode(p));
  phraseParents = new Uint32Array(pp.buffer, pp.byteOffset, pp.byteLength >> 2);
  return { entries: meta.entries, phrases: meta.phrases, build: meta.build };
}

// ---------------------------------------------------------------------------
// Meaning blocks

function decodeBlock(bytes) {
  const out = new Uint16Array(bytes.length);
  let o = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b !== 255) out[o++] = charTable[b];
    else {
      const cp = (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
      i += 3;
      if (cp > 0xffff) {
        const v = cp - 0x10000;
        out[o++] = 0xd800 + (v >> 10);
        out[o++] = 0xdc00 + (v & 0x3ff);
      } else out[o++] = cp;
    }
  }
  let s = '';
  for (let i = 0; i < o; i += 8192) s += String.fromCharCode.apply(null, out.subarray(i, Math.min(o, i + 8192)));
  return s.split('\x1e');
}

function blockOf(id) {
  const starts = meta.blockStarts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= id) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

async function loadBlock(b) {
  let entry = blockCache.get(b);
  if (entry) {
    blockCache.delete(b);
    blockCache.set(b, entry);
    return entry;
  }
  entry = fetchBin(`m/${b}.bin`).then(decodeBlock);
  blockCache.set(b, entry);
  if (blockCache.size > BLOCK_CACHE) blockCache.delete(blockCache.keys().next().value);
  try {
    return await entry;
  } catch (e) {
    blockCache.delete(b);
    throw e;
  }
}

async function getRecord(id) {
  const b = blockOf(id);
  const recs = await loadBlock(b);
  const rec = recs[id - meta.blockStarts[b]];
  const sep = rec.indexOf('\x1f');
  return { pron: rec.slice(0, sep), body: rec.slice(sep + 1) };
}

async function getEntry(id) {
  if (id < 0 || id >= meta.entries) return null;
  const { pron, body } = await getRecord(id);
  return {
    id,
    word: words.display[id],
    pron,
    body,
    prev: id > 0 ? words.display[id - 1] : null,
    next: id + 1 < meta.entries ? words.display[id + 1] : null,
  };
}

// Plain-text snippet: around the first query term if given, else the opening of the entry.
const plainText = (body) =>
  body
    .replace(/\x01/g, ' ◄ ')
    .replace(/\x04/g, ' ♦ ')
    .replace(/[\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function findTerm(text, terms) {
  // Locate a term in the original text by scanning normalized words; exact beats prefix.
  if (!terms || !terms.length) return -1;
  const test = termTester(terms);
  const re = /[^\s.,;:!?()[\]«»"'،؛؟]+/g;
  let m;
  let prefixAt = -1;
  while ((m = re.exec(text))) {
    const r = test(m[0]);
    if (r === 2) return m.index;
    if (r === 1 && prefixAt < 0) prefixAt = m.index;
  }
  return prefixAt;
}

async function snippet(id, terms) {
  const { pron, body } = await getRecord(id);
  const text = plainText(body);
  const at = findTerm(text, terms);
  let s;
  if (at <= 40) s = text.slice(0, 160);
  else {
    let from = text.lastIndexOf(' ', at - 40);
    from = from < 0 ? 0 : from + 1;
    s = '… ' + text.slice(from, from + 160);
  }
  if (s.length < text.length) s = s.replace(/\s+\S*$/, '') + ' …';
  return { id, pron, text: s };
}

// ---------------------------------------------------------------------------
// Headword search

function lineOf(list, pos) {
  const ls = list.lineStart;
  let lo = 0;
  let hi = list.count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ls[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// A compact match may join words ("یادآوردن" matches «یاد آوردن»), but must not glue
// unrelated word fragments together («… ن یا در …» is not a match for «یاد»). Joins that
// the query did not ask for are accepted only for whole words or at the start of the line.
function validMatch(list, p, len, qBounds, lineStartPos) {
  const { boundary, compact } = list;
  let unexpected = false;
  for (let k = 1; k < len; k++) {
    if (boundary[p + k] && !qBounds.has(k)) {
      unexpected = true;
      break;
    }
  }
  if (!unexpected) return true;
  if (p === lineStartPos) return true;
  return boundary[p] === 1 && (boundary[p + len] === 1 || compact.charCodeAt(p + len) === 10);
}

// Returns 4 tiers of line numbers: exact, prefix, word-start, substring.
function scanList(list, q, qBounds = new Set()) {
  const tiers = [[], [], [], []];
  const { compact, boundary, lineStart } = list;
  if (q.length === 1) {
    // Single letter: prefix matches only (substring hits would be most of the dictionary).
    let pos = compact.indexOf('\n' + q);
    while (pos !== -1 && tiers[0].length + tiers[1].length < HEAD_LIMIT) {
      const line = lineOf(list, pos + 1);
      const len = lineStart[line + 1] - lineStart[line] - 1;
      tiers[len === 1 ? 0 : 1].push(line);
      pos = compact.indexOf('\n' + q, pos + 1);
    }
    return tiers;
  }
  let pos = compact.indexOf(q);
  while (pos !== -1) {
    const line = lineOf(list, pos);
    const start = lineStart[line];
    const end = lineStart[line + 1] - 1; // position of the trailing "\n"
    let best = 4;
    for (let p = pos; p !== -1 && p < end; p = compact.indexOf(q, p + 1)) {
      if (!validMatch(list, p, q.length, qBounds, start)) continue;
      const t = p === start ? (end - start === q.length ? 0 : 1) : boundary[p] ? 2 : 3;
      if (t < best) best = t;
      if (best <= 2) break;
    }
    if (best < 4 && tiers[best].length < HEAD_LIMIT) tiers[best].push(line);
    pos = compact.indexOf(q, end);
  }
  return tiers;
}

function searchHeadwords(query) {
  const spaced = normalizeSpaced(query);
  const q = spaced.replace(/ /g, '');
  if (!q) return [];
  // Offsets (in the compact query) where the user typed a word break.
  const qBounds = new Set();
  for (let i = 0, k = 0; i < spaced.length; i++) {
    if (spaced[i] === ' ') qBounds.add(k);
    else k++;
  }
  const wt = scanList(words, q, qBounds);
  const pt = scanList(phrases, q, qBounds);
  const out = [];
  for (let t = 0; t < 4 && out.length < HEAD_LIMIT; t++) {
    for (const line of wt[t]) out.push({ id: line, w: words.display[line], tier: t });
    for (const line of pt[t]) {
      const parent = phraseParents[line];
      out.push({ id: parent, w: phrases.display[line], parent: words.display[parent], tier: t, phrase: true });
    }
  }
  return out.slice(0, HEAD_LIMIT);
}

// ---------------------------------------------------------------------------
// Meaning (full-text) search
//
// Index shards are grouped by token prefix (see tools/build-data.mjs). For a query token
// we load the shard covering it plus, for prefix expansion, every shard whose key starts
// with it.

let shardKeyMap;
let shardKeyList;
const PREFIX_MIN = 3; // shorter tokens are matched exactly only
const PREFIX_WEIGHT = 0.55;
const MAX_EXPANSIONS = 300;

function readVarint(buf, st) {
  let x = 0;
  let shift = 0;
  let b;
  do {
    b = buf[st.p++];
    x += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80);
  return x;
}

async function loadShard(s) {
  let entry = shardCache.get(s);
  if (entry) {
    shardCache.delete(s);
    shardCache.set(s, entry);
    return entry;
  }
  entry = fetchBin(`t/${s}.bin`).then((buf) => {
    const st = { p: 0 };
    const n = readVarint(buf, st);
    const heads = [];
    for (let i = 0; i < n; i++) {
      const len = readVarint(buf, st);
      const token = utf8.decode(buf.subarray(st.p, st.p + len));
      st.p += len;
      const count = readVarint(buf, st);
      const bytes = readVarint(buf, st);
      heads.push({ token, count, bytes, off: 0 });
    }
    const dict = new Map();
    let off = st.p;
    for (const h of heads) {
      h.off = off;
      off += h.bytes;
      dict.set(h.token, h);
    }
    return { buf, dict, heads };
  });
  shardCache.set(s, entry);
  if (shardCache.size > SHARD_CACHE) shardCache.delete(shardCache.keys().next().value);
  return entry;
}

function shardsFor(token) {
  if (!shardKeyMap) {
    shardKeyMap = new Map(meta.shardKeys);
    shardKeyList = meta.shardKeys.map((k) => k[0]).sort();
  }
  const out = new Set();
  for (let l = token.length; l >= 0; l--) {
    const s = shardKeyMap.get(token.slice(0, l));
    if (s !== undefined) {
      out.add(s);
      break;
    }
  }
  if (token.length >= PREFIX_MIN) {
    let lo = 0;
    let hi = shardKeyList.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (shardKeyList[mid] < token) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < shardKeyList.length && shardKeyList[i].startsWith(token) && out.size < 8; i++) {
      out.add(shardKeyMap.get(shardKeyList[i]));
    }
  }
  return [...out];
}

const SCORE = Array.from({ length: 16 }, (_, s) => 0.1 * 2 ** ((s + 0.5) / 1.95));

function decodePostings(shard, h, weight, best) {
  const st = { p: h.off };
  let prev = 0;
  for (let i = 0; i < h.count; i++) {
    const v = readVarint(shard.buf, st);
    prev += Math.floor(v / 16);
    const s = weight * SCORE[v & 15];
    if (!(best.get(prev) >= s)) best.set(prev, s);
  }
}

// Per query token: Map entry id -> best weighted score, plus the token's idf.
async function matchToken(token) {
  const shards = await Promise.all(shardsFor(token).map(loadShard));
  let exact = null;
  const expansions = [];
  for (const sh of shards) {
    const e = sh.dict.get(token);
    if (e) exact = { sh, h: e };
    if (token.length >= PREFIX_MIN) {
      for (const h of sh.heads) if (h.token !== token && h.token.startsWith(token)) expansions.push({ sh, h });
    }
  }
  if (!exact && !expansions.length) return null;
  expansions.sort((a, b) => b.h.count - a.h.count);
  expansions.length = Math.min(expansions.length, MAX_EXPANSIONS);
  const N = meta.entries;
  const df = exact ? exact.h.count : Math.min(N, expansions.reduce((a, x) => a + x.h.count, 0));
  const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
  const best = new Map();
  if (exact) decodePostings(exact.sh, exact.h, 1, best);
  for (const x of expansions) decodePostings(x.sh, x.h, PREFIX_WEIGHT, best);
  return { best, idf };
}

async function searchMeanings(query, exclude) {
  let toks = [...new Set(tokenize(query))];
  const content = toks.filter((t) => !stop.has(t));
  if (!content.length) return { results: [], terms: [] };
  toks = content.slice(0, 6);
  const lists = (await Promise.all(toks.map(matchToken))).filter(Boolean);
  if (!lists.length) return { results: [], terms: toks };
  const acc = new Map();
  const hits = new Map();
  for (const { best, idf } of lists) {
    for (const [id, s] of best) {
      acc.set(id, (acc.get(id) || 0) + idf * s);
      hits.set(id, (hits.get(id) || 0) + 1);
    }
  }
  // Prefer entries containing every term; fall back to partial matches.
  const need = lists.length;
  let ids = [...acc.keys()].filter((id) => hits.get(id) === need && !exclude.has(id));
  if (!ids.length) ids = [...acc.keys()].filter((id) => !exclude.has(id));
  // Ties (scores are quantized) go to simpler headwords first.
  ids.sort((a, b) => acc.get(b) - acc.get(a) || words.display[a].length - words.display[b].length || a - b);
  return {
    results: ids.slice(0, MEANING_LIMIT).map((id) => ({ id, w: words.display[id] })),
    terms: toks,
    total: ids.length,
  };
}

// ---------------------------------------------------------------------------

const ready = init();

const handlers = {
  async init() {
    return ready;
  },
  async search({ q }) {
    await ready;
    const t0 = performance.now();
    const head = searchHeadwords(q);
    return { head, ms: performance.now() - t0 };
  },
  async meanings({ q, exclude }) {
    await ready;
    const t0 = performance.now();
    const r = await searchMeanings(q, new Set(exclude || []));
    r.ms = performance.now() - t0;
    return r;
  },
  async entry({ id }) {
    await ready;
    return getEntry(id);
  },
  async snippets({ ids, terms }) {
    await ready;
    return Promise.all(ids.map((id) => snippet(id, terms)));
  },
  async lookup({ word }) {
    // Resolve a headword to entry ids (exact matches), used for stored list items.
    await ready;
    const q = normalizeCompact(word);
    return scanList(words, q)[0];
  },
  async random() {
    await ready;
    return Math.floor(Math.random() * meta.entries);
  },
};

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    const result = await handlers[type](payload || {});
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
