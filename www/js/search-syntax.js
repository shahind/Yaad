// Quoted/regex search syntax and pattern helpers shared by the UI and worker.
import { ENTRY_TAGS } from './search-origin-grammar.js';
import { SENSE_TAGS, normalizeSenseFilters } from './search-subject-usage.js';
import { SOURCE_TAGS } from './search-citations.js';
import { normalizeSpaced, normalizeQuoted } from './normalize.js';
import { normalizeMeaningPattern } from './search-meaning-pattern.js';

const QUOTES = new Map([['"', '"'], ['“', '”'], ['«', '»']]);
const MAX_PATTERN_LENGTH = 500;
const MAX_TAGGED_LENGTH = 4000;
const TAG_END = '(?=[^\\n]*\\n)';
const WORD_TAIL = '[^\\n]*$';
const RULE_START = '(?=[^\\n]*?(?:';
export const SEARCH_SCOPES = [
  ['both', 'واژه و معنی', 'either'],
  ['headword', 'واژه یا ترکیب', 'headword'],
  ['meaning', 'معنی', 'meaning'],
];
const activeRule = (rule) => rule.kind === 'exact' ? String(rule.value).length : String(rule.value).trim();
export const SEARCH_TAGS = [...ENTRY_TAGS, ...SENSE_TAGS];
export const SEARCH_FILTER_TAGS = [...SEARCH_TAGS.filter((tag) => !tag.aliasOf), ...SOURCE_TAGS];
export const hasTagFilters = (filters = {}) => SEARCH_FILTER_TAGS.some((tag) => filters[tag.key] === 1 || filters[tag.key] === -1);

