// Smoke test: runs the real search worker in Node against www/data.
//   node tools/test-search.mjs [query ...]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { BrowserWorker } from './worker-shim.mjs';
import { normalizeQuoted } from '../www/js/normalize.js';
import { highlightWord } from '../www/js/render.js';
import { plainMeaning, compactMeaning } from '../www/js/search-match-text.js';
import { readEntryTags, tagFilterMasks, matchesEntryTags } from '../www/js/search-origin-grammar.js';
import { buildWordQuery } from '../www/js/search-syntax.js';

globalThis.Worker = BrowserWorker;

let dataLoads = 0;
let dataBytes = 0;
globalThis.fetch = async (url) => {
  const buf = fs.readFileSync(fileURLToPath(String(url).split('?')[0]));
  dataLoads++;
  dataBytes += buf.length;
  return new Response(buf, { status: 200 });
};
const replies = new Map();
let seq = 0;
globalThis.self = globalThis;
globalThis.postMessage = (msg) => {
  if (msg.progress) return;
  const reply = replies.get(msg.id);
  replies.delete(msg.id);
  reply?.(msg);
};
await import('../www/js/search.worker.js');
const call = (type, payload) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    replies.set(id, (m) => (m.error ? reject(new Error(m.error)) : resolve(m.result)));
    self.onmessage({ data: { id, type, payload } });
  });

const t0 = performance.now();
const info = await call('init');
console.log(`loaded ${info.entries} entries, ${info.phrases} phrases in ${Math.round(performance.now() - t0)} ms`);

let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
};

const queries = process.argv.slice(2);
if (queries.length) {
  for (const q of queries) {
    const beforeLoads = dataLoads;
    const beforeBytes = dataBytes;
    const h = await call('search', { q });
    const m = await call('meanings', { q, exclude: [] });
    console.log(`\n«${q}» headwords ${h.head.length} (${h.ms.toFixed(1)} ms), meanings ${m.total} (${m.ms.toFixed(1)} ms)`);
    console.log('  head:', h.head.slice(0, 15).map((x) => x.w).join(' | '));
    console.log('  mean:', m.results.slice(0, 15).map((x) => x.w).join(' | '));
    // Dictionary payload loads, excluding HTTP overhead and browser cache effects.
    console.log(`  data: ${dataLoads - beforeLoads} files, ${((dataBytes - beforeBytes) / 1048576).toFixed(2)} MiB`);
  }
  process.exit(0);
}

// Headwords: compounds that start with other letters must be found (e.g. «به یاد آوردن»).
const yad = await call('search', { q: 'یاد' });
const yadWords = yad.head.map((x) => x.w);
check('«یاد» exact entry is first', yadWords[0] === 'یاد');
check('«یاد» finds compounds starting with other letters', yadWords.some((w) => /^(به|از) یاد/.test(w)));
check('«یاد» has no cross-word false hits', !yadWords.some((w) => /^از آب و گل/.test(w)));
const joined = await call('search', { q: 'یادآوردن' });
check('«یادآوردن» matches spaced forms', joined.head.some((x) => x.w.replace(/\s/g, '') === 'یادآوردن'));
const arabic = await call('search', { q: 'كتاب' });
check('Arabic kaf is normalized', arabic.head.some((x) => x.w === 'کتاب'));

const exact = await call('search', { q: '"یاد"' });
check('quoted headwords include longer words containing the literal phrase', exact.head.length > 0 && exact.head[0].w === 'یاد' && exact.head.some((x) => x.w === 'یادگار') && exact.head.every((x) => normalizeQuoted(x.w).includes('یاد')));
const pattern = await call('search', { q: '/^یاد/' });
check('regex searches headwords with match offsets', pattern.head.length > 0 && pattern.head.every((x) => x.w.startsWith('یاد') && x.match.start === 0));
const compoundPattern = await call('search', { q: '/^به یاد/' });
check('regex searches sub-entry compounds', compoundPattern.head.some((x) => x.phrase));

const filters = { arabic: 1, noun: 1, proper: -1 };
const filtered = await call('search', { q: '', filters });
check('origin and grammar filters return entries', filtered.head.length > 0);
const samples = await Promise.all(filtered.head.slice(0, 3).map((h) => call('entry', { id: h.id })));
check('built tag indexes match the entries opening labels', samples.length > 0 && samples.every((e) => matchesEntryTags(readEntryTags(e.body), tagFilterMasks(filters))));

// Meanings: «یاد» must reach «خاطره» (its meaning contains «یادگار»).
const ym = await call('meanings', { q: 'یاد', exclude: [] });
check('«یاد» meaning search reaches «خاطره»', ym.results.some((x) => x.w === 'خاطره'));
const mm = await call('meanings', { q: 'خورشید', exclude: [] });
check('«خورشید» meaning search returns results', mm.results.length > 10);
const regexMeanings = await call('meanings', { q: '/خورشید/', exclude: [] });
check('regex searches indexed meaning words', regexMeanings.results.length > 0 && regexMeanings.results.every((r) => r.terms?.some((term) => term.includes('خورشید'))));

