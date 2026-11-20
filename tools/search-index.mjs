// Search-index writers and tag totals shared by the data builder and fixture tests.
import { Buffer } from 'node:buffer';
import { ENTRY_TAGS } from '../www/js/search-origin-grammar.js';
import { SENSE_TAGS, canonicalSenseIds } from '../www/js/search-subject-usage.js';
import { SOURCE_TAGS } from '../www/js/search-citations.js';
import { tokenize } from '../www/js/normalize.js';

export const TAG_COUNTS_VERSION = 1;

// Match the ordinary meaning index's exclusions. Compound headings belong to
// headword search; their token positions still count toward the entry's limit.
export const indexableMeaning = (body) => body
  .replace(/\x02[^\x03]*\x03/g, ' ')
  .replace(/\([^()\n]{0,40}\)/g, ' ')
  .replace(/[\x00-\x1f]/g, ' ');
export function scopedTokens(body) {
  const heading = body.match(/^(?:\x04\s*)?\x05[^\x06]+\x06\s*؛/);
  return { tokens: tokenize(indexableMeaning(body)), skip: heading ? tokenize(indexableMeaning(heading[0])).length : 0 };
}

function varint(out, value) {
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    out.push(byte | (value ? 128 : 0));
  } while (value);
}

// Shared token-shard format for ordinary entry and sparse sense postings.
export function writeTokenShards(postings, write, directory = 't') {
  const SHARD_BUDGET = 160 * 1024; // raw bytes per shard file
  const enc = new TextEncoder();
  const allTokens = [...postings.keys()].sort();
  const encoded = allTokens.map((t) => {
    const arr = postings.get(t);
    const body = [];
    let prev = 0;
    for (let i = 0; i < arr.length; i += 2) {
      varint(body, (arr[i] - prev) * 16 + arr[i + 1]);
      prev = arr[i];
    }
    return { t, tb: enc.encode(t), body, count: arr.length / 2 };
  });
  const sizeOf = (e) => e.tb.length + e.body.length + 8;
  const groups = []; // { key, from, to } over `encoded`, in sorted order
  function partition(from, to, prefix) {
    let size = 0;
    for (let i = from; i < to; i++) size += sizeOf(encoded[i]);
    if (size <= SHARD_BUDGET || to - from <= 1) {
      groups.push({ key: prefix, from, to, size });
      return;
    }
    const depth = prefix.length;
    let i = from;
    if (encoded[i].t.length === depth) {
      groups.push({ key: prefix, from: i, to: i + 1, size: sizeOf(encoded[i]) });
      i++;
    }
    while (i < to) {
      const c = encoded[i].t[depth];
      let j = i;
      while (j < to && encoded[j].t[depth] === c) j++;
      partition(i, j, prefix + c);
      i = j;
    }
  }
  partition(0, encoded.length, '');

  const shardKeys = [];
  let indexBytes = 0;
  let postingCount = 0;
  let shardCount = 0;
  for (let g = 0; g < groups.length; ) {
    const members = [];
    let size = 0;
    while (g < groups.length && (members.length === 0 || size + groups[g].size <= SHARD_BUDGET)) {
      size += groups[g].size;
      members.push(groups[g++]);
    }
    const head = [];
    const body = [];
    const n = members.reduce((a, m) => a + m.to - m.from, 0);
    varint(head, n);
    for (const m of members) {
      shardKeys.push([m.key, shardCount]);
      for (let i = m.from; i < m.to; i++) {
        const e = encoded[i];
        varint(head, e.tb.length);
        for (const x of e.tb) head.push(x);
        varint(head, e.count);
        varint(head, e.body.length);
        for (const x of e.body) body.push(x);
        postingCount += e.count;
      }
    }
    indexBytes += write(`${directory}/${shardCount}.txt`, Buffer.concat([Buffer.from(head), Buffer.from(body)]));
    shardCount++;
  }
  return { shardKeys, shardCount, indexBytes, postingCount };
}

// Source postings are independent of the token and origin/grammar indexes.
export function writeSourceIndex(postings, write) {
  const counts = [];
  let rawBytes = 0;
  let indexBytes = 0;
  for (const source of SOURCE_TAGS) {
    const ids = postings[source.id];
    ids.sort((a, b) => a - b);
    const out = [];
    varint(out, ids.length);
    let previous = 0;
    for (const id of ids) {
      varint(out, id - previous);
      previous = id;
    }
    const bytes = Uint8Array.from(out);
    rawBytes += bytes.length;
    indexBytes += write(`r/${source.id}.txt`, bytes);
    counts.push(ids.length);
  }
  return { counts, rawBytes, indexBytes, postingCount: counts.reduce((sum, count) => sum + count, 0) };
}

// Global totals for searchable words and compounds, computed only during builds.
export function countTags(entryMasks, phraseMasks, senseRows) {
  const counts = Object.fromEntries([...ENTRY_TAGS, ...SENSE_TAGS.filter((tag) => !tag.aliasOf)].map((tag) => [tag.key, 0]));
  const bits = new Map(ENTRY_TAGS.map((tag) => [tag.bit, tag.key]));
  for (const masks of [entryMasks, phraseMasks]) {
    for (let mask of masks) {
      while (mask) {
        const bit = mask & -mask;
        const key = bits.get(bit);
        if (key) counts[key]++;
        mask ^= bit;
      }
    }
  }
  const owners = SENSE_TAGS.map(() => new Set());
  for (const [entry, phrase, , , facets] of senseRows) {
    if (phrase < 0) continue;
    const owner = phrase ? entryMasks.length + phrase - 1 : entry;
    for (const facet of canonicalSenseIds(facets)) owners[facet].add(owner);
  }
  for (const tag of SENSE_TAGS) if (!tag.aliasOf) counts[tag.key] = owners[tag.id].size;
  return counts;
}
