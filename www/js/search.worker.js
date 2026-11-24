// Search worker: owns all dictionary data so the UI thread never blocks.
//
// Headword search runs over two in-memory lists (entries and sub-entry phrases), each kept
// as one "compact" normalized string so a query is a handful of native indexOf scans.
// Simple meaning words use the sharded token index. Phrases, exclusions and
// patterns the index cannot represent are checked against definition text.
// Meaning blocks are fetched on demand and kept in a small LRU cache.
import { normalizeCompact, normalizeSpaced, normalizeQuoted, quotedMatch, tokenize, termTester } from './normalize.js';
import { parseSearchQuery, isTaggedPattern, quotedIndexTerms, readHeadwordRegex, readMeaningRegex, hasTagFilters, readSearchBuilder, buildSearchQuery } from './search-syntax.js';
import { compatibleTagIndex, tagFilterMasks, matchesEntryTags } from './search-origin-grammar.js';
import { plainMeaning, regexSnippet, compactMatches } from './search-match-text.js';
import { compatibleSenseIndex, SENSE_TAGS, normalizeSenseFilters, hasSenseFilters, planSenseFilters } from './search-subject-usage.js';
import { SOURCE_VERSION, SOURCE_TAGS, hasSourceFilters, decodeSourceOwners, planSourceFilters } from './search-citations.js';

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
let tagData;
let senseData;
let compoundData;
let compoundScopeRows;
let compoundFacetPlan;
const sourceData = new Map();
let sourcePlan;
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
  const literal = '\n' + normalizeQuoted(text, true) + '\n';
  const literalStart = new Uint32Array(display.length + 1);
  for (let i = 0, line = 0; i < literal.length; i++) {
    if (literal.charCodeAt(i) === 10) literalStart[line++] = i + 1;
  }
  return { display, compact, boundary, lineStart, literal, literalStart, count: display.length };
}

async function init() {
  meta = await fetch(new URL('meta.json', DATA), { cache: 'no-cache' }).then((r) => r.json());
  const [w, p, pp] = await Promise.all([
    fetchBin('words.txt'),
    fetchBin('phrases.txt'),
    fetchBin('phrase-parents.txt'),
  ]);
  charTable = new Uint16Array(256);
  for (let i = 0; i < meta.charset.length; i++) charTable[i] = meta.charset.charCodeAt(i);
  stop = new Set(meta.stopwords);
  words = buildList(utf8.decode(w));
  phrases = buildList(utf8.decode(p));
  phraseParents = new Uint32Array(pp.buffer, pp.byteOffset, pp.byteLength >> 2);
  return { entries: meta.entries, phrases: meta.phrases, build: meta.build };
}

async function loadTags(masks) {
  if (!compatibleTagIndex(meta.tagVersion, masks)) {
    throw new Error('برای این برچسب‌ها، واژه‌نامه را به‌روز کنید.');
  }
  if (!tagData) {
    tagData = Promise.all([fetchBin('entry-tags.txt'), fetchBin('phrase-tags.txt')]).then(([entries, compounds]) => {
      if (entries.byteLength !== words.count * 8 || compounds.byteLength !== meta.phrases * 8) {
        throw new Error('داده‌های برچسب واژه‌ها ناقص است؛ دوباره تلاش کنید.');
      }
      return {
        entries: new BigUint64Array(entries.buffer, entries.byteOffset, entries.byteLength / 8),
        phrases: new BigUint64Array(compounds.buffer, compounds.byteOffset, compounds.byteLength / 8),
      };
    });
  }
  try {
    return await tagData;
  } catch (error) {
    tagData = null;
    throw error;
  }
}

async function loadSenses() {
  if (!compatibleSenseIndex(meta.senseVersion)) {
    throw new Error('برای موضوع و کاربرد، واژه‌نامه را به‌روز کنید.');
  }
  if (!senseData) senseData = fetchBin('sense-meta.txt').then((bytes) => {
    const rows = JSON.parse(utf8.decode(bytes));
    if (!Array.isArray(rows) || rows.length !== meta.senseRows || rows.some((row) => !Array.isArray(row) || row.length !== 5
      || !row.slice(0, 4).every(Number.isInteger) || row[0] < 0 || row[0] >= meta.entries || row[1] < -1 || row[1] > meta.phrases
      || row[2] < 0 || row[3] < row[2] || !Array.isArray(row[4]) || row[4].some((id) => !Number.isInteger(id) || !SENSE_TAGS[id]))) {
      throw new Error('داده‌های برچسب معنی‌ها ناقص است؛ دوباره تلاش کنید.');
    }
    return rows;
  });
  try { return await senseData; }
  catch (error) { senseData = null; throw error; }
}

async function loadSourcePlan(filters, mode) {
  const selected = SOURCE_TAGS.filter((tag) => filters[tag.key] === 1 || filters[tag.key] === -1);
  if (meta.sourceVersion !== SOURCE_VERSION || !Array.isArray(meta.sourceCounts)
    || selected.some((tag) => !Number.isInteger(meta.sourceCounts[tag.id]) || meta.sourceCounts[tag.id] < 0)) {
    throw new Error('برای جستجوی یادکردها، واژه‌نامه را به‌روز کنید.');
  }
  const key = JSON.stringify([mode || 'any', selected.map((tag) => [tag.id, filters[tag.key]])]);
  if (sourcePlan?.key === key) return sourcePlan.promise;
  const promise = Promise.all(selected.map(async (source) => {
    if (!sourceData.has(source.id)) sourceData.set(source.id, fetchBin(`r/${source.id}.txt`).then((bytes) => {
      const owners = decodeSourceOwners(bytes, meta.entries + meta.phrases, meta.sourceCounts[source.id]);
      if (!owners) throw new Error('داده‌های یادکردها بددیسیده است؛ دوباره تلاش کنید.');
      return owners;
    }));
    try { return [source.id, await sourceData.get(source.id)]; }
    catch (error) { sourceData.delete(source.id); throw error; }
  })).then((entries) => planSourceFilters(new Map(entries), filters, meta.entries + meta.phrases, mode));
  sourcePlan = { key, promise };
  try { return await promise; }
  catch (error) { if (sourcePlan?.promise === promise) sourcePlan = null; throw error; }
}

async function loadCompoundSenses() {
  if (!meta.sourceSenseRows) return [];
  if (!compoundData) compoundData = fetchBin('source-senses.txt').then((bytes) => {
    const rows = JSON.parse(utf8.decode(bytes));
    if (!Array.isArray(rows) || rows.length !== meta.sourceSenseRows || rows.some((row) => !Array.isArray(row) || row.length !== 5
      || !row.slice(0, 4).every(Number.isInteger) || row[0] < 0 || row[0] >= meta.entries || row[1] < -1 || row[1] > meta.phrases
      || row[2] < 0 || row[3] < row[2] || !Array.isArray(row[4]) || row[4].some((id) => !Number.isInteger(id) || !SENSE_TAGS[id]))) {
      throw new Error('داده‌های ترکیب‌ها بددیسیده است؛ دوباره تلاش کنید.');
    }
    return rows;
  });
  try { return await compoundData; }
  catch (error) { compoundData = null; throw error; }
}

