// Shared text and match offsets for quoted/regex search, snippets and highlighting.
export const plainMeaning = (body) =>
  body
    .replace(/\x0e([^\x0f]*)\x0f/g, '[$1]')
    .replace(/\x01/g, ' ◄ ')
    .replace(/\x04/g, ' ♦ ')
    .replace(/[\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function regexSnippet(text, pron, match) {
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
  };
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