export const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export function parseSearchQuery(input) {
  const text = String(input).trim();
  const closing = QUOTES.get(text[0]);
  if (closing) {
    if (text.length < 2 || !text.endsWith(closing)) {
      throw new Error('عبارت را در گیومه بگذارید؛ مانند «یاد».');
    }
    return { mode: 'exact', text: text.slice(1, -1) };
  }
  if (/^\(*\s*(?:headword|meaning|either)\s*:/.test(text)) return parseScopedQuery(text);
  if (!text.startsWith('/')) return { mode: 'text', text };
  const end = text.lastIndexOf('/');
  if (end === 0) throw new Error('الگو را با / ببندید؛ مانند /^یاد/.');
  const source = text.slice(1, end);
  const flags = text.slice(end + 1) || 'u';
  if (!source) throw new Error('الگوی جستجو خالی است.');
  const maxLength = isTaggedPattern(source) || isCombinedPattern(source) ? MAX_TAGGED_LENGTH : MAX_PATTERN_LENGTH;
  if (source.length > maxLength) throw new Error(`الگو حداکثر ${maxLength.toLocaleString('fa-IR')} نویسه باشد.`);
  if (!/^[imsu]+$/.test(flags) || new Set(flags).size !== flags.length) {
    throw new Error('پرچم‌ها: i، m، s، u؛ بدون تکرار.');
  }
  try {
    new RegExp(source, flags);
  } catch {
    throw new Error('الگو نامعتبر است؛ نشانه‌ها و پرانتزها را بررسی کنید.');
  }
  return { mode: 'regex', source, flags };
}

// Scoped conditions use explicit field names rather than pretending that one
// regex can match a headword and its indexed meanings at the same time.
function parseScopedQuery(text) {
  if (text.length > MAX_TAGGED_LENGTH) throw new Error('شرط‌های جستجو بیش از اندازه طولانی‌اند.');
  let at = 0;
  let count = 0;
  let depth = 0;
  const invalid = () => { throw new Error('شرط را مانند headword:/^یاد/u AND meaning:/خاطر/u بنویسید.'); };
  const space = () => { while (/\s/.test(text[at] || '') && at < text.length) at++; };
  const join = (match, a, b) => ({ match, rules: [a, b].flatMap((node) => node.match === match ? node.rules : [node]) });
  const atom = () => {
    space();
    if (text[at] === '(') {
      if (++depth > 8) invalid();
      at++;
      const node = expression();
      space();
      if (text[at++] !== ')') invalid();
      depth--;
      return node;
    }
    const field = text.slice(at).match(/^(headword|meaning|either)\s*:\s*/);
    if (!field) invalid();
    at += field[0].length;
    const start = at;
    if (text[at++] !== '/') invalid();
    let inClass = false;
    for (; at < text.length; at++) {
      const ch = text[at];
      if (ch === '\\') { at++; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) break;
    }
    if (at === text.length) invalid();
    at++;
    while (/[a-z]/i.test(text[at] || '') && at < text.length) at++;
    if (++count > 32) throw new Error('حداکثر ۳۲ شرط جستجو بسازید.');
    return { scope: field[1] === 'either' ? 'both' : field[1], query: parseSearchQuery(text.slice(start, at)) };
  };
  const operation = (word) => {
    space();
    if (!text.slice(at).startsWith(word) || /[a-z]/i.test(text[at + word.length] || '')) return false;
    at += word.length;
    return true;
  };
  const conjunction = () => {
    let node = atom();
    while (operation('AND')) node = join('all', node, atom());
    return node;
  };
  const expression = () => {
    let node = conjunction();
    while (operation('OR')) node = join('any', node, conjunction());
    return node;
  };
  const tree = expression();
  space();
  if (at !== text.length) invalid();
  const groups = scopedGroups(tree);
  return { mode: 'scoped', expression: tree, flags: groups[0].rules[0].query.flags,
    hasMeanings: groups.some((group) => group.rules.some((node) => node.scope !== 'headword')) };
}

function scopedGroups(tree) {
  if (!tree.rules) return [{ match: 'all', rules: [tree] }];
  if (tree.rules.every((node) => !node.rules)) return [{ match: tree.match, rules: tree.rules }];
  if (tree.rules.some((node) => node.rules?.some((child) => child.rules))) {
    throw new Error('گروه‌بندی شرط‌ها را ساده‌تر کنید؛ هر گروه فقط شرط داشته باشد.');
  }
  return tree.rules.map((node) => node.rules ? node : { match: 'all', rules: [node] });
}

export function buildScopedQuery(groups, match = 'any', flags = 'u') {
  const parts = groups.flatMap((group) => {
    const rules = group.rules.filter(activeRule).map((rule) => {
      const field = SEARCH_SCOPES.find(([scope]) => scope === (rule.scope || 'both'));
      if (!field) throw new Error('جای جستجو شناخته نشد.');
      return `${field[2]}:${buildSearchQuery(rule.kind, rule.value, {}, rule.flags || flags)}`;
    });
    return rules.length ? [rules.length === 1 ? rules[0] : `(${rules.join(group.match === 'any' ? ' OR ' : ' AND ')})`] : [];
  });
  const text = parts.join(match === 'all' ? ' AND ' : ' OR ');
  if (text) parseSearchQuery(text);
  return text;
}

// RegExp.source escapes literal delimiters and line breaks. The preview can then
// be copied as a regex literal without search inputs silently stripping newlines.
function regexQuery(source, flags) {
  parseSearchQuery(`/${source}/${flags}`);
  const query = `/${new RegExp(source, flags).source}/${flags}`;
  parseSearchQuery(query);
  return query;
}

// Recognize metadata wrappers from earlier queries. Current tag controls send
// independent filters; the assertion keeps legacy matches on the headword line.
export const isTaggedPattern = (source) => source.includes(TAG_END);
const isCombinedPattern = (source) => source.startsWith('^(?') && source.endsWith(WORD_TAIL);

const tagCondition = (tag, state) => `(?${state === 1 ? '=' : '!'}[^\\n]*\\n[^\\n]*\\(${escapeRegex(tag.code)}\\))`;

// Legacy query serialization. The UI now sends tag filters separately.
export function buildTaggedQuery(input, filters = {}) {
  filters = normalizeSenseFilters(filters);
  const selected = SEARCH_TAGS.filter((tag) => filters[tag.key] === 1 || filters[tag.key] === -1);
  if (!selected.length) return input;
  const query = parseSearchQuery(input);
  const source = query.mode === 'regex' ? query.source
    : escapeRegex(query.text) || '.*';
  const flags = query.mode === 'regex' ? query.flags : 'u';
  const conditions = selected.map((tag) => tagCondition(tag, filters[tag.key])).join('');
  // m gives ^/$ their usual headword boundaries before the appended metadata line.
  return regexQuery(`${conditions}(?:${source})${TAG_END}`, flags.includes('m') ? flags : 'm' + flags);
}

// Reopen generated expressions with the same choices. Unknown/custom regex syntax
// remains editable as-is instead of silently inventing checkbox state.
export function readSearchBuilder(input) {
  const query = parseSearchQuery(input);
  if (query.mode === 'scoped') {
    return { query, filters: {}, match: query.expression.rules?.some((node) => node.rules) ? query.expression.match : 'any', groups: scopedGroups(query.expression).map((group) => ({
      match: group.match,
      rules: group.rules.map((node) => ({ ...readPatternRule(node.query.source), scope: node.scope,
        ...(node.query.flags !== query.flags ? { flags: node.query.flags } : {}) })),
    })) };
  }
  const result = (wordQuery, filters) => ({ query: wordQuery, filters: normalizeSenseFilters(filters), ...readWordRules(wordQuery) });
  if (query.mode !== 'regex' || !isTaggedPattern(query.source)) return result(query, {});
  let source = query.source;
  const filters = {};
  for (;;) {
    let found = false;
    for (const tag of SEARCH_TAGS) {
      for (const state of [1, -1]) {
        const condition = tagCondition(tag, state);
        if (!source.startsWith(condition)) continue;
        if (Object.hasOwn(filters, tag.key)) return result(query, {});
        filters[tag.key] = state;
        source = source.slice(condition.length);
        found = true;
        break;
      }
      if (found) break;
    }
    if (!found) break;
  }
  if (!Object.keys(filters).length || !source.startsWith('(?:') || !source.endsWith(')' + TAG_END)) {
    return result(query, {});
  }
  return result({ ...query, source: source.slice(3, -TAG_END.length - 1) }, filters);
}

export function buildSearchQuery(kind, input, filters = {}, flags = 'u') {
  const text = kind === 'exact' ? String(input) : String(input).trim();
  if (!text) {
    if (SEARCH_TAGS.some((tag) => filters[tag.key] === 1 || filters[tag.key] === -1)) return buildTaggedQuery(`/.*/${flags}`, filters);
    throw new Error('متن یا تعداد نویسه‌ها را وارد کنید.');
  }
  const literal = escapeRegex(text);
  let source;
  switch (kind) {
    case 'exact': source = literal; break;
    case 'whole': source = `^${literal}$`; break;
    case 'regex': source = text; break;
    case 'starts': source = `^${literal}`; break;
    case 'ends': source = `${literal}$`; break;
    case 'contains': source = literal; break;
    case 'excludes': source = `^(?!.*${literal}).*$`; break;
    case 'not-starts': source = `^(?!${literal}).*$`; break;
    case 'not-ends': source = `^(?!.*${literal}$).*$`; break;
    case 'either': {
      const choices = text.split(/[,،\n]/).map((s) => s.trim()).filter(Boolean);
      if (choices.length < 2) throw new Error('دست‌کم دو گزینه را با ویرگول جدا کنید.');
      source = `(?:${choices.map(escapeRegex).join('|')})`;
      break;
    }
    case 'letters': source = `^(?:${[...new Set(text.replace(/\s/g, ''))].map(escapeRegex).join('|')})+$`; break;
    case 'wildcard': source = `^${[...text].map((ch) => ch === '*' ? '.*' : ch === '?' ? '.' : escapeRegex(ch)).join('')}$`; break;
    case 'length':
    case 'min-length':
    case 'max-length': {
      const digits = text.replace(/[۰-۹٠-٩]/g, (ch) => String(ch.charCodeAt(0) - (ch >= '۰' ? 0x06f0 : 0x0660)));
      const length = Number(digits);
      if (!/^\d+$/.test(digits) || length < 1 || length > 100) throw new Error('طول باید بین ۱ و ۱۰۰ باشد.');
      const count = kind === 'min-length' ? `${length},` : kind === 'max-length' ? `0,${length}` : length;
      source = `^.{${count}}$`;
      break;
    }
    case 'length-range': {
      const digits = text.replace(/[۰-۹٠-٩]/g, (ch) => String(ch.charCodeAt(0) - (ch >= '۰' ? 0x06f0 : 0x0660)));
      const range = digits.match(/^(\d+)\s*[-–،,]\s*(\d+)$/);
      if (!range || +range[1] < 1 || +range[2] > 100 || +range[1] > +range[2]) {
        throw new Error('بازه را از کم به زیاد، بین ۱ و ۱۰۰ بنویسید؛ مانند ۳-۷.');
      }
      source = `^.{${+range[1]},${+range[2]}}$`;
      break;
    }
    default: throw new Error('نوع الگو شناخته نشد.');
  }
  return buildTaggedQuery(regexQuery(source, flags), filters);
}

// Every rule tests the same headword independently. AND/OR groups are themselves
// regex assertions, so copying the resulting query carries the complete logic.
export function buildCombinedQuery(groups, match = 'any', filters = {}, flags = 'u') {
  const active = groups.map((group, index) => ({
    index,
    match: group.match,
    rules: group.rules.map((rule, index) => ({ ...rule, index })).filter(activeRule),
  })).filter((group) => group.rules.length);
  if (!active.length) return buildSearchQuery('contains', '', filters, flags);
  if (active.length === 1 && active[0].rules.length === 1) {
    const rule = active[0].rules[0];
    return buildSearchQuery(rule.kind, rule.value, filters, flags);
  }
  const sources = active.map((group) => ({
    match: group.match,
    sources: group.rules.map((rule) => {
      try {
        return parseSearchQuery(buildSearchQuery(rule.kind, rule.value, {}, flags)).source;
      } catch (error) {
        throw new Error(`گروه ${(group.index + 1).toLocaleString('fa-IR')}، شرط ${(rule.index + 1).toLocaleString('fa-IR')}: ${error.message}`);
      }
    }),
  }));
  const tagged = SEARCH_TAGS.some((tag) => filters[tag.key] === 1 || filters[tag.key] === -1)
    || sources.some((group) => group.sources.some(isTaggedPattern));
  const end = tagged ? '\\n' : '$';
  const builtGroups = sources.map((group) => {
    const rules = group.sources.map((source) => `${RULE_START}${source})(?=[^\\n]*${end}))`);
    return `(?:${rules.join(group.match === 'any' ? '|' : '')})`;
  });
  const body = match === 'all' ? builtGroups.map((group) => `(?=${group})`).join('') : `(?:${builtGroups.join('|')})`;
  return buildTaggedQuery(regexQuery(`^${body}${WORD_TAIL}`, flags), filters);
}

// Changing independent tag controls must not turn ordinary text or quoted input
// into a regex. Only editing word rules changes the search syntax.
export function buildWordQuery(groups, match = 'any', flags = 'u', original = '') {
  const current = readSearchBuilder(original);
  const originalFlags = current.query.mode === 'regex' || current.query.mode === 'scoped' ? current.query.flags : 'u';
  const activeGroups = (groups) => groups.map((group) => ({ ...group, rules: group.rules.filter(activeRule).map((rule) => {
    const { scope, ...rest } = rule;
    return scope && scope !== 'both' ? rule : rest;
  }) })).filter((group) => group.rules.length);
  if (!Object.keys(current.filters).length && JSON.stringify([activeGroups(groups), match, flags]) === JSON.stringify([activeGroups(current.groups), current.match, originalFlags])) return original;
  const active = groups.some((group) => group.rules.some(activeRule));
  if (!active) return '';
  return groups.flatMap((group) => group.rules.filter(activeRule)).length > 1
    || groups.some((group) => group.rules.some((rule) => activeRule(rule) && rule.scope && rule.scope !== 'both'))
    ? buildScopedQuery(groups, match, flags) : buildCombinedQuery(groups, match, {}, flags);
}

// Migrate the canonical tag wrappers emitted by earlier builder versions. Custom
// metadata regexes keep their explicit regex semantics.
export function separateSearchFilters(input) {
  if (!String(input).startsWith('/') || !String(input).includes(TAG_END)) return { q: input, filters: {} };
  const query = parseSearchQuery(input);
  const parsed = readHeadwordRegex(query);
  if (!parsed || parsed.metadata) return { q: input, filters: {} };
  return { q: parsed.tagOnly ? '' : regexQuery(parsed.query.source, parsed.query.flags), filters: parsed.filters };
}

// Read only the canonical structures emitted above. Other regexes stay available
// as custom rules, including expressions with nested groups or character classes.
function regexGroup(source, start = 0) {
  if (source[start] !== '(') return null;
  let depth = 0;
  let inClass = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (!inClass && ch === '(') depth++;
    else if (!inClass && ch === ')' && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

function splitAlternatives(source) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] === '(') {
      const group = regexGroup(source, i);
      if (!group) return null;
      i += group.length - 1;
    } else if (source[i] === '|') {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function literalValue(source) {
  const text = source.replace(/\\([.*+?^${}()|[\]\\/])/g, '$1');
  return escapeRegex(text) === source ? text : null;
}

function readPatternRule(source) {
  const length = source.match(/^\^\.\{(\d+)(,(\d*))?\}\$$/);
  if (length) {
    if (!length[2]) return { kind: 'length', value: length[1] };
    if (!length[3]) return { kind: 'min-length', value: length[1] };
    if (length[1] === '0') return { kind: 'max-length', value: length[3] };
    return { kind: 'length-range', value: `${length[1]}-${length[3]}` };
  }
  for (const [kind, prefix, suffix] of [
    ['excludes', '^(?!.*', ').*$'], ['not-ends', '^(?!.*', '$).*$'], ['not-starts', '^(?!', ').*$'],
    ['whole', '^', '$'], ['starts', '^', ''], ['ends', '', '$'], ['contains', '', ''],
  ]) {
    if (!source.startsWith(prefix) || !source.endsWith(suffix)) continue;
    const value = literalValue(source.slice(prefix.length, suffix ? -suffix.length : undefined));
    if (value) {
      if (value !== value.trim()) return kind === 'contains' ? { kind: 'exact', value } : { kind: 'regex', value: source };
      return { kind, value };
    }
  }
  for (const [kind, prefix, suffix] of [['either', '(?:', ')'], ['letters', '^(?:', ')+$']]) {
    if (!source.startsWith(prefix) || !source.endsWith(suffix)) continue;
    const parts = splitAlternatives(source.slice(prefix.length, -suffix.length));
    const values = parts?.map(literalValue);
    if (!values?.length || values.some((value) => !value)) continue;
    if (kind === 'either' && values.length > 1 && values.every((value) => !/[,،]/.test(value))) {
      return { kind, value: values.join('، ') };
    }
    if (kind === 'letters' && values.every((value) => [...value].length === 1 && !/\s/.test(value))) {
      return { kind, value: values.join('') };
    }
  }
  if (source.startsWith('^') && source.endsWith('$')) {
    const body = source.slice(1, -1);
    let value = '';
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '.' && body[i + 1] === '*') { value += '*'; i++; }
      else if (body[i] === '.') value += '?';
      else if (body[i] === '\\' && i + 1 < body.length) {
        const literal = literalValue(body.slice(i, i + 2));
        if (literal === null || literal === '*' || literal === '?') { value = ''; break; }
        value += literal;
        i++;
      } else if (literalValue(body[i]) !== null && body[i] !== '*' && body[i] !== '?') value += body[i];
      else { value = ''; break; }
    }
    if (value) return { kind: 'wildcard', value };
  }
  return { kind: 'regex', value: source };
}

