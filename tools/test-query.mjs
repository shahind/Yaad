// Search smoke tests with in-memory fixtures; no generated dictionary or build needed.
//   node tools/test-query.mjs
import { isDeepStrictEqual } from 'node:util';
import { BrowserWorker } from './worker-shim.mjs';
import { parseSearchQuery, buildSearchQuery, buildCombinedQuery, buildTaggedQuery, buildWordQuery, buildScopedQuery, separateSearchFilters, readSearchBuilder, isTaggedPattern, escapeRegex, quotedIndexTerms, readHeadwordRegex, readMeaningRegex, SEARCH_FILTER_TAGS } from '../www/js/search-syntax.js';
import { normalizeCompact, normalizeQuoted, quotedMatch, tokenize, termTester } from '../www/js/normalize.js';
import { highlightWord, markMatch, markRanges } from '../www/js/render.js';
import { plainMeaning, regexSnippet, literalRange, compactMeaning, compactMatches } from '../www/js/search-match-text.js';
import { normalizeMeaningPattern, meaningPatternMatcher } from '../www/js/search-meaning-pattern.js';
import { ENTRY_TAGS, readEntryTags, entryTagText, tagFilterMasks, matchesEntryTags, TAG_VERSION } from '../www/js/search-origin-grammar.js';
import { SENSE_VERSION, SENSE_TAGS, readOpeningTags, splitSenses, planSenseFilters, senseTagText, normalizeSenseFilters } from '../www/js/search-subject-usage.js';
import { SOURCE_VERSION, SOURCE_TAGS, readSources, sourceOwners, decodeSourceOwners } from '../www/js/search-citations.js';
import { writeTokenShards, writeSourceIndex, TAG_COUNTS_VERSION, countTags, scopedTokens } from './search-index.mjs';

let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
};

const matchesError = (error, expected) => !expected || (typeof expected === 'function' ? error instanceof expected : expected.test(error.message));
const throws = (run, expected) => {
  try {
    run();
    return false;
  } catch (error) {
    return matchesError(error, expected);
  }
};
const rejects = (promise, expected) => promise.then(() => false, (error) => matchesError(error, expected));

// Plain, quoted and regex syntax remain distinct.
{
  check('plain queries trim surrounding spaces', isDeepStrictEqual(parseSearchQuery(' یاد '), { mode: 'text', text: 'یاد' }));
  check('parentheses do not imply regex', parseSearchQuery('کتاب (قدیم)').mode === 'text');
  for (const query of ['"به یاد آوردن"', '«به یاد آوردن»', '“به یاد آوردن”']) {
    check('paired quotes select phrase mode', isDeepStrictEqual(parseSearchQuery(query), { mode: 'exact', text: 'به یاد آوردن' }));
  }
  check('slashes select regex mode', isDeepStrictEqual(parseSearchQuery('/^یاد.*$/'), { mode: 'regex', source: '^یاد.*$', flags: 'u' }));
  check('quotes preserve edge spaces', parseSearchQuery('  " book do "  ').text === ' book do ');
  check('explicit regex flags are retained', parseSearchQuery('/book/i').flags === 'i');
  for (const query of ['"یاد', '/یاد', '//', '/[/', '/a/ii', '/a/g', `/${'a'.repeat(501)}/`]) {
    check('invalid queries are rejected: ' + query, throws(() => parseSearchQuery(query), Error));
  }
}

const builtRegex = (kind, input) => {
  const { source, flags } = parseSearchQuery(buildSearchQuery(kind, input));
  return new RegExp(source, flags);
};

// Explicit fields keep headword and meaning predicates independently editable.
{
  const groups = [{ match: 'all', rules: [
    { kind: 'starts', value: 'ک', scope: 'headword' }, { kind: 'contains', value: 'آموزش', scope: 'meaning' },
  ] }];
  const q = buildWordQuery(groups);
  check('mixed field helpers emit explicit scoped syntax', q === '(headword:/^ک/u AND meaning:/آموزش/u)');
  const plainBuilder = readSearchBuilder('یاد');
  plainBuilder.groups[0].rules.push({ kind: 'contains', value: '', scope: 'meaning' });
  check('empty scoped rules do not change ordinary text search', buildWordQuery(plainBuilder.groups, plainBuilder.match, 'u', 'یاد') === 'یاد');
  const query = parseSearchQuery(q);
  check('scoped syntax preserves both independent fields', query.mode === 'scoped' && query.expression.rules[0].scope === 'headword' && query.expression.rules[1].scope === 'meaning');
  for (const match of ['all', 'any']) {
    for (const groupMatch of ['all', 'any']) {
      const mixed = [{ ...groups[0], match: groupMatch }, { match: 'all', rules: [{ kind: 'ends', value: 'گار', scope: 'both' }] }];
      const built = buildScopedQuery(mixed, match, 'iu');
      const reopened = readSearchBuilder(built);
      check('scoped groups round-trip with independent all/any relationships', buildWordQuery(reopened.groups, reopened.match, reopened.query.flags, built) === built);
      check('scoped groups preserve every target', reopened.groups.flatMap((group) => group.rules).map((rule) => rule.scope).join(',') === 'headword,meaning,both');
    }
  }
  for (const text of ['headword:/a\\/b/u AND meaning:/[/]/u', 'meaning:/۲۱/u', '(headword:/Book/i OR meaning:/book/u)']) {
    const read = readSearchBuilder(text);
    check('manual scoped syntax retains escapes, digits and individual flags', buildWordQuery(read.groups, read.match, read.query.flags, text) === text);
  }
  const precedence = parseSearchQuery('headword:/a/u OR meaning:/b/u AND meaning:/c/u');
  check('AND binds more tightly than OR in scoped input', precedence.expression.match === 'any' && precedence.expression.rules[1].match === 'all');
  for (const text of ['headword:', 'headword:/a/u AND', 'meaning:/[/u', 'headword:/a/u XOR meaning:/b/u', '(headword:/a/u', 'headword:/a/g', new Array(33).fill('meaning:/a/u').join(' AND ')]) {
    check('invalid or excessive scoped conditions are rejected', throws(() => parseSearchQuery(text)));
  }
}

// Builders escape literal punctuation and implement common searches.
{
  const literal = 'a.b+[x](y){2}?^$|/\\';
  check('literal regex punctuation is escaped', new RegExp(`^${escapeRegex(literal)}$`, 'u').test(literal));
  check('starts matches a prefix', builtRegex('starts', 'یاد').test('یادگار'));
  check('starts rejects a later occurrence', !builtRegex('starts', 'یاد').test('به یاد'));
  check('ends matches a suffix', builtRegex('ends', 'گار').test('یادگار'));
  check('ends rejects extra characters', !builtRegex('ends', 'گار').test('یادگاری'));
  check('contains treats punctuation literally', builtRegex('contains', 'a.b').test('xa.by'));
  check('contains rejects regex wildcard expansion', !builtRegex('contains', 'a.b').test('xazby'));
  check('excludes accepts absent text', builtRegex('excludes', 'یاد').test('کتاب'));
  check('excludes rejects present text', !builtRegex('excludes', 'یاد').test('یادگار'));
  check('either matches an alternative', builtRegex('either', 'یاد، خاطر').test('خاطره'));
  check('either escapes punctuation', !builtRegex('either', 'a.b,c+d').test('axb'));
  check('literal phrase helper emits regex', buildSearchQuery('exact', 'یاد') === '/یاد/u');
  check('letters accepts allowed characters', builtRegex('letters', 'ا ب د ر').test('برادر'));
  check('letters rejects other characters', !builtRegex('letters', 'ابدر').test('کتاب'));
  check('letters escapes character-class punctuation', builtRegex('letters', ']-\\').test(']-\\'));
}

// Single and combined phrase rules emit regex with the selected case setting.
{
  const phrase = { kind: 'exact', value: 'Book do ' };
  for (const flags of ['u', 'iu']) {
    for (const filters of [{}, { noun: 1 }]) {
      const single = buildCombinedQuery([{ match: 'all', rules: [phrase] }], 'any', filters, flags);
      const combined = buildCombinedQuery([{ match: 'all', rules: [phrase, { kind: 'contains', value: 'next' }] }], 'any', filters, flags);
      for (const text of [single, combined]) {
        const query = parseSearchQuery(text);
        check('single and combined phrases use regex mode', query.mode === 'regex');
        check('phrase rules retain case flags', query.flags.includes('i') === flags.includes('i'));
        const re = new RegExp(query.source, query.flags);
        const suffix = filters.noun ? '\n(اِ)' : '';
        check('phrase rules match with surrounding text', re.test('a Book do next' + suffix));
        check('phrase case matching follows the visible flags', re.test('a book do next' + suffix) === flags.includes('i'));
        check('phrase rules preserve a required space', !re.test('a Book dowom next' + suffix));
        const reopened = readSearchBuilder(text);
        check('phrase queries reopen without changing the expression', buildCombinedQuery(reopened.groups, reopened.match, reopened.filters, reopened.query.flags) === text);
      }
    }
  }
}

// Custom patterns serialize slashes and line breaks into copyable regex literals.
{
  check('custom regex escapes slash delimiters', buildSearchQuery('regex', '^/usr/') === '/^\\/usr\\//u');
  for (const value of ['a/b', 'a\nb', 'a\rb', 'a\u2028b', 'a\u2029b']) {
    for (const filters of value === 'a/b' ? [{}, { noun: 1 }] : [{}]) {
      const built = buildSearchQuery('regex', value, filters);
      check('regex output escapes line breaks', !/[\n\r\u2028\u2029]/.test(built));
      const { source, flags } = parseSearchQuery(built);
      check('serialized regex retains its matching behavior', new RegExp(source, flags).test(value + (filters.noun ? '\n(اِ)' : '')));
    }
  }
  const groups = [{ match: 'all', rules: [{ kind: 'regex', value: 'a/b' }, { kind: 'contains', value: 'a' }] }];
  const { source, flags } = parseSearchQuery(buildCombinedQuery(groups));
  check('combined custom regex matches a literal slash', new RegExp(source, flags).test('a/b'));
}

// Wildcards and Unicode word lengths work without interpreting literal regex.
{
  check('question-mark wildcard matches one character', builtRegex('wildcard', 'ک?اب').test('کتاب'));
  check('question-mark wildcard respects the full length', !builtRegex('wildcard', 'ک?اب').test('کتابخانه'));
  check('star wildcard can match zero characters', builtRegex('wildcard', 'یاد*').test('یاد'));
  check('wildcards preserve literal punctuation', builtRegex('wildcard', 'a.*').test('a.xyz'));
  check('wildcards do not expand literal punctuation', !builtRegex('wildcard', 'a.*').test('abxyz'));
  for (const length of ['4', '۴', '٤']) check('length accepts Latin and Persian digit variants', builtRegex('length', length).test('کتاب'));
  check('Unicode length counts a supplementary character once', builtRegex('length', '1').test('🌱'));
  for (const length of ['0', '-2', '101', '2.5', 'abc']) check('invalid lengths are rejected', throws(() => buildSearchQuery('length', length)));
  check('empty prefix is rejected', throws(() => buildSearchQuery('starts', ' ')));
  check('either requires two alternatives', throws(() => buildSearchQuery('either', 'یاد')));
}

// Negative prefix/suffix and length bounds do not require hand-written regex.
{
  check('negative prefix accepts other starts', builtRegex('not-starts', 'نا').test('توانا'));
  check('negative prefix rejects the specified start', !builtRegex('not-starts', 'نا').test('ناتوان'));
  check('negative suffix accepts other endings', builtRegex('not-ends', 'ها').test('کتاب'));
  check('negative suffix rejects the specified ending', !builtRegex('not-ends', 'ها').test('کتابها'));
  check('minimum length accepts longer text', builtRegex('min-length', '۴').test('کتابخانه'));
  check('minimum length rejects shorter text', !builtRegex('min-length', '۴').test('آب'));
  check('maximum length accepts shorter text', builtRegex('max-length', '۴').test('آب'));
  check('maximum length rejects longer text', !builtRegex('max-length', '۴').test('کتابخانه'));
  check('length range accepts Persian digits', builtRegex('length-range', '۲-۴').test('کتاب'));
  check('length range accepts Arabic-Indic digits', builtRegex('length-range', '٢–٤').test('آب'));
  check('length range rejects longer text', !builtRegex('length-range', '2-4').test('کتابخانه'));
  for (const value of ['4-2', '0-4', '2-101', 'abc', '2.5-4']) check('invalid length ranges are rejected', throws(() => buildSearchQuery('length-range', value)));
}

const combinedRegex = (groups, match = 'any', filters = {}, flags = 'u') => {
  const query = parseSearchQuery(buildCombinedQuery(groups, match, filters, flags));
  return new RegExp(query.source, query.flags);
};

// Different word rules combine independently, including overlapping matches.
{
  const re = combinedRegex([{ match: 'all', rules: [
    { kind: 'starts', value: 'ک' }, { kind: 'ends', value: 'اب' },
    { kind: 'contains', value: 'تا' }, { kind: 'length', value: '۴' },
  ] }]);
  check('combined prefix suffix and length match together', re.test('کتاب'));
  for (const word of ['کلاب', 'بکتاب', 'کتابخانه']) check('combined rules reject a missing condition: ' + word, !re.test(word));
  const overlap = combinedRegex([{ match: 'all', rules: [
    { kind: 'contains', value: 'aba' }, { kind: 'contains', value: 'bab' },
  ] }]);
  check('independent conditions allow overlapping matches', overlap.test('abab'));
  const escaped = combinedRegex([{ match: 'all', rules: [
    { kind: 'starts', value: 'a.b' }, { kind: 'ends', value: '[x]' },
  ] }]);
  check('combined rules escape punctuation', escaped.test('a.b[x]'));
  check('combined rules reject expanded punctuation', !escaped.test('azb[x]'));
}

// AND/OR rules and groups preserve the intended alternatives.
{
  const alternatives = combinedRegex([
    { match: 'all', rules: [{ kind: 'starts', value: 'یاد' }, { kind: 'ends', value: 'گار' }] },
    { match: 'all', rules: [{ kind: 'starts', value: 'کت' }, { kind: 'ends', value: 'اب' }] },
  ]);
  check('OR groups accept the first alternative', alternatives.test('یادگار'));
  check('OR groups accept the second alternative', alternatives.test('کتاب'));
  check('OR groups reject an incomplete first group', !alternatives.test('یادی'));
  check('OR groups reject an incomplete second group', !alternatives.test('کتانی'));
  const intersection = combinedRegex([
    { match: 'any', rules: [{ kind: 'starts', value: 'ک' }, { kind: 'starts', value: 'ب' }] },
    { match: 'all', rules: [{ kind: 'ends', value: 'اب' }, { kind: 'length', value: '4' }] },
  ], 'all');
  check('AND groups match their intersection', intersection.test('کتاب'));
  check('AND groups enforce length', !intersection.test('باب'));
  check('AND groups enforce prefix', !intersection.test('شراب'));
}

// Combined expressions reopen as editable helper rows and groups.
{
  const groups = [
    { match: 'all', rules: [{ kind: 'starts', value: 'ک' }, { kind: 'length-range', value: '3-7' }, { kind: 'not-ends', value: 'ها' }] },
    { match: 'any', rules: [{ kind: 'contains', value: 'یاد' }, { kind: 'excludes', value: 'بد' }] },
  ];
  for (const match of ['all', 'any']) {
    for (const filters of [{}, { arabic: 1, proper: -1 }]) {
      const query = buildCombinedQuery(groups, match, filters, 'iu');
      const reopened = readSearchBuilder(query);
      check('reopening preserves the group relation', reopened.match === match);
      check('reopening preserves editable groups', isDeepStrictEqual(reopened.groups, groups));
      check('reopening preserves metadata choices', isDeepStrictEqual(reopened.filters, filters));
      const rebuilt = combinedRegex(reopened.groups, reopened.match, reopened.filters, reopened.query.flags);
      const original = parseSearchQuery(query);
      const re = new RegExp(original.source, original.flags);
      for (const word of ['کتاب', 'یادگار', 'بد', 'کتاب\n(ع) (اِ)', 'کتاب\n(ع) (اِخ)']) {
        check('rebuilt groups retain their behavior: ' + word, rebuilt.test(word) === re.test(word));
      }
    }
  }
  for (const [kind, value] of [
    ['length', '4'], ['min-length', '3'], ['max-length', '7'], ['length-range', '2-5'], ['whole', 'کتاب'],
    ['not-starts', 'نا'], ['not-ends', 'ها'], ['wildcard', 'ک?اب*'], ['either', 'یاد، خاطر'], ['letters', 'ابدر'],
  ]) {
    const reopened = readSearchBuilder(buildSearchQuery(kind, value));
    check('individual helpers reopen as editable rules', isDeepStrictEqual(reopened.groups[0].rules[0], { kind, value }));
  }
}

// Empty rows, literal phrases and custom regex rules remain usable.
{
  check('empty rows are ignored', buildCombinedQuery([{ match: 'all', rules: [
    { kind: 'exact', value: 'یاد' }, { kind: 'contains', value: ' ' },
  ] }]) === '/یاد/u');
  check('empty groups without metadata are rejected', throws(() => buildCombinedQuery([{ match: 'all', rules: [] }])));
  check('metadata-only searches emit a tagged regex', isTaggedPattern(parseSearchQuery(buildCombinedQuery([], 'any', { arabic: 1 })).source));
  const anchored = readSearchBuilder('/^آب$/u');
  check('anchored literal queries retain their anchors', buildCombinedQuery(anchored.groups, anchored.match, anchored.filters, anchored.query.flags) === '/^آب$/u');
  const groups = [{ match: 'all', rules: [
    { kind: 'regex', value: '(?:foo|bar)[()]' }, { kind: 'contains', value: '(' },
  ] }];
  const q = buildCombinedQuery(groups);
  check('custom regex rules reopen unchanged', isDeepStrictEqual(readSearchBuilder(q).groups, groups));
  const re = combinedRegex(groups, 'any', {}, 'iu');
  check('custom regex honors case flags', re.test('FOO('));
  check('custom regex still requires every condition', !re.test('bar)'));
  check('invalid custom regex identifies its group', throws(() => buildCombinedQuery([{ match: 'all', rules: [
    { kind: 'starts', value: 'ک' }, { kind: 'regex', value: '[' },
  ] }]), /گروه/));
}

// Word predicates cannot accidentally match the metadata line.
{
  const re = combinedRegex([{ match: 'all', rules: [
    { kind: 'regex', value: '.*معرب' }, { kind: 'starts', value: 'ک' },
  ] }], 'any', { arabic: 1 }, 'su');
  check('word rules cannot match the metadata line', !re.test('کتاب\n(ع) (معرب)'));
  check('word rules can match the same text in the headword', re.test('کمعرب\n(ع)'));
}

