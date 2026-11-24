import { NORM_TABLE } from './normalize.js';

const fold = (char) => {
  const code = char.codePointAt(0);
  if (code === 0x200c || NORM_TABLE[code] === 0) return '';
  return code < 128 || code > 0xffff || NORM_TABLE[code] === 32 ? char : String.fromCharCode(NORM_TABLE[code]);
};
const literal = (char) => char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const classLiteral = (char) => /[\]\\^\-]/.test(char) ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : char;
function classRange(chars) {
  const codes = [...chars].map((char) => char.codePointAt(0)).sort((a, b) => a - b);
  let out = '';
  for (let at = 0; at < codes.length;) {
    let end = at;
    while (codes[end + 1] === codes[end] + 1) end++;
    out += classLiteral(String.fromCodePoint(codes[at]));
    if (end > at) out += (end > at + 1 ? '-' : '') + classLiteral(String.fromCodePoint(codes[end]));
    at = end + 1;
  }
  return out;
}

function atom(source, at) {
  const rest = source.slice(at);
  const escaped = rest.match(/^\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2}))/i);
  if (escaped) return { char: String.fromCodePoint(parseInt(escaped[1] || escaped[2] || escaped[3], 16)), raw: escaped[0], end: at + escaped[0].length };
  if (source[at] === '\\') {
    const special = rest.match(/^\\(?:[pP]\{[^}]*\}|k<[^>]*>)/);
    const raw = special?.[0] || rest.slice(0, 2);
    return { char: /^\\[^a-z\d]/i.test(raw) ? raw.slice(1) : null, raw, end: at + raw.length };
  }
  const char = String.fromCodePoint(source.codePointAt(at));
  return { char, raw: char, end: at + char.length };
}

// Decode character escapes before folding, and map ranges as sets rather than
// moving their endpoints (آ-ئ does not become the much larger range ا-ی).
export function normalizeMeaningPattern(source) {
  let out = '';
  for (let at = 0; at < source.length;) {
    if (source.startsWith('(?<', at) && !/[=!]/.test(source[at + 3])) {
      const end = source.indexOf('>', at + 3);
      out += source.slice(at, end + 1); at = end + 1; continue;
    }
    if (source[at] === '[') {
      out += '['; at++;
      if (source[at] === '^') { out += '^'; at++; }
      while (at < source.length && source[at] !== ']') {
        const first = atom(source, at);
        if (first.char !== null && source[first.end] === '-' && source[first.end + 1] !== ']' && first.end + 1 < source.length) {
          const last = atom(source, first.end + 1);
          if (last.char !== null) {
            const from = first.char.codePointAt(0), to = last.char.codePointAt(0);
            const chars = new Set();
            for (let code = from; code <= Math.min(to, 0xffff); code++) {
              const mapped = fold(String.fromCodePoint(code));
              if (mapped) chars.add(mapped);
            }
            out += classRange(chars);
            if (to > 0xffff) out += `${String.fromCodePoint(Math.max(from, 0x10000))}-${last.char}`;
            at = last.end; continue;
          }
        }
        out += first.char === null ? first.raw : classLiteral(fold(first.char));
        at = first.end;
      }
      out += ']'; at++; continue;
    }
    const item = atom(source, at);
    out += item.char === null ? item.raw : source[at] === '\\' ? literal(fold(item.char)) : fold(item.char);
    at = item.end;
  }
  return out;
}

function wordAnchors(source) {
  let out = '', inClass = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\\') { out += char + (source[++i] || ''); continue; }
    if (char === '[') inClass = true;
    if (char === ']') inClass = false;
    out += !inClass && char === '^' ? '(?<![\\p{L}\\p{N}_])'
      : !inClass && char === '$' ? '(?![\\p{L}\\p{N}_])' : char;
  }
  return out;
}

const foldedCharacters = [];
for (let code = 128; code <= 0xffff; code++) {
  const char = String.fromCharCode(code);
  if (fold(char) !== char) foldedCharacters.push(classLiteral(char));
}
const foldingPattern = new RegExp(`[${foldedCharacters.join('')}]`, 'g');

