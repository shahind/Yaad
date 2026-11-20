// Subject and usage search filters, with separate tags for each meaning and compound.
import { readEntryTags, normalizeTagLabel } from './search-origin-grammar.js';
import { normalizeCompact } from './normalize.js';

export const SENSE_VERSION = 3;
export const compatibleSenseIndex = (version) => version === 1 || version === 2 || version === SENSE_VERSION;
// IDs below are part of the index format. Append labels; change the version when
// existing assignments or extraction rules change.
export const SENSE_TAGS = [
  { key: 'subject-logic', label: 'منطق', group: 'subject', code: 'اصطلاح منطق', pattern: /^(?:منطق|منطقی)$/ },
  { key: 'subject-medicine', label: 'پزشکی', names: ['طب', 'طبی', 'تشریح'], group: 'subject', code: 'اصطلاح پزشکی', pattern: /^(?:پزشکی(?: قدیم)?|طب|طبی|تشریح)$/ },
  { key: 'subject-fiqh', label: 'فقه', group: 'subject', code: 'اصطلاح فقه', pattern: /^(?:فقه|فقهی|اصول|شرع|فقه و حقوق)$/ },
  { key: 'subject-mysticism', label: 'عرفان و تصوف', group: 'subject', code: 'اصطلاح عرفان', pattern: /^(?:تصوف|صوفیه|عرفان|عرفانی)$/ },
  { key: 'subject-prosody', label: 'عروض', group: 'subject', code: 'اصطلاح عروض', pattern: /^(?:عروض|عروضی)$/ },
  { key: 'subject-music', label: 'موسیقی', group: 'subject', code: 'اصطلاح موسیقی', pattern: /^موسیقی$/ },
  { key: 'subject-philosophy', label: 'فلسفه', group: 'subject', code: 'اصطلاح فلسفه', pattern: /^(?:فلسفه|فلسفی)$/ },
  { key: 'subject-astronomy', label: 'نجوم', group: 'subject', code: 'اصطلاح نجوم', pattern: /^(?:نجوم|نجومی|هیات|هییت|فلک|فلکی|احکام نجوم)$/ },
  { key: 'subject-rhetoric', label: 'بلاغت و بدیع', group: 'subject', code: 'اصطلاح بدیع', pattern: /^(?:بدیع|بدیعی|بلاغت|بیان|معانی|معانی و بیان)$/ },
  { key: 'subject-mathematics', label: 'ریاضی', group: 'subject', code: 'اصطلاح ریاضی', pattern: /^(?:ریاضی|ریاضیات|حساب|جبر|هندسه|هندسی)$/ },
  { key: 'subject-grammar', label: 'دستور زبان', group: 'subject', code: 'اصطلاح نحو', pattern: /^(?:نحو|نحوی|صرف|صرفی|صرف عربی|دستور|دستوری|دستور زبان)$/ },
  { key: 'subject-botany', label: 'گیاه‌شناسی', group: 'subject', code: 'اصطلاح گیاه شناسی', pattern: /^(?:گیاه شناسی|گیاهشناسی)$/ },
  { key: 'subject-physics', label: 'فیزیک', group: 'subject', code: 'اصطلاح فیزیک', pattern: /^(?:فیزیک|فیزیکی)$/ },
  { key: 'subject-law', label: 'حقوق', group: 'subject', code: 'اصطلاح حقوق', pattern: /^(?:حقوق(?: جزا| تجارت)?|حقوقی|قضا|قضایی|فقه و حقوق)$/ },
  { key: 'subject-chemistry', label: 'شیمی', group: 'subject', code: 'اصطلاح شیمی', pattern: /^(?:شیمی|کیمیا)$/ },
  { key: 'subject-zoology', label: 'جانورشناسی', group: 'subject', code: 'اصطلاح جانورشناسی', pattern: /^(?:جانورشناسی|جانور شناسی)$/ },
  // Retain the old slot for existing indexes and saved queries; expose medicine only.
  { key: 'subject-anatomy', aliasOf: 'subject-medicine', group: 'subject', code: 'اصطلاح تشریح' },
  { key: 'subject-geography', label: 'جغرافیا', group: 'subject', code: 'اصطلاح جغرافیا', pattern: /^(?:جغرافیا|جغرافیایی)$/ },
  { key: 'subject-geology', label: 'زمین‌شناسی', group: 'subject', code: 'اصطلاح زمین شناسی', pattern: /^(?:زمین شناسی|زمینشناسی)$/ },
  { key: 'subject-military', label: 'نظامی', group: 'subject', code: 'اصطلاح نظامی', pattern: /^نظامی$/ },
  { key: 'colloquial', label: 'عامیانه', group: 'usage', code: 'عامیانه', pattern: /^(?:اصطلاح عامیانه|در تداول (?:عامه|عوام|عامیانه)|عامیانه)$/ },
  { key: 'figurative', label: 'مجازی', group: 'usage', code: 'بمجاز', pattern: /^(?:بمجاز|به مجاز|مجازا|مجاز)$/ },
];
for (let i = 0; i < SENSE_TAGS.length; i++) SENSE_TAGS[i].id = i;