// Quoted phrases keep literal spaces and order without automatic word boundaries.
{
  const phrase = normalizeQuoted('ياد آوردن');
  check('quoted phrases fold letters and diacritics', normalizeQuoted('از یادِ آوردن، سخن گفت').indexOf(phrase) === 3);
  check('quoted phrases allow an earlier word fragment', normalizeQuoted('بیاد آوردن').indexOf(phrase) === 1);
  for (const text of ['یادگار آوردن', 'آوردن یاد', 'یاد چیزی آوردن', 'یادآوردن']) {
    check('quoted phrases require literal order and spaces', normalizeQuoted(text).indexOf(phrase) === -1);
  }
  check('quoted normalization joins ZWNJ', normalizeQuoted('هم‌دِل') === normalizeQuoted('همدل'));
  check('ordinary highlighting accepts token prefixes', termTester(['یاد'])('یادگار') === 1);
  check('whole-token highlighting rejects prefixes', termTester(['یاد'], true)('یادگار') === 0);
  check('whole-token highlighting ignores diacritics', termTester(['یاد'], true)('یادِ') === 2);
  check('quoted book do matches book dowom', isDeepStrictEqual(quotedMatch('book dowom', 'book do'), { start: 0, end: 7 }));
  check('a trailing space rejects book dowom', quotedMatch('book dowom', 'book do ') === null);
  check('a trailing space accepts book do next', isDeepStrictEqual(quotedMatch('book do next', 'book do '), { start: 0, end: 8 }));
  check('end of text does not count as a space', quotedMatch('book do', 'book do ') === null);
  check('punctuation does not count as a space', quotedMatch('book do, next', 'book do ') === null);
  check('quoted normalization preserves edge spaces', normalizeQuoted(' كتاب ') === ' کتاب ');
  check('quoted normalization preserves repeated spaces', normalizeQuoted('book  do ') === 'book  do ');
  check('quoted normalization folds diacritics', normalizeQuoted('هم‌دِل') === 'همدل');
  check('quoted offsets refer to the original text', isDeepStrictEqual(quotedMatch('یک يَادِگار', normalizeQuoted('یاد')), { start: 3, end: 8 }));
}

// Literal builder rules preserve edge spaces when combined and reopened.
{
  check('literal builder preserves both edge spaces', buildSearchQuery('exact', ' book do ') === '/ book do /u');
  check('space-only literal rules are retained', buildCombinedQuery([{ match: 'all', rules: [{ kind: 'exact', value: ' ' }] }]) === '/ /u');
  const groups = [{ match: 'all', rules: [
    { kind: 'exact', value: 'book do ' }, { kind: 'contains', value: 'next' },
  ] }];
  for (const filters of [{}, { noun: 1 }]) {
    const built = buildCombinedQuery(groups, 'any', filters);
    const reopened = readSearchBuilder(built);
    check('reopened literal rules preserve spaces', isDeepStrictEqual(reopened.groups, groups));
    check('literal rules rebuild to the same expression', buildCombinedQuery(reopened.groups, reopened.match, reopened.filters, reopened.query.flags) === built);
    const { source, flags } = parseSearchQuery(built);
    const re = new RegExp(source, flags);
    const tags = filters.noun ? '\n(اِ)' : '';
    check('combined literal rules accept the required space', re.test('a book do next' + tags));
    check('combined literal rules reject a longer word fragment', !re.test('book dowom next' + tags));
    check('combined literal rules reject punctuation instead of a space', !re.test('book do, next' + tags));
  }
  const { source, flags } = parseSearchQuery(buildSearchQuery('exact', 'book do ', { noun: 1 }));
  const re = new RegExp(source, flags);
  check('tagged literal rules match within longer text', re.test('a book do next\n(اِ)'));
  check('tagged literal rules preserve a required space', !re.test('book dowom\n(اِ)'));
  check('whole-text rules accept the complete text', builtRegex('whole', 'book do').test('book do'));
  check('whole-text rules reject a longer word', !builtRegex('whole', 'book do').test('book dowom'));
}

// Regex result highlighting uses worker offsets and escapes HTML.
{
  check('headword highlighting escapes HTML', highlightWord('<یاد>', '', { start: 1, end: 4 }) === '&lt;<b>یاد</b>&gt;');
  check('zero-width headword matches add no markup', highlightWord('یاد', '', { start: 0, end: 0 }) === 'یاد');
}

// Meaning snippets center the actual regex match and escape markup.
{
  const text = plainMeaning('(اِ) ' + 'توضیح '.repeat(80) + 'پایان ویژه');
  const match = { start: text.indexOf('پایان ویژه'), end: text.length };
  const snippet = regexSnippet(text, 'تَ', match);
  check('late meaning snippets show a leading ellipsis', snippet.text.startsWith('… '));
  check('meaning snippets retain the matched span', snippet.text.slice(snippet.match.start, snippet.match.end) === 'پایان ویژه');
  check('meaning snippets retain pronunciation', snippet.pron === 'تَ');
  check('meaning highlighting escapes HTML', markMatch('<خ>', { start: 1, end: 2 }) === '&lt;<mark>خ</mark>&gt;');
  check('zero-width meaning matches add no markup', markMatch('<خ>', { start: 0, end: 0 }) === '&lt;خ&gt;');
  check('plain meanings preserve subentry boundaries', plainMeaning('یاد\x05 آوردن\x06\n\x04ترکیب') === 'یاد آوردن ♦ ترکیب');
  check('plain meanings preserve inline pronunciation', plainMeaning('واژه\x0eاَ\x0f') === 'واژه[اَ]');
}

// Entry highlights locate literal matches across formatting text nodes.
{
  check('literal ranges cross formatted text nodes', isDeepStrictEqual(literalRange(['از یاد', 'ِ ', 'آوردن'], 'یادِ آوردن'), {
    start: { part: 0, offset: 3 }, end: { part: 2, offset: 5 },
  }));
  check('literal ranges ignore formatting separators', isDeepStrictEqual(literalRange(['یاد', ' \n♦ ', 'آوردن'], 'یاد آوردن'), {
    start: { part: 0, offset: 0 }, end: { part: 2, offset: 5 },
  }));
  check('missing literal text has no highlight', literalRange(['کتاب'], 'گمشده') === null);
  check('empty literal text has no highlight', literalRange(['کتاب'], '') === null);
  check('literal ranges select the matched occurrence', isDeepStrictEqual(literalRange(['آب و ', 'آب'], 'آب', 'آب و '), {
    start: { part: 1, offset: 0 }, end: { part: 1, offset: 2 },
  }));
}

// Multiple highlights merge overlaps and retain their positions across formatting.
{
  check('multiple title matches highlight both requested words', highlightWord('خورشید و ماه', '', [{ start: 0, end: 6 }, { start: 9, end: 12 }]) === '<b>خورشید</b> و <b>ماه</b>');
  check('multiple snippet spans merge overlaps and escape HTML', markMatch('<خورشید> و ماه', [{ start: 2, end: 5 }, { start: 1, end: 7 }, { start: 11, end: 14 }]) === '&lt;<mark>خورشید</mark>&gt; و <mark>ماه</mark>');
  check('invalid and empty match spans add no markup', markMatch('<x>', [{ start: 2, end: 1 }, { start: 0, end: 0 }]) === '&lt;x&gt;');
  const oldDocument = globalThis.document, oldFilter = globalThis.NodeFilter;
  class Node {
    constructor(tag, text = '') { this.tag = tag; this.nodeValue = text; this.children = []; }
    get textContent() { return this.tag === '#text' ? this.nodeValue : this.children.map((node) => node.textContent).join(''); }
    set textContent(text) { this.children = []; this.append(text); }
    append(...items) { for (const item of items) { const node = typeof item === 'string' ? new Node('#text', item) : item; node.parent = this; this.children.push(node); } }
    replaceWith(fragment) {
      const index = this.parent.children.indexOf(this);
      for (const node of fragment.children) node.parent = this.parent;
      this.parent.children.splice(index, 1, ...fragment.children);
    }
  }
  const textNodes = (node) => node.tag === '#text' ? [node] : node.children.flatMap(textNodes);
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.document = {
    createTreeWalker(root) { const nodes = textNodes(root); let i = 0; return { currentNode: null, nextNode() { this.currentNode = nodes[i++]; return !!this.currentNode; } }; },
    createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node('#fragment'),
  };
  try {
    const root = new Node('div'), bold = new Node('b'), next = new Node('p');
    bold.append(' آوردن'); next.append('یاد آوردن');
    root.append('(اِ) یاد', bold, ' و فراموش ', next);
    const body = '(اِ) یاد\x05 آوردن\x06 و فراموش\x01یاد آوردن';
    const text = plainMeaning(body);
    const hits = [...text.matchAll(/یاد آوردن|فراموش/g)].map((match) => ({ part: 0, match: { start: match.index, end: match.index + match[0].length } }));
    const marks = markRanges(root, compactMatches(body, [{ text }], hits));
    check('entry highlights cover every match across formatted nodes and sense boundaries', isDeepStrictEqual(marks.map((node) => node.textContent.trim()), ['یاد', 'آوردن', 'فراموش', 'یاد آوردن']));
    check('entry highlighting preserves the original rendered text', root.textContent === '(اِ) یاد آوردن و فراموش یاد آوردن');
  } finally {
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldFilter === undefined) delete globalThis.NodeFilter; else globalThis.NodeFilter = oldFilter;
  }
}

// Opening Dehkhoda labels distinguish origins and kinds of words.
{
  for (const [opening, filters] of [
    ['(ع اِ) پدر.', { arabic: 1, noun: 1, proper: -1 }],
    ['(از ع، اِ مرکب ) باقیمانده.', { arabic: 1, noun: 1, compound: 1 }],
    ['(ع ص، اِ) گروه.', { arabic: 1, adjective: 1, noun: 1 }],
    ['(اِخ ) نام.', { proper: 1, noun: -1, arabic: -1 }],
    ['(ترکیب عطفی، اِمرکب ) کبر.', { compound: 1, noun: 1, arabic: -1 }],
    ['(معرب، اِ) گیاه.', { arabicized: 1, arabic: -1, noun: 1 }],
    ['(فرانسوی، اِ) واژه.', { french: 1, noun: 1 }],
    ['(ترکی، اِ) واژه.', { turkish: 1, noun: 1 }],
    ['(ع ن مف مرکب) واژه.', { arabic: 1, passive: 1, compound: 1 }],
    ['(حامص مرکب) تکبر.', { abstract: 1, compound: 1, infinitive: -1 }],
    ['(ع مص جعلی، اِمص) واژه.', { arabic: 1, infinitive: 1, 'verbal-noun': 1 }],
    ['؛ \x0eدَ ن\x0f (مص مرکب) توضیح.', { infinitive: 1, compound: 1 }],
  ]) check('opening labels identify origin and grammar: ' + opening, matchesEntryTags(readEntryTags(opening), tagFilterMasks(filters)));
  check('opening pronunciation does not hide labels', matchesEntryTags(readEntryTags('[اَ] (ع حرف) توضیح.'), tagFilterMasks({ arabic: 1, particle: 1 })));
}

// Audited origins, word kinds and spelling variants remain independent labels.
{
  // Confirmed spellings and label combinations from the local parentheses audit.
  for (const [label, filters] of [
    ['(مغولی، اِ)', { mongolian: 1, noun: 1 }],
    ['(ترکی، مغولی، اِ)', { turkish: 1, mongolian: 1, noun: 1 }],
    ['(هزوارش، مص)', { huzvarish: 1, infinitive: 1 }],
    ['(سریانی، اِ)', { syriac: 1, noun: 1 }],
    ['(پهلوی، ص، اِ)', { pahlavi: 1, adjective: 1, noun: 1 }],
    ['(اوستایی، نف مرکب)', { avestan: 1, active: 1, compound: 1 }],
    ['(سنسکریت، اِ مرکب)', { sanskrit: 1, noun: 1, compound: 1 }],
    ['(سانسکریت، اِ)', { sanskrit: 1, noun: 1 }],
    ['(عبرانی، اِ)', { hebrew: 1, noun: 1, arabic: -1 }],
    ['(اسپانیولی، اِ)', { spanish: 1, noun: 1 }],
    ['(آلمانی، اِ)', { german: 1, noun: 1 }],
    ['(ایتالیائی، اِ)', { italian: 1, noun: 1 }],
    ['(آرامی، اِ)', { aramaic: 1, noun: 1 }],
    ['(آسی، اِ)', { ossetian: 1, noun: 1 }],
    ['(لاطینی، اِ)', { latin: 1, noun: 1 }],
    ['(فرنسوی، اِ)', { french: 1, noun: 1 }],
    ['(فرنسه، اِ)', { french: 1, noun: 1 }],
    ['(فرانسسوی، اِ)', { french: 1, noun: 1 }],
    ['(ازع، اِمص)', { arabic: 1, 'verbal-noun': 1 }],
    ['(ازترکی، اِ)', { turkish: 1, noun: 1 }],
    ['(از هندی و اردو، اِ)', { hindi: 1, urdu: 1, noun: 1 }],
    ['(ترکی، آذربایجانی، اِ)', { turkish: 1, azerbaijani: 1, noun: 1, azeri: -1 }],
    ['(ازیونانی، اِ)', { greek: 1, noun: 1 }],
    ['(مأخوذ از انگلیسی، اِ)', { english: 1, noun: 1 }],
    ['(مص مأخوذ از تازی)', { infinitive: 1, arabic: 1 }],
    ['(مأخوذ از فرانسه)', { french: 1 }],
    ['(اِ خ)', { proper: 1, noun: -1 }],
    ['(اِمصغر)', { noun: 1 }],
    ['(اِصوت)', { noun: 1, interjection: 1, adjective: -1 }],
    ['(صوت مرکب)', { interjection: 1, compound: 1, adjective: -1 }],
    ['(عددترتیبی، ص نسبی)', { numeral: 1, adjective: 1 }],
    ['(ص تفضیلی)', { comparative: 1, adjective: 1 }],
    ['(جملهٔ فعلیهٔ دعایی)', { sentence: 1 }],
    ['(علامت اختصاری)', { abbreviation: 1 }],
    ['(نفی)', { negation: 1, active: -1 }],
    ['(منادا، صوت)', { vocative: 1, interjection: 1 }],
    ['(ادات استفهام + ضمیر)', { particle: 1, pronoun: 1 }],
    ['(موصول + قید)', { pronoun: 1, adverb: 1 }],
    ['(اسم مصدر)', { 'verbal-noun': 1, noun: -1, infinitive: -1 }],
    ['(حاصل مصدر)', { abstract: 1, infinitive: -1 }],
    ['(حرف ربطمرکب)', { particle: 1, compound: 1 }],
    ['(اسم خاص)', { proper: 1, noun: -1 }],
    ['(نعت فاعلی)', { active: 1, adjective: 1 }],
    ['(قید مرکب)', { adverb: 1, compound: 1 }],
    ['(مزید مؤخرامکنه)', { suffix: 1 }],
    ['(پیشوندفعلی)', { prefix: 1 }],
    ['(فارسی) (صفت)', { adjective: 1 }],
    ['(فارسی باستان، اِ)', { noun: 1 }],
    ['(ع = انارة، مص)', { arabic: 1, infinitive: 1 }],
    ['(فارسی است و در لغت عرب آنرا عربی گیرند)', { arabic: -1 }],
    ['(لاتینی آرکتولاپا ص)', { latin: 1, adjective: -1 }],
    ['(اتباع)', { echo: 1 }],
    ['(از اتباع)', { echo: 1 }],
    ['(ازاتباع)', { echo: 1 }],
    ['(اِ مرکب، از اتباع)', { noun: 1, compound: 1, echo: 1 }],
    ['(ع ص مرکب) (اتباع)', { arabic: 1, adjective: 1, compound: 1, echo: 1 }],
    ['(فعل اتباعی)', { verb: 1, echo: 1 }],
    ['(ع ازاتباع)', { arabic: 1, echo: 1 }],
    ['(از اتباع حیص)', { echo: 1 }],
  ]) check('audited labels retain their intended categories: ' + label, matchesEntryTags(readEntryTags(label), tagFilterMasks(filters)));
  for (const tag of ENTRY_TAGS) {
    check('every tag recognizes its own canonical label: ' + tag.key, !!(readEntryTags('(' + tag.code + ')') & tag.bit));
  }
  check('tag bits are unique and fit the stored 64-bit index', new Set(ENTRY_TAGS.map((tag) => tag.bit)).size === ENTRY_TAGS.length && ENTRY_TAGS.every((tag) => tag.bit > 0n && tag.bit < (1n << 64n)));
  const high = readEntryTags('(ع منادا اتباع)');
  check('64-bit tag storage preserves high and low bits together', new BigUint64Array([high])[0] === high && matchesEntryTags(high, tagFilterMasks({ arabic: 1, vocative: 1, echo: 1 })));
  for (const label of ['(ع (ص))', '(یهودی)', '(زردشتی)', '(اصطلاح فقه)', '(از فرهنگ فارسی معین)']) {
    check('uncertain text is not silently converted into tags: ' + label, readEntryTags(label) === 0n);
  }
}

// Confirmed header typos classify exactly like the intended category; no fuzzy
// matching or source-text replacement is involved.
{
  for (const [raw, canonical] of [
    ['(فرانسسوی، اِ)', '(فرانسوی، اِ)'],
    ['(فرنسه، اِ)', '(فرانسوی، اِ)'],
    ['(ازفرانسسوی، اِ)', '(از فرانسوی، اِ)'],
    ['(مأخوذ ازفرنسه، اِ)', '(مأخوذ از فرانسه، اِ)'],
    ['(ص م رکب)', '(ص مرکب)'],
    ['(اِ م-رکب)', '(اِ مرکب)'],
    ['(فرانسوی، اِ م__رکب)', '(فرانسوی، اِ مرکب)'],
    ['(حرف ربط مرک-ب)', '(حرف ربط مرکب)'],
    ['(ترکیب اضافی، اِ مررکب)', '(ترکیب اضافی، اِ مرکب)'],
    ['(حا مص)', '(حامص)'],
    ['(ص تفصیلی)', '(ص تفضیلی)'],
  ]) {
    check('audited typo has the canonical category mask: ' + raw, readEntryTags(raw) === readEntryTags(canonical));
    check('opening extraction shares the same typo aliases: ' + raw, readOpeningTags(raw).mask === readOpeningTags(canonical).mask);
  }
  for (const [raw, category] of [['(فرانسیس)', 'french'], ['(فرانسوا)', 'french'], ['(ترکیب وصفی، اِ مرکب)', 'turkish']]) {
    check('similar unrelated labels do not acquire an origin: ' + raw, matchesEntryTags(readEntryTags(raw), tagFilterMasks({ [category]: -1 })));
  }
  check('comparative typo repair leaves ordinary prose alone', readEntryTags('توضیح ص تفصیلی') === 0n);
  const fiqh = SENSE_TAGS.find((tag) => tag.key === 'subject-fiqh').id;
  check('split subject prefix remains searchable', readOpeningTags('(اصطلا ح اصول)').facets.includes(fiqh));
}

// Citations, later mentions and missing labels do not imply an origin.
{
  for (const text of ['واژه‌ای از زبان عربی (ع اِ).', '(فرهنگ فارسی معین) واژه.', '(برهان) (ع اِ) واژه.']) {
    check('citations and later labels imply no origin: ' + text, readEntryTags(text) === 0n);
  }
  check('only opening labels contribute metadata', matchesEntryTags(readEntryTags('(اِ) توضیح. (ع ص)'), tagFilterMasks({ noun: 1, arabic: -1, adjective: -1 })));
  check('a later mention of echo words does not tag the entry', matchesEntryTags(readOpeningTags('(اِ) توضیح دربارهٔ اتباع. (اتباع)').mask, tagFilterMasks({ noun: 1, echo: -1 })));
  check('requiring a missing origin rejects the entry', matchesEntryTags(0n, tagFilterMasks({ arabic: 1 })) === false);
  check('excluding a missing origin retains the entry', matchesEntryTags(0n, tagFilterMasks({ arabic: -1 })) === true);
  check('unmarked entries have no inferred Persian label', !ENTRY_TAGS.some((tag) => tag.key === 'persian'));
  check('unset origin conditions impose no restriction', matchesEntryTags(0n, tagFilterMasks({ arabic: 0 })) === true);
}

