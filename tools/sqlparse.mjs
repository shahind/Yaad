// Streaming-ish parser for the phpMyAdmin dumps in DB/*.sql.
// Yields { id, word, meaning, file } for every row of every INSERT statement.
import fs from 'node:fs';
import path from 'node:path';

const ESC = { n: '\n', r: '\r', t: '\t', 0: '\0', Z: '\x1a', b: '\b' };
const WS = new Set([' ', '\r', '\n', '\t']);

export function* parseFile(file) {
  const data = fs.readFileSync(file, 'utf8');
  let i = 0;
  const skipWs = () => { while (WS.has(data[i])) i++; };
  for (;;) {
    i = data.indexOf('INSERT INTO', i);
    if (i < 0) return;
    i = data.indexOf('VALUES', i) + 6;
    for (;;) {
      skipWs();
      if (data[i] !== '(') throw new Error(`${file}: expected ( at ${i}`);
      i++;
      const fields = [];
      for (;;) {
        skipWs();
        if (data[i] === "'") {
          i++;
          let out = '';
          let start = i;
          for (;;) {
            const c = data[i];
            if (c === '\\') {
              out += data.slice(start, i);
              const nx = data[i + 1];
              out += ESC[nx] ?? nx;
              i += 2;
              start = i;
            } else if (c === "'") {
              if (data[i + 1] === "'") {
                out += data.slice(start, i + 1);
                i += 2;
                start = i;
              } else {
                out += data.slice(start, i);
                i++;
                break;
              }
            } else i++;
          }
          fields.push(out);
        } else {
          let j = i;
          while (!WS.has(data[j]) && data[j] !== ',' && data[j] !== ')') j++;
          fields.push(data.slice(i, j));
          i = j;
        }
        skipWs();
        if (data[i] === ',') { i++; continue; }
        if (data[i] !== ')') throw new Error(`${file}: expected ) at ${i}`);
        i++;
        break;
      }
      yield { id: +fields[0], word: fields[1], meaning: fields[2] };
      skipWs();
      if (data[i] === ',') { i++; continue; }
      if (data[i] !== ';') throw new Error(`${file}: expected ; at ${i}`);
      i++;
      break;
    }
  }
}

export function* allRows(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    for (const row of parseFile(path.join(dir, f))) {
      row.file = f;
      yield row;
    }
  }
}
