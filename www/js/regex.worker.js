// Run regex searches in a disposable worker so slow patterns can be terminated.
// The search worker keeps dictionary data and other queries available.
import { entryTagText, matchesEntryTags } from './search-origin-grammar.js';

self.onmessage = ({ data: { words, phrases, tokens, source, flags, limit, tags, masks, facets, sources, conditions, metadata = !!tags } }) => {
  try {
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
