/* Makes public/assets/logo-dark.png from public/assets/logo.png.
 *
 * The logo is transparent artwork: three blue/green bars beside a navy
 * "wholesale" and a grey "payments". The bars and the grey already read on a
 * dark background; the navy wordmark does not, it disappears into it. So this
 * lifts only the navy and leaves every other pixel exactly as it was. An
 * invert, or a CSS filter, would take the bars down with it.
 *
 * Antialiasing lives in the alpha channel, not in lighter shades of navy, so
 * swapping the RGB of the solid pixels keeps the edges smooth.
 *
 * Run after replacing the logo:  node scripts/build-dark-logo.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'public/assets/logo.png');
const OUT = join(root, 'public/assets/logo-dark.png');

const LIGHT = [0xea, 0xee, 0xfb];   // what the navy becomes
// The navy, and nothing else: saturated, blue, and dark. The bright blue bar is
// the same hue but half again as light, which is what the lightness bound is for.
const IS_NAVY = (h, l, s) => s > 0.45 && h >= 195 && h <= 265 && l < 0.35;

function readChunks(buf) {
  const out = [];
  let i = 8;
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    out.push({ type: buf.toString('latin1', i + 4, i + 8), data: buf.subarray(i + 8, i + 8 + len) });
    i += 12 + len;
  }
  return out;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([head, body, crc]);
}

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

const src = readFileSync(SRC);
const chunks = readChunks(src);
const ihdr = chunks.find((c) => c.type === 'IHDR').data;
const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4);
if (ihdr[8] !== 8 || ihdr[9] !== 6) throw new Error('expected 8-bit RGBA; got depth ' + ihdr[8] + ' type ' + ihdr[9]);

const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
const bpp = 4, stride = w * bpp;
let prev = Buffer.alloc(stride);
const rows = [];
for (let y = 0, pos = 0; y < h; y++) {
  const f = raw[pos++];
  const line = Buffer.from(raw.subarray(pos, pos + stride));
  pos += stride;
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? line[x - bpp] : 0;
    const b = prev[x];
    const c = x >= bpp ? prev[x - bpp] : 0;
    if (f === 1) line[x] = (line[x] + a) & 255;
    else if (f === 2) line[x] = (line[x] + b) & 255;
    else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
    else if (f === 4) line[x] = (line[x] + paeth(a, b, c)) & 255;
  }
  rows.push(line);
  prev = line;
}

let moved = 0;
for (const row of rows) {
  for (let x = 0; x < w; x++) {
    const o = x * 4;
    if (row[o + 3] === 0) continue;
    const r = row[o] / 255, g = row[o + 1] / 255, bl = row[o + 2] / 255;
    const max = Math.max(r, g, bl), min = Math.min(r, g, bl);
    const l = (max + min) / 2;
    if (max === min) continue;                    // grey: no hue to test
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let hue;
    if (max === r) hue = ((g - bl) / d + (g < bl ? 6 : 0));
    else if (max === g) hue = (bl - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (IS_NAVY(hue, l, s)) { [row[o], row[o + 1], row[o + 2]] = LIGHT; moved++; }
  }
}
if (!moved) throw new Error('no navy pixels found — has the logo changed?');

const body = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), r])));
writeFileSync(OUT, Buffer.concat([
  src.subarray(0, 8),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(body, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]));
console.log(`Wrote ${OUT} — ${moved.toLocaleString()} navy pixels lifted to #${LIGHT.map((v) => v.toString(16)).join('')}`);
