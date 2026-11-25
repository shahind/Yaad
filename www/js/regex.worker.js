// Run regex searches in a disposable worker so slow patterns can be terminated.
// The search worker keeps dictionary data and other queries available.
import { entryTagText, matchesEntryTags } from './search-origin-grammar.js';
import { meaningPatternMatcher } from './search-meaning-pattern.js';
import { regexSnippet, mergeMatches, takeMatches } from './search-match-text.js';

function contributingRules(node, matched) {
  if (!node.rules) return matched[node.index] ? [node.index] : null;
  const children = node.rules.map((rule) => contributingRules(rule, matched));
  if (node.match === 'all' && children.some((child) => child === null)) return null;
  const accepted = children.filter((child) => child !== null);
  return accepted.length ? [...new Set(accepted.flat())] : null;
}

function wordMatches(re, text, limit) {
  const all = new RegExp(re.source, re.flags + 'g'), matches = [];
  let match;
  while (matches.length < limit && (match = all.exec(text))) {
    if (match[0].length) matches.push({ start: match.index, end: match.index + match[0].length });
    else all.lastIndex = match.index + (all.unicode && text.codePointAt(match.index) > 0xffff ? 2 : 1);
  }
  return matches;
}

function displayMatcher(plan) {
  const leaves = plan.leaves.map((leaf) => ({ ...leaf, head: new RegExp(leaf.head.source, leaf.head.flags),
    meaning: leaf.meaning ? meaningPatternMatcher(leaf.meaning) : null }));
  return (definition) => {
    const status = leaves.map((leaf) => ({
      head: leaf.scope !== 'meaning' && leaf.head.test(definition.word),
      meaning: leaf.scope !== 'headword' && definition.parts.length ? leaf.meaning?.(definition.parts) : null,
    }));
    const active = contributingRules(plan.tree, status.map((row) => !!(row.head || row.meaning))) || [];
    const limit = definition.entry ? 5000 : 64;
    let headMatches;
    if (definition.entry || definition.kind === 'h') {
      const headRules = active.filter((index) => status[index].head && !leaves[index].negative);
      headMatches = mergeMatches(takeMatches(headRules.map((index) => wordMatches(leaves[index].head, definition.word, limit)), limit));
    }
    if (definition.kind === 'h') return { headMatches };
    const meaningRules = active.filter((index) => status[index].meaning);
    const collect = (window) => takeMatches(meaningRules.map((index) => leaves[index].meaning(definition.parts, {
      collect: true, limit, ...(window ? { window } : {}),
    }).matches), limit);
    if (definition.entry) return { headMatches, matches: collect() };
    const first = meaningRules.map((index) => status[index].meaning).find((row) => row.match.end > row.match.start)
      || { part: 0, match: { start: 0, end: 0 } };
    const part = definition.parts[first.part] || { text: '' };
    const { bounds, ...snippet } = regexSnippet(part.text, definition.pron, first.match, true);
    const matches = collect({ part: first.part, from: bounds.from, to: bounds.to });
    const spans = mergeMatches(matches.filter((hit) => hit.part === first.part).map((hit) => ({
      start: bounds.prefix + Math.max(bounds.from, hit.match.start) - bounds.from,
      end: bounds.prefix + Math.min(bounds.to, hit.match.end) - bounds.from,
    })), snippet.text.length);
    return { snippet: { ...snippet, matches: spans } };
  };
}

self.onmessage = ({ data: { words, phrases, tokens, definitions, plans, highlight, source, flags, limit, tags, masks, facets, sources, conditions, metadata = !!tags } }) => {
  try {
    if (highlight) {
      self.postMessage({ highlights: definitions.map(displayMatcher(highlight)) });
      return;
    }
    if (definitions) {
      const patterns = plans.map(meaningPatternMatcher);
      self.postMessage({ matches: patterns.map((test) => definitions.flatMap((row, index) => {
        const match = test(row.parts);
        return match ? [{ index, ...match }] : [];
      })) });
      return;
    }
    if (conditions) {
      const patterns = conditions.map((query) => new RegExp(query.source, query.flags));
      if (tokens) {
        const matches = patterns.map((re, index) => {
          const found = [];
          if (conditions[index].scope === 'headword') return found;
          for (let i = 0; i < tokens.length; i++) if (re.test(tokens[i])) found.push(i);
          return found;
        });
        self.postMessage({ matches });
      } else {
        const count = words.length + phrases.length;
        const masks = patterns.map(() => new Uint32Array(Math.ceil(count / 32)));
        const starts = new Int32Array(count).fill(-1);
        const ends = new Uint32Array(count);
        for (const [offset, list] of [[0, words], [words.length, phrases]]) {
          for (let line = 0; line < list.length; line++) {
            const owner = offset + line;
            for (let index = 0; index < patterns.length; index++) {
              if (conditions[index].scope === 'meaning') continue;
              const match = patterns[index].exec(list[line]);
              if (!match) continue;
              masks[index][owner >>> 5] |= 1 << (owner & 31);
              if (starts[owner] < 0) { starts[owner] = match.index; ends[owner] = match.index + match[0].length; }
            }
          }
        }
        self.postMessage({ masks, starts, ends }, [...masks.map((mask) => mask.buffer), starts.buffer, ends.buffer]);
      }
      return;
    }
    const re = new RegExp(source, flags);
    if (tokens) {
      const matches = [];
      for (let i = 0; i < tokens.length; i++) if (re.test(tokens[i])) matches.push(i);
      self.postMessage({ matches });
      return;
    }
    const tiers = [[], [], [], []];
    const tagText = new Map();
    for (const [phrase, list] of [[false, words], [true, phrases]]) {
      for (let line = 0; line < list.length; line++) {
        const mask = tags ? (phrase ? tags.phrases : tags.entries)[line] : 0n;
        if (masks && !matchesEntryTags(mask, masks) || facets && !(phrase ? facets.phrases : facets.entries)[line]
          || sources && !sources[phrase ? words.length + line : line]) continue;
        const word = list[line];
        if (metadata && !tagText.has(mask)) tagText.set(mask, entryTagText(mask));
        const contexts = metadata && facets ? (phrase ? facets.contexts.phrases : facets.contexts.entries).get(line) : null;
        let match;
        let range = facets && (phrase ? facets.phraseRanges : facets.entryRanges).get(line);
        for (const context of contexts || [{ text: '' }]) {
          const text = metadata ? word + '\n' + tagText.get(mask) + (context.text ? ' ' + context.text : '') : word;
          match = re.exec(text);
          if (match && match.index + match[0].length <= word.length) { range = context.range || range; break; }
          match = null;
        }
        if (!match) continue;
        const start = match.index;
        const end = start + match[0].length;
        if (end > word.length) continue;
        const tier = start === 0 ? (end === word.length ? 0 : 1) : 3;
        if (tiers[tier].length < limit) tiers[tier].push({ line, phrase, tier, match: { start, end }, ...(range ? { range } : {}) });
        if (tiers[0].length === limit) {
          self.postMessage({ results: tiers[0] });
          return;
        }
      }
    }
    self.postMessage({ results: tiers.flat().slice(0, limit) });
  } catch {
    self.postMessage({ error: 'اجرای الگو ناموفق بود.' });
  }
};
