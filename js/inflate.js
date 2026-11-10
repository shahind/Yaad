// Minimal gzip/DEFLATE decoder, used only where DecompressionStream is unavailable
// (older Android WebViews / iOS < 16.4). Based on the classic tinf algorithm.

function Tree() {
  this.table = new Uint16Array(16);
  this.trans = new Uint16Array(288);
}

const sltree = new Tree();
const sdtree = new Tree();
const lengthBits = new Uint8Array(30);
const lengthBase = new Uint16Array(30);
const distBits = new Uint8Array(30);
const distBase = new Uint16Array(30);
const clcidx = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const codeTree = new Tree();
const lengths = new Uint8Array(288 + 32);
const offs = new Uint16Array(16);

function buildBitsBase(bits, base, delta, first) {
  for (let i = 0; i < delta; i++) bits[i] = 0;
  for (let i = 0; i < 30 - delta; i++) bits[i + delta] = (i / delta) | 0;
  for (let sum = first, i = 0; i < 30; i++) {
    base[i] = sum;
    sum += 1 << bits[i];
  }
}

function buildTree(t, lens, off, num) {
  t.table.fill(0);
  for (let i = 0; i < num; i++) t.table[lens[off + i]]++;
  t.table[0] = 0;
  for (let sum = 0, i = 0; i < 16; i++) {
    offs[i] = sum;
    sum += t.table[i];
  }
  for (let i = 0; i < num; i++) if (lens[off + i]) t.trans[offs[lens[off + i]]++] = i;
}

(function init() {
  for (let i = 0; i < 7; i++) sltree.table[i] = 0;
  sltree.table[7] = 24;
  sltree.table[8] = 152;
  sltree.table[9] = 112;
  for (let i = 0; i < 24; i++) sltree.trans[i] = 256 + i;
  for (let i = 0; i < 144; i++) sltree.trans[24 + i] = i;
  for (let i = 0; i < 8; i++) sltree.trans[24 + 144 + i] = 280 + i;
  for (let i = 0; i < 112; i++) sltree.trans[24 + 144 + 8 + i] = 144 + i;
  for (let i = 0; i < 5; i++) sdtree.table[i] = 0;
  sdtree.table[5] = 32;
  for (let i = 0; i < 32; i++) sdtree.trans[i] = i;
  buildBitsBase(lengthBits, lengthBase, 4, 3);
  buildBitsBase(distBits, distBase, 2, 1);
  lengthBits[28] = 0;
  lengthBase[28] = 258;
})();

function inflateRaw(src, start) {
  let pos = start;
  let tag = 0;
  let bitcount = 0;
  let out = new Uint8Array(src.length * 4 + 1024);
  let olen = 0;
  const ensure = (n) => {
    if (olen + n <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, olen + n));
    bigger.set(out);
    out = bigger;
  };
  const getbit = () => {
    if (!bitcount--) {
      tag = src[pos++];
      bitcount = 7;
    }
    const bit = tag & 1;
    tag >>>= 1;
    return bit;
  };
  const readbits = (num, base) => {
    if (!num) return base;
    while (bitcount < 24) {
      tag |= (src[pos++] || 0) << bitcount;
      bitcount += 8;
    }
    const val = tag & (0xffff >>> (16 - num));
    tag >>>= num;
    bitcount -= num;
    return val + base;
  };
  const decodeSym = (t) => {
    while (bitcount < 24) {
      tag |= (src[pos++] || 0) << bitcount;
      bitcount += 8;
    }
    let sum = 0;
    let cur = 0;
    let len = 0;
    do {
      cur = 2 * cur + (tag & 1);
      tag >>>= 1;
      ++len;
      sum += t.table[len];
      cur -= t.table[len];
    } while (cur >= 0);
    bitcount -= len;
    return t.trans[sum + cur];
  };
  const decodeTrees = (lt, dt) => {
    const hlit = readbits(5, 257);
    const hdist = readbits(5, 1);
    const hclen = readbits(4, 4);
    lengths.fill(0, 0, 19);
    for (let i = 0; i < hclen; i++) lengths[clcidx[i]] = readbits(3, 0);
    buildTree(codeTree, lengths, 0, 19);
    for (let num = 0; num < hlit + hdist; ) {
      const sym = decodeSym(codeTree);
      if (sym === 16) {
        const prev = lengths[num - 1];
        for (let l = readbits(2, 3); l; l--) lengths[num++] = prev;
      } else if (sym === 17) {
        for (let l = readbits(3, 3); l; l--) lengths[num++] = 0;
      } else if (sym === 18) {
        for (let l = readbits(7, 11); l; l--) lengths[num++] = 0;
      } else lengths[num++] = sym;
    }
    buildTree(lt, lengths, 0, hlit);
    buildTree(dt, lengths, hlit, hdist);
  };
  const ltree = new Tree();
  const dtree = new Tree();
  let bfinal;
  do {
    bfinal = getbit();
    const btype = readbits(2, 0);
    if (btype === 0) {
      // Stored block: drop remaining bits of the current byte.
      while (bitcount > 8) {
        pos--;
        bitcount -= 8;
      }
      bitcount = 0;
      tag = 0;
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      ensure(len);
      out.set(src.subarray(pos, pos + len), olen);
      olen += len;
      pos += len;
    } else {
      let lt = sltree;
      let dt = sdtree;
      if (btype === 2) {
        decodeTrees(ltree, dtree);
        lt = ltree;
        dt = dtree;
      }
      for (;;) {
        let sym = decodeSym(lt);
        if (sym === 256) break;
        if (sym < 256) {
          ensure(1);
          out[olen++] = sym;
        } else {
          sym -= 257;
          const length = readbits(lengthBits[sym], lengthBase[sym]);
          const dist = decodeSym(dt);
          const offset = olen - readbits(distBits[dist], distBase[dist]);
          ensure(length);
          for (let i = offset; i < offset + length; ++i) out[olen++] = out[i];
        }
      }
    }
  } while (!bfinal);
  return out.subarray(0, olen);
}

export function gunzip(src) {
  let pos = 10;
  const flg = src[3];
  if (flg & 4) pos += 2 + (src[10] | (src[11] << 8));
  if (flg & 8) while (src[pos++]);
  if (flg & 16) while (src[pos++]);
  if (flg & 2) pos += 2;
  return inflateRaw(src, pos);
}