function readRuleGroup(source) {
  if (!source.startsWith('(?:') || regexGroup(source) !== source) return null;
  const body = source.slice(3, -1);
  const rules = [];
  let match = null;
  for (let at = 0; at < body.length;) {
    const leaf = regexGroup(body, at);
    const suffix = [')(?=[^\\n]*$))', ')(?=[^\\n]*\\n))'].find((end) => leaf?.endsWith(end));
    if (!leaf?.startsWith(RULE_START) || !suffix) return null;
    rules.push(readPatternRule(leaf.slice(RULE_START.length, -suffix.length)));
    at += leaf.length;
    if (at === body.length) break;
    const separator = body[at] === '|' ? 'any' : 'all';
    if (match && match !== separator) return null;
    match = separator;
    if (separator === 'any') at++;
  }
  return rules.length ? { match: match || 'all', rules } : null;
}

function readWordRules(query) {
  const fallback = () => {
    let rule = query.mode === 'regex' ? readPatternRule(query.source)
      : { kind: query.mode === 'exact' ? 'exact' : 'starts', value: query.text };
    return { match: 'any', groups: [{ match: 'all', rules: [rule] }] };
  };
  if (query.mode !== 'regex' || !isCombinedPattern(query.source)) return fallback();
  const body = query.source.slice(1, -WORD_TAIL.length);
  let match;
  let parts;
  if (body.startsWith('(?:') && regexGroup(body) === body) {
    match = 'any';
    parts = splitAlternatives(body.slice(3, -1));
  } else {
    match = 'all';
    parts = [];
    for (let at = 0; at < body.length;) {
      const group = regexGroup(body, at);
      if (!group?.startsWith('(?=')) return fallback();
      parts.push(group.slice(3, -1));
      at += group.length;
    }
  }
  const groups = parts?.map(readRuleGroup);
  if (!groups?.length || groups.some((group) => !group)) return fallback();
  return { match, groups };
}

