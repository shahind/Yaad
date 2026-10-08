// Smoke test: runs the real search worker in Node against www/data.
//   node tools/test-search.mjs [query ...]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

globalThis.fetch = async (url) => {
  const buf = fs.readFileSync(fileURLToPath(String(url).split('?')[0]));
  return new Response(buf, { status: 200 });
};
const replies = new Map();
let seq = 0;
globalThis.self = globalThis;
globalThis.postMessage = (msg) => replies.get(msg.id)?.(msg);
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
    const h = await call('search', { q });
    const m = await call('meanings', { q, exclude: [] });
    console.log(`\n«${q}» headwords ${h.head.length} (${h.ms.toFixed(1)} ms), meanings ${m.total} (${m.ms.toFixed(1)} ms)`);
    console.log('  head:', h.head.slice(0, 15).map((x) => x.w).join(' | '));
    console.log('  mean:', m.results.slice(0, 15).map((x) => x.w).join(' | '));
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

// Meanings: «یاد» must reach «خاطره» (its meaning contains «یادگار»).
const ym = await call('meanings', { q: 'یاد', exclude: [] });
check('«یاد» meaning search reaches «خاطره»', ym.results.some((x) => x.w === 'خاطره'));
const mm = await call('meanings', { q: 'خورشید', exclude: [] });
check('«خورشید» meaning search returns results', mm.results.length > 10);

// Entry decoding.
const e = await call('entry', { id: yad.head[0].id });
check('entry decodes', e && e.word === 'یاد' && e.body.length > 100);
const s = await call('snippets', { ids: [yad.head[0].id], terms: [] });
check('snippet decodes', s[0].text.length > 20);

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