const phraseMeaning = await call('meanings', { q: 'sarvǎže:/^ابه$/u AND cem:/یاد آوردن/u', exclude: [] });
check('meaning regex finds a spaced phrase in the real dictionary', phraseMeaning.results.some((row) => row.w === 'ابه' && row.snippet?.text.includes('یاد آوردن')));
const absentMeaning = await call('meanings', { q: 'sarvǎže:/^آفتاب$/u AND cem:/^(?!.*خورشید).*$/u', exclude: [] });
const absentEntries = await Promise.all(absentMeaning.results.map((row) => call('entry', { id: row.id })));
check('meaning exclusions reject real entries containing the forbidden word', absentEntries.length > 0 && absentEntries.every((entry) => !entry.body.includes('خورشید')));
const commonMeaning = await call('meanings', { q: 'sarvǎže:/^آب$/u AND cem:/^آب$/u', exclude: [] });
check('real meaning search can find a complete common word omitted from the index', commonMeaning.results.some((row) => row.w === 'آب' && row.snippet?.text.includes('آب')));
const literalMeaning = await call('meanings', { q: '/^آوردن$/u', exclude: [] });
const escapedMeaning = await call('meanings', { q: '/^\\u0622وردن$/u', exclude: [] });
check('real literal and escaped Persian regexes agree', literalMeaning.results.length > 0 && isDeepStrictEqual(escapedMeaning.results, literalMeaning.results));

const highlightQuery = 'sarvǎže:/^ابه$/u AND cem:/یاد آوردن/u AND cem:/فراموش/u';
const phraseRow = phraseMeaning.results.find((row) => row.w === 'ابه');
const allHighlights = (await call('snippets', { q: highlightQuery, requests: [{ id: phraseRow.id, key: 'all-highlights', kind: 'm' }] }))[0];
check('real result previews retain multiple phrase and term highlights', isDeepStrictEqual(allHighlights.matches.map(({ start, end }) => allHighlights.text.slice(start, end)), ['یاد آوردن', 'فراموش', 'یاد آوردن', 'فراموش']));
const highlightLoads = dataLoads;
const entryHighlights = await call('highlights', { q: highlightQuery, id: phraseRow.id });
const highlightedEntry = await call('entry', { id: phraseRow.id });
const entryText = compactMeaning(plainMeaning(highlightedEntry.body));
check('opened entries highlight both repeated real search terms', isDeepStrictEqual(entryHighlights.matches.map(({ start, end }) => entryText.slice(start, end)), ['یادآوردن', 'فراموش', 'یادآوردن', 'فراموش']));
check('extra entry highlights require no additional dictionary files after the snippet', dataLoads === highlightLoads);
const titleQuery = 'sarvǎže:/خورشید/u AND sarvǎže:/ماه/u';
const titleMatch = (await call('search', { q: titleQuery })).head.find((row) => row.w === 'تیره شدن خورشید و ماه');
const titleHighlights = await call('highlights', { q: titleQuery, id: titleMatch.id, word: titleMatch.w });
check('opened real compound headwords highlight both words', highlightWord(titleMatch.w, '', titleHighlights.headMatches) === 'تیره شدن <b>خورشید</b> و <b>ماه</b>');

// Exercise the builder and worker against shipped data, not just fixtures. An
// older generated dictionary can pass ordinary searches but reject mixed fields.
try {
  const groups = [{ match: 'all', rules: [
    { scope: 'headword', kind: 'regex', value: '^خاطره$' },
    { scope: 'meaning', kind: 'starts', value: 'یاد' },
  ] }];
  const q = buildWordQuery(groups);
  const head = await call('search', { q });
  const meanings = await call('meanings', { q, exclude: [] });
  check('mixed AND conditions require the same entry in real dictionary data',
    head.head.length === 0 && meanings.results.length > 0 && meanings.results.every((row) => row.w === 'خاطره'));

  groups[0].match = 'any';
  groups[0].rules[0].value = '^یاد$';
  const either = buildWordQuery(groups);
  const eitherHead = await call('search', { q: either });
  const eitherMeanings = await call('meanings', { q: either, exclude: [] });
  const meaningOnly = buildWordQuery([{ match: 'all', rules: [groups[0].rules[1]] }]);
  const independentMeanings = await call('meanings', { q: meaningOnly, exclude: [] });
  // OR broadens the search, so a particular AND result may fall beyond the
  // meaning display limit. Compare the branch under the same ordering and cap.
  check('mixed OR conditions preserve both fields in real dictionary data',
    eitherHead.head.some((row) => row.w === 'یاد') && independentMeanings.results.length > 0
    && isDeepStrictEqual(eitherMeanings.results, independentMeanings.results)
    && eitherMeanings.total === independentMeanings.total && eitherMeanings.limited === independentMeanings.limited);
} catch (error) {
  check('mixed headword and meaning conditions work with generated dictionary data', false);
  console.error(`${error.message}\nRebuild the dictionary with npm run build:data, then rerun npm test.`);
}

// Entry decoding.
const e = await call('entry', { id: yad.head[0].id });
check('entry decodes', e && e.word === 'یاد' && e.body.length > 100);
const s = await call('snippets', { ids: [yad.head[0].id], terms: [] });
check('snippet decodes', s[0].text.length > 20);

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