// Internal phrase words are complete tokens; the final word can be a prefix when
// no separator follows it inside the quotes. The first fragment may be a suffix
// of a longer word, so multi-word phrases need not use it as an index restriction.
export function quotedIndexTerms(text) {
  const literal = normalizeQuoted(text);
  const tokens = normalizeSpaced(literal).split(' ').filter(Boolean);
  return tokens.map((token, index) => ({
    token,
    prefix: index === tokens.length - 1 && literal.endsWith(token),
  })).filter(({ token }, index) => token.length > 1 && !(index === 0 && tokens.length > 1 && literal.startsWith(token))).slice(-6);
}

// Read legacy builder tag conditions as index checks. Hand-edited metadata regexes
// retain the original two-line context and final line guard.
export function readHeadwordRegex(query) {
  const builder = readSearchBuilder(`/${query.source}/${query.flags}`);
  if (!Object.keys(builder.filters).length) return null;
  const tagOnly = builder.query.source === '.*';
  let metadata = !tagOnly && (query.flags.includes('s') || !query.flags.includes('m')
    || builder.groups.some((group) => group.rules.some((rule) => rule.kind === 'regex')));
  let wordQuery = builder.query;
  if (!metadata && !tagOnly && isTaggedPattern(wordQuery.source)) {
    try {
      wordQuery = parseSearchQuery(buildCombinedQuery(builder.groups, builder.match, {}, query.flags));
    } catch {
      // Hand-edited rules can exceed helper input limits while remaining valid regex.
      metadata = true;
    }
  }
  if (metadata) wordQuery = { ...builder.query, source: `(?:${builder.query.source})${TAG_END}` };
  return { query: wordQuery, filters: builder.filters, tagOnly, metadata };
}