// Origin and kind choices are real, editable regex lookaheads.
{
  const filters = { arabic: 1, noun: 1, proper: -1 };
  const q = buildSearchQuery('starts', 'ک', filters);
  const { source, flags } = parseSearchQuery(q);
  check('metadata choices generate visible regex assertions', source.includes('(?=') && source.includes('(?!') && source.includes('\\(ع\\)'));
  const regex = new RegExp(source, flags);
  check('required metadata matches the entry', regex.test('کتاب\n' + entryTagText(readEntryTags('(ع اِ)'))));
  check('missing required metadata rejects the entry', !regex.test('کتاب\n' + entryTagText(readEntryTags('(اِ)'))));
  check('excluded metadata rejects the entry', !regex.test('کتاب\n' + entryTagText(readEntryTags('(ع اِخ)'))));
  check('metadata conditions retain the word predicate', !regex.test('خاطره\n' + entryTagText(readEntryTags('(ع اِ)'))));
  const reopened = readSearchBuilder(q);
  check('tagged queries reopen their word pattern', reopened.query.source === '^ک');
  check('tagged queries reopen their conditions', isDeepStrictEqual(reopened.filters, filters));
  const cleared = parseSearchQuery(buildSearchQuery('regex', reopened.query.source, {}, reopened.query.flags));
  check('clearing metadata preserves the word pattern', cleared.source === '^ک');
  check('cleared metadata removes the tagged matcher', !isTaggedPattern(cleared.source));
  check('excluded metadata can be searched without text', isTaggedPattern(parseSearchQuery(buildSearchQuery('starts', '', { arabic: -1 })).source));
  const exact = parseSearchQuery(buildSearchQuery('exact', 'کتاب', filters));
  check('tagged literal phrases match the literal word', new RegExp(exact.source, exact.flags).test('کتاب\n(ع) (اِ)'));
  check('tagged literal phrases allow longer words', new RegExp(exact.source, exact.flags).test('کتابخانه\n(ع) (اِ)'));
  const whole = parseSearchQuery(buildSearchQuery('whole', 'کتاب', filters));
  check('tagged whole-text rules reject longer words', !new RegExp(whole.source, whole.flags).test('کتابخانه\n(ع) (اِ)'));
  const ending = parseSearchQuery(buildSearchQuery('ends', 'تاب', filters));
  check('tagged suffixes retain end anchoring', new RegExp(ending.source, ending.flags).test('کتاب\n(ع) (اِ)'));
  for (const tag of ENTRY_TAGS) {
    for (const state of [1, -1]) {
      const built = parseSearchQuery(buildTaggedQuery('/.*/', { [tag.key]: state }));
      const re = new RegExp(built.source, built.flags);
      check('required and excluded labels match their selected states: ' + tag.key, re.test('واژه\n' + entryTagText(tag.bit)) === (state === 1));
      check('missing labels match their selected states: ' + tag.key, re.test('واژه\n') === (state === -1));
    }
  }
}

// Indexed tag checks preserve the visible regex, offsets and metadata context.
{
  const noOrigins = Object.fromEntries(ENTRY_TAGS.filter((tag) => tag.group === 'origin').map((tag) => [tag.key, -1]));
  const onlyTags = readHeadwordRegex(parseSearchQuery(buildTaggedQuery('/.*/', noOrigins)));
  check('excluding every origin plans a tag-only search', onlyTags.tagOnly && !onlyTags.metadata);
  check('origin exclusions leave unmarked kinds eligible', matchesEntryTags(readEntryTags('(اِ)'), tagFilterMasks(onlyTags.filters)));
  check('ordinary regexes retain their existing execution path', readHeadwordRegex(parseSearchQuery('/^یاد/')) === null);
  const rules = [
    ['starts', 'یاد'], ['ends', 'گار'], ['contains', 'یاد'], ['excludes', 'یاد'],
    ['not-starts', 'یاد'], ['not-ends', 'گار'], ['whole', 'یاد'], ['exact', ' book '],
    ['either', 'یاد، کتاب'], ['letters', 'یاد'], ['wildcard', 'ی*د'], ['length', '۳'],
    ['regex', 'یاد(?=\\n)'], ['regex', 'یاد(?=[\\s\\S]*\\(ع\\))'],
  ];
  const samples = ['یاد', 'یادگار', 'به یاد', 'کتاب', ' book ', 'Book', 'یَاد', 'یاد\u2028گار'];
  for (const flags of ['u', 'iu', 'su']) {
    for (const [kind, value] of rules) {
      const query = parseSearchQuery(buildSearchQuery(kind, value, { arabic: 1, proper: -1 }, flags));
      const plan = readHeadwordRegex(query);
      const original = new RegExp(query.source, query.flags);
      const optimized = new RegExp(plan.query.source, plan.query.flags);
      let same = true;
      for (const mask of [0n, readEntryTags('(ع اِ)'), readEntryTags('(ع اِخ)')]) {
        for (const word of samples) {
          const text = word + '\n' + entryTagText(mask);
          const before = original.exec(text);
          const after = matchesEntryTags(mask, tagFilterMasks(plan.filters)) ? optimized.exec(plan.metadata ? text : word) : null;
          same &&= before?.index === after?.index && before?.[0] === after?.[0];
        }
      }
      check('indexed tags preserve ' + kind + ' matches and offsets with ' + flags, same);
    }
  }
  const groups = [{ match: 'all', rules: [{ kind: 'starts', value: 'یاد' }, { kind: 'ends', value: 'گار' }] }];
  const combined = readHeadwordRegex(parseSearchQuery(buildCombinedQuery(groups, 'any', noOrigins)));
  check('combined helpers execute without a metadata line', !combined.metadata && !isTaggedPattern(combined.query.source));
  check('combined helpers retain both word conditions', new RegExp(combined.query.source, combined.query.flags).test('یادگار') && !new RegExp(combined.query.source, combined.query.flags).test('یادبود'));
  const custom = readHeadwordRegex(parseSearchQuery(buildTaggedQuery('/یاد(?=\\n)/', { arabic: -1 })));
  check('custom regexes retain their metadata-line context', custom.metadata && !custom.query.source.includes('\\(ع\\)'));
  const withoutM = parseSearchQuery(buildSearchQuery('whole', 'یاد', { arabic: 1 }));
  const plan = readHeadwordRegex({ ...withoutM, flags: 'u' });
  check('custom removal of multiline mode preserves the two-line context', plan.metadata && !new RegExp(plan.query.source, plan.query.flags).test('یاد\n(ع)'));
  const long = readHeadwordRegex(parseSearchQuery(buildTaggedQuery('/^.{101}$/', { arabic: -1 })));
  check('raw regex lengths retain ranges outside helper limits', !long.metadata && long.query.source === '^.{101}$');
  const folded = readHeadwordRegex(parseSearchQuery(buildSearchQuery('starts', 'ياد', { arabic: -1 })));
  check('headword tag planning preserves raw letter variants', folded.query.source === '^ياد' && !new RegExp(folded.query.source, folded.query.flags).test('یادگار'));
  const positive = parseSearchQuery(buildTaggedQuery('/.*/', { arabic: 1 }));
  const negative = parseSearchQuery(buildTaggedQuery('/.*/', { arabic: -1 }));
  const repeated = { ...positive, source: negative.source.slice(0, negative.source.indexOf('(?:')) + positive.source };
  check('conflicting repeated tag assertions retain raw regex semantics', readHeadwordRegex(repeated) === null);
}

// Indexed query planning retains literal spaces and only targets fixed prefixes.
{
  check('quoted final fragments use a prefix lookup', isDeepStrictEqual(quotedIndexTerms('book do'), [{ token: 'do', prefix: true }]));
  check('quoted trailing spaces require complete indexed terms', isDeepStrictEqual(quotedIndexTerms('book do '), [{ token: 'do', prefix: false }]));
  check('quoted leading spaces retain the first complete term', isDeepStrictEqual(quotedIndexTerms(' book do '), [{ token: 'book', prefix: false }, { token: 'do', prefix: false }]));
  check('unindexed single letters have no phrase seed', quotedIndexTerms('و').length === 0);
  const prefix = readMeaningRegex(parseSearchQuery('/^ياد/'));
  check('indexed regex folds literal letter variants', prefix.query.source === '^یاد');
  check('index prefix selection follows the normalized query', isDeepStrictEqual(prefix.prefixes, ['یاد']));
  check('indexed regex folds literal Persian digits', readMeaningRegex(parseSearchQuery('/۲۱/')).query.source === '21');
  check('indexed regex folds literal ZWNJ', readMeaningRegex(parseSearchQuery('/هم‌دل/')).query.source === 'همدل');
  check('indexed regex preserves explicit regex escapes', readMeaningRegex(parseSearchQuery('/^\\p{L}+$/u')).query.source === '^\\p{L}+$');
  check('unanchored regex retains the whole token vocabulary', readMeaningRegex(parseSearchQuery('/گار$/')).prefixes === null);
}

// Subjects and usage labels describe the same sense, with independent grammar.
{
  for (const [label, key] of [['(ص نسبی)', 'relative-adjective'], ['(اِمصغر)', 'diminutive'], ['(نف مرخم)', 'shortened']]) {
    check('grammatical refinement is independently searchable: ' + key, matchesEntryTags(readEntryTags(label), tagFilterMasks({ [key]: 1 })));
  }
  const id = (key) => SENSE_TAGS.find((tag) => tag.key === key).id;
  for (const tag of SENSE_TAGS.filter((tag) => !tag.aliasOf)) {
    check('sense label recognizes its canonical spelling: ' + tag.key, readOpeningTags('(' + tag.code + ')').facets.includes(tag.id));
    const built = buildSearchQuery('starts', 'یاد', { [tag.key]: 1 });
    check('sense filter remains visible and reopens: ' + tag.key, readSearchBuilder(built).filters[tag.key] === 1 && built.includes(tag.code));
  }
  for (const label of ['(اصطلاح طب)', '(در اصطلاح پزشکی)', '(اِ، اصطلاح پزشکی)', '(اصطلاح تشریح)', '(اصطلاح علم تشریح)']) {
    check('medical aliases share a subject category: ' + label, readOpeningTags(label).facets.includes(id('subject-medicine')));
  }
  const anatomy = id('subject-anatomy');
  const medicine = id('subject-medicine');
  check('anatomy produces only the medicine badge', isDeepStrictEqual(readOpeningTags('(اصطلاح تشریح)').facets, [medicine]));
  check('anatomy has no independent filter choice', !SEARCH_FILTER_TAGS.some((tag) => tag.key === 'subject-anatomy'));
  check('finding anatomy in the menu leads to medicine', SEARCH_FILTER_TAGS.find((tag) => tag.key === 'subject-medicine').names.includes('تشریح'));
  check('retiring anatomy preserves subsequent index IDs', anatomy === 16 && id('subject-geography') === 17);
  check('old anatomy metadata uses the medicine name once', senseTagText([anatomy, medicine]) === '(اصطلاح پزشکی)');
  const legacyFilters = { 'subject-anatomy': 1, arabic: -1 };
  check('old anatomy filters migrate without mutating their input', isDeepStrictEqual(normalizeSenseFilters(legacyFilters), { 'subject-medicine': 1, arabic: -1 }) && legacyFilters['subject-anatomy'] === 1);
  check('an explicit medicine choice takes precedence over a retired choice', isDeepStrictEqual(normalizeSenseFilters({ 'subject-anatomy': 1, 'subject-medicine': -1 }), { 'subject-medicine': -1 }));
  const oldQuery = buildSearchQuery('starts', 'یاد', { 'subject-medicine': 1 }).replace('پزشکی', 'تشریح');
  check('saved anatomy patterns reopen as medicine', isDeepStrictEqual(readSearchBuilder(oldQuery).filters, { 'subject-medicine': 1 }));
  check('saved anatomy patterns migrate to independent medicine filters', isDeepStrictEqual(separateSearchFilters(oldQuery).filters, { 'subject-medicine': 1 }));
  const legacyRows = [[0, 0, 0, 20, [anatomy]], [1, 0, 0, 20, [medicine]], [2, 0, 0, 20, [id('subject-geography')]]];
  check('medicine includes old anatomy rows', isDeepStrictEqual([...planSenseFilters(legacyRows, { 'subject-medicine': 1 }, 3, 0).entries], [1, 1, 0]));
  check('excluding medicine also excludes old anatomy rows', isDeepStrictEqual([...planSenseFilters(legacyRows, { 'subject-medicine': -1 }, 3, 0).entries], [0, 0, 1]));
  check('grammar can follow a subject header', matchesEntryTags(readOpeningTags('(اصطلاح منطق) (اِ)').mask, tagFilterMasks({ noun: 1 })));
  check('citations stop subject extraction', !readOpeningTags('(ناظم الاطباء) (اصطلاح طب)').facets.length);
  check('later prose does not introduce a header tag', !readOpeningTags('توضیح (اصطلاح طب)').facets.length);
  const body = '(اِ) آغاز\x01(اصطلاح طب) دارو\x01(بمجاز) سخن';
  const senses = splitSenses(body);
  check('later senses retain their own subjects', senses.length === 3 && !senses[0].facets.length && senses[1].facets.includes(id('subject-medicine')));
  check('a subject does not leak into the following sense', !senses[2].facets.includes(id('subject-medicine')) && senses[2].facets.includes(id('figurative')));
  const introduction = splitSenses('(اِ)\x01(اصطلاح طب) دارو');
  check('a grammar-only introduction is not an unlabelled sense', introduction.length === 1 && introduction[0].facets.includes(id('subject-medicine')));
  const rows = senses.map((sense) => [0, sense.phrase, sense.start, sense.end, sense.facets]);
  const cross = planSenseFilters(rows, { 'subject-medicine': 1, figurative: 1 }, 1, 0);
  check('positive facets must coexist in one sense', !cross.entries[0] && !cross.allowed.some(Boolean));
  const excluded = planSenseFilters(rows, { 'subject-medicine': -1 }, 2, 0);
  check('exclusions retain another unlabelled sense', excluded.entries[0] === 1 && !excluded.allowed[1]);
  check('entries absent from sparse metadata satisfy exclusions', excluded.entries[1] === 1);
  const cited = splitSenses('(اِ) متن\x02نقل \x01 (اصطلاح طب)\x03 پایان');
  check('sense markers inside citations are ignored', cited.length === 1 && !cited[0].facets.length);
  const compound = splitSenses('(اِ) متن\x04\x05ترکیب\x06 ؛ (اصطلاح طب) دارو\x01(بمجاز) سخن', new Map([['ترکیب', 2]]));
  check('compound senses retain independent ownership', compound.length === 3 && compound[1].phrase === 3 && compound[2].phrase === 3 && compound[1].facets.includes(id('subject-medicine')));
  const unlisted = splitSenses('(اِ) متن\x05ترکیب بلند\x06 ؛ (اصطلاح طب) دارو');
  const unlistedRows = unlisted.map((sense) => [0, sense.phrase, sense.start, sense.end, sense.facets]);
  const unlistedPlan = planSenseFilters(unlistedRows, { 'subject-medicine': 1 }, 1, 0);
  check('unindexed compounds do not label the main headword', !unlistedPlan.entries[0] && unlistedPlan.allowed[1] === 1);
  const query = parseSearchQuery(buildSearchQuery('starts', 'یاد', { arabic: 1, 'subject-medicine': 1, figurative: -1 }));
  const expression = new RegExp(query.source, query.flags);
  const tagText = entryTagText(readEntryTags('(ع اِ)')) + ' ' + senseTagText([id('subject-medicine')]);
  check('combined origin and subject conditions are real regex', expression.test('یاد\n' + tagText));
  check('visible regex also enforces excluded usage', !expression.test('یاد\n' + tagText + ' ' + senseTagText([id('figurative')])));
}

// Source recognition requires explicit citations, and preserves compound ownership.
{
  const id = (key) => SOURCE_TAGS.find((tag) => tag.key === key).id;
  check('source aliases and page numbers share one category', isDeepStrictEqual(readSources('(برهان) (از برهان قاطع، ص ۲۱)'), [id('source-burhan')]));
  check('joined source prefixes and normalized Arabic letters are accepted', isDeepStrictEqual(readSources('(ازمنتهی الارب) (ناظم الاطباء)'), [id('source-nazem'), id('source-montaha')]));
  check('multiple explicit references in one parenthesis are retained', readSources('(برهان و آنندراج)').length === 2);
  check('marked book citations remain identifiable', isDeepStrictEqual(readSources('\x02فرهنگ فارسی معین\x03'), [id('source-moein')]));
  check('prose, poet names and similar names are not source tags', readSources('برهان قاطع نام کتاب است. (غیاث الدین) (برهان قاطع کتابی است) \x02فردوسی\x03').length === 0);
  const body = '(اِ) متن (برهان)\x01معنی دیگر (آنندراج)\x04\x05ترکیب\x06 ؛ متن (ناظم الاطباء)';
  const owners = sourceOwners(body, splitSenses(body, new Map([['ترکیب', 0]])));
  check('main entry source badges combine its own meanings', isDeepStrictEqual([...owners.get(0)], [id('source-burhan'), id('source-anandraj')]));
  check('compound-only citations do not label their parent', isDeepStrictEqual([...owners.get(1)], [id('source-nazem')]) && !owners.get(0).has(id('source-nazem')));
  const encoded = new Map();
  const postings = SOURCE_TAGS.map(() => []);
  postings[0] = [300, 0, 128];
  const written = writeSourceIndex(postings, (name, bytes) => { encoded.set(name, bytes); return bytes.length; });
  check('source owner deltas round-trip across varint boundaries', isDeepStrictEqual([...decodeSourceOwners(encoded.get('r/0.txt'), 301, 3)], [0, 128, 300]));
  check('source index rejects truncated or mismatched postings', decodeSourceOwners(encoded.get('r/0.txt').slice(0, -1), 301, 3) === null && decodeSourceOwners(encoded.get('r/0.txt'), 301, 2) === null);
  check('source writer reports exact posting counts', written.postingCount === 3 && written.counts[0] === 3);
  const oldIds = ['source-burhan', 'source-anandraj', 'source-nazem', 'source-montaha', 'source-aqrab', 'source-ghiyas', 'source-rashidi', 'source-jahangiri', 'source-anjoman', 'source-nezam', 'source-moein', 'source-dehar', 'source-qamus-alam', 'source-qamus-bible'];
  check('expanding the source catalog preserves all original on-disk IDs', isDeepStrictEqual(SOURCE_TAGS.slice(0, oldIds.length).map((tag) => tag.key), oldIds));
  const aliases = SOURCE_TAGS.flatMap((tag) => tag.names);
  check('normalized source aliases remain unambiguous across categories', new Set(aliases).size === aliases.length);
  for (const raw of ['(شعوری)', '(از شعوری)', '(فرهنگ شعوری)', '(لسان العجم شعوری ج ۲ ص۱۲)', '(شعوری ورق۲۹)', '(شعوری ایضاً)']) {
    check('audited Shoori references share the same category: ' + raw, isDeepStrictEqual(readSources(raw), [id('source-shoori')]));
  }
  const pair = readSources('(کلیله و دمنه و شعوری)');
  check('source lists preserve titles that contain conjunctions', pair.length === 2 && pair.includes(id('source-kalila')) && pair.includes(id('source-shoori')));
  const chain = readSources('(شعوری از مجمعالفرس)');
  check('chained citations retain both explicitly named sources', chain.length === 2 && chain.includes(id('source-shoori')) && chain.includes(id('source-majma-fors')));
  check('source names in explanatory prose are not guessed', readSources('(شعوری دربارهٔ لغت نوشته است) (فرهنگ شعوری کتابی است) (شعوریان)').length === 0);
  check('book commentaries keep their own source category', isDeepStrictEqual(readSources('(حاشیهٔ برهان چ معین ص۱۲)'), [id('source-burhan-notes')]));
  check('source notes are recognized separately from printed works', isDeepStrictEqual(readSources('(یادداشت به خط مرحوم دهخدا)'), [id('source-author-notes')]));
}

