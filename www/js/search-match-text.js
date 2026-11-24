// Shared text and match offsets for quoted/regex search, snippets and highlighting.
export const plainMeaning = (body) =>
  body
    .replace(/\x0e([^\x0f]*)\x0f/g, '[$1]')
    .replace(/\x01/g, ' ◄ ')
    .replace(/\x04/g, ' ♦ ')
    .replace(/[\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function regexSnippet(text, pron, match, bounds = false) {
  let from = Math.max(0, match.start - 40);
  if (from) {
    const space = text.indexOf(' ', from);
    if (space >= 0 && space < match.start) from = space + 1;
  }
  const to = Math.min(text.length, Math.max(from + 200, match.start + 1));
  const prefix = from ? '… ' : '';
  return {
    pron,
    text: prefix + text.slice(from, to) + (to < text.length ? ' …' : ''),
    match: { start: prefix.length + match.start - from, end: prefix.length + Math.min(match.end, to) - from },
    ...(bounds ? { bounds: { from, to, prefix: prefix.length } } : {}),
  };
}

export function mergeMatches(matches, length = Infinity) {
  const sorted = (matches || []).filter((match) => match && Number.isFinite(match.start) && Number.isFinite(match.end))
    .map(({ start, end }) => ({ start: Math.max(0, start), end: Math.min(length, end) }))
    .filter(({ start, end }) => end > start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const match of sorted) {
    const last = merged.at(-1);
    if (last && match.start <= last.end) last.end = Math.max(last.end, match.end);
    else merged.push({ ...match });
  }
  return merged;
}

// Coordinates after removing rendering whitespace and sense/compound symbols.
export const compactMeaning = (text) => text.replace(/[\s◄♦]/g, '');

export function compactMatches(body, parts, matches) {
  const offsets = new Map();
  return mergeMatches(matches.map(({ part, match }) => {
    if (!offsets.has(part)) {
      const text = parts[part].text;
      const positions = new Uint32Array(text.length + 1);
      for (let i = 0; i < text.length; i++) positions[i + 1] = positions[i] + (compactMeaning(text[i]) ? 1 : 0);
      offsets.set(part, { positions, base: compactMeaning(plainMeaning(body.slice(0, parts[part].range?.[0] || 0))).length });
    }
    const { positions, base } = offsets.get(part);
    return { start: base + positions[match.start], end: base + positions[match.end] };
  }));
}

// Locate a literal match in rendered text fragments without executing user regexes
// on the UI thread. Formatting whitespace and sense/sub-entry markers may differ.
export function literalRange(parts, needle, before = '') {
  const compact = (text) => text.replace(/[\s◄♦]/g, '');
  const target = compact(needle);
  if (!target) return null;
  let text = '';
  const positions = [];
  for (let part = 0; part < parts.length; part++) {
    for (let offset = 0; offset < parts[part].length; offset++) {
      const ch = parts[part][offset];
      if (!compact(ch)) continue;
      text += ch;
      positions.push({ part, offset });
    }
  }
  const prefix = compact(before);
  const sample = prefix + target;
  let occurrence = 0;
  for (let at = sample.indexOf(target); at >= 0 && at < prefix.length; at = sample.indexOf(target, at + 1)) occurrence++;
  let at = text.indexOf(target);
  while (occurrence-- > 0 && at >= 0) at = text.indexOf(target, at + 1);
  if (at < 0) return null;
  return { start: positions[at], end: { ...positions[at + target.length - 1], offset: positions[at + target.length - 1].offset + 1 } };
}