// A fixed token prefix can target the existing prefix shards. Unanchored regexes
// must inspect the vocabulary; no definition bodies are scanned for regex lookup.
export function readMeaningRegex(query) {
  const builder = readSearchBuilder(`/${query.source}/${query.flags}`);
  if (isTaggedPattern(query.source) && !Object.keys(builder.filters).length) return null;
  // Combined tagged helpers contain line guards inside their word assertions.
  // Rebuild those assertions without metadata before matching individual tokens.
  const wordQuery = isTaggedPattern(builder.query.source)
    ? parseSearchQuery(buildCombinedQuery(builder.groups, builder.match, {}, builder.query.flags)) : builder.query;
  if (isTaggedPattern(wordQuery.source)) return null;
  // Fold literal Persian/Arabic letters and digits to the same indexed form.
  // ASCII regex syntax, case flags and explicit escapes retain their meaning.
  const source = normalizeMeaningPattern(wordQuery.source);
  try {
    new RegExp(source || '(?!)', wordQuery.flags);
  } catch {
    return null;
  }
  const normalizedBuilder = readWordRules({ ...wordQuery, source: source || '(?!)' });
  const combine = (parts, match) => {
    if (match === 'any') return parts.some((part) => part === null) ? null : [...new Set(parts.flat())];
    const known = parts.filter((part) => part !== null);
    return known.sort((a, b) => Math.min(...b.map((s) => s.length)) - Math.min(...a.map((s) => s.length)))[0] || null;
  };
  const prefix = (rule) => {
    if (rule.kind === 'starts' || rule.kind === 'whole') return rule.value ? [rule.value] : null;
    if (rule.kind === 'wildcard') {
      const first = rule.value.split(/[?*]/)[0];
      return first ? [first] : null;
    }
    return null;
  };
  return {
    query: { ...wordQuery, source: source || '(?!)' },
    filters: builder.filters,
    match: normalizedBuilder.match,
    groups: normalizedBuilder.groups.map((group) => ({ match: group.match, rules: group.rules.map((rule) => {
      const negative = ['excludes', 'not-starts', 'not-ends'].includes(rule.kind);
      const kind = negative ? { excludes: 'contains', 'not-starts': 'starts', 'not-ends': 'ends' }[rule.kind] : rule.kind;
      let query;
      try { query = parseSearchQuery(buildSearchQuery(kind, rule.value, {}, wordQuery.flags)); }
      catch { query = { source, flags: wordQuery.flags }; }
      return { source: normalizeMeaningPattern(query.source), flags: query.flags, negative,
        wholeText: rule.kind === 'regex' && /\(\?(?:!|<!)/.test(rule.value),
        wordOnly: ['letters', 'length', 'min-length', 'max-length', 'length-range', 'wildcard'].includes(rule.kind) && !/\s/.test(rule.value),
        kind: rule.kind, value: normalizeQuoted(rule.value) };
    }) })),
    prefixes: query.flags.includes('i') ? null
      : combine(normalizedBuilder.groups.map((group) => combine(group.rules.map(prefix), group.match)), normalizedBuilder.match)?.map((value) => normalizeQuoted(value)) || null,
  };
}