// Global counts use searchable owners, not repeated senses or citation counts.
{
  const medicine = SENSE_TAGS.find((tag) => tag.key === 'subject-medicine').id;
  const figurative = SENSE_TAGS.find((tag) => tag.key === 'figurative').id;
  const entries = new BigUint64Array([readEntryTags('(ع اِ اتباع)'), readEntryTags('(اِ)')]);
  const phrases = [readEntryTags('(ع ص)'), readEntryTags('(اِ اتباع)')];
  const rows = [[0, 0, 0, 20, [medicine]], [0, 0, 20, 40, [medicine, figurative]],
    [0, 1, 40, 60, [medicine]], [0, 1, 60, 80, [medicine]], [0, 2, 80, 100, [medicine]], [1, -1, 0, 20, [figurative]]];
  const counts = countTags(entries, phrases, rows);
  check('tag counts combine distinct main words and compounds', counts.arabic === 2 && counts.noun === 3 && counts.adjective === 1);
  check('tag counts preserve the highest unsigned tag bit', counts.echo === 2);
  check('repeated senses do not inflate global facet counts', counts['subject-medicine'] === 3 && counts.figurative === 1);
  check('unused tags have a real zero count', counts['subject-law'] === 0 && counts.french === 0);
  check('tag counting never modifies stored owner masks', entries[0] === readEntryTags('(ع اِ اتباع)'));
  const anatomy = SENSE_TAGS.find((tag) => tag.key === 'subject-anatomy').id;
  const merged = countTags(entries, phrases, [...rows, [0, 0, 100, 120, [anatomy]], [1, 0, 0, 20, [anatomy, medicine]]]);
  check('merged medicine counts deduplicate old anatomy owners', merged['subject-medicine'] === 4);
  check('retired anatomy has no separate count', !Object.hasOwn(merged, 'subject-anatomy'));
}

function fixture(options = {}) {
  const words = options.words || ['یاد', 'یادگار', 'کتاب', 'به یاد آوردن', 'خاطره', 'پراکنده', 'مرز', 'هم‌دل', 'Book', 'بوفه'];
  const phrases = options.phrases || ['از یاد بردن', 'به یاد آوردن'];
  const bodies = options.bodies || [
    '(اِ) خاطر و حافظه', '(ص مرکب، اِ مرکب) خاطره و نشانه', '(ع اِ) یادگار مکتوب', '(مص مرکب) یاد آوردن',
    '(ع اِ) از یادِ آوردن و یاد سخن گفت', '(ص) آوردن چیزی به یاد', '(اِخ) بیادآوردن و یادگار', '(ص مرکب) دوست هم‌دل', 'A printed book ۲۱', '(فرانسوی، اِ) میز خوراک ' + 'توضیح '.repeat(510) + 'پایان ویژه',
  ];
  const phraseBodies = options.phraseBodies || ['بدون برچسب.', '؛ \x0eبِ\x0f (مص مرکب) توضیح.'];
  const phraseParents = options.phraseParents || new Array(phrases.length).fill(0);
  const stopwords = options.stopwords || ['و', 'به'];
  const records = bodies.map((body) => `\x1f${body}`).join('\x1e');
  const charset = [...new Set(records)].join('');
  const encode = (text) => Uint8Array.from([...text].map((ch) => charset.indexOf(ch)));
  const varint = (value) => {
    const out = [];
    do {
      const byte = value & 127;
      value = Math.floor(value / 128);
      out.push(byte | (value ? 128 : 0));
    } while (value);
    return out;
  };
  const postings = new Map();
  bodies.forEach((body, id) => {
    const indexed = body.replace(/\x02[^\x03]*\x03/g, ' ').replace(/\([^()\n]{0,40}\)/g, ' ');
    for (const token of new Set(tokenize(indexed).slice(0, 500))) {
      if (stopwords.includes(token)) continue;
      if (!postings.has(token)) postings.set(token, []);
      postings.get(token).push(id);
    }
  });
  const groups = new Map();
  for (const [token, ids] of postings) {
    const key = options.splitIndex ? token[0] : '';
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key).set(token, ids);
  }
  const encodeShard = (terms) => {
    const header = varint(terms.size);
    const payload = [];
    for (const [token, ids] of terms) {
      const bytes = new TextEncoder().encode(token);
      let prev = 0;
      const deltas = ids.flatMap((id) => {
        const out = varint((id - prev) * 16 + 5);
        prev = id;
        return out;
      });
      header.push(...varint(bytes.length), ...bytes, ...varint(ids.length), ...varint(deltas.length));
      payload.push(...deltas);
    }
    return new Uint8Array([...header, ...payload]);
  };
  const shardKeys = [...groups.keys()].map((key, id) => [key, id]);
  const senseRows = [];
  const sourceSenseRows = [];
  let sourceCompoundEntries = 0;
  bodies.forEach((body, id) => {
    const names = new Map(phrases.flatMap((word, index) => phraseParents[index] === id ? [[normalizeCompact(word), index]] : []));
    names.set(normalizeCompact(words[id]), -1);
    const senses = splitSenses(body, names);
    const citedCompound = [...sourceOwners(body, senses)].some(([owner]) => owner > 0);
    if (citedCompound) sourceCompoundEntries++;
    if (senses.some((sense) => sense.facets.length)) {
      for (const sense of senses) senseRows.push([id, sense.phrase, sense.start, sense.end, sense.facets]);
    } else if (citedCompound || options.completeCompounds && senses.some((sense) => sense.phrase !== 0)) {
      for (const sense of senses) sourceSenseRows.push([id, sense.phrase, sense.start, sense.end, sense.facets]);
    }
  });
  const scopePostings = (rows) => {
    const postings = new Map();
    let previous = -1;
    let consumed = 0;
    rows.forEach(([id, , start, end], sense) => {
      if (id !== previous) { previous = id; consumed = 0; }
      const text = bodies[id].slice(start, end).replace(/\x02[^\x03]*\x03/g, ' ').replace(/\([^()\n]{0,40}\)/g, ' ');
      const tokens = tokenize(text);
      const skip = options.completeCompounds ? scopedTokens(bodies[id].slice(start, end)).skip : 0;
      const indexed = tokens.slice(skip, Math.max(skip, 500 - consumed));
      consumed += tokens.length;
      for (const token of new Set(indexed)) {
        if (stopwords.includes(token)) continue;
        if (!postings.has(token)) postings.set(token, []);
        postings.get(token).push(sense, 0);
      }
    });
    return postings;
  };
  const senseFiles = [];
  const senseIndex = writeTokenShards(scopePostings(senseRows), (name, data) => { senseFiles.push([name, data]); return data.length; }, 's');
  const sourceSenseFiles = [];
  const sourceSenseIndex = sourceSenseRows.length ? writeTokenShards(scopePostings(sourceSenseRows), (name, data) => { sourceSenseFiles.push([name, data]); return data.length; }, 'u') : { shardKeys: [] };
  const sourcePostings = SOURCE_TAGS.map(() => []);
  bodies.forEach((body, id) => {
    const names = new Map(phrases.flatMap((word, index) => phraseParents[index] === id ? [[normalizeCompact(word), index]] : []));
    names.set(normalizeCompact(words[id]), -1);
    for (const [owner, sources] of sourceOwners(body, splitSenses(body, names))) {
      if (owner < 0) continue;
      for (const source of sources) sourcePostings[source].push(owner === 0 ? id : words.length + owner - 1);
    }
  });
  phraseBodies.forEach((body, id) => {
    if (id >= phrases.length) return;
    for (const source of readSources(body)) {
      const owner = words.length + id;
      if (!sourcePostings[source].includes(owner)) sourcePostings[source].push(owner);
    }
  });
  const sourceFiles = [];
  const sourceIndex = writeSourceIndex(sourcePostings, (name, data) => { sourceFiles.push([name, data]); return data.length; });
  const tagCounts = countTags(bodies.map((body) => readOpeningTags(body).mask), phraseBodies.slice(0, phrases.length).map((body) => readOpeningTags(body).mask), senseRows);
  return new Map([
    ['meta.json', JSON.stringify({ entries: words.length, phrases: phrases.length, tagCountsVersion: TAG_COUNTS_VERSION, tagCounts, tagVersion: TAG_VERSION, sourceVersion: SOURCE_VERSION, sourceCounts: sourceIndex.counts, sourceCompoundEntries, sourceSenseRows: sourceSenseRows.length, sourceSenseShardKeys: sourceSenseIndex.shardKeys, ...(options.completeCompounds ? { compoundScopeVersion: 1 } : {}), senseVersion: SENSE_VERSION, senseRows: senseRows.length, senseShardKeys: senseIndex.shardKeys, charset, stopwords, blockStarts: bodies.map((_, id) => id), shardKeys, shards: groups.size, build: 'fixture' })],
    ['words.txt', words.join('\n')],
    ['phrases.txt', phrases.join('\n')],
    ['phrase-parents.txt', new Uint32Array(phraseParents)],
    ['entry-tags.txt', new BigUint64Array(bodies.map((body) => readOpeningTags(body).mask))],
    ['phrase-tags.txt', new BigUint64Array(phraseBodies.map((body) => readOpeningTags(body).mask))],
    ['sense-meta.txt', JSON.stringify(senseRows)],
    ...senseFiles,
    ...sourceFiles,
    ...sourceSenseFiles,
    ...(sourceSenseRows.length ? [['source-senses.txt', JSON.stringify(sourceSenseRows)]] : []),
    ...bodies.map((body, id) => [`m/${id}.txt`, encode(`\x1f${body}`)]),
    ...[...groups.values()].map((terms, id) => [`t/${id}.txt`, encodeShard(terms)]),
  ]);
}


const files = fixture();
const fetched = [];
globalThis.fetch = async (url) => {
  const name = new URL(url).pathname.split('/data/')[1];
  fetched.push(name);
  return new Response(files.get(name), { status: files.has(name) ? 200 : 404 });
};
globalThis.Worker = BrowserWorker;
globalThis.self = globalThis;
const replies = new Map();
const progressReplies = new Map();
let seq = 0;
globalThis.postMessage = (message) => {
  if (message.progress) {
    progressReplies.get(message.id)?.(message.progress);
    return;
  }
  const reply = replies.get(message.id);
  replies.delete(message.id);
  progressReplies.delete(message.id);
  reply?.(message);
};
await import('../www/js/search.worker.js');
const call = (type, payload, onProgress) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    if (onProgress) progressReplies.set(id, onProgress);
    replies.set(id, (m) => (m.error ? reject(new Error(m.error)) : resolve(m.result)));
    self.onmessage({ data: { id, type, payload } });
  });
await call('init');

// Opening the filter menu reads metadata only, including with older data builds.
{
  const before = fetched.length;
  const counts = await call('filterCounts');
  check('filter totals count searchable words and compounds', counts.total === 12 && counts.counts.arabic === 2);
  check('known zero counts stay distinct from unavailable counts', counts.counts['source-shoori'] === 0 && counts.counts['subject-law'] === 0);
  check('loading menu counts fetches no tag indexes or definitions', fetched.length === before);
  const original = files.get('meta.json');
  const meta = JSON.parse(original);
  delete meta.tagCountsVersion;
  meta.sourceCounts = meta.sourceCounts.slice(0, 14);
  files.set('meta.json', JSON.stringify(meta));
  await import('../www/js/search.worker.js?older-filter-counts');
  await call('init');
  const older = await call('filterCounts');
  check('old builds leave unavailable totals unknown instead of zero', older.counts.arabic === undefined && older.counts['source-shoori'] === undefined);
  check('old builds still expose existing source totals', older.counts['source-burhan'] === 0);
  files.set('meta.json', original);
  await import('../www/js/search.worker.js?restored-filter-counts');
  await call('init');
}

// Anatomy belongs to medicine in both new builds and existing sense indexes.
{
  const backup = new Map(files);
  const medicine = SENSE_TAGS.find((tag) => tag.key === 'subject-medicine').id;
  const anatomy = SENSE_TAGS.find((tag) => tag.key === 'subject-anatomy').id;
  const filters = { 'subject-medicine': 1 };
  const bodies = ['(اصطلاح تشریح) درمان بدن (برهان)', '(اصطلاح پزشکی) درمان بدن',
    '(اصطلاح جغرافیا) درمان زمین', '(اِ) درمان روزمره',
    '(اِ) درمان عمومی\x04\x05ترکیب تشریح\x06 ؛ (اصطلاح تشریح) درمان پیکر (برهان)'];
  try {
    for (const version of [SENSE_VERSION, 2]) {
      files.clear();
      for (const [name, data] of fixture({ words: ['تشریحی', 'پزشکی', 'جغرافیایی', 'عادی', 'ترکیب دار'], bodies,
        phrases: ['ترکیب تشریح'], phraseParents: [4], phraseBodies: ['(اصطلاح تشریح) درمان پیکر (برهان)'] })) files.set(name, data);
      if (version === 2) {
        const rows = JSON.parse(files.get('sense-meta.txt'));
        for (const row of rows) if (row[0] === 0 || row[0] === 4 && row[1] > 0) row[4] = row[4].map((id) => id === medicine ? anatomy : id);
        files.set('sense-meta.txt', JSON.stringify(rows));
        const meta = JSON.parse(files.get('meta.json'));
        meta.senseVersion = version;
        meta.tagCounts['subject-medicine'] = 1;
        meta.tagCounts['subject-anatomy'] = 2;
        files.set('meta.json', JSON.stringify(meta));
      }
      await import('../www/js/search.worker.js?anatomy-merge-' + version);
      await call('init');
      const before = fetched.length;
      const counts = (await call('filterCounts')).counts;
      check('medicine totals use the combined count or stay unknown for old builds: ' + version, version === 2 ? counts['subject-medicine'] === undefined : counts['subject-medicine'] === 3);
      check('anatomy counts are retired without extra data requests: ' + version, counts['subject-anatomy'] === undefined && fetched.length === before);
      const head = (await call('search', { q: '', filters })).head;
      check('medicine headword filtering includes anatomy and its compounds: ' + version, head.length === 3 && head.some((row) => row.id === 0) && head.some((row) => row.id === 1) && head.some((row) => row.id === 4 && row.phrase));
      for (const q of ['درمان', '"درمان"', '/^درمان$/']) {
        const result = await call('meanings', { q, filters, exclude: [] });
        check('medicine includes anatomical meaning matches: ' + version + ' ' + q, isDeepStrictEqual(result.results.map((row) => row.id).sort(), [0, 1, 4]));
      }
      const phrase = await call('meanings', { q: '"درمان بدن"', filters, exclude: [] });
      check('quoted medical phrases include anatomical senses: ' + version, isDeepStrictEqual(phrase.results.map((row) => row.id).sort(), [0, 1]));
      const excluded = await call('meanings', { q: 'درمان', filters: { 'subject-medicine': -1 }, exclude: [] });
      check('medicine exclusions remove anatomical senses while retaining unlabelled senses: ' + version, isDeepStrictEqual(excluded.results.map((row) => row.id).sort(), [2, 3, 4]));
      const sources = await call('meanings', { q: 'درمان', filters: { ...filters, 'source-burhan': 1 }, exclude: [] });
      check('merged anatomy filtering composes with source ownership: ' + version, isDeepStrictEqual(sources.results.map((row) => row.id).sort(), [0, 4]));
      const legacy = await call('search', { q: '', filters: { 'subject-anatomy': 1 } });
      check('old anatomy selections use the combined medicine category: ' + version, isDeepStrictEqual(legacy.head, head));
      check('anatomy classification preserves original dictionary content: ' + version, (await call('entry', { id: 0 })).body === bodies[0]);
    }
  } finally {
    files.clear();
    for (const [name, data] of backup) files.set(name, data);
    await import('../www/js/search.worker.js?restored-anatomy-merge');
    await call('init');
  }
}

// Headwords retain quoted substring matching and raw regex offsets.
{
  const plain = await call('search', { q: 'یاد' });
  check('plain search ranks the exact entry first', plain.head[0].w === 'یاد');
  const quoted = await call('search', { q: '"یاد"' });
  check('quotes include longer headwords', quoted.head.some((row) => row.w === 'یادگار'));
  check('quoted Arabic kaf is normalized', (await call('search', { q: '«كتاب»' })).head.some((row) => row.w === 'کتاب'));
  const regex = await call('search', { q: '/^یاد/' });
  check('headword regex retains raw matching', isDeepStrictEqual(regex.head.map((row) => row.w), ['یاد', 'یادگار']));
  check('headword regex returns original offsets', isDeepStrictEqual(regex.head[1].match, { start: 0, end: 3 }));
  check('headword regex searches compounds', (await call('search', { q: '/بردن$/' })).head.some((row) => row.phrase));
}

// Single quoted words and regex lookup never fetch definitions.
{
  const before = fetched.length;
  const plain = await call('meanings', { q: 'یاد', exclude: [] });
  const quoted = await call('meanings', { q: '"یاد"', exclude: [] });
  check('quoted words reuse the ordinary index result', isDeepStrictEqual(quoted.results, plain.results));
  check('quoted words find longer indexed words', quoted.results.some((row) => row.w === 'کتاب'));
  check('quoted word results load snippets lazily', quoted.results.every((row) => !row.snippet));
  const missing = await call('meanings', { q: '"گمشده"', exclude: [] });
  check('missing quoted words return immediately from the index', missing.results.length === 0);
  const common = await call('meanings', { q: '"به"', exclude: [] });
  check('quoted stop words do not trigger broader prefix lookup', common.unindexed && common.results.length === 0);
  const regex = await call('meanings', { q: '/گار$/', exclude: [] });
  check('regex anchors apply to indexed words', isDeepStrictEqual(regex.results.map((row) => row.w).sort(), ['کتاب', 'مرز'].sort()));
  check('regex results retain the matched indexed word', regex.results.every((row) => row.terms.includes('یادگار')));
  check('word and regex lookup fetch no definition blocks', !fetched.slice(before).some((file) => file.startsWith('m/')));
  check('lookup needs no separate regex index', !fetched.some((file) => file.startsWith('g/')));
  check('indexed regex accepts literal Persian numerals', isDeepStrictEqual((await call('meanings', { q: '/۲۱/', exclude: [] })).results.map((row) => row.w), ['Book']));
  const snippets = await call('snippets', { ids: [2], terms: [], literal: 'یاد' });
  check('lazy quoted snippets show the actual literal match', snippets[0].text.slice(snippets[0].match.start, snippets[0].match.end) === 'یاد');
  const terms = await call('snippets', { exact: true, requests: [{ key: 'regex-word', id: 2, terms: ['یادگار'] }] });
  check('regex snippets locate each results matched word', terms[0].text.includes('یادگار'));
}