function originalMatch(text, match) {
  let start = text.length, end = text.length, position = 0;
  for (let at = 0; at < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(at));
    const mapped = fold(char);
    if (mapped && position === match.index) start = at;
    if (mapped && position + mapped.length >= match.index + match[0].length) { end = at + (match[0].length ? char.length : 0); break; }
    position += mapped.length;
    at += char.length;
  }
  if (!match[0].length) return { start, end: start };
  while (end < text.length && !fold(text[end])) end++;
  return { start, end };
}

export function meaningPatternMatcher(plan) {
  const groups = plan.groups.map((group) => ({ ...group, rules: group.rules.map((rule) => {
    const flags = rule.flags.includes('u') ? rule.flags : rule.flags + 'u';
    return { ...rule, re: new RegExp(rule.wholeText || rule.wordOnly ? rule.source : wordAnchors(rule.source), flags) };
  }) }));
  return (parts, { collect = false, limit = 200, window } = {}) => {
    const normalized = parts.map((part) => part.text.replace(foldingPattern, fold));
    let evidence;
    const evaluate = (rule) => {
      let found;
      if (rule.wholeText) {
        const match = rule.re.exec(normalized.join(' ◄ '));
        return { accepted: !!match, evidence: match && match.index + match[0].length <= normalized[0].length
          ? { part: 0, match: originalMatch(parts[0].text, match) } : undefined };
      }
      for (let part = 0; part < normalized.length; part++) {
        let match;
        if (rule.wordOnly) {
          for (const word of normalized[part].matchAll(/[\p{L}\p{N}_]+/gu)) {
            match = rule.re.exec(word[0]);
            if (match) { match.index += word.index; break; }
          }
        } else match = rule.re.exec(normalized[part]);
        if (!match) continue;
        found = { part, match: originalMatch(parts[part].text, match) };
        break;
      }
      const accepted = rule.negative ? !found : !!found;
      return { accepted, evidence: accepted && !rule.negative ? found : undefined };
    };
    const matches = groups.map((group) => {
      const results = group.rules.map(evaluate);
      const accepted = group.match === 'any' ? results.some((row) => row.accepted) : results.every((row) => row.accepted);
      return { accepted, results, evidence: accepted ? results.find((row) => row.evidence?.match.end > row.evidence?.match.start)?.evidence : undefined };
    });
    const accepted = plan.match === 'any' ? matches.some((row) => row.accepted) : matches.every((row) => row.accepted);
    if (!accepted) return null;
    evidence = matches.find((row) => row.evidence)?.evidence;
    const first = evidence || { part: 0, match: { start: 0, end: 0 } };
    if (!collect) return first;
    const found = [];
    const rulesCount = groups.reduce((count, group, gi) => count + (matches[gi].accepted ? group.rules.filter((rule, ri) => matches[gi].results[ri].accepted && !rule.negative).length : 0), 0);
    const perRule = Math.max(1, Math.floor(limit / (rulesCount || 1)));
    for (let group = 0; group < groups.length && found.length < limit; group++) {
      if (!matches[group].accepted) continue;
      for (let index = 0; index < groups[group].rules.length && found.length < limit; index++) {
        const rule = groups[group].rules[index];
        if (!matches[group].results[index].accepted || rule.negative || rule.wholeText && rule.source.startsWith('^(?!')) continue;
        const end = Math.min(limit, found.length + perRule);
        const re = new RegExp(rule.re.source, rule.re.flags + 'g');
        for (let part = 0; part < parts.length && found.length < end; part++) {
          if (window && window.part !== part) continue;
          const from = window ? parts[part].text.slice(0, window.from).replace(foldingPattern, fold).length : 0;
          const to = window ? parts[part].text.slice(0, window.to).replace(foldingPattern, fold).length : normalized[part].length;
          const targets = rule.wordOnly ? normalized[part].matchAll(/[\p{L}\p{N}_]+/gu) : [{ 0: normalized[part], index: 0 }];
          for (const target of targets) {
            if (target.index + target[0].length < from || target.index > to) continue;
            re.lastIndex = Math.max(0, from - target.index);
            let match;
            while (found.length < end && (match = re.exec(target[0]))) {
              if (match.index + target.index >= to) break;
              if (!match[0].length) {
                re.lastIndex = match.index + (target[0].codePointAt(match.index) > 0xffff ? 2 : 1);
                continue;
              }
              match.index += target.index;
              found.push({ part, match: originalMatch(parts[part].text, match) });
            }
            if (found.length >= end) break;
          }
        }
      }
    }
    return { ...first, matches: found };
  };
}