export function normalizeSenseFilters(filters = {}) {
  for (const tag of SENSE_TAGS) {
    if (!tag.aliasOf || !Object.hasOwn(filters, tag.key)) continue;
    filters = { ...filters };
    if (filters[tag.aliasOf] !== 1 && filters[tag.aliasOf] !== -1) filters[tag.aliasOf] = filters[tag.key];
    delete filters[tag.key];
  }
  return filters;
}

// Old anatomy rows remain usable without downloading or rebuilding dictionary data.
export function canonicalSenseIds(ids) {
  if (!ids.some((id) => SENSE_TAGS[id].aliasOf)) return ids;
  return [...new Set(ids.map((id) => {
    const tag = SENSE_TAGS[id];
    return tag.aliasOf ? SENSE_TAGS.find((candidate) => candidate.key === tag.aliasOf).id : id;
  }))];
}

export const hasSenseFilters = (filters = {}) => {
  filters = normalizeSenseFilters(filters);
  return SENSE_TAGS.some((tag) => filters[tag.key] === 1 || filters[tag.key] === -1);
};
export const positiveSenseFilters = (filters = {}) => {
  filters = normalizeSenseFilters(filters);
  return SENSE_TAGS.some((tag) => filters[tag.key] === 1);
};
export const senseTagText = (ids) => canonicalSenseIds(ids).map((id) => '(' + SENSE_TAGS[id].code + ')').join(' ');

function senseFilterTest(filters, modes) {
  filters = normalizeSenseFilters(filters);
  const excluded = SENSE_TAGS.filter((tag) => filters[tag.key] === -1).map((tag) => tag.id);
  const groups = (modes ? ['subject', 'usage'] : [null]).map((group) => ({
    ids: SENSE_TAGS.filter((tag) => filters[tag.key] === 1 && (!group || tag.group === group)).map((tag) => tag.id),
    all: !modes || modes[group] === 'all',
  }));
  return (ids) => {
    ids = canonicalSenseIds(ids);
    return !excluded.some((id) => ids.includes(id))
      && groups.every((group) => !group.ids.length || (group.all ? group.ids.every((id) => ids.includes(id)) : group.ids.some((id) => ids.includes(id))));
  };
}

// Read a contiguous header, stopping before sources and ordinary parenthetical prose.
export function readOpeningTags(body) {
  let rest = body.replace(/^[\s.،؛:\x01]+/, '')
    .replace(/^(?:\[[^\]]{0,200}\]|\x0e[^\x0f]{0,200}\x0f)\s*/, '');
  let mask = 0n;
  const facets = new Set();
  for (let i = 0; i < 8; i++) {
    const match = rest.match(/^\(([^()\n]{1,100})\)\s*/);
    if (!match) break;
    let accepted = false;
    for (const field of match[1].split(/[,،]/)) {
      const grammar = readEntryTags('(' + field + ')');
      const label = normalizeTagLabel(field);
      const subject = label.match(/^(?:(?:در|به) )?اصطلاح (.+)$/);
      const found = SENSE_TAGS.filter((tag) => !tag.aliasOf && tag.pattern.test(tag.group === 'subject' ? subject?.[1].replace(/^علم /, '') || '' : label));
      if (!grammar && !found.length && !/^(?:فارسی|پارسی)(?= |$)/.test(label)) break;
      accepted = true;
      mask |= grammar;
      for (const tag of found) facets.add(tag.id);
    }
    if (!accepted) break;
    rest = rest.slice(match[0].length);
  }
  return { mask, facets: [...facets], contentOffset: body.length - rest.length };
}