// Quotes verify adjacency and literal spaces only in indexed candidates.
{
  let before = fetched.length;
  const missing = await call('meanings', { q: '"یاد گمشده"', exclude: [] });
  check('missing phrase terms do not fall back to partial matches', missing.results.length === 0);
  check('missing phrase terms load no definitions', !fetched.slice(before).some((file) => file.startsWith('m/')));
  const phrase = await call('meanings', { q: '"یاد آوردن"', exclude: [] });
  check('quoted phrases verify order and adjacency', isDeepStrictEqual(phrase.results.map((row) => row.w).sort(), ['به یاد آوردن', 'خاطره'].sort()));
  check('verified phrases include matched snippets', phrase.results.every((row) => row.snippet.text.slice(row.snippet.match.start, row.snippet.match.end).replace(/ِ/g, '') === 'یاد آوردن'));
  check('phrase verification honors excluded entry ids', (await call('meanings', { q: '"یاد آوردن"', exclude: [3, 4] })).results.length === 0);
  before = fetched.length;
  const short = await call('meanings', { q: '"و"', exclude: [] });
  check('unindexed short phrases are reported explicitly', short.unindexed && short.results.length === 0);
  const late = await call('meanings', { q: '"پایان ویژه"', exclude: [] });
  check('quotes preserve the upstream indexed-text scope', late.results.length === 0);
  check('unindexed content never triggers a full-definition scan', !fetched.slice(before).some((file) => file.startsWith('m/')));
  const joined = await call('meanings', { q: '"همدل"', exclude: [] });
  check('quoted word lookup retains ZWNJ normalization', joined.results.some((row) => row.w === 'هم‌دل'));
}

// Regex searches normalized indexed words and streams index progress.
{
  const before = fetched.length;
  const updates = [];
  const result = await call('meanings', { q: '/آوردن$/', exclude: [], progress: true }, (progress) => updates.push(progress));
  check('word regex finds occurrences inside definitions', result.results.some((row) => row.w === 'خاطره'));
  check('word regex uses normalized indexed words', result.results.some((row) => row.w === 'مرز'));
  check('regex progress describes index shards', updates.every((update) => update.stage === 'index'));
  check('regex progress matches the final results', updates.at(-1).matched === result.results.length);
  check('regex lookup does not verify every definition', !fetched.slice(before).some((file) => file.startsWith('m/')));
  check('cross-word regex checks the displayed definition', (await call('meanings', { q: '/یاد آوردن/', exclude: [] })).results.some((row) => row.w === 'خاطره'));
  check('regex can find visible labels omitted from the token index', (await call('meanings', { q: '/\\(ع اِ\\)/', exclude: [] })).results.some((row) => row.w === 'کتاب'));
}

// Metadata is applied to posting entry ids, including combined helper rules.
{
  const before = fetched.length;
  const filtered = buildTaggedQuery('/یادگار/', { arabic: 1, noun: 1 });
  check('metadata filters indexed regex entries', isDeepStrictEqual((await call('meanings', { q: filtered, exclude: [] })).results.map((row) => row.w), ['کتاب']));
  const groups = [{ match: 'all', rules: [{ kind: 'starts', value: 'یا' }, { kind: 'ends', value: 'گار' }] }];
  const combined = buildCombinedQuery(groups, 'any', { arabic: 1 });
  check('combined tagged helpers match indexed words', isDeepStrictEqual((await call('meanings', { q: combined, exclude: [] })).results.map((row) => row.w), ['کتاب']));
  const onlyTags = buildTaggedQuery('/.*/', { arabic: 1, noun: 1, proper: -1 });
  check('metadata-only searches use existing tag masks', isDeepStrictEqual((await call('meanings', { q: onlyTags, exclude: [] })).results.map((row) => row.w), ['کتاب', 'خاطره']));
  check('metadata meaning lookup loads no definitions', !fetched.slice(before).some((file) => file.startsWith('m/')));
  const parsed = parseSearchQuery(filtered);
  const custom = `/(?:${parsed.source})/${parsed.flags}`;
  const unsupported = await call('meanings', { q: custom, exclude: [] });
  check('unsupported embedded metadata is reported explicitly', unsupported.unsupported);
  check('unrestricted word regex does not need definition scans', (await call('meanings', { q: '/.*/', exclude: [] })).results.length === 10);
}

// Entry navigation and newer searches can cancel a stalled token matcher.
{
  const realWorker = globalThis.Worker;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  globalThis.Worker = class extends BrowserWorker {
    postMessage(data) {
      if (data.tokens) entered();
      else super.postMessage(data);
    }
  };
  try {
    const scan = call('meanings', { q: '/مکتوب/', exclude: [] });
    const cancelled = rejects(scan, /لغو/);
    await started;
    check('entry navigation works during stalled regex lookup', (await call('entry', { id: 2 })).word === 'کتاب');
    check('new headword search works during stalled regex lookup', (await call('search', { q: 'کتاب' })).head[0].w === 'کتاب');
    check('new queries cancel stalled regex meaning lookup', await cancelled);
  } finally {
    globalThis.Worker = realWorker;
  }
  check('invalid headword regex remains rejected', await rejects(call('search', { q: '/[/' })));
  const old = call('search', { q: '/یاد/' });
  const cancelled = rejects(old, /لغو/);
  await call('cancelSearch');
  check('headword regex cancellation remains available', await cancelled);
}

// Required and excluded labels still filter headwords and individual compounds.
{
  const q = buildTaggedQuery('/.*/', { arabic: 1, noun: 1, proper: -1 });
  check('headword origin and grammar filters remain valid', isDeepStrictEqual((await call('search', { q })).head.map((row) => row.w), ['کتاب', 'خاطره']));
  const compounds = await call('search', { q: buildTaggedQuery('/.*/', { infinitive: 1, compound: 1 }) });
  check('compound metadata remains independent', compounds.head.some((row) => row.phrase && row.w === 'به یاد آوردن'));
  const noOrigins = Object.fromEntries(ENTRY_TAGS.filter((tag) => tag.group === 'origin').map((tag) => [tag.key, -1]));
  const noOriginQuery = buildTaggedQuery('/.*/', noOrigins);
  const realWorker = globalThis.Worker;
  const before = fetched.length;
  try {
    globalThis.Worker = class { constructor() { throw new Error('Tag-only lookup must not start a regex worker'); } };
    const head = (await call('search', { q: noOriginQuery })).head;
    check('no-origin searches use tag bits without starting a regex worker', isDeepStrictEqual(head.filter((row) => !row.phrase).map((row) => row.w), ['یاد', 'یادگار', 'به یاد آوردن', 'پراکنده', 'مرز', 'هم‌دل', 'Book']));
    check('no-origin searches retain independently untagged compounds', head.filter((row) => row.phrase).length === 2);
    check('tag-only headword results retain complete match offsets', head.every((row) => row.tier === 0 && row.match.start === 0 && row.match.end === row.w.length));
    const meanings = await call('meanings', { q: noOriginQuery, exclude: head.filter((row) => !row.phrase).map((row) => row.id) });
    check('no-origin meaning searches apply the same exclusions', meanings.results.length === 0);
    check('tag-only searches fetch neither token shards nor definition blocks', !fetched.slice(before).some((name) => /^[tm]\//.test(name)));
  } finally {
    globalThis.Worker = realWorker;
  }
  const plans = [];
  try {
    globalThis.Worker = class extends BrowserWorker {
      postMessage(message) { plans.push(message); super.postMessage(message); }
    };
    const groups = [{ match: 'all', rules: [{ kind: 'starts', value: 'یاد' }, { kind: 'ends', value: 'گار' }] }];
    const result = await call('search', { q: buildCombinedQuery(groups, 'any', noOrigins) });
    check('origin exclusions combine with multiple word patterns', isDeepStrictEqual(result.head.map((row) => row.w), ['یادگار']));
    check('combined headword searches execute word regex without tag assertions', plans.length === 1 && plans[0].masks.exclude && !plans[0].metadata && !isTaggedPattern(plans[0].source));
    const raw = await call('search', { q: buildTaggedQuery('/یاد(?=\\n)/', noOrigins) });
    check('custom newline assertions keep their headword offsets', isDeepStrictEqual(raw.head.map((row) => [row.w, row.match]), [['یاد', { start: 0, end: 3 }]]));
    const wrapped = parseSearchQuery(noOriginQuery);
    const fallback = await call('search', { q: `/(?:${wrapped.source})/${wrapped.flags}` });
    check('custom wrappers retain the full visible regex behavior', isDeepStrictEqual(fallback.head.map((row) => row.w), ['یاد', 'یادگار', 'به یاد آوردن', 'پراکنده', 'مرز', 'هم‌دل', 'Book', 'از یاد بردن', 'به یاد آوردن']));
  } finally {
    globalThis.Worker = realWorker;
  }
  const worker = new BrowserWorker(new URL('../www/js/regex.worker.js', import.meta.url));
  try {
    const found = await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.results);
      worker.onerror = reject;
      const masks = new BigUint64Array(450);
      masks[449] = readEntryTags('(ع اِ)');
      const { source, flags } = parseSearchQuery(buildTaggedQuery('/.*/', { arabic: 1 }));
      worker.postMessage({ words: new Array(450).fill('واژه'), phrases: [], source, flags, limit: 400, tags: { entries: masks, phrases: new BigUint64Array() } });
    });
    check('headword metadata filtering precedes its result cap', found.length === 1 && found[0].line === 449);
  } finally {
    await worker.terminate();
  }
}

// Tag-only lookup preserves ranking and stops at the existing headword cap.
{
  const backup = new Map(files);
  const realWorker = globalThis.Worker;
  try {
    const words = new Array(450).fill('واژه');
    words[0] = 'واژه\u2028دیگر';
    const bodies = new Array(450).fill('(اِ) توضیح');
    bodies[449] = '(ع اِ) توضیح';
    files.clear();
    for (const [name, data] of fixture({ words, bodies, phrases: ['عبارت'], phraseBodies: ['(ع اِ) توضیح'] })) files.set(name, data);
    await import('../www/js/search.worker.js?tag-only-limit');
    await call('init');
    globalThis.Worker = class { constructor() { throw new Error('Tag-only lookup must not start a regex worker'); } };
    const required = await call('search', { q: buildTaggedQuery('/.*/', { arabic: 1 }) });
    check('tag-only filtering finds entries past the headword cap', required.head.length === 2 && required.head[0].id === 449 && required.head[1].phrase);
    const noOrigins = Object.fromEntries(ENTRY_TAGS.filter((tag) => tag.group === 'origin').map((tag) => [tag.key, -1]));
    const excluded = await call('search', { q: buildTaggedQuery('/.*/', noOrigins) });
    check('tag-only exclusions respect the headword result cap', excluded.head.length === 400);
    check('tag-only complete matches rank ahead of partial line matches', excluded.head[0].id === 1 && excluded.head[399].id === 400 && excluded.head.every((row) => row.tier === 0));
    const dotAll = await call('search', { q: buildTaggedQuery('/.*/su', noOrigins) });
    check('tag-only dotAll preserves full-title match offsets', dotAll.head[0].id === 0 && dotAll.head[0].match.end === words[0].length);
  } finally {
    globalThis.Worker = realWorker;
    files.clear();
    for (const [name, data] of backup) files.set(name, data);
  }
}

// Echo-word labels use the final Uint64 bit and independent index filtering.
{
  const backup = new Map(files);
  const realWorker = globalThis.Worker;
  const bodies = ['(اِ مرکب، از اتباع) سخن بیهوده', '(اِ) سخن درست', '(ع ص مرکب) (اتباع) سخن آمیخته'];
  try {
    files.clear();
    const data = fixture({
      words: ['چرت و پرت', 'کار', 'خلط ملط'], bodies,
      phrases: ['خر و پر'], phraseBodies: ['(ازاتباع) سخن بیهوده'], phraseParents: [1],
    });
    for (const [name, value] of data) files.set(name, value);
    await import('../www/js/search.worker.js?echo-tag');
    await call('init');
    globalThis.Worker = class { constructor() { throw new Error('Independent echo filtering must not start a regex worker'); } };
    const before = fetched.length;
    const head = await call('search', { q: '', filters: { echo: 1 } });
    check('echo filters identify both standalone and combined opening labels', isDeepStrictEqual(head.head.filter((row) => !row.phrase).map((row) => row.id), [0, 2]));
    check('echo compounds keep their own category without tagging their parent', head.head.some((row) => row.phrase && row.id === 1 && row.w === 'خر و پر'));
    const meaning = await call('meanings', { q: 'سخن', filters: { echo: 1 }, exclude: [] });
    check('echo meaning filters use token postings and bit 63', isDeepStrictEqual(meaning.results.map((row) => row.id).sort(), [0, 2]));
    const excluded = await call('search', { q: '', filters: { echo: -1 } });
    check('echo exclusion preserves the unlabelled parent entry', isDeepStrictEqual(excluded.head.map((row) => row.id), [1]));
    check('echo tag filtering loads no definitions', !fetched.slice(before).some((file) => file.startsWith('m/')));
    check('echo classification preserves the original entry body', (await call('entry', { id: 0 })).body === bodies[0]);
    globalThis.Worker = realWorker;
    const regex = await call('search', { q: '/^چرت/u', filters: { echo: 1 } });
    check('explicit word regexes preserve the highest unsigned tag bit', regex.head.length === 1 && regex.head[0].id === 0);
    for (const version of [3, 4]) {
      const meta = JSON.parse(files.get('meta.json'));
      meta.tagVersion = version;
      files.set('meta.json', JSON.stringify(meta));
      await import('../www/js/search.worker.js?echo-tag-old-index-' + version);
      await call('init');
      check('existing tags remain usable with older indexes: ' + version, (await call('search', { q: '', filters: { noun: 1 } })).head.length === 2);
      for (const state of [1, -1]) {
        check('old indexes request a rebuild for echo inclusion/exclusion: ' + version + '/' + state, await rejects(call('search', { q: '', filters: { echo: state } }), /به‌روز کنید/));
      }
      check('old meaning indexes request a rebuild for echo filters: ' + version, await rejects(call('meanings', { q: 'سخن', filters: { echo: 1 }, exclude: [] }), /به‌روز کنید/));
      check('old serialized tag queries request the same echo rebuild: ' + version, await rejects(call('search', { q: buildTaggedQuery('/.*/u', { echo: 1 }) }), /به‌روز کنید/));
      check('old serialized meaning queries request the same echo rebuild: ' + version, await rejects(call('meanings', { q: buildSearchQuery('starts', 'سخن', { echo: 1 }), exclude: [] }), /به‌روز کنید/));
    }
  } finally {
    globalThis.Worker = realWorker;
    files.clear();
    for (const [name, value] of backup) files.set(name, value);
  }
}

// 64-bit labels survive binary loading, worker cloning and indexed filtering.
{
  const backup = new Map(files);
  try {
    files.clear();
    const data = fixture({
      words: ['واژه عبری', 'واژه فینیقی', 'نفی', 'واژه عربی'],
      bodies: ['(عبری اِ) مشترک', '(فینیقی اِ) مشترک', '(نفی) مشترک', '(ع اِ) مشترک'],
      phrases: ['عبارت ژاپنی'], phraseBodies: ['(ژاپنی اِ) توضیح'],
    });
    for (const [name, value] of data) files.set(name, value);
    await import('../www/js/search.worker.js?wide-tag-index');
    await call('init');
    const head = await call('search', { q: buildSearchQuery('starts', 'واژه', { hebrew: 1 }) });
    check('headword regex workers retain tags above bit 31', isDeepStrictEqual(head.head.map((row) => row.w), ['واژه عبری']));
    const meaning = await call('meanings', { q: buildSearchQuery('starts', 'مشترک', { phoenician: 1 }), exclude: [] });
    check('indexed meaning regex filters retain high tag bits', isDeepStrictEqual(meaning.results.map((row) => row.w), ['واژه فینیقی']));
    const only = await call('search', { q: buildTaggedQuery('/.*/', { negation: 1 }) });
    check('tag-only searches retain bits above numeric integer precision', isDeepStrictEqual(only.head.map((row) => row.w), ['نفی']));
    const compound = await call('search', { q: buildTaggedQuery('/.*/', { japanese: 1 }) });
    check('compound labels use the full 64-bit index independently', compound.head.length === 1 && compound.head[0].phrase && compound.head[0].w === 'عبارت ژاپنی');
  } finally {
    files.clear();
    for (const [name, value] of backup) files.set(name, value);
  }
}

