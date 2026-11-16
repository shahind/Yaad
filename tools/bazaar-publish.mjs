// Publish a signed App Bundle to Cafe Bazaar through the Pishkhan API.
//
//   BAZAAR_API_SECRET=… node tools/bazaar-publish.mjs <app.aab> <app.bin> [--dry-run]
//
// Flow: reuse (or create) the draft release → upload AAB → upload BIN → wait until Bazaar
// has processed the bundle → commit for review with auto-publish. Changelogs come from the
// "What's new" section of store/play-listing.md ("- فارسی: …" / "- English: …" lines).
// Optional env: BAZAAR_ROLLOUT (percent, default 100), BAZAAR_AUTO_PUBLISH (default true),
// BAZAAR_DEVELOPER_NOTE.
import { openAsBlob, readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const BASE = 'https://api.pishkhan.cafebazaar.ir/v1';
const [aab, bin] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const dryRun = process.argv.includes('--dry-run');
const secret = process.env.BAZAAR_API_SECRET;

const die = msg => { console.error(`bazaar-publish: ${msg}`); process.exit(1); };
if (!aab || !bin) die('usage: bazaar-publish.mjs <app.aab> <app.bin> [--dry-run]');
for (const f of [aab, bin]) if (!existsSync(f)) die(`missing ${f}`);
if (!secret && !dryRun) die('BAZAAR_API_SECRET is not set');

function changelogs() {
  const md = existsSync('store/play-listing.md') ? readFileSync('store/play-listing.md', 'utf8') : '';
  const section = md.split(/^## What's new.*$/m)[1] || '';
  const line = re => (section.match(re)?.[1] || '').trim();
  return { fa: line(/^- فارسی:\s*(.+)$/m), en: line(/^- English:\s*(.+)$/m) };
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'CAFEBAZAAR-PISHKHAN-API-SECRET': secret,
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}
const must = async (label, p) => {
  const r = await p;
  if (!r.ok) die(`${label} failed: HTTP ${r.status} ${JSON.stringify(r.data)}`);
  console.log(`✓ ${label}`);
  return r.data;
};
const upload = async (path, field, file) => {
  const form = new FormData();
  form.append(field, await openAsBlob(file, { type: 'application/octet-stream' }), basename(file));
  return api('POST', path, form);
};

const notes = changelogs();
const commitBody = {
  changelog_fa: notes.fa,
  changelog_en: notes.en,
  developer_note: process.env.BAZAAR_DEVELOPER_NOTE || '',
  staged_rollout_percentage: Number(process.env.BAZAAR_ROLLOUT || 100),
  auto_publish: (process.env.BAZAAR_AUTO_PUBLISH ?? 'true') !== 'false',
};
console.log(`AAB ${aab}\nBIN ${bin}\nchangelog fa: ${notes.fa || '(empty)'}\nchangelog en: ${notes.en || '(empty)'}`);
console.log(`rollout ${commitBody.staged_rollout_percentage}%, auto-publish ${commitBody.auto_publish}`);
if (dryRun) { console.log('dry run: nothing sent'); process.exit(0); }

const draft = await api('GET', '/apps/releases/last-uncommitted/');
if (draft.ok) console.log('✓ using the existing draft release');
else await must('create draft release', api('POST', '/apps/releases/'));

await must('upload AAB', upload('/apps/releases/upload-aab/', 'aab', aab));
await must('upload BIN', upload('/apps/releases/upload-bin/', 'file', bin));

// Bazaar splits the bundle into APKs and checks them against the BIN; state "D" means done.
const deadline = Date.now() + 40 * 60_000;
for (;;) {
  const s = await must('bundle status', api('GET', '/apps/releases/bundle-status/'));
  const state = s?.bundle?.state;
  console.log(`  bundle state: ${state ?? JSON.stringify(s)}`);
  if (state === 'D') break;
  if (Date.now() > deadline) die('timed out waiting for Bazaar to process the bundle');
  await new Promise(r => setTimeout(r, 30_000));
}

await must('commit release for review', api('POST', '/apps/releases/commit/', commitBody));
console.log('Sent to Cafe Bazaar review.');