// Ranges are UTF-16 offsets in the converted body. A compound owns its following
// senses until the next compound header; no subject label leaks to another sense.
export function splitSenses(body, phraseIds = new Map()) {
  const visible = body.replace(/\x02[^\x03]*\x03|\x0e[^\x0f]*\x0f/g, (text) => ' '.repeat(text.length));
  const boundaries = [{ start: 0, header: 0, phrase: 0 }];
  for (let at = visible.indexOf('\x01'); at >= 0; at = visible.indexOf('\x01', at + 1)) boundaries.push({ start: at, header: at + 1 });
  const headings = /(?:\x04\s*)?\x05([^\x06]+)\x06\s*؛/g;
  let match;
  while ((match = headings.exec(visible))) {
    const phrase = phraseIds.get(normalizeCompact(match[1]));
    boundaries.push({ start: match.index, header: headings.lastIndex, phrase: phrase === undefined ? -1 : phrase + 1 });
  }
  boundaries.sort((a, b) => a.start - b.start);
  let phrase = 0;
  return boundaries.map((boundary, index) => {
    if (boundary.phrase !== undefined) phrase = boundary.phrase;
    const end = boundaries[index + 1]?.start ?? body.length;
    const tags = readOpeningTags(body.slice(boundary.header, end));
    return { start: boundary.start, end, phrase, ...tags, contentOffset: boundary.header + tags.contentOffset };
  }).filter((sense) => sense.end > sense.start && (sense.facets.length
    || body.slice(sense.contentOffset, sense.end).replace(/[\s\x00-\x1f.،؛:]/g, '')));
}

// Rows are [entry id, phrase id + 1 (0 = main, -1 = unindexed compound), start, end, facet ids]. Entries with
// no facet labels need no rows; their senses all satisfy exclusion-only filters.
export function planSenseFilters(rows, filters, entryCount, phraseCount, metadata = false, modes) {
  const accepts = senseFilterTest(filters, modes);
  const positive = positiveSenseFilters(filters);
  const entries = new Uint8Array(entryCount).fill(positive ? 0 : 1);
  const phrases = new Uint8Array(phraseCount).fill(positive ? 0 : 1);
  const affectedEntries = new Set(rows.map((row) => row[0]));
  const affectedPhrases = new Set(rows.filter((row) => row[1] > 0).map((row) => row[1] - 1));
  for (const id of affectedEntries) entries[id] = 0;
  for (const id of affectedPhrases) phrases[id] = 0;
  const allowed = new Uint8Array(rows.length);
  const entryRanges = new Map();
  const phraseRanges = new Map();
  const contexts = { entries: new Map(), phrases: new Map() };
  for (let id = 0; id < rows.length; id++) {
    const [entry, phrase, start, end, facets] = rows[id];
    if (!accepts(facets)) continue;
    allowed[id] = 1;
    if (phrase < 0) continue;
    const list = phrase ? phrases : entries;
    const owner = phrase ? phrase - 1 : entry;
    list[owner] = 1;
    const ranges = phrase ? phraseRanges : entryRanges;
    if (!ranges.has(owner)) ranges.set(owner, [start, end]);
    if (metadata) {
      const map = phrase ? contexts.phrases : contexts.entries;
      if (!map.has(owner)) map.set(owner, []);
      const text = senseTagText(facets);
      if (!map.get(owner).some((item) => item.text === text)) map.get(owner).push({ text, range: [start, end] });
    }
  }
  return { entries, phrases, allowed, affectedEntries, entryRanges, phraseRanges, contexts, positive };
}