// Targeted regex prefixes only read the relevant existing token shards.
{
  const backup = new Map(files);
  try {
    files.clear();
    for (const [name, data] of fixture({ splitIndex: true })) files.set(name, data);
    await import('../www/js/search.worker.js?split-token-index');
    await call('init');
    const meta = JSON.parse(files.get('meta.json'));
    const expected = meta.shardKeys.find(([key]) => key === 'ی')[1];
    const before = fetched.length;
    const found = await call('meanings', { q: '/^یاد/', exclude: [] });
    check('targeted regex finds indexed prefix matches', found.results.some((row) => row.w === 'کتاب'));
    check('fixed regex prefixes only load their token shards', isDeepStrictEqual(fetched.slice(before), [`t/${expected}.txt`]));
    const repeated = fetched.length;
    await call('meanings', { q: '/^یاد/', exclude: [] });
    check('repeated regex lookup reuses cached index data', fetched.length === repeated);

    await import('../www/js/search.worker.js?cancel-token-index-load');
    await call('init');
    const realFetch = globalThis.fetch;
    let entered;
    let release;
    const started = new Promise((resolve) => { entered = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async (url) => {
      if (new URL(url).pathname.includes('/t/')) { entered(); await waiting; }
      return realFetch(url);
    };
    try {
      const lookup = call('meanings', { q: '"یاد"', exclude: [] });
      const cancelled = rejects(lookup, /لغو/);
      await started;
      check('headword lookup works during index loading', (await call('search', { q: 'کتاب' })).head[0].w === 'کتاب');
      check('new queries cancel quoted index loading', await cancelled);
    } finally {
      release();
      globalThis.fetch = realFetch;
    }
  } finally {
    files.clear();
    for (const [name, data] of backup) files.set(name, data);
  }
}

// Candidate verification failures preserve already-streamed phrase matches.
{
  const backup = new Map(files);
  const titles = new Array(45).fill('واژه');
  try {
    files.clear();
    for (const [name, data] of fixture({ words: titles, bodies: titles.map(() => 'book do next'), phrases: [], phraseBodies: [], stopwords: [] })) files.set(name, data);
    files.delete('m/40.txt');
    await import('../www/js/search.worker.js?phrase-block-failure');
    await call('init');
    const updates = [];
    check('missing candidate blocks report verification failure', await rejects(call('meanings', { q: '"book do"', exclude: [], progress: true }, (p) => updates.push(p)), /404/));
    check('verified phrase results arrive before a later block fails', updates.some((update) => update.results.length === 40));
  } finally {
    files.clear();
    for (const [name, data] of backup) files.set(name, data);
  }
}

// Broad indexed regex stops at the existing result limit without loading bodies.
{
  const backup = new Map(files);
  try {
    files.clear();
    const titles = new Array(1005).fill('واژه');
    for (const [name, data] of fixture({ words: titles, bodies: titles.map(() => 'متن'), phrases: [], phraseBodies: [], stopwords: [] })) files.set(name, data);
    await import('../www/js/search.worker.js?indexed-regex-limit');
    await call('init');
    const before = fetched.length;
    const result = await call('meanings', { q: '/متن/', exclude: [] });
    check('regex entries respect the existing result cap', result.results.length === 1000 && result.limited);
    check('capped regex lookup does not load definitions', !fetched.slice(before).some((file) => file.startsWith('m/')));
  } finally {
    files.clear();
    for (const [name, data] of backup) files.set(name, data);
  }
}

// Quoted spaces are significant for headwords and indexed phrase candidates.
{
  const backup = new Map(files);
  const titles = ['book dowom', 'book do next', 'book do', 'book do, next', 'bookdo next', 'notebook dowom', 'a book dowom', 'a book do next'];
  try {
    files.clear();
    for (const [name, data] of fixture({ words: titles, bodies: titles.map((title) => `(اِ) ${title}`), phrases: [], phraseBodies: [], stopwords: [] })) files.set(name, data);
    await import('../www/js/search.worker.js?quoted-index-spaces');
    await call('init');
    for (const type of ['search', 'meanings']) {
      const search = async (q) => {
        const result = await call(type, { q, exclude: [] });
        return type === 'search' ? result.head : result.results;
      };
      const plain = await search('"book do"');
      check('quoted phrases include longer final words', isDeepStrictEqual(plain.map((row) => row.w).sort(), titles.filter((word) => word.includes('book do')).sort()));
      for (const q of ['"book do "', '«book do »', '“book do ”']) {
        const results = await search(q);
        check('trailing quoted spaces require actual following spaces', isDeepStrictEqual(results.map((row) => row.w).sort(), ['book do next', 'a book do next'].sort()));
        for (const row of results) {
          const text = row.snippet?.text || row.w;
          const match = row.snippet?.match || row.match;
          check('quoted highlights preserve the required space', text.slice(match.start, match.end) === 'book do ');
        }
      }
      check('quoted punctuation is literal', isDeepStrictEqual((await search('"book do,"')).map((row) => row.w), ['book do, next']));
      check('empty quotes remain empty', (await search('""')).length === 0);
    }
  } finally {
    files.clear();
    for (const [name, data] of backup) files.set(name, data);
  }
}

// Sparse subject/usage postings require the word and all facets in one sense.
{
  const backup = new Map(files);
  const bodies = [
    '(اِ) واژه عادی\x01(اصطلاح پزشکی) دارو درمان\x01(بمجاز) راز گفتار',
    '(اِمصغر) (اصطلاح طب) (در تداول عامه) درمان\x01(بمجاز) راز',
    '(نف مرخم) (اصطلاح طب) راز پزشکی\x01(بمجاز) درمان ادبی',
    '(ص نسبی) درمان عمومی',
    '(اِ) مقدمه\x04\x05عبارت پزشکی\x06 ؛ \x0eتلفظ\x0f (اصطلاح پزشکی) درمان ترکیبی\x01(بمجاز) راز',
    '(اِ) ' + 'توضیح '.repeat(510) + '\x01(اصطلاح پزشکی) درمانآخر',
  ];
  const medical = { 'subject-medicine': 1 };
  const query = (filters, source = '^درمان$') => buildSearchQuery('regex', source, filters);
  try {
    files.clear();
    for (const [name, value] of fixture({ words: ['دو معنا', 'دو برچسب', 'متناقض', 'بی برچسب', 'ترکیب دار', 'دیر'], bodies,
      phrases: ['عبارت پزشکی'], phraseParents: [4], phraseBodies: ['(اصطلاح پزشکی) درمان'] })) files.set(name, value);
    await import('../www/js/search.worker.js?sense-filters');
    await call('init');
    let before = fetched.length;
    await call('search', { q: 'درمان' });
    await call('meanings', { q: 'درمان', exclude: [] });
    check('ordinary search does not load subject data or sparse shards', !fetched.slice(before).some((file) => file === 'sense-meta.txt' || file.startsWith('s/')));
    const realWorker = globalThis.Worker;
    before = fetched.length;
    try {
      globalThis.Worker = class { constructor() { throw new Error('Facet-only lookup must not execute regex'); } };
      const heads = (await call('search', { q: query(medical, '.*') })).head;
      check('later subject labels can find the entry headword', heads.some((row) => row.id === 0 && !row.phrase));
      check('a compound subject does not label its parent headword', !heads.some((row) => row.id === 4 && !row.phrase) && heads.some((row) => row.id === 4 && row.phrase));
      const both = await call('search', { q: query({ ...medical, figurative: 1 }, '.*') });
      check('headword facets cannot combine different senses', both.head.length === 0);
      check('tag-only subject lookup loads no tokens or definitions', !fetched.slice(before).some((file) => /^[stm]\//.test(file)));
    } finally { globalThis.Worker = realWorker; }
    before = fetched.length;
    const found = await call('meanings', { q: query(medical), exclude: [] });
    check('subject word matches belong to the labelled sense', isDeepStrictEqual(found.results.map((row) => row.id).sort(), [0, 1, 4]));
    check('subject word lookup uses sparse postings without definition reads', fetched.slice(before).some((file) => file.startsWith('s/')) && !fetched.slice(before).some((file) => file.startsWith('m/')));
    check('subject lookup retains the original token budget', !(await call('meanings', { q: query(medical, '^درمانآخر$'), exclude: [] })).results.length);
    const combined = await call('meanings', { q: query({ ...medical, colloquial: 1 }), exclude: [] });
    check('subject and usage conditions apply in the same sense', isDeepStrictEqual(combined.results.map((row) => row.id), [1]));
    const cross = await call('meanings', { q: query({ ...medical, figurative: 1 }), exclude: [] });
    check('meaning facets cannot combine separate senses', cross.results.length === 0);
    const negative = await call('meanings', { q: query({ 'subject-medicine': -1 }), exclude: [] });
    check('subject exclusions include unlabelled entries and other senses', isDeepStrictEqual(negative.results.map((row) => row.id).sort(), [2, 3]));
    const grammar = await call('meanings', { q: query({ ...medical, diminutive: 1 }), exclude: [] });
    check('grammar refinements compose with sense filters', isDeepStrictEqual(grammar.results.map((row) => row.id), [1]));
    for (const [key, id] of [['diminutive', 1], ['shortened', 2], ['relative-adjective', 3]]) {
      const head = await call('search', { q: query({ [key]: 1 }, '.*') });
      check('built index preserves grammatical refinement: ' + key, head.head.length === 1 && head.head[0].id === id);
    }
    const raw = parseSearchQuery(query(medical, '^دو'));
    const wrapped = await call('search', { q: `/(?:${raw.source})/${raw.flags}` });
    check('custom metadata regex retains matching sense ranges', wrapped.head.length === 2 && wrapped.head.find((row) => row.id === 0).range[0] === bodies[0].indexOf('\x01'));
    const medRange = found.results.find((row) => row.id === 0).range;
    const fig = await call('meanings', { q: query({ figurative: 1 }, '^راز$'), exclude: [] });
    const figRange = fig.results.find((row) => row.id === 0).range;
    const snippets = await call('snippets', { exact: true, requests: [
      { key: 'medical', id: 0, terms: ['درمان'], range: medRange },
      { key: 'figurative', id: 0, terms: ['راز'], range: figRange },
    ] });
    check('snippets show only the matching medical sense', snippets[0].key === 'medical' && snippets[0].text.includes('درمان') && !snippets[0].text.includes('راز'));
    check('one snippet batch can show distinct senses of the same entry', snippets[1].key === 'figurative' && snippets[1].text.includes('راز') && !snippets[1].text.includes('درمان'));
    const saved = files.get('sense-meta.txt');
    files.set('sense-meta.txt', '[[999999,0,0,5,[]]]');
    await import('../www/js/search.worker.js?corrupt-sense-index');
    await call('init');
    check('incompatible sense metadata is reported', await rejects(call('search', { q: query(medical, '.*') }), /ناقص/));
    files.set('sense-meta.txt', saved);
    check('sense metadata can be retried after failure', (await call('search', { q: query(medical, '.*') })).head.length > 0);
    const meta = JSON.parse(files.get('meta.json'));
    delete meta.senseVersion;
    files.set('meta.json', JSON.stringify(meta));
    await import('../www/js/search.worker.js?missing-sense-index');
    await call('init');
    check('new facets explain when a data rebuild is needed', await rejects(call('meanings', { q: query(medical), exclude: [] }), /به‌روز کنید/));
    check('ordinary regex remains available without sense metadata', (await call('meanings', { q: '/^درمان$/', exclude: [] })).results.length > 0);
    meta.senseVersion = SENSE_VERSION;
    files.set('meta.json', JSON.stringify(meta));
    await import('../www/js/search.worker.js?cancel-sense-index');
    await call('init');
    const realFetch = globalThis.fetch;
    let entered;
    let release;
    const started = new Promise((resolve) => { entered = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    try {
      globalThis.fetch = async (url) => {
        if (new URL(url).pathname.includes('/s/')) { entered(); await waiting; }
        return realFetch(url);
      };
      const lookup = call('meanings', { q: query(medical), exclude: [] });
      const cancelled = rejects(lookup, /لغو/);
      await started;
      await call('search', { q: 'دو' });
      check('new queries cancel stalled sparse-sense lookups', await cancelled);
    } finally {
      release();
      globalThis.fetch = realFetch;
    }
  } finally {
    files.clear();
    for (const [name, value] of backup) files.set(name, value);
  }
}

// Selecting or excluding a category includes its confirmed misspelled labels.
{
  const backup = new Map(files);
  try {
    const bodies = [
      '(فرنسه، اِ) نمونه', '(فرانسسوی، اِ) نمونه', '(فرانسوی، اِ م__رکب) (اصطلا ح طب) نمونه',
      '(اِ) تعریف\x01(اصطلا ح اصول) نمونه فقهی', '(فرانسوا) متن نقل', '(اِ) متن دربارهٔ فرنسه و فرانسه',
    ];
    files.clear();
    for (const [name, value] of fixture({ words: ['فرانسه یک', 'فرانسه دو', 'فرانسه مرکب', 'اصولی', 'نقل', 'متن'], bodies })) files.set(name, value);
    await import('../www/js/search.worker.js?confirmed-label-typos');
    await call('init');
    const q = (filters, source = '.*') => buildSearchQuery('regex', source, filters);
    const french = await call('search', { q: q({ french: 1 }) });
    check('selected French category includes both misspelled labels', isDeepStrictEqual(french.head.map((row) => row.id), [0, 1, 2]));
    const excluded = await call('search', { q: q({ french: -1 }) });
    check('excluded French category excludes its misspelled labels', isDeepStrictEqual(excluded.head.filter((row) => !row.phrase).map((row) => row.id), [3, 4, 5]));
    const compound = await call('search', { q: q({ french: 1, compound: 1 }) });
    check('independent typo aliases compose in one category search', isDeepStrictEqual(compound.head.map((row) => row.id), [2]));
    const meaning = await call('meanings', { q: q({ french: 1 }, '^نمونه$'), exclude: [] });
    check('meaning search uses the same typo-tolerant category index', isDeepStrictEqual(meaning.results.map((row) => row.id), [0, 1, 2]));
    const subject = await call('meanings', { q: q({ 'subject-fiqh': 1 }, '^نمونه$'), exclude: [] });
    check('misspelled subject headers participate in sense search', isDeepStrictEqual(subject.results.map((row) => row.id), [3]));
    const combined = await call('meanings', { q: q({ french: 1, 'subject-medicine': 1 }, '^نمونه$'), exclude: [] });
    check('category and subject aliases share one matching sense', isDeepStrictEqual(combined.results.map((row) => row.id), [2]));
    check('classification preserves the original dictionary spelling', (await call('entry', { id: 0 })).body.startsWith('(فرنسه، اِ)'));
  } finally {
    files.clear();
    for (const [name, value] of backup) files.set(name, value);
  }
}

// Independent tag controls preserve text/quote modes and default to alternatives.
{
  for (const q of ['یاد', '"book do "', '', '/^یاد/u']) {
    const current = readSearchBuilder(q);
    const flags = current.query.mode === 'regex' ? current.query.flags : 'u';
    check('tag-only builder changes preserve original query syntax: ' + q, buildWordQuery(current.groups, current.match, flags, q) === q);
  }
  const migrated = separateSearchFilters(buildTaggedQuery('/.*/u', { arabic: 1, french: 1 }));
  check('old tag-only expressions migrate to independent filters', migrated.q === '' && migrated.filters.arabic === 1 && migrated.filters.french === 1);
  const modes = tagFilterMasks({ arabic: 1, french: 1, noun: 1 }, {});
  check('origins are alternatives while word-kind constraints still apply', matchesEntryTags(readEntryTags('(ع اِ)'), modes) && matchesEntryTags(readEntryTags('(فرانسوی اِ)'), modes) && !matchesEntryTags(readEntryTags('(ع مص)'), modes));
  check('explicit all mode can still require a tag combination', !matchesEntryTags(readEntryTags('(ع اِ)'), tagFilterMasks({ arabic: 1, french: 1 }, { origin: 'all' })));
  check('excluded tags override any selected alternative', !matchesEntryTags(readEntryTags('(ع فرانسوی اِ)'), tagFilterMasks({ arabic: -1, french: 1 }, {})));
}

// No regex worker is used for tag-only, normal indexed or quoted tag searches.
{
  const backup = new Map(files);
  const realWorker = globalThis.Worker;
  const bodies = [
    '(ع اِ) یادگار آبی کتاب قدیم',
    '(فرانسوی اِ) یادگار سرخ کتاب تازه',
    '(ع، فرانسوی، ص مرکب، اِ مرکب) (اصطلاح طب) (بمجاز) یادگار سبز کتاب قدیم',
    '(ع مص) آغاز',
    '(اِ) عمومی\x01(اصطلاح طب) یادگار آبی کتاب میان قدیم\x01(اصطلاح طب) یادگار سفید کتاب قدیم\x01(بمجاز) یادگار سرخ کتاب قدیم',
    '(اِ) (اصطلاح فقه) (در تداول عامه) یادگار کتاب قدیم',
  ];
  try {
    files.clear();
    for (const [name, value] of fixture({ words: ['یاد عربی', 'یاد فرانسوی', 'یاد مشترک', 'یاد مصدر', 'خاطره', 'دو معنی'], bodies })) files.set(name, value);
    await import('../www/js/search.worker.js?independent-tags');
    await call('init');
    globalThis.Worker = class { constructor() { throw new Error('Text and tag filtering must not start a regex worker'); } };
    const filters = { arabic: 1, french: 1 };
    let before = fetched.length;
    const onlyTags = await call('search', { q: '', filters });
    check('multiple selected origins return either origin', isDeepStrictEqual(onlyTags.head.filter((row) => !row.phrase).map((row) => row.id), [0, 1, 2, 3]));
    check('tag-only filtering loads no token or meaning blocks', !fetched.slice(before).some((file) => /^[stm]\//.test(file)));
    const allOrigins = await call('search', { q: '', filters, tagMatch: { origin: 'all' } });
    check('all mode explicitly requires both origins', isDeepStrictEqual(allOrigins.head.map((row) => row.id), [2]));
    const types = await call('search', { q: '', filters: { ...filters, noun: 1, adjective: 1 } });
    check('groups combine with AND and selections within a group with OR', isDeepStrictEqual(types.head.filter((row) => !row.phrase).map((row) => row.id), [0, 1, 2]));
    const compound = await call('search', { q: '', filters: { noun: 1, compound: 1 }, tagMatch: { kind: 'all' } });
    check('compound nouns can still be required explicitly', isDeepStrictEqual(compound.head.map((row) => row.id), [2]));
    const excluded = await call('search', { q: 'یاد', filters: { french: 1, arabic: -1 } });
    check('plain headword search applies excluded tags before ranking', isDeepStrictEqual(excluded.head.map((row) => row.id), [1]));
    const plain = await call('search', { q: 'یاد', filters });
    const quoted = await call('search', { q: '"یاد"', filters });
    check('plain filtered headwords retain indexOf lookup', plain.head.length === 4);
    check('quoted filtered headwords retain literal lookup', quoted.head.length === 4);
    before = fetched.length;
    const meaning = await call('meanings', { q: 'یادگار', filters, exclude: [] });
    const single = await call('meanings', { q: '"یادگار"', filters, exclude: [] });
    check('ordinary filtered meanings use the fast token index', isDeepStrictEqual(meaning.results.map((row) => row.id).sort(), [0, 1, 2]));
    check('single quoted filtered meanings use the same index', isDeepStrictEqual(single.results.map((row) => row.id).sort(), [0, 1, 2]));
    check('single-word filtered search loads no definitions', !fetched.slice(before).some((file) => file.startsWith('m/')));
    const topics = { 'subject-medicine': 1, 'subject-fiqh': 1 };
    const subjects = await call('meanings', { q: 'یادگار', filters: topics, exclude: [] });
    check('multiple subjects are alternatives in indexed text search', isDeepStrictEqual(subjects.results.map((row) => row.id).sort(), [2, 4, 5]));
    const bothSubjects = await call('meanings', { q: 'یادگار', filters: topics, tagMatch: { subject: 'all' }, exclude: [] });
    check('subject all mode still requires one sense with both labels', bothSubjects.results.length === 0);
    const mixed = await call('meanings', { q: 'یادگار', filters: { ...topics, figurative: 1 }, exclude: [] });
    check('subject and usage grouping stays within one sense', isDeepStrictEqual(mixed.results.map((row) => row.id), [2]));
    const phrase = await call('meanings', { q: '"کتاب قدیم"', filters: { 'subject-medicine': 1 }, exclude: [] });
    check('quoted phrases are verified in the selected subject sense', isDeepStrictEqual(phrase.results.map((row) => row.id).sort(), [2, 4]));
    const later = phrase.results.find((row) => row.id === 4);
    check('phrase verification can try a second eligible sense of one entry', later.range[0] === bodies[4].lastIndexOf('\x01(اصطلاح طب)') && !later.snippet.text.includes('میان') && !later.snippet.text.includes('سرخ'));
    const negative = await call('meanings', { q: 'یادگار', filters: { 'subject-medicine': -1 }, exclude: [] });
    check('plain exclusions include unlabelled entries and other senses', isDeepStrictEqual(negative.results.map((row) => row.id).sort(), [0, 1, 4, 5]));
    const complete = await call('meanings', { q: 'یادگار آبی', filters: { 'subject-medicine': -1 }, exclude: [] });
    check('complete word matches precede partial matches across filtered indexes', isDeepStrictEqual(complete.results.map((row) => row.id), [0]));
    const scopedWords = await call('meanings', { q: 'کتاب قدیم', filters: { 'subject-medicine': 1 }, exclude: [] });
    check('filtered multiword meanings use indexed words within one eligible sense', isDeepStrictEqual(scopedWords.results.map((row) => row.id).sort(), [2, 4]));
    globalThis.Worker = realWorker;
    const regexHead = await call('search', { q: '/^یاد/u', filters });
    check('an explicit word regex composes with independent origin alternatives', regexHead.head.length === 4);
    const regexMeaning = await call('meanings', { q: '/^یادگار$/u', filters: topics, exclude: [] });
    check('an explicit meaning regex retains grouped subject filters', isDeepStrictEqual(regexMeaning.results.map((row) => row.id).sort(), [2, 4, 5]));
    const meta = JSON.parse(files.get('meta.json'));
    meta.tagVersion = 3;
    meta.senseVersion = 1;
    files.set('meta.json', JSON.stringify(meta));
    await import('../www/js/search.worker.js?compatible-tag-revisions');
    await call('init');
    check('compatible older tag layouts remain usable', (await call('search', { q: '', filters })).head.length === 4);
    check('compatible older sense layouts remain usable', (await call('meanings', { q: 'یادگار', filters: topics, exclude: [] })).results.length === 3);
  } finally {
    globalThis.Worker = realWorker;
    files.clear();
    for (const [name, value] of backup) files.set(name, value);
  }
}

// Filters are applied before headword and meaning limits, including quoted lookup.
{
  const backup = new Map(files);
  const realWorker = globalThis.Worker;
  try {
    const count = 1205;
    const bodies = new Array(count).fill('(ع اِ) token');
    bodies[count - 1] = '(فرانسوی اِ) token (برهان)';
    files.clear();
    for (const [name, value] of fixture({ words: Array.from({ length: count }, (_, id) => 'واژه ' + id), bodies })) files.set(name, value);
    await import('../www/js/search.worker.js?independent-filter-limits');
    await call('init');
    globalThis.Worker = class { constructor() { throw new Error('Filtered index lookup must not execute regex'); } };
    for (const q of ['واژه', '"واژه"']) {
      const result = await call('search', { q, filters: { french: 1 } });
      check('headword filter runs before its result cap: ' + q, result.head.length === 1 && result.head[0].id === count - 1);
    }
    for (const q of ['token', '"token"']) {
      const result = await call('meanings', { q, filters: { french: 1 }, exclude: [] });
      check('meaning filter runs before its result cap: ' + q, result.results.length === 1 && result.results[0].id === count - 1);
    }
    for (const [type, q] of [['search', 'واژه'], ['search', '"واژه"'], ['meanings', 'token'], ['meanings', '"token"']]) {
      const result = await call(type, { q, filters: { 'source-burhan': 1 }, exclude: [] });
      const rows = result.head || result.results;
      check('source filters precede result limits: ' + type + '/' + q, rows.length === 1 && rows[0].id === count - 1);
    }
  } finally {
    globalThis.Worker = realWorker;
    files.clear();
    for (const [name, value] of backup) files.set(name, value);
  }
}

// Sources remain independent of regex and load only when selected. Compound
// meaning matches use existing sense postings plus the minimal additional scopes.
{
  const backup = new Map(files);
  const realWorker = globalThis.Worker;
  const bodies = [
    '(ع اِ) token book dowom (برهان)',
    '(فرانسوی اِ) token book dowom (آنندراج)',
    '(اِ) token book dowom (برهان) (آنندراج) (فرهنگ شعوری)',
    '(اِ) token book dowom\x01(اصطلاح طب) دارو (برهان)',
    '(اِ) rootword\x04\x05ترکیب خاص\x06 ؛ compoundword token book dowom (ناظم الاطباء) (شعوری)',
    '(اِ) rootword\x04\x05ترکیب طبی\x06 ؛ (اصطلاح طب) token درمان (برهان)',
  ];
  try {
    files.clear();
    const data = fixture({ words: ['واژه الف', 'واژه ب', 'واژه ج', 'واژه د', 'واژه ه', 'واژه و'], bodies,
      phrases: ['ترکیب خاص', 'ترکیب طبی'], phraseParents: [4, 5], phraseBodies: ['(ناظم الاطباء)', '(برهان)'] });
    for (const [name, value] of data) files.set(name, value);
    const initial = fetched.length;
    await import('../www/js/search.worker.js?source-index');
    await call('init');
    await call('search', { q: 'واژه' });
    await call('meanings', { q: 'token', exclude: [] });
    check('unfiltered searches fetch no source postings or additional scopes', !fetched.slice(initial).some((name) => /^r\/|^u\/|^source-senses/.test(name)));
    globalThis.Worker = class { constructor() { throw new Error('Source filters must not start a regex worker'); } };
    const filters = { 'source-burhan': 1 };
    let before = fetched.length;
    const only = await call('search', { q: '', filters });
    check('source-only title search keeps main and compound ownership', isDeepStrictEqual(only.head.filter((row) => !row.phrase).map((row) => row.id), [0, 2, 3]) && only.head.some((row) => row.phrase && row.id === 5));
    check('source-only title search loads just the selected source file', isDeepStrictEqual(fetched.slice(before), ['r/0.txt']));
    const alternatives = await call('search', { q: '', filters: { ...filters, 'source-anandraj': 1 } });
    check('multiple source selections default to alternatives', isDeepStrictEqual(alternatives.head.filter((row) => !row.phrase).map((row) => row.id), [0, 1, 2, 3]));
    const all = await call('search', { q: '', filters: { ...filters, 'source-anandraj': 1 }, tagMatch: { source: 'all' } });
    check('source all mode requires both citations on the same owner', isDeepStrictEqual(all.head.map((row) => row.id), [2]));
    const combined = await call('search', { q: 'واژه', filters: { ...filters, arabic: 1, noun: 1 } });
    check('source filters combine with origin and word kind', isDeepStrictEqual(combined.head.map((row) => row.id), [0]));
    before = fetched.length;
    const plain = await call('meanings', { q: 'token', filters, exclude: [] });
    const quoted = await call('meanings', { q: '"token"', filters, exclude: [] });
    check('plain source-filtered meanings include indexed compound scopes', isDeepStrictEqual(plain.results.map((row) => row.id).sort(), [0, 2, 3, 5]));
    const multiword = await call('meanings', { q: 'token book', filters, exclude: [] });
    check('source-filtered multiword search preserves all-words-first ranking', isDeepStrictEqual(multiword.results.map((row) => row.id).sort(), [0, 2, 3]));
    check('single-word quotes retain source-filtered index lookup', isDeepStrictEqual(quoted.results.map((row) => row.id).sort(), [0, 2, 3, 5]));
    check('plain and single quoted source filters load no definitions', !fetched.slice(before).some((name) => name.startsWith('m/')));
    const medical = await call('meanings', { q: 'token', filters: { ...filters, 'subject-medicine': 1 }, exclude: [] });
    check('source and subject filters preserve the matching sense', isDeepStrictEqual(medical.results.map((row) => row.id), [5]));
    const compoundFilters = { 'source-nazem': 1 };
    const compound = await call('meanings', { q: 'compoundword', filters: compoundFilters, exclude: [] });
    check('compound-only sources find their indexed meaning', compound.results.length === 1 && compound.results[0].id === 4 && compound.results[0].range[0] === bodies[4].indexOf('\x04'));
    const parent = await call('meanings', { q: 'rootword', filters: compoundFilters, exclude: [] });
    check('a compound source does not match unrelated parent meaning text', parent.results.length === 0);
    const phrase = await call('meanings', { q: '"book do"', filters: compoundFilters, exclude: [] });
    check('quoted phrase verification stays within the cited compound', phrase.results.length === 1 && phrase.results[0].id === 4);
    const excluded = await call('meanings', { q: 'token', filters: { 'source-burhan': -1 }, exclude: [] });
    check('source exclusions retain differently cited compounds and entries', isDeepStrictEqual(excluded.results.map((row) => row.id).sort(), [1, 4]));
    check('source badges leave original dictionary text intact', (await call('entry', { id: 4 })).body === bodies[4]);
    before = fetched.length;
    await call('search', { q: 'واژه', filters: compoundFilters });
    await call('meanings', { q: 'compoundword', filters: compoundFilters, exclude: [] });
    check('typing reuses loaded source postings and scopes', !fetched.slice(before).some((name) => /^r\/|^u\/|^source-senses/.test(name)));
    globalThis.Worker = realWorker;
    const regexHead = await call('search', { q: '/^ترکیب/u', filters: compoundFilters });
    check('explicit title regexes retain independent compound source filters', regexHead.head.length === 1 && regexHead.head[0].id === 4);
    const regexMeaning = await call('meanings', { q: '/^compoundword$/u', filters: compoundFilters, exclude: [] });
    check('explicit meaning regexes retain independent compound source filters', regexMeaning.results.length === 1 && regexMeaning.results[0].id === 4);
    const shooriFilters = { 'source-shoori': 1 };
    const shooriHead = await call('search', { q: '', filters: shooriFilters });
    check('expanded source filters preserve entry and compound ownership', shooriHead.head.length === 2 && shooriHead.head.some((row) => row.id === 2 && !row.phrase) && shooriHead.head.some((row) => row.id === 4 && row.phrase));
    const shooriMeaning = await call('meanings', { q: 'token', filters: shooriFilters, exclude: [] });
    check('Shoori aliases participate in fast indexed meaning search', isDeepStrictEqual(shooriMeaning.results.map((row) => row.id).sort(), [2, 4]));
    const broken = files.get('r/0.txt');
    files.set('r/0.txt', broken.slice(0, -1));
    await import('../www/js/search.worker.js?source-index-retry');
    await call('init');
    check('corrupt source postings report an error', await rejects(call('search', { q: '', filters }), /بددیسیده/));
    files.set('r/0.txt', broken);
    check('source postings can be retried after failure', (await call('search', { q: '', filters })).head.length === 4);
    const meta = JSON.parse(files.get('meta.json'));
    meta.sourceCounts = meta.sourceCounts.slice(0, 14);
    files.set('meta.json', JSON.stringify(meta));
    await import('../www/js/search.worker.js?source-index-older-catalog');
    await call('init');
    check('older catalogs keep their existing source filters usable', (await call('search', { q: '', filters })).head.length === 4);
    check('new source filters request a rebuild with an older catalog', await rejects(call('search', { q: '', filters: shooriFilters }), /به‌روز کنید/));
    delete meta.sourceVersion;
    files.set('meta.json', JSON.stringify(meta));
    await import('../www/js/search.worker.js?source-index-missing');
    await call('init');
    check('old data requests a rebuild for source filters', await rejects(call('search', { q: '', filters }), /به‌روز کنید/));
    check('old data keeps ordinary indexed meaning search', (await call('meanings', { q: 'token', exclude: [] })).results.length > 0);
  } finally {
    globalThis.Worker = realWorker;
    files.clear();
    for (const [name, value] of backup) files.set(name, value);
  }
}

// Scoped conditions combine complete owner masks before applying result limits.
{
  const backup = new Map(files);
  const realFetch = globalThis.fetch;
  const install = async (name, options) => {
    files.clear();
    for (const [file, bytes] of fixture({ ...options, completeCompounds: true })) files.set(file, bytes);
    await import('../www/js/search.worker.js?scoped-' + name);
    await call('init');
  };
  try {
    const options = {
      words: ['کتاب', 'کتابچه', 'دفتر', 'دیوان', 'کمد', 'آموزش', 'کتابت', 'دوا'],
      phrases: ['کتاب فرعی', 'دفتر پنهان', 'کتاب درمان'], phraseParents: [2, 0, 3],
      phraseBodies: ['(اِ) شعر سروده', '(اِ) راز (آنندراج)', '(ص) نمونه'],
      bodies: [
        '(ع اِ) آموزش هنر (برهان)\x04\x05دفتر پنهان\x06 ؛ (اِ) راز (آنندراج)',
        '(اِ) خاطره یادگار', '(اِ) آموزش خط\x04\x05کتاب فرعی\x06 ؛ (اِ) شعر سروده',
        '(اِ) (اصطلاح طب) درمان دارو (برهان)\x04\x05کتاب درمان\x06 ؛ (ص) نمونه',
        '(اِ) جای لباس', '(اِ) بیانی مستقل', '(اِ) آموزش خط',
        '(اِ) (اصطلاح طب) دارو\x01(اصطلاح منطق) نور',
      ],
    };
    await install('owners', options);
    let before = fetched.length;
    const head = await call('search', { q: 'headword:/^آموزش$/u' });
    check('headword-only conditions ignore matches found solely in meanings', isDeepStrictEqual(head.head.map((row) => row.id), [5]));
    const compoundHead = await call('search', { q: 'headword:/^کتاب فرعی$/u' });
    check('headword-only conditions also search existing compound titles', compoundHead.head.length === 1 && compoundHead.head[0].phrase && compoundHead.head[0].id === 2 && compoundHead.head[0].w === 'کتاب فرعی');
    check('headword-only conditions load no meaning or scope indexes', !fetched.slice(before).some((name) => /^(?:[sturm]\/|sense-meta|source-senses)/.test(name)));
    before = fetched.length;
    check('impossible headword conditions return no matches', (await call('search', { q: 'headword:/^گمشده$/u AND meaning:/./u' })).head.length === 0);
    check('impossible headword conditions load no meaning or scope indexes', !fetched.slice(before).some((name) => /^(?:[sturm]\/|sense-meta|source-senses)/.test(name)));
    const meanings = async (q, payload = {}) => (await call('meanings', { q, exclude: [], ...payload })).results;
    check('meaning-only conditions ignore the headword itself', isDeepStrictEqual((await meanings('meaning:/^آموزش$/u')).map((row) => row.id), [0, 2, 6]));
    const q = 'headword:/^کتاب/u AND meaning:/^آموزش$/u';
    before = fetched.length;
    const combined = await call('search', { q });
    check('an AND condition requiring a meaning does not return headword-only matches', combined.head.length === 0);
    const requests = fetched.length;
    check('headword and meaning conditions intersect the same entry', isDeepStrictEqual((await meanings(q)).map((row) => row.id), [0, 6]));
    check('the second result section reuses the completed scoped query', fetched.length === requests);
    check('scoped regex conditions fetch no definition blocks', !fetched.slice(before).some((name) => name.startsWith('m/')));
    check('meaning AND conditions may match different indexed words', isDeepStrictEqual((await meanings('meaning:/^آموزش$/u AND meaning:/^هنر$/u')).map((row) => row.id), [0]));
    const either = 'headword:/^کمد$/u OR meaning:/^دارو$/u';
    check('OR retains its independently matching headword branch', isDeepStrictEqual((await call('search', { q: either })).head.map((row) => row.id), [4]));
    check('OR retains its independently matching meaning branch', isDeepStrictEqual((await meanings(either)).map((row) => row.id), [3, 7]));
    check('groups combine headword and meaning predicates', isDeepStrictEqual((await meanings('(headword:/^کتاب$/u AND meaning:/هنر/u) OR (headword:/^کتابت$/u AND meaning:/خط/u)')).map((row) => row.id), [0, 6]));
    check('all groups can each contain alternative fields', isDeepStrictEqual((await meanings('(headword:/^کتاب/u OR meaning:/دارو/u) AND (meaning:/خط/u OR meaning:/هنر/u)')).map((row) => row.id), [0, 6]));
    check('scoped both retains headword matches', (await call('search', { q: 'either:/^آموزش$/u' })).head.some((row) => row.id === 5));
    check('scoped both retains meaning matches', (await meanings('either:/^آموزش$/u')).length === 3);
    const compound = await meanings('headword:/^کتاب فرعی$/u AND meaning:/^شعر$/u');
    check('uncited compounds have their own indexed meaning scope', compound.length === 1 && compound[0].id === 2 && compound[0].phrase && compound[0].w === 'کتاب فرعی' && compound[0].range);
    check('compound heading tokens are not mistaken for meaning text', (await meanings('headword:/^کتاب فرعی$/u AND meaning:/^کتاب$/u')).length === 0);
    check('compound meanings cannot satisfy their parent headword condition', (await meanings('headword:/^دفتر$/u AND meaning:/^شعر$/u')).length === 0);
    check('parent meanings cannot satisfy a compound headword condition', (await meanings('headword:/^کتاب فرعی$/u AND meaning:/^آموزش$/u')).length === 0);
    check('origin filters stay independent of scoped patterns', isDeepStrictEqual((await meanings(q, { filters: { arabic: 1 } })).map((row) => row.id), [0]));
    check('subject filters constrain the matched meaning', (await meanings('headword:/^دوا$/u AND meaning:/نور/u', { filters: { 'subject-medicine': 1 } })).length === 0);
    check('subject filters retain eligible meaning matches', (await meanings('headword:/^دوا$/u AND meaning:/دارو/u', { filters: { 'subject-medicine': 1 } })).length === 1);
    check('citation filters compose with independent word/meaning predicates', isDeepStrictEqual((await meanings(q, { filters: { 'source-burhan': 1 } })).map((row) => row.id), [0]));
    const hidden = 'headword:/^دفتر پنهان$/u AND meaning:/راز/u';
    check('compound citation filters use the compound itself', (await meanings(hidden, { filters: { 'source-anandraj': 1 } })).length === 1);
    check('parent citations do not satisfy compound scoped searches', (await meanings(hidden, { filters: { 'source-burhan': 1 } })).length === 0);
    check('parent origin does not satisfy compound scoped searches', (await meanings(hidden, { filters: { arabic: 1 } })).length === 0);
    await install('uncited-owner', { words: ['مادر'], bodies: ['(اِ) parenttoken (برهان)\x04\x05فرزند\x06 ؛ (اِ) childtoken'],
      phrases: ['فرزند'], phraseParents: [0], phraseBodies: ['(اِ) childtoken'] });
    check('complete compound scopes preserve source isolation without cited compounds', (await call('meanings', { q: '/^childtoken$/u', filters: { 'source-burhan': 1 }, exclude: [] })).results.length === 0);
    const rows = 1105;
    await install('limits', { words: Array.from({ length: rows }, (_, id) => id === rows - 1 ? 'کتابهدف' : 'کتاب' + id),
      bodies: Array.from({ length: rows }, (_, id) => '(اِ) token' + (id === rows - 1 ? ' needle' : '')),
      phrases: [], phraseParents: [], phraseBodies: [] });
    check('scoped headword intersections happen before the 400-result cap', isDeepStrictEqual((await call('search', { q: 'headword:/^کتاب/u AND headword:/هدف$/u' })).head.map((row) => row.id), [rows - 1]));
    check('scoped meaning intersections happen before the 1000-result cap', isDeepStrictEqual((await meanings('meaning:/^token$/u AND meaning:/^needle$/u')).map((row) => row.id), [rows - 1]));
    check('mixed field intersections happen before the meaning-result cap', isDeepStrictEqual((await meanings('headword:/هدف$/u AND meaning:/^token$/u')).map((row) => row.id), [rows - 1]));
    const many = await call('meanings', { q: 'meaning:/^token$/u', exclude: [] });
    check('scoped result display remains bounded', many.results.length === 1000 && many.limited);
    const cappedOr = 'headword:/^کتابهدف$/u OR meaning:/^token$/u';
    const cappedHead = await call('search', { q: cappedOr });
    const cappedMeanings = await call('meanings', { q: cappedOr, exclude: [] });
    check('OR preserves a headword beyond the capped meaning results',
      isDeepStrictEqual(cappedHead.head.map((row) => row.id), [rows - 1])
      && isDeepStrictEqual(cappedMeanings.results, many.results)
      && cappedMeanings.limited === many.limited && cappedMeanings.total === many.total);
    const remaining = await call('meanings', { q: 'meaning:/^token$/u', exclude: Array.from({ length: 1000 }, (_, id) => id) });
    check('scoped exclusions are applied before the display limit', remaining.results.length === 105 && remaining.results[0].id === 1000);
    await install('cancel', options);
    let entered;
    let release;
    const started = new Promise((resolve) => { entered = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async (url) => {
      if (new URL(url).pathname.includes('/t/')) { entered(); await waiting; }
      return realFetch(url);
    };
    try {
      const pending = call('search', { q: 'headword:/^کتاب/u AND meaning:/آموزش/u' });
      const cancelled = rejects(pending, /لغو/);
      await started;
      await call('search', { q: 'کتاب' });
      check('ordinary typing cancels an in-progress mixed-field search', await cancelled);
    } finally {
      release();
      globalThis.fetch = realFetch;
    }
    await install('retry', options);
    let failedOnce = false;
    globalThis.fetch = async (url) => {
      if (!failedOnce && new URL(url).pathname.endsWith('/source-senses.txt')) {
        failedOnce = true;
        throw new Error('temporary compound load failure');
      }
      return realFetch(url);
    };
    check('mixed-field searches report a failed compound-index load', await rejects(call('meanings', { q, exclude: [] }), /temporary/));
    check('mixed-field searches can retry the same expression after a load failure', isDeepStrictEqual((await meanings(q)).map((row) => row.id), [0, 6]));
    globalThis.fetch = realFetch;
    const meta = JSON.parse(files.get('meta.json'));
    delete meta.compoundScopeVersion;
    files.set('meta.json', JSON.stringify(meta));
    await import('../www/js/search.worker.js?scoped-old-data');
    await call('init');
    check('old data keeps headword-only scoped conditions usable', (await call('search', { q: 'headword:/^کتاب$/u' })).head.length === 1);
    check('old data requests complete compound indexes for mixed conditions', await rejects(call('search', { q }), /به‌روز کنید/));
    delete meta.tagVersion;
    delete meta.senseVersion;
    delete meta.sourceVersion;
    files.set('meta.json', JSON.stringify(meta));
    await import('../www/js/search.worker.js?scoped-upstream-compounds');
    await call('init');
    const oldCompound = await call('search', { q: 'headword:/^کتاب فرعی$/u' });
    check('compound headword conditions need only the original upstream word/phrase indexes', oldCompound.head.length === 1 && oldCompound.head[0].phrase && oldCompound.head[0].w === 'کتاب فرعی');
  } finally {
    globalThis.fetch = realFetch;
    files.clear();
    for (const [name, value] of backup) files.set(name, value);
  }
}

// Meaning rules share scope semantics, verify absence across the selected text,
// and fall back to displayed definitions for phrases and unindexed characters.
{
  const backup = new Map(files);
  const realWorker = globalThis.Worker;
  const bodies = [
    '(اِ) خورشید و ماه.\x01(اِ) روشنی روز.',
    '(اِ) یادِ آوردن و یادآوردن.',
    '(اِ) آب را از چاه بکش.',
    '(اِ) تنها ماه.',
    '(اِ) Book AA.',
    '(اِ) book aa.',
    '(اِ) ' + 'توضیح '.repeat(510) + 'یاد آوردن و خورشید.',
    '(اِ) (اصطلاح طب) یاد آوردن\x01(اصطلاح منطق) خورشید',
    '(اِ) واژه مادر\x04\x05ترکیب خاص\x06 ؛ (اِ) یاد آوردن و خورشید.',
  ];
  try {
    files.clear();
    for (const [name, bytes] of fixture({ words: ['آفتاب', 'ذکر', 'چاه', 'شب', 'لاتین بزرگ', 'لاتین کوچک', 'بلند', 'دو معنی', 'مادر'], bodies,
      phrases: ['ترکیب خاص'], phraseParents: [8], phraseBodies: ['(اِ) یاد آوردن و خورشید.'],
      stopwords: ['و', 'را', 'از', 'اب'], completeCompounds: true })) files.set(name, bytes);
    await import('../www/js/search.worker.js?meaning-regressions');
    await call('init');
    const meanings = async (q, options = {}) => (await call('meanings', { q, exclude: [], ...options })).results;
    const ids = (rows) => rows.map((row) => row.id).sort((a, b) => a - b);
    const rules = [{ match: 'all', rules: [{ kind: 'contains', value: 'خورشید' }, { kind: 'contains', value: 'ماه' }] }];
    const both = await meanings(buildWordQuery(rules));
    const meaningOnly = await meanings(buildWordQuery([{ ...rules[0], rules: rules[0].rules.map((rule) => ({ ...rule, scope: 'meaning' })) }]));
    check('default AND scope retains every meaning-only AND match', both.length > 0 && meaningOnly.every((row) => both.some((found) => found.id === row.id)));
    const mixed = buildWordQuery([{ match: 'all', rules: [{ kind: 'whole', value: 'آفتاب' }, { kind: 'contains', value: 'ماه' }] }]);
    check('default AND can combine evidence from the title and its meaning', isDeepStrictEqual(ids(await meanings(mixed)), [0]));
    const excluded = buildWordQuery([{ match: 'all', rules: [{ scope: 'headword', kind: 'whole', value: 'آفتاب' }, { scope: 'meaning', kind: 'excludes', value: 'خورشید' }] }]);
    check('without text rejects an entry even when another sense lacks the text', (await meanings(excluded)).length === 0);
    check('custom negative assertions also reject forbidden text in another sense', (await meanings('headword:/^آفتاب$/u AND meaning:/^(?!.*(?:خورشید|ستاره)).*$/u')).length === 0);
    const negative = '/^(?!.*خورشید).*$/u';
    const absent = await meanings(negative);
    check('negative meaning regex rejects every entry containing the forbidden text, including late mentions', !absent.some((row) => [0, 6, 7, 8].includes(row.id)) && absent.some((row) => row.id === 3));
    check('negative meaning matches do not highlight an unrelated indexed word', absent.every((row) => !row.terms && row.match.start === row.match.end));
    const phrase = await meanings('/یاد آوردن/u');
    check('phrase regex finds spaced text, folded diacritics and text beyond the index budget', isDeepStrictEqual(ids(phrase), [1, 6, 7, 8]));
    const first = phrase.find((row) => row.id === 1);
    check('phrase snippets preserve the original diacritics and exact match offsets', first.snippet.text.slice(first.snippet.match.start, first.snippet.match.end) === 'یادِ آوردن');
    check('wildcard regex spans separate words', (await meanings('/یاد.*آوردن/u')).some((row) => row.id === 6));
    check('anchored phrases match complete words inside a definition', (await meanings('/^یاد آوردن$/u')).some((row) => row.id === 1));
    check('complete common words omitted from the index remain searchable', isDeepStrictEqual(ids(await meanings('/^آب$/u')), [2]));
    check('single-letter meaning words remain searchable', (await meanings('/^و$/u')).some((row) => row.id === 0));
    const literal = await meanings('/^آوردن$/u');
    check('escaped Unicode and literal Persian patterns produce identical results', isDeepStrictEqual(await meanings('/^\\u0622وردن$/u'), literal));
    check('code-point escapes use the same Persian folding', isDeepStrictEqual(await meanings('/^\\u{622}وردن$/u'), literal));
    check('Latin uppercase regex matches the displayed uppercase word', isDeepStrictEqual(ids(await meanings('/^Book$/u')), [4]));
    check('Latin lowercase regex preserves case sensitivity', isDeepStrictEqual(ids(await meanings('/^book$/u')), [5]));
    check('case-insensitive meaning regex matches both displayed variants', isDeepStrictEqual(ids(await meanings('/^book$/iu')), [4, 5]));
    check('uppercase character classes can find displayed uppercase letters', isDeepStrictEqual(ids(await meanings('/^[A-Z]{2}$/u')), [4]));
    check('meaning phrases honor selected subject ranges', isDeepStrictEqual(ids(await meanings('/یاد آوردن/u', { filters: { 'subject-medicine': 1 } })), [7]));
    check('meaning exclusions apply only to selected subject ranges', (await meanings(negative, { filters: { 'subject-medicine': 1 } })).some((row) => row.id === 7));
    const compound = await meanings('headword:/^ترکیب خاص$/u AND meaning:/یاد آوردن/u');
    check('phrase scans retain compound ownership and matching ranges', compound.length === 1 && compound[0].phrase && compound[0].range && compound[0].snippet.text.includes('یاد آوردن'));
    check('compound phrases cannot satisfy their parent title', (await meanings('headword:/^مادر$/u AND meaning:/یاد آوردن/u')).length === 0);
    check('compound negative rules reject forbidden text within that compound', (await meanings('headword:/^ترکیب خاص$/u AND meaning:/^(?!.*خورشید).*$/u')).length === 0);
    const progress = [];
    await call('meanings', { q: '/یاد آوردن/u', exclude: [], progress: true }, (update) => progress.push(update));
    check('definition scans stream matching rows and accurate completion counts', progress.some((update) => update.results.length) && progress.at(-1).scanned === progress.at(-1).total && progress.at(-1).matched === phrase.length);
    await import('../www/js/search.worker.js?cancel-definition-regression');
    await call('init');
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    globalThis.Worker = class extends BrowserWorker {
      postMessage(data) { if (data.definitions) entered(); else super.postMessage(data); }
    };
    const pending = meanings('/یاد آوردن/u');
    const cancelled = rejects(pending, /لغو/);
    await started;
    check('entry navigation stays available during definition matching', (await call('entry', { id: 0 })).word === 'آفتاب');
    await call('search', { q: 'شب' });
    check('new queries cancel a stalled definition matcher', await cancelled);
  } finally {
    globalThis.Worker = realWorker;
    files.clear();
    for (const [name, bytes] of backup) files.set(name, bytes);
  }
  const range = new RegExp(normalizeMeaningPattern('[آ-ئ]'), 'u');
  check('folded character ranges retain their original set rather than expanding endpoints', range.test('ا') && range.test('ی') && !range.test('ک'));
  check('escaped punctuation remains literal after pattern folding', new RegExp(normalizeMeaningPattern('\\u002e'), 'u').test('.') && !new RegExp(normalizeMeaningPattern('\\u002e'), 'u').test('x'));
  const named = normalizeMeaningPattern('(?<آب>آب)\\k<آب>');
  check('normalization preserves named capture identifiers and backreferences', new RegExp(named, 'u').test('اباب'));
  const length = meaningPatternMatcher(readMeaningRegex(parseSearchQuery('/^.{4}$/u')));
  check('length helpers count a word rather than a span across short words', length([{ text: 'تو با من' }]) === null && !!length([{ text: 'یک کتاب خوب' }]));
}

// Highlight details are collected lazily for requested rows and opened entries.
{
  const backup = new Map(files), realWorker = globalThis.Worker;
  const words = ['آفتاب', 'یادآوری', 'بدل', 'شب', 'دو معنی', 'مادر', 'تکرار', 'حساس'];
  const bodies = [
    '(اِ) خورشید و ماه. خورشید و ماه.',
    '(اِ) یادِ آوردن و فراموش کردن؛ یاد آوردن و فراموش کردن.',
    '(اِ) خورشید و ماه و دنباله.', '(اِ) همان.',
    '(اِ) (اصطلاح طب) خورشید\x01(اصطلاح منطق) ماه',
    '(اِ) خورشید مادر (برهان)\x04\x05خورشید و ماه\x06 ؛ (اِ) یاد آوردن و فراموش کردن. (آنندراج)',
    '(اِ) ' + 'خورشید '.repeat(250) + 'ماه.', '(اِ) Book book AA aa.',
  ];
  try {
    files.clear();
    for (const [name, bytes] of fixture({ words, bodies, phrases: ['خورشید و ماه'], phraseParents: [5],
      phraseBodies: ['(اِ) یاد آوردن و فراموش کردن. (آنندراج)'], stopwords: ['و'], completeCompounds: true })) files.set(name, bytes);
    await import('../www/js/search.worker.js?lazy-highlights');
    await call('init');
    const query = 'headword:/^آفتاب$/u AND meaning:/خورشید/u AND meaning:/ماه/u';
    const before = await call('meanings', { q: query, exclude: [] });
    const loaded = fetched.length;
    const display = await call('snippets', { q: query, requests: [{ key: 'sun', id: 0, kind: 'm' }] });
    check('visible snippets highlight all searched terms and repetitions', isDeepStrictEqual(display[0].matches.map(({ start, end }) => display[0].text.slice(start, end)), ['خورشید', 'ماه', 'خورشید', 'ماه']));
    check('visible highlight requests load only the requested definition', fetched.slice(loaded).filter((name) => name.startsWith('m/')).every((name) => name === 'm/0.txt') && !fetched.slice(loaded).some((name) => /^[stu]\//.test(name)));
    const names = (id, result) => { const text = compactMeaning(plainMeaning(bodies[id])); return result.matches.map(({ start, end }) => text.slice(start, end)); };
    const full = await call('highlights', { id: 0, q: query });
    check('opened entries retain all positive query highlights', isDeepStrictEqual(names(0, full), ['خورشید', 'ماه', 'خورشید', 'ماه']));
    check('extra highlights do not change cached search results', isDeepStrictEqual((await call('meanings', { q: query, exclude: [] })).results, before.results));
    const phraseQuery = 'headword:/^یادآوری$/u AND meaning:/یاد آوردن/u AND meaning:/فراموش/u';
    const phrase = await call('highlights', { id: 1, q: phraseQuery });
    check('opened entries combine phrase and indexed term highlights', isDeepStrictEqual(names(1, phrase), ['یادِآوردن', 'فراموش', 'یادآوردن', 'فراموش']));
    const phraseSnippet = (await call('snippets', { q: phraseQuery, requests: [{ id: 1, key: 'phrase', kind: 'm' }] }))[0];
    check('phrase snippets retain original diacritics and additional words', markMatch(phraseSnippet.text, phraseSnippet.matches).includes('<mark>یادِ آوردن</mark>') && markMatch(phraseSnippet.text, phraseSnippet.matches).includes('<mark>فراموش</mark>'));
    const alternative = await call('highlights', { id: 1, q: 'meaning:/(?:یاد|فراموش)/u' });
    check('regex alternatives highlight every visible occurrence', isDeepStrictEqual(names(1, alternative), ['یادِ', 'فراموش', 'یاد', 'فراموش']));
    const headQuery = 'headword:/خورشید/u AND headword:/ماه/u';
    const title = (await call('snippets', { q: headQuery, requests: [{ id: 5, word: 'خورشید و ماه', key: 'title', kind: 'h' }] }))[0];
    check('compound result titles retain multiple independent match spans', highlightWord('خورشید و ماه', '', title.headMatches) === '<b>خورشید</b> و <b>ماه</b>');
    const branch = await call('highlights', { id: 2, q: '(meaning:/خورشید/u AND meaning:/نیافته/u) OR meaning:/ماه/u' });
    check('failed OR branches do not contribute stray highlights', isDeepStrictEqual(names(2, branch), ['ماه']));
    const headBranch = (await call('snippets', { q: '(headword:/خورشید/u AND headword:/نیافته/u) OR headword:/ماه/u', requests: [{ id: 5, word: 'خورشید و ماه', key: 'head-or', kind: 'h' }] }))[0];
    check('failed headword branches do not highlight their partial matches', highlightWord('خورشید و ماه', '', headBranch.headMatches) === 'خورشید و <b>ماه</b>');
    const negative = await call('highlights', { id: 3, q: 'meaning:/^(?!.*خورشید).*$/u' });
    check('absence conditions add no positive highlights', negative.matches.length === 0);
    const across = await call('highlights', { id: 4, q: 'meaning:/خورشید/u AND meaning:/ماه/u' });
    check('query terms in separate senses are both highlighted', isDeepStrictEqual(names(4, across), ['خورشید', 'ماه']));
    const medical = await call('highlights', { id: 4, q: 'meaning:/خورشید/u OR meaning:/ماه/u', filters: { 'subject-medicine': 1 } });
    check('entry highlighting respects the selected subject sense', isDeepStrictEqual(names(4, medical), ['خورشید']));
    const child = await call('highlights', { id: 5, word: 'خورشید و ماه', q: 'headword:/^خورشید و ماه$/u AND meaning:/یاد آوردن/u AND meaning:/فراموش/u' });
    check('compound entry highlights stay within that compound', isDeepStrictEqual(names(5, child), ['یادآوردن', 'فراموش']));
    const parent = await call('highlights', { id: 5, q: 'meaning:/خورشید/u OR meaning:/فراموش/u' });
    check('parent highlighting does not include child-only meaning matches', isDeepStrictEqual(names(5, parent), ['خورشید']));
    const cited = await call('highlights', { id: 5, q: 'meaning:/خورشید/u OR meaning:/فراموش/u', filters: { 'source-burhan': 1 } });
    check('entry highlights respect source ownership', isDeepStrictEqual(names(5, cited), ['خورشید']));
    const limits = await call('highlights', { id: 6, q: 'meaning:/خورشید/u AND meaning:/ماه/u' });
    check('highlight budgets retain a later term even after many earlier matches', limits.matches.length <= 200 && names(6, limits).includes('ماه'));
    const limitedSnippet = (await call('snippets', { q: 'meaning:/خورشید/u OR meaning:/ماه/u', requests: [{ id: 6, key: 'limited', kind: 'm' }] }))[0];
    check('snippet highlight collection stays inside its preview', limitedSnippet.matches.length <= 64 && limitedSnippet.matches.every(({ start, end }) => start >= 0 && end <= limitedSnippet.text.length));
    const upper = await call('highlights', { id: 7, q: 'meaning:/Book/u OR meaning:/AA/u' });
    check('extra highlight matches preserve case-sensitive regex flags', isDeepStrictEqual(names(7, upper), ['Book', 'AA']));
    const zero = await call('highlights', { id: 0, q: 'meaning:/(?=خورشید)/u OR meaning:/ماه/u' });
    check('zero-width alternatives finish without inserting empty marks', isDeepStrictEqual(names(0, zero), ['ماه', 'ماه']));
    const overlap = await call('highlights', { id: 1, q: 'meaning:/یاد/u OR meaning:/یاد آوردن/u' });
    check('overlapping term and phrase highlights merge cleanly', isDeepStrictEqual(names(1, overlap), ['یادِآوردن', 'یادآوردن']));
    const pendingKey = 'display-cancel';
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    globalThis.Worker = class extends BrowserWorker {
      postMessage(data) { if (data.highlight) entered(); else super.postMessage(data); }
    };
    const delayed = call('snippets', { q: query, requests: [{ id: 0, key: pendingKey, kind: 'm' }] });
    const cancelled = rejects(delayed, /لغو/);
    await started;
    check('entry navigation remains responsive during extra highlighting', (await call('entry', { id: 3 })).word === 'شب');
    await call('search', { q: 'شب' });
    check('typing a new query cancels outdated highlight work', await cancelled);
  } finally {
    globalThis.Worker = realWorker;
    files.clear();
    for (const [name, bytes] of backup) files.set(name, bytes);
  }
}

// Existing dictionary data needs no additional files for quoted or regex search.
{
  const meta = JSON.parse(files.get('meta.json'));
  delete meta.tagVersion;
  files.set('meta.json', JSON.stringify(meta));
  await import('../www/js/search.worker.js?legacy-token-index');
  await call('init');
  const before = fetched.length;
  check('old data supports quoted index lookup', (await call('meanings', { q: '"یاد"', exclude: [] })).results.some((row) => row.w === 'کتاب'));
  check('old data supports indexed regex', isDeepStrictEqual((await call('meanings', { q: '/مکتوب/', exclude: [] })).results.map((row) => row.w), ['کتاب']));
  check('old data never falls back to a full definition scan', !fetched.slice(before).some((file) => file.startsWith('m/') || file.startsWith('g/')));
  check('old data still identifies missing tag indexes', await rejects(call('search', { q: buildTaggedQuery('/.*/', { arabic: 1 }) }), /به‌روز کنید/));
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