async function filterContext(filters, modes = {}, metadata = false, meanings = false, scoped = false) {
  modes = modes || {};
  const masks = tagFilterMasks(filters, modes);
  const tags = masks.include || masks.exclude ? await loadTags(masks) : null;
  const sources = hasSourceFilters(filters) ? await loadSourcePlan(filters, modes.source) : null;
  const baseRows = hasSenseFilters(filters) || metadata || scoped || meanings && sources && (meta.compoundScopeVersion === 1 || meta.sourceCompoundEntries) ? await loadSenses() : null;
  const extraRows = meanings && (sources || scoped) && baseRows ? await loadCompoundSenses() : [];
  if (extraRows.length && !compoundScopeRows) compoundScopeRows = [...baseRows, ...extraRows];
  const rows = baseRows ? extraRows.length ? compoundScopeRows : baseRows : null;
  let facets = null;
  if (rows) {
    const key = JSON.stringify([metadata, modes.subject, modes.usage, SENSE_TAGS.map((tag) => filters[tag.key] || 0)]);
    if ((sources || scoped) && compoundFacetPlan?.rows === rows && compoundFacetPlan.key === key) facets = compoundFacetPlan.plan;
    else {
      facets = planSenseFilters(rows, filters, meta.entries, meta.phrases, metadata, modes);
      if ((sources || scoped) && meanings) compoundFacetPlan = { rows, key, plan: facets };
    }
  }
  const acceptSense = (row) => {
    const phrase = row[1] > 0 && (!!sources || scoped);
    return (!tags || matchesEntryTags(phrase ? tags.phrases[row[1] - 1] : tags.entries[row[0]], masks))
      && (!sources || row[1] >= 0 && !!sources[phrase ? meta.entries + row[1] - 1 : row[0]]);
  };
  return {
    filters, modes, masks, tags, rows, facets, sources, extraRows, baseCount: baseRows?.length || 0, acceptSense,
    acceptEntry: (id) => (!tags || matchesEntryTags(tags.entries[id], masks)) && (!sources || !!sources[id]),
    acceptHead: (line, phrase) => (!tags || matchesEntryTags((phrase ? tags.phrases : tags.entries)[line], masks))
      && (!facets || !!(phrase ? facets.phrases : facets.entries)[line]) && (!sources || !!sources[phrase ? meta.entries + line : line]),
  };
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
  entry = fetchBin(`m/${b}.txt`).then(decodeBlock);
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
const plainText = plainMeaning;

function findTerm(text, terms, exact = false) {
  // Locate a term in the original text by scanning normalized words; exact beats prefix.
  if (!terms || !terms.length) return -1;
  const test = termTester(terms, exact);
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

async function snippet(id, terms, exact, literal, range, record) {
  const { pron, body } = record || await getRecord(id);
  const text = plainText(range ? body.slice(range[0], range[1]) : body);
  if (literal) {
    const match = quotedMatch(text, normalizeQuoted(literal));
    if (match) return { id, ...regexSnippet(text, pron, match) };
  }
  const at = findTerm(text, terms, exact);
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

function lineOf(list, pos, ls = list.lineStart) {
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
function scanList(list, q, qBounds = new Set(), accept) {
  const tiers = [[], [], [], []];
  const { compact, boundary, lineStart } = list;
  if (q.length === 1) {
    // Single letter: prefix matches only (substring hits would be most of the dictionary).
    let pos = compact.indexOf('\n' + q);
    while (pos !== -1 && tiers[0].length + tiers[1].length < HEAD_LIMIT) {
      const line = lineOf(list, pos + 1);
      const len = lineStart[line + 1] - lineStart[line] - 1;
      if (!accept || accept(line)) tiers[len === 1 ? 0 : 1].push(line);
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
    if (best < 4 && tiers[best].length < HEAD_LIMIT && (!accept || accept(line))) tiers[best].push(line);
    pos = compact.indexOf(q, end);
  }
  return tiers;
}

function scanQuotedList(list, q, accept) {
  const tiers = [[], [], [], []];
  const { literal, literalStart } = list;
  let pos = literal.indexOf(q);
  while (pos !== -1) {
    const line = lineOf(list, pos, literalStart);
    const start = literalStart[line];
    const end = literalStart[line + 1] - 1;
    let best = 4;
    for (let p = pos; p !== -1 && p < end; p = literal.indexOf(q, p + 1)) {
      const tier = p === start ? (p + q.length === end ? 0 : 1) : literal[p - 1] === ' ' ? 2 : 3;
      best = Math.min(best, tier);
      if (best <= 2) break;
    }
    if (best < 4 && tiers[best].length < HEAD_LIMIT && (!accept || accept(line))) tiers[best].push(line);
    pos = literal.indexOf(q, end);
  }
  return tiers;
}

function searchHeadwords(query, quoted = false, context) {
  const spaced = normalizeSpaced(query);
  const q = quoted ? normalizeQuoted(query) : spaced.replace(/ /g, '');
  if (!q) return [];
  // Offsets (in the compact query) where the user typed a word break.
  const qBounds = new Set();
  for (let i = 0, k = 0; i < spaced.length; i++) {
    if (spaced[i] === ' ') qBounds.add(k);
    else k++;
  }
  const acceptWord = context ? (line) => context.acceptHead(line, false) : undefined;
  const acceptPhrase = context ? (line) => context.acceptHead(line, true) : undefined;
  const wt = quoted ? scanQuotedList(words, q, acceptWord) : scanList(words, q, qBounds, acceptWord);
  const pt = quoted ? scanQuotedList(phrases, q, acceptPhrase) : scanList(phrases, q, qBounds, acceptPhrase);
  const out = [];
  for (let t = 0; t < 4 && out.length < HEAD_LIMIT; t++) {
    for (const line of wt[t]) out.push({ id: line, w: words.display[line], tier: t, ...(quoted ? { match: quotedMatch(words.display[line], q) } : {}), ...(context?.facets?.entryRanges.has(line) ? { range: context.facets.entryRanges.get(line) } : {}) });
    for (const line of pt[t]) {
      const parent = phraseParents[line];
      out.push({ id: parent, w: phrases.display[line], parent: words.display[parent], tier: t, phrase: true, ...(quoted ? { match: quotedMatch(phrases.display[line], q) } : {}), ...(context?.facets?.phraseRanges.has(line) ? { range: context.facets.phraseRanges.get(line) } : {}) });
    }
  }
  return out.slice(0, HEAD_LIMIT);
}

let patternJob;
let headSearchSeq = 0;

function cancelPatternSearch() {
  patternJob?.cancel();
}

function patternHeadword({ line, phrase, tier, match, range }) {
  if (!phrase) return { id: line, w: words.display[line], tier, match, ...(range ? { range } : {}) };
  const id = phraseParents[line];
  return { id, w: phrases.display[line], parent: words.display[id], phrase: true, tier, match, ...(range ? { range } : {}) };
}

function filteredHeadwords(context) {
  const results = [];
  for (const [phrase, list] of [[false, words.display], [true, phrases.display]]) {
    for (let line = 0; line < list.length && results.length < HEAD_LIMIT; line++) {
      if (!context.acceptHead(line, phrase)) continue;
      const range = context.facets && (phrase ? context.facets.phraseRanges : context.facets.entryRanges).get(line);
      results.push(patternHeadword({ line, phrase, tier: 0, range }));
    }
  }
  return results;
}

function filteredMeaningEntries(context, exclude) {
  const results = [];
  const seen = new Set();
  const add = (id, range, row) => {
    if (seen.has(id) || exclude.has(id) || !(row ? context.acceptSense(row) : context.acceptEntry(id))) return;
    seen.add(id);
    results.push({ id, w: words.display[id], ...(range ? { range } : {}) });
  };
  if (context.facets) {
    for (let sense = 0; sense < context.rows.length && results.length < MEANING_LIMIT; sense++) {
      if (context.facets.allowed[sense]) add(context.rows[sense][0], context.rows[sense].slice(2, 4), context.rows[sense]);
    }
  }
  if (!context.facets?.positive) {
    for (let id = 0; id < meta.entries && results.length < MEANING_LIMIT; id++) {
      if (!context.facets?.affectedEntries.has(id)) add(id);
    }
  }
  return { results, terms: [], total: results.length, limited: results.length >= MEANING_LIMIT };
}

// A tag-only search needs neither regex execution nor a copy of all headwords in
// a disposable worker. Full-word matches keep the same priority as other regexes.
function searchTagHeadwords(tags, masks, flags, facets) {
  const tiers = [[], []];
  for (const [phrase, list, tagList] of [[false, words.display, tags.entries], [true, phrases.display, tags.phrases]]) {
    for (let line = 0; line < list.length; line++) {
      if (!matchesEntryTags(tagList[line], masks) || facets && !(phrase ? facets.phrases : facets.entries)[line]) continue;
      const word = list[line];
      let end = word.length;
      if (!flags.includes('s')) {
        for (const separator of ['\r', '\u2028', '\u2029']) {
          const at = word.indexOf(separator);
          if (at !== -1 && at < end) end = at;
        }
      }
      const tier = end === word.length ? 0 : 1;
      const range = facets && (phrase ? facets.phraseRanges : facets.entryRanges).get(line);
      if (tiers[tier].length < HEAD_LIMIT) tiers[tier].push(patternHeadword({ line, phrase, tier, match: { start: 0, end }, range }));
      if (tiers[0].length === HEAD_LIMIT) return tiers[0];
    }
  }
  return tiers.flat().slice(0, HEAD_LIMIT);
}

function searchPattern(query, tags, facets, independentMasks, sources) {
  const parsed = tags && !independentMasks ? readHeadwordRegex(query) : null;
  const masks = independentMasks || (parsed ? tagFilterMasks(parsed.filters) : null);
  const { source, flags } = parsed?.query || query;
  if (parsed?.tagOnly) return Promise.resolve(searchTagHeadwords(tags, masks, flags, facets));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./regex.worker.js', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (error, results) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      patternJob = null;
      if (error) reject(new Error(error));
      else resolve(results.map(patternHeadword));
    };
    const timer = setTimeout(() => finish('جستجو بیش از اندازه طول کشید؛ الگوی ساده‌تری بنویسید.'), 2000);
    patternJob = { cancel: () => finish('جستجوی الگو لغو شد.') };
    worker.onmessage = ({ data }) => finish(data.error, data.results);
    worker.onerror = () => finish('اجرای الگو شکست خورد؛ دوباره تلاش کنید.');
    try {
      worker.postMessage({ words: words.display, phrases: phrases.display, source, flags, limit: HEAD_LIMIT, tags, masks, facets, sources, metadata: isTaggedPattern(query.source) && (parsed?.metadata ?? !!tags) });
    } catch {
      finish('اجرای الگو شکست خورد؛ دوباره تلاش کنید.');
    }
  });
}

// ---------------------------------------------------------------------------
// Meaning (full-text) search
//
// Index shards are grouped by token prefix (see tools/build-data.mjs). For a query token
// we load the shard covering it plus, for prefix expansion, every shard whose key starts
// with it.

const shardTables = new Map();
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

async function loadShard(s, directory = 't') {
  const key = directory + '/' + s;
  let entry = shardCache.get(key);
  if (entry) {
    shardCache.delete(key);
    shardCache.set(key, entry);
    return entry;
  }
  entry = fetchBin(`${directory}/${s}.txt`).then((buf) => {
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
  shardCache.set(key, entry);
  if (shardCache.size > SHARD_CACHE) shardCache.delete(shardCache.keys().next().value);
  return entry;
}

function shardsFor(token, expand = token.length >= PREFIX_MIN, directory = 't') {
  if (!shardTables.has(directory)) {
    const keys = directory === 's' ? meta.senseShardKeys : directory === 'u' ? meta.sourceSenseShardKeys : meta.shardKeys;
    shardTables.set(directory, { map: new Map(keys), list: keys.map((k) => k[0]).sort() });
  }
  const { map: shardKeyMap, list: shardKeyList } = shardTables.get(directory);
  const out = new Set();
  for (let l = token.length; l >= 0; l--) {
    const s = shardKeyMap.get(token.slice(0, l));
    if (s !== undefined) {
      out.add(s);
      break;
    }
  }
  if (expand) {
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
async function matchToken(token, expand = token.length >= PREFIX_MIN, directory = 't') {
  const shards = await Promise.all(shardsFor(token, expand, directory).map((id) => loadShard(id, directory)));
  let exact = null;
  const expansions = [];
  for (const sh of shards) {
    const e = sh.dict.get(token);
    if (e) exact = { sh, h: e };
    if (expand) {
      for (const h of sh.heads) if (h.token !== token && h.token.startsWith(token)) expansions.push({ sh, h });
    }
  }
  if (!exact && !expansions.length) return null;
  expansions.sort((a, b) => b.h.count - a.h.count);
  expansions.length = Math.min(expansions.length, MAX_EXPANSIONS);
  const N = directory === 's' ? meta.senseRows : directory === 'u' ? meta.sourceSenseRows : meta.entries;
  const df = exact ? exact.h.count : Math.min(N, expansions.reduce((a, x) => a + x.h.count, 0));
  const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
  const best = new Map();
  if (exact) decodePostings(exact.sh, exact.h, 1, best);
  for (const x of expansions) decodePostings(x.sh, x.h, PREFIX_WEIGHT, best);
  return { best, idf };
}

let meaningPatternJob;
let meaningSearchSeq = 0;

function cancelMeaningPatternSearch() {
  meaningPatternJob?.cancel();
}

function meaningTask(run) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      task.cancelled = true;
      task.cleanup?.();
      if (meaningPatternJob === task) meaningPatternJob = null;
      error ? reject(error) : resolve(result);
    };
    const task = { cancelled: false, cleanup: null, cancel: () => finish(new Error('جستجوی الگو لغو شد.')) };
    meaningPatternJob = task;
    Promise.resolve().then(() => run(task)).then((result) => finish(null, result), (error) => finish(error));
  });
}

function rankMeanings(lists, exclude, strict = false, { accept, rows, dedupe = true, required = lists.length } = {}) {
  const acc = new Map();
  const hits = new Map();
  for (const { best, idf } of lists) {
    for (const [id, s] of best) {
      acc.set(id, (acc.get(id) || 0) + idf * s);
      hits.set(id, (hits.get(id) || 0) + 1);
    }
  }
  const entry = (id) => rows ? rows[id][0] : id;
  const eligible = (id) => !exclude.has(entry(id)) && (!accept || accept(id));
  let ids = [...acc.keys()].filter((id) => hits.get(id) === required && eligible(id));
  if (!strict && !ids.length) ids = [...acc.keys()].filter(eligible);
  ids.sort((a, b) => acc.get(b) - acc.get(a) || words.display[entry(a)].length - words.display[entry(b)].length || a - b);
  if (rows && dedupe) {
    const seen = new Set();
    ids = ids.filter((id) => { const parent = entry(id); if (seen.has(parent)) return false; seen.add(parent); return true; });
  }
  return { results: ids.slice(0, MEANING_LIMIT).map((id) => ({ id: entry(id), w: words.display[entry(id)], ...(rows ? { range: rows[id].slice(2, 4) } : {}) })), total: ids.length };
}

function meaningDirectories(context) {
  return context?.facets ? ['s', ...(context.extraRows.length ? ['u'] : []), ...(!context.facets.positive ? ['t'] : [])] : ['t'];
}

function meaningScope(context, directory) {
  if (directory === 't') return { accept: context ? (id) => context.acceptEntry(id)
    && (!context.facets || !context.facets.affectedEntries.has(id)) : undefined };
  const rows = directory === 'u' ? context.extraRows : context.rows;
  const offset = directory === 'u' ? context.baseCount : 0;
  return { rows, accept: (id) => context.facets.allowed[id + offset] && context.acceptSense(rows[id]) };
}

async function searchMeanings(query, exclude, context) {
  const toks = [...new Set(tokenize(query))].filter((token) => !stop.has(token)).slice(0, 6);
  if (!toks.length) return { results: [], terms: [] };
  const groups = meaningDirectories(context);
  const sources = [];
  for (const directory of groups) {
    const lists = await Promise.all(toks.map((token) => matchToken(token, token.length >= PREFIX_MIN, directory)));
    if (!lists.some(Boolean)) continue;
    sources.push({ lists, options: meaningScope(context, directory) });
  }
  // Preserve the ordinary all-words-first ranking across both sparse sense and
  // unlabelled-entry indexes; partial matches are a fallback for the whole query.
  const required = toks.filter((_, i) => sources.some(({ lists }) => lists[i])).length;
  const rank = (strict) => sources.map(({ lists, options }) => rankMeanings(lists.filter(Boolean), exclude, strict, { ...options, required }));
  let ranked = rank(sources.length > 1);
  if (sources.length > 1 && !ranked.some((found) => found.total)) ranked = rank(false);
  return { results: ranked.flatMap((found) => found.results).slice(0, MEANING_LIMIT), total: ranked.reduce((sum, found) => sum + found.total, 0), terms: toks };
}

function searchQuotedMeanings(query, exclude, onProgress, context) {
  return meaningTask(async (task) => {
    const literal = normalizeQuoted(query.text);
    if (!literal) return { results: [], terms: [], total: 0 };
    const terms = quotedIndexTerms(query.text).filter(({ token, prefix }) => prefix || !stop.has(token));
    if (!terms.length) return { results: [], terms: [], total: 0, unindexed: true };
    const singleWord = terms.length === 1 && literal === terms[0].token;
    if (singleWord) {
      if (stop.has(terms[0].token)) return { results: [], terms: [], total: 0, unindexed: true };
      terms[0].prefix = terms[0].token.length >= PREFIX_MIN;
    }
    const candidates = { results: [], total: 0 };
    const groups = meaningDirectories(context);
    for (const directory of groups) {
      const lists = await Promise.all(terms.map(({ token, prefix }) => matchToken(token, prefix, directory)));
      if (task.cancelled) return;
      if (lists.some((list) => list === null)) continue;
      const found = rankMeanings(lists, exclude, true, {
        ...meaningScope(context, directory), dedupe: singleWord,
      });
      candidates.results.push(...found.results);
      candidates.total += found.total;
      if (candidates.results.length >= MEANING_LIMIT) break;
    }
    candidates.results.length = Math.min(candidates.results.length, MEANING_LIMIT);
    // An indexed token/prefix already proves a single unpunctuated word occurs.
    // Keep definition loading as lazy as ordinary search, including highlighting.
    if (singleWord) return { ...candidates, terms: [literal] };
    const results = [];
    const seen = new Set();
    let scanned = 0;
    onProgress?.({ results: [], scanned, total: candidates.results.length, matched: 0 });
    for (let offset = 0; offset < candidates.results.length; offset += 40) {
      if (task.cancelled) return;
      const batch = candidates.results.slice(offset, offset + 40);
      const blocks = [...new Set(batch.map((row) => blockOf(row.id)))];
      for (let i = 0; i < blocks.length; i += 4) {
        await Promise.all(blocks.slice(i, i + 4).map(loadBlock));
        if (task.cancelled) return;
      }
      const delta = [];
      for (const row of batch) {
        if (seen.has(row.id)) continue;
        const { pron, body } = await getRecord(row.id);
        if (task.cancelled) return;
        const text = plainMeaning(row.range ? body.slice(row.range[0], row.range[1]) : body);
        const match = quotedMatch(text, literal);
        if (match) { seen.add(row.id); delta.push({ ...row, match, snippet: regexSnippet(text, pron, match) }); }
      }
      scanned += batch.length;
      results.push(...delta);
      onProgress?.({ results: delta, scanned, total: candidates.results.length, matched: results.length });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { results, terms: [], total: results.length, scanned, candidateLimited: candidates.total > MEANING_LIMIT };
  });
}

function patternMatcher(task) {
  let worker;
  let reply;
  let timer;
  const finish = (error, matches) => {
    clearTimeout(timer);
    const pending = reply;
    reply = null;
    if (pending) error ? pending.reject(error) : pending.resolve(matches);
  };
  task.cleanup = () => {
    worker?.terminate();
    finish(new Error('جستجوی الگو لغو شد.'));
  };
  return (payload) => new Promise((resolve, reject) => {
    if (!worker) {
      worker = new Worker(new URL('./regex.worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data);
      worker.onerror = () => finish(new Error('اجرای الگو شکست خورد؛ دوباره تلاش کنید.'));
    }
    reply = { resolve, reject };
    timer = setTimeout(() => finish(new Error('جستجو بیش از اندازه طول کشید؛ الگوی ساده‌تری بنویسید.')), 2000);
    try {
      worker.postMessage(payload);
    } catch {
      finish(new Error('اجرای الگو شکست خورد؛ دوباره تلاش کنید.'));
    }
  });
}

const displayJobs = new Set();
const cancelDisplayJobs = () => { for (const task of displayJobs) task.cancel(); };

function displayTask(run) {
  let rejectCancelled;
  const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
  const task = { cancelled: false, cleanup: null, cancel() {
    task.cancelled = true;
    task.cleanup?.();
    rejectCancelled(new Error('نمایش نتیجه لغو شد.'));
  } };
  displayJobs.add(task);
  return Promise.race([run(task), cancelled]).finally(() => {
    task.cancelled = true;
    task.cleanup?.();
    displayJobs.delete(task);
  });
}

let displayPlanCache;
function displayPlan(q) {
  if (displayPlanCache?.q === q) return displayPlanCache;
  const query = parseSearchQuery(q), leaves = [];
  const add = (node) => {
    if (node.rules) return { match: node.match, rules: node.rules.map(add) };
    const read = readSearchBuilder(`/${node.query.source}/${node.query.flags}`);
    const negative = read.groups.every((group) => group.rules.every((rule) => ['excludes', 'not-starts', 'not-ends'].includes(rule.kind)))
      || node.query.source.startsWith('^(?!');
    const meaning = node.scope === 'headword' ? null : readMeaningRegex(node.query);
    const head = readHeadwordRegex(node.query)?.query || node.query;
    return { index: leaves.push({ scope: node.scope, head: { source: head.source, flags: head.flags }, negative,
      meaning: meaning ? { match: meaning.match, groups: meaning.groups } : null }) - 1 };
  };
  let expression;
  if (query.mode === 'scoped') expression = query.expression;
  else {
    const builder = readSearchBuilder(q);
    expression = { match: builder.match, rules: builder.groups.map((group) => ({ match: group.match, rules: group.rules.map((rule) => ({
      scope: 'both', query: parseSearchQuery(buildSearchQuery(rule.kind, rule.value, {}, query.flags)),
    })) })) };
  }
  const plan = { tree: add(expression), leaves };
  displayPlanCache = { q, query, plan };
  return displayPlanCache;
}

// Extra highlight work is restricted to requested rows; search result selection
// and index scans do not retain or enumerate additional occurrences.
function displayHighlights({ q, filters = {}, tagMatch = {}, requests, entry = false }) {
  return displayTask(async (task) => {
    const { query, plan } = displayPlan(q);
    const meanings = plan.leaves.some((leaf) => leaf.scope !== 'headword') && requests.some((row) => row.kind !== 'h');
    const scoped = query.mode === 'scoped';
    const context = meanings && (scoped || hasTagFilters(filters)) ? await filterContext(filters, tagMatch, false, true, scoped) : null;
    if (task.cancelled) throw new Error('نمایش نتیجه لغو شد.');
    const wanted = new Set(requests.map((row) => row.id));
    const rowsByEntry = new Map();
    for (let i = 0; i < (context?.rows?.length || 0); i++) {
      const row = context.rows[i];
      if (!wanted.has(row[0]) || !context.facets.allowed[i] || !context.acceptSense(row)) continue;
      if (!rowsByEntry.has(row[0])) rowsByEntry.set(row[0], []);
      rowsByEntry.get(row[0]).push(row);
    }
    const run = patternMatcher(task), result = [];
    for (let offset = 0; offset < requests.length; offset += 40) {
      const batch = requests.slice(offset, offset + 40);
      const records = new Map(await Promise.all([...new Set(batch.map((row) => row.id))].map(async (id) => [id, await getRecord(id)])));
      if (task.cancelled) throw new Error('نمایش نتیجه لغو شد.');
      const definitions = batch.map((request) => {
        const { body, pron } = records.get(request.id);
        const word = request.word || words.display[request.id];
        let rows = rowsByEntry.get(request.id) || [];
        if (scoped) rows = rows.filter((row) => request.word ? row[1] > 0 && phrases.display[row[1] - 1] === request.word : row[1] === 0);
        const parts = request.kind === 'h' ? [] : context?.facets.affectedEntries.has(request.id) ? rows.map((row) => {
          let start = row[2];
          if (scoped) start += body.slice(start, row[3]).match(/^(?:\x04\s*)?\x05[^\x06]+\x06\s*؛\s*/)?.[0].length || 0;
          return { text: plainMeaning(body.slice(start, row[3])), range: [start, row[3]] };
        }) : context?.facets.positive || context && !context.acceptEntry(request.id) ? [] : [{ text: plainMeaning(body) }];
        return { word, pron, parts, kind: request.kind, entry };
      });
      const { highlights } = await run({ highlight: plan, definitions });
      if (task.cancelled) throw new Error('نمایش نتیجه لغو شد.');
      for (let i = 0; i < batch.length; i++) {
        const request = batch[i], found = highlights[i];
        const { body } = records.get(request.id);
        if (entry) result.push({ headMatches: found.headMatches, matches: compactMatches(body, definitions[i].parts, found.matches), word: definitions[i].word });
        else if (request.kind === 'h') result.push({ key: request.key, ...await snippet(request.id, [], false, '', undefined, records.get(request.id)), headMatches: found.headMatches });
        else result.push({ key: request.key, id: request.id, ...found.snippet });
      }
    }
    return result;
  });
}

function tokenMatcher(query, task) {
  const run = patternMatcher(task);
  return async (tokens) => (await run({ tokens, source: query.source, flags: query.flags })).matches;
}

function patternShards(keys, prefixes) {
  return [...new Set(keys.filter(([key]) => !prefixes || prefixes.some((prefix) => key.startsWith(prefix) || prefix.startsWith(key))).map(([, id]) => id))];
}

function needsMeaningScan(parsed) {
  if (parsed.query.source === '.*') return false;
  const rules = parsed.groups.flatMap((group) => group.rules);
  if (rules.length !== 1) return true;
  const rule = rules[0];
  if (!['contains', 'starts', 'ends', 'whole'].includes(rule.kind) || rule.negative
    || /[\s\p{Script=Latin}]/u.test(rule.source) || tokenize(rule.value).length !== 1 || rule.value.length < 2) return true;
  return [...stop].some((word) => rule.kind === 'whole' ? word === rule.value
    : rule.kind === 'starts' ? word.startsWith(rule.value) : rule.kind === 'ends' ? word.endsWith(rule.value) : word.includes(rule.value));
}

function definitionEvidence(definition, hit) {
  const part = definition.parts[hit.part];
  return { ...(part.range ? { range: part.range } : {}), match: hit.match,
    snippet: regexSnippet(part.text, definition.pron, hit.match) };
}

async function scanMeaningDefinitions(plans, task, { context, possible, scoped = false, exclude = new Set(), run = patternMatcher(task), onProgress, onBatch, stopped = () => false }) {
  const rowsByEntry = new Map();
  for (let index = 0; index < (context?.rows?.length || 0); index++) {
    const row = context.rows[index];
    if (!context.facets.allowed[index] || !context.acceptSense(row) || scoped && row[1] < 0) continue;
    const owner = scoped && row[1] > 0 ? meta.entries + row[1] - 1 : row[0];
    if (possible && !hasOwner(possible, owner)) continue;
    if (!rowsByEntry.has(row[0])) rowsByEntry.set(row[0], []);
    rowsByEntry.get(row[0]).push({ owner, range: row.slice(2, 4) });
  }
  const candidates = [];
  for (let id = 0; id < meta.entries; id++) {
    if (exclude.has(id)) continue;
    if (context?.facets?.affectedEntries.has(id)) {
      if (rowsByEntry.has(id)) candidates.push(id);
    } else if (!context?.facets?.positive && (!context || context.acceptEntry(id)) && (!possible || hasOwner(possible, id))) candidates.push(id);
  }
  let scanned = 0, matched = 0;
  onProgress?.({ stage: 'definitions', results: [], scanned, total: candidates.length, matched });
  for (let offset = 0; offset < candidates.length && !stopped(); offset += 256) {
    if (task.cancelled) return;
    const ids = candidates.slice(offset, offset + 256);
    const blockIds = new Map();
    for (const id of ids) {
      const block = blockOf(id);
      if (!blockIds.has(block)) blockIds.set(block, []);
      blockIds.get(block).push(id);
    }
    const blocks = [...blockIds.keys()];
    const records = new Map();
    for (let i = 0; i < blocks.length; i += 4) {
      const batch = blocks.slice(i, i + 4);
      const loaded = await Promise.all(batch.map(loadBlock));
      if (task.cancelled) return;
      batch.forEach((block, index) => {
        for (const id of blockIds.get(block)) records.set(id, loaded[index][id - meta.blockStarts[block]]);
      });
    }
    const definitions = [];
    for (const id of ids) {
      const record = records.get(id), separator = record.indexOf('\x1f');
      const body = record.slice(separator + 1), pron = record.slice(0, separator);
      const owners = new Map();
      for (const row of rowsByEntry.get(id) || [{ owner: id }]) {
        let start = row.range?.[0] || 0;
        const end = row.range?.[1] ?? body.length;
        if (scoped) {
          const heading = body.slice(start, end).match(/^(?:\x04\s*)?\x05[^\x06]+\x06\s*؛\s*/);
          if (heading) start += heading[0].length;
        }
        if (!owners.has(row.owner)) owners.set(row.owner, { id, owner: row.owner, pron, parts: [] });
        owners.get(row.owner).parts.push({ text: plainMeaning(body.slice(start, end)), ...(row.range ? { range: [start, end] } : {}) });
      }
      definitions.push(...owners.values());
    }
    const { matches } = await run({ definitions, plans: plans.map(({ groups, match }) => ({ groups, match })) });
    if (task.cancelled) return;
    const update = onBatch(definitions, matches) || {};
    scanned += ids.length;
    matched = update.matched ?? matched;
    onProgress?.({ stage: 'definitions', results: update.results || [], scanned, total: candidates.length, matched });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { scanned };
}

async function searchDefinitionMeanings(parsed, exclude, onProgress, task, context) {
  const results = [];
  const seen = new Set();
  const scanned = await scanMeaningDefinitions([parsed], task, { context, exclude, onProgress,
    stopped: () => results.length >= MEANING_LIMIT,
    onBatch: (definitions, [matches]) => {
      const delta = [];
      for (const hit of matches) {
        const definition = definitions[hit.index];
        if (seen.has(definition.id) || results.length + delta.length >= MEANING_LIMIT) continue;
        seen.add(definition.id);
        delta.push({ id: definition.id, w: words.display[definition.id], ...definitionEvidence(definition, hit) });
      }
      results.push(...delta);
      return { results: delta, matched: results.length };
    },
  });
  return { results, terms: [], total: results.length, limited: results.length >= MEANING_LIMIT, scanned: scanned?.scanned || 0 };
}

async function searchSenseMeanings(parsed, tags, masks, exclude, onProgress, task) {
  const rows = parsed.context?.rows || await loadSenses();
  if (task.cancelled) return;
  const plan = parsed.context?.facets || planSenseFilters(rows, parsed.filters, meta.entries, meta.phrases, false, parsed.modes);
  const results = [];
  const seen = new Set();
  const add = (id, terms, range, row) => {
    if (seen.has(id) || exclude.has(id) || (parsed.context ? !(row ? parsed.context.acceptSense(row) : parsed.context.acceptEntry(id)) : tags && !matchesEntryTags(tags.entries[id], masks))) return;
    seen.add(id);
    results.push({ id, w: words.display[id], ...(terms ? { terms } : {}), ...(range ? { range } : {}) });
  };
  if (parsed.query.source === '.*') {
    for (let sense = 0; sense < rows.length && results.length < MEANING_LIMIT; sense++) {
      if (plan.allowed[sense]) add(rows[sense][0], null, rows[sense].slice(2, 4), rows[sense]);
    }
    if (!plan.positive) {
      for (let id = 0; id < meta.entries && results.length < MEANING_LIMIT; id++) {
        if (!plan.affectedEntries.has(id)) add(id);
      }
    }
    return { results, terms: [], total: results.length, limited: results.length >= MEANING_LIMIT };
  }
  const batches = [{ directory: 's', ids: patternShards(meta.senseShardKeys, parsed.prefixes) }];
  if (parsed.context?.extraRows.length) batches.push({ directory: 'u', ids: patternShards(meta.sourceSenseShardKeys, parsed.prefixes) });
  // Unlabelled entries always satisfy exclusions. Their original postings remain
  // sufficient; labelled entries are searched only through their own sense rows.
  if (!plan.positive) batches.push({ directory: 't', ids: patternShards(meta.shardKeys, parsed.prefixes) });
  const total = batches.reduce((n, batch) => n + batch.ids.length, 0);
  const matchTokens = tokenMatcher(parsed.query, task);
  let scanned = 0;
  onProgress?.({ stage: 'index', results: [], scanned, total, matched: 0 });
  for (const { directory, ids } of batches) {
    for (let offset = 0; offset < ids.length && results.length < MEANING_LIMIT; offset += 4) {
      const loaded = await Promise.all(ids.slice(offset, offset + 4).map((id) => loadShard(id, directory)));
      if (task.cancelled) return;
      const heads = loaded.flatMap((shard) => shard.heads.map((head) => ({ shard, head })));
      const matches = await matchTokens(heads.map(({ head }) => head.token));
      if (task.cancelled) return;
      const before = results.length;
      for (const index of matches) {
        const { shard, head } = heads[index];
        const state = { p: head.off };
        let id = 0;
        for (let i = 0; i < head.count && results.length < MEANING_LIMIT; i++) {
          id += Math.floor(readVarint(shard.buf, state) / 16);
          if (directory !== 't') {
            const sense = directory === 'u' ? id + parsed.context.baseCount : id;
            if (plan.allowed[sense]) add(rows[sense][0], [head.token], rows[sense].slice(2, 4), rows[sense]);
          } else if (!plan.affectedEntries.has(id)) add(id, [head.token]);
        }
      }
      scanned += loaded.length;
      onProgress?.({ stage: 'index', results: results.slice(before), scanned, total, matched: results.length });
    }
  }
  return { results, terms: [], total: results.length, limited: results.length >= MEANING_LIMIT, scanned };
}

function searchRegexMeanings(query, exclude, onProgress, context) {
  return meaningTask(async (task) => {
    const parsed = readMeaningRegex(query);
    if (!parsed) return { results: [], terms: [], total: 0, unsupported: true };
    if (context) { parsed.filters = context.filters; parsed.context = context; parsed.modes = context.modes; }
    const masks = context?.masks || tagFilterMasks(parsed.filters);
    const filtered = !!(masks.include || masks.exclude);
    const tags = context?.tags || (filtered ? await loadTags(masks) : null);
    if (task.cancelled) return;
    if (needsMeaningScan(parsed)) return searchDefinitionMeanings(parsed, exclude, onProgress, task,
      context || (hasTagFilters(parsed.filters) ? await filterContext(parsed.filters, parsed.modes, false, true) : undefined));
    if (hasSenseFilters(parsed.filters) || context?.facets) return searchSenseMeanings(parsed, tags, masks, exclude, onProgress, task);
    // Metadata-only queries need no token shards or definition bodies.
    if ((filtered || context?.sources) && parsed.query.source === '.*') {
      const results = [];
      for (let id = 0; id < meta.entries && results.length < MEANING_LIMIT; id++) {
        if (!exclude.has(id) && (context ? context.acceptEntry(id) : matchesEntryTags(tags.entries[id], masks))) results.push({ id, w: words.display[id] });
      }
      return { results, terms: [], total: results.length, limited: results.length >= MEANING_LIMIT };
    }
    const shardIds = patternShards(meta.shardKeys, parsed.prefixes);
    const matchTokens = tokenMatcher(parsed.query, task);
    const results = [];
    const seen = new Set();
    let scanned = 0;
    onProgress?.({ stage: 'index', results: [], scanned, total: shardIds.length, matched: 0 });
    for (let offset = 0; offset < shardIds.length && results.length < MEANING_LIMIT; offset += 4) {
      const loaded = await Promise.all(shardIds.slice(offset, offset + 4).map((id) => loadShard(id)));
      if (task.cancelled) return;
      const heads = loaded.flatMap((shard) => shard.heads.map((head) => ({ shard, head })));
      const matches = await matchTokens(heads.map(({ head }) => head.token));
      if (task.cancelled) return;
      const delta = [];
      for (const index of matches) {
        const { shard, head } = heads[index];
        const state = { p: head.off };
        let id = 0;
        for (let i = 0; i < head.count && results.length + delta.length < MEANING_LIMIT; i++) {
          id += Math.floor(readVarint(shard.buf, state) / 16);
          if (seen.has(id) || exclude.has(id) || (context ? !context.acceptEntry(id) : tags && !matchesEntryTags(tags.entries[id], masks))) continue;
          seen.add(id);
          delta.push({ id, w: words.display[id], terms: [head.token] });
        }
        if (results.length + delta.length >= MEANING_LIMIT) break;
      }
      scanned += loaded.length;
      results.push(...delta);
      onProgress?.({ stage: 'index', results: delta, scanned, total: shardIds.length, matched: results.length });
    }
    return { results, terms: [], total: results.length, limited: results.length >= MEANING_LIMIT, scanned };
  });
}

const hasOwner = (mask, owner) => !!(mask[owner >>> 5] & (1 << (owner & 31)));
const addOwner = (mask, owner) => { mask[owner >>> 5] |= 1 << (owner & 31); };

// Evaluate independent predicates before applying display limits. For AND, a
// meaning contributes evidence only when every other condition also succeeds.
function scopedMasks(node, heads, meanings) {
  if (!node.rules) {
    const head = heads[node.index];
    const meaning = meanings[node.index];
    return { head, meaning, matched: head.map((word, i) => word | meaning[i]) };
  }
  const children = node.rules.map((rule) => scopedMasks(rule, heads, meanings));
  const result = Object.fromEntries(['head', 'meaning', 'matched'].map((key) => [key, children[0][key].slice()]));
  for (const child of children.slice(1)) {
    for (let i = 0; i < result.head.length; i++) {
      result.head[i] = node.match === 'all' ? result.head[i] & child.head[i] : result.head[i] | child.head[i];
      result.matched[i] = node.match === 'all' ? result.matched[i] & child.matched[i] : result.matched[i] | child.matched[i];
      result.meaning[i] |= child.meaning[i];
    }
  }
  if (node.match === 'all') for (let i = 0; i < result.meaning.length; i++) result.meaning[i] &= result.matched[i];
  return result;
}

function searchScopedConditions(query, filters, modes, onProgress) {
  return meaningTask(async (task) => {
    const leaves = [];
    const index = (node) => node.rules ? { match: node.match, rules: node.rules.map(index) } : { index: leaves.push(node) - 1 };
    const tree = index(query.expression);
    const hasMeanings = leaves.some((node) => node.scope !== 'headword');
    if (hasMeanings && meta.compoundScopeVersion !== 1) throw new Error('برای شرط‌های جداگانهٔ واژه و معنی، واژه‌نامه را به‌روز کنید.');
    const ownerCount = meta.entries + meta.phrases;
    const size = Math.ceil(ownerCount / 32);
    const empty = () => new Uint32Array(size);
    const allowed = empty().fill(0xffffffff);
    const run = patternMatcher(task);
    const original = leaves.map((node) => ({ ...node.query, scope: node.scope }));
    const headMatches = leaves.some((node) => node.scope !== 'meaning')
      ? await run({ conditions: original, words: words.display, phrases: phrases.display })
      : { masks: leaves.map(empty), starts: new Int32Array(0), ends: new Uint32Array(0) };
    if (task.cancelled) return;
    const possible = scopedMasks(tree, headMatches.masks, leaves.map((node) => node.scope === 'headword' ? empty() : allowed)).matched;
    if (!possible.some(Boolean)) return { head: [], meaningOwners: new Uint32Array(0), terms: [], rangeStart: new Uint32Array(0), rangeEnd: new Uint32Array(0) };
    const context = await filterContext(filters, modes, false, hasMeanings, hasMeanings);
    if (task.cancelled) return;
    allowed.fill(0);
    for (let owner = 0; owner < ownerCount; owner++) {
      if (context.acceptHead(owner < meta.entries ? owner : owner - meta.entries, owner >= meta.entries)) addOwner(allowed, owner);
    }
    for (let i = 0; i < size; i++) possible[i] &= allowed[i];
    const meaningMasks = leaves.map(empty);
    const terms = hasMeanings ? new Array(ownerCount) : [];
    const evidence = hasMeanings ? new Array(ownerCount) : [];
    const rangeStart = new Uint32Array(hasMeanings ? ownerCount : 0);
    const rangeEnd = new Uint32Array(hasMeanings ? ownerCount : 0);
    if (hasMeanings && possible.some(Boolean)) {
      const parsed = leaves.map((node) => node.scope === 'headword' ? null : readMeaningRegex(node.query));
      if (parsed.some((part, i) => !part && leaves[i].scope !== 'headword')) throw new Error('این الگو در معنی‌ها اجرا نمی‌شود؛ آن را ساده‌تر کنید.');
      const scannedRules = parsed.flatMap((part, index) => part && needsMeaningScan(part) ? [index] : []);
      const conditions = parsed.map((part, i) => ({ ...(part?.query || leaves[i].query), scope: scannedRules.includes(i) ? 'headword' : leaves[i].scope }));
      const indexed = parsed.filter((part, i) => part && !scannedRules.includes(i));
      const prefixes = indexed.some((part) => !part.prefixes) ? null : indexed.flatMap((part) => part.prefixes);
      const batches = (indexed.length ? meaningDirectories(context) : []).map((directory) => ({ directory,
        ids: patternShards(directory === 's' ? meta.senseShardKeys : directory === 'u' ? meta.sourceSenseShardKeys : meta.shardKeys, prefixes) }));
      const total = batches.reduce((sum, batch) => sum + batch.ids.length, 0);
      let scanned = 0;
      for (const { directory, ids } of batches) {
        const scope = meaningScope(context, directory);
        for (let offset = 0; offset < ids.length; offset += 4) {
          const loaded = await Promise.all(ids.slice(offset, offset + 4).map((id) => loadShard(id, directory)));
          if (task.cancelled) return;
          const heads = loaded.flatMap((shard) => shard.heads.map((head) => ({ shard, head })));
          const { matches } = await run({ conditions, tokens: heads.map(({ head }) => head.token) });
          if (task.cancelled) return;
          for (let rule = 0; rule < matches.length; rule++) {
            for (const hit of matches[rule]) {
              const { shard, head } = heads[hit];
              const state = { p: head.off };
              let id = 0;
              for (let n = 0; n < head.count; n++) {
                id += Math.floor(readVarint(shard.buf, state) / 16);
                if (scope.accept && !scope.accept(id)) continue;
                const row = scope.rows?.[id];
                const owner = row ? row[1] < 0 ? -1 : row[1] ? meta.entries + row[1] - 1 : row[0] : id;
                if (owner < 0 || !hasOwner(possible, owner)) continue;
                addOwner(meaningMasks[rule], owner);
                if (!terms[owner]) {
                  terms[owner] = head.token;
                  if (row) { rangeStart[owner] = row[2]; rangeEnd[owner] = row[3]; }
                }
              }
            }
          }
          scanned += loaded.length;
          onProgress?.({ stage: 'index', results: [], scanned, total, matched: 0 });
        }
      }
      if (scannedRules.length) {
        const scanPossible = scopedMasks(tree, headMatches.masks, meaningMasks.map((mask, index) => scannedRules.includes(index) ? possible : mask)).matched;
        for (let i = 0; i < scanPossible.length; i++) scanPossible[i] &= possible[i];
        await scanMeaningDefinitions(scannedRules.map((index) => parsed[index]), task, { context, scoped: true, possible: scanPossible, run, onProgress,
          onBatch: (definitions, matches) => {
            for (let index = 0; index < matches.length; index++) {
              for (const hit of matches[index]) {
                const definition = definitions[hit.index];
                addOwner(meaningMasks[scannedRules[index]], definition.owner);
                const found = definitionEvidence(definition, hit);
                if (found.match.end > found.match.start || !evidence[definition.owner] && !terms[definition.owner]) evidence[definition.owner] = found;
              }
            }
          },
        });
        if (task.cancelled) return;
      }
    }
    const matches = scopedMasks(tree, headMatches.masks, meaningMasks);
    const tiers = [[], [], [], []];
    const meaningOwners = [];
    for (let owner = 0; owner < ownerCount; owner++) {
      if (!hasOwner(allowed, owner)) continue;
      if (hasOwner(matches.head, owner)) {
        const phrase = owner >= meta.entries;
        const line = phrase ? owner - meta.entries : owner;
        const word = (phrase ? phrases : words).display[line];
        const start = headMatches.starts[owner];
        const end = headMatches.ends[owner];
        const tier = start === 0 ? end === word.length ? 0 : 1 : 3;
        const range = context.facets && (phrase ? context.facets.phraseRanges : context.facets.entryRanges).get(line);
        if (tiers[tier].length < HEAD_LIMIT) tiers[tier].push(patternHeadword({ line, phrase, tier, match: { start, end }, range }));
      }
      if (hasOwner(matches.meaning, owner)) meaningOwners.push(owner);
    }
    return { head: tiers.flat().slice(0, HEAD_LIMIT), meaningOwners: Uint32Array.from(meaningOwners), terms, evidence, rangeStart, rangeEnd };
  });
}

function scopedMeaningResults(found, exclude) {
  const results = [];
  let total = 0;
  for (const owner of found.meaningOwners) {
    const phrase = owner >= meta.entries;
    const line = phrase ? owner - meta.entries : owner;
    const id = phrase ? phraseParents[line] : line;
    if (exclude.has(id)) continue;
    total++;
    if (results.length === MEANING_LIMIT) continue;
    results.push({ id, w: (phrase ? phrases : words).display[line],
      ...(phrase ? { phrase: true, parent: words.display[id] } : {}),
      ...(found.terms[owner] ? { terms: [found.terms[owner]] } : {}),
      ...(found.rangeEnd[owner] ? { range: [found.rangeStart[owner], found.rangeEnd[owner]] } : {}),
      ...(found.evidence?.[owner] || {}) });
  }
  return { results, terms: [], total: Math.min(total, MEANING_LIMIT), limited: total > MEANING_LIMIT };
}

let scopedResult;
const scopedKey = (q, filters, modes) => JSON.stringify([q, filters, modes]);

function cacheScopedQuery(q, query, filters, modes, onProgress) {
  const current = { key: scopedKey(q, filters, modes) };
  current.promise = searchScopedConditions(query, filters, modes, onProgress).catch((error) => {
    if (scopedResult === current) scopedResult = null;
    throw error;
  });
  scopedResult = current;
  return current.promise;
}

// ---------------------------------------------------------------------------

const ready = init();

const handlers = {
  async cancelSearch() {
    await ready;
    cancelDisplayJobs();
    cancelPatternSearch();
    cancelMeaningPatternSearch();
    headSearchSeq++;
    meaningSearchSeq++;
    scopedResult = null;
  },
  async init() {
    return ready;
  },
  async filterCounts() {
    await ready;
    const total = meta.entries + meta.phrases;
    const counts = {};
    const valid = (count) => Number.isInteger(count) && count >= 0 && count <= total;
    if (meta.tagCountsVersion === 1) {
      for (const [key, count] of Object.entries(meta.tagCounts || {})) if (valid(count)) counts[key] = count;
      // Old separate totals cannot give the union: an owner may have both labels.
      for (const tag of SENSE_TAGS) {
        if (!tag.aliasOf) continue;
        if (counts[tag.key]) delete counts[tag.aliasOf];
        delete counts[tag.key];
      }
    }
    if (meta.sourceVersion === SOURCE_VERSION) {
      for (const source of SOURCE_TAGS) {
        const count = meta.sourceCounts?.[source.id];
        if (valid(count)) counts[source.key] = count;
      }
    }
    return { counts, total };
  },
  async search({ q = '', filters = {}, tagMatch = {} }, onProgress) {
    await ready;
    cancelDisplayJobs();
    filters = normalizeSenseFilters(filters);
    cancelPatternSearch();
    cancelMeaningPatternSearch();
    meaningSearchSeq++;
    const seq = ++headSearchSeq;
    const t0 = performance.now();
    const query = parseSearchQuery(q);
    scopedResult = null;
    if (query.mode === 'scoped') {
      const found = await cacheScopedQuery(q, query, filters, tagMatch, onProgress);
      return { head: found.head, ms: performance.now() - t0 };
    }
    let head;
    if (hasTagFilters(filters)) {
      const metadata = query.mode === 'regex' && isTaggedPattern(query.source);
      const context = await filterContext(filters, tagMatch, metadata);
      if (seq !== headSearchSeq) throw new Error('جستجوی الگو لغو شد.');
      if (query.mode === 'text' && !normalizeCompact(query.text)) head = filteredHeadwords(context);
      else if (query.mode === 'regex') head = await searchPattern(query, context.tags || (metadata ? await loadTags() : null), context.facets, context.masks, context.sources);
      else head = searchHeadwords(query.text, query.mode === 'exact', context);
    } else if (query.mode === 'regex') {
      const tagged = isTaggedPattern(query.source);
      const parsed = tagged ? readHeadwordRegex(query) : null;
      const tags = tagged ? await loadTags(parsed ? tagFilterMasks(parsed.filters) : undefined) : null;
      const needsSenses = tags && (!parsed || hasSenseFilters(parsed.filters));
      const rows = needsSenses ? await loadSenses() : null;
      const facets = rows ? planSenseFilters(rows, parsed?.filters || {}, meta.entries, meta.phrases, !parsed || parsed.metadata) : null;
      if (seq !== headSearchSeq) throw new Error('جستجوی الگو لغو شد.');
      head = await searchPattern(query, tags, facets);
    } else head = searchHeadwords(query.text, query.mode === 'exact');
    return { head, ms: performance.now() - t0 };
  },
  async meanings({ q = '', exclude, progress, filters = {}, tagMatch = {} }, onProgress) {
    await ready;
    filters = normalizeSenseFilters(filters);
    const query = parseSearchQuery(q);
    if (query.mode === 'scoped') {
      const t0 = performance.now();
      const key = scopedKey(q, filters, tagMatch);
      if (scopedResult?.key !== key) {
        cancelMeaningPatternSearch();
        cacheScopedQuery(q, query, filters, tagMatch, progress ? onProgress : null);
      }
      const found = await scopedResult.promise;
      return { ...scopedMeaningResults(found, new Set(exclude || [])), ms: performance.now() - t0 };
    }
    cancelMeaningPatternSearch();
    const seq = ++meaningSearchSeq;
    const t0 = performance.now();
    const excluded = new Set(exclude || []);
    const context = hasTagFilters(filters) ? await filterContext(filters, tagMatch, false, true) : undefined;
    if (seq !== meaningSearchSeq) throw new Error('جستجوی الگو لغو شد.');
    const r = context && query.mode === 'text' && !normalizeCompact(query.text) ? filteredMeaningEntries(context, excluded)
      : query.mode === 'text' ? await searchMeanings(query.text, excluded, context)
        : query.mode === 'exact' ? await searchQuotedMeanings(query, excluded, progress ? onProgress : null, context)
          : await searchRegexMeanings(query, excluded, progress ? onProgress : null, context);
    r.ms = performance.now() - t0;
    return r;
  },
  async entry({ id }) {
    await ready;
    return getEntry(id);
  },
  async snippets({ ids, terms, exact, literal, requests, q, filters, tagMatch }) {
    await ready;
    if (q && requests) return displayHighlights({ q, filters, tagMatch, requests });
    if (requests) return Promise.all(requests.map(async ({ key, id, terms, range }) => ({ key, ...await snippet(id, terms, exact, literal, range) })));
    return Promise.all(ids.map((id) => snippet(id, terms, exact, literal)));
  },
  async highlights({ id, q, filters, tagMatch, word }) {
    await ready;
    return (await displayHighlights({ q, filters, tagMatch, requests: [{ id, word, kind: 'm' }], entry: true }))[0];
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
    const result = await handlers[type](payload || {}, (progress) => self.postMessage({ id, progress }));
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
