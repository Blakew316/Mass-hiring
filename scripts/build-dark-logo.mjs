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
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decode, encode } from './lib/png.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'public/assets/logo.png');
const OUT = join(root, 'public/assets/logo-dark.png');

const LIGHT = [0xea, 0xee, 0xfb];   // what the navy becomes
// The navy, and nothing else: saturated, blue, and dark. The bright blue bar is
// the same hue but half again as light, which is what the lightness bound is for.
const IS_NAVY = (h, l, s) => s > 0.45 && h >= 195 && h <= 265 && l < 0.35;

const { width: w, height: h, data } = decode(readFileSync(SRC));

let moved = 0;
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (data[o + 3] === 0) continue;
    const r = data[o] / 255, g = data[o + 1] / 255, bl = data[o + 2] / 255;
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
    if (IS_NAVY(hue, l, s)) { [data[o], data[o + 1], data[o + 2]] = LIGHT; moved++; }
  }
}
if (!moved) throw new Error('no navy pixels found — has the logo changed?');

writeFileSync(OUT, encode({ width: w, height: h, data }));
console.log(`Wrote ${OUT} — ${moved.toLocaleString()} navy pixels lifted to #${LIGHT.map((v) => v.toString(16)).join('')}`);
