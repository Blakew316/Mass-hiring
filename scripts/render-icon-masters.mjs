/* Renders the app-icon masters from assets/icons/source.html.
 *
 * Two steps, both reproducible from public/assets/logo.png:
 *   1. Crop the three bars out of the logo — the wordmark beside them is a
 *      smudge at icon size, the bars are what anybody recognises. The crop is
 *      found by looking for the gap between them and the "wholesale", not
 *      hard-coded, so replacing the logo still works.
 *   2. Render source.html at 1024x1024 once per face and save the masters
 *      beside it. scripts/build-icons.mjs makes every shipped size from those,
 *      with no dependencies.
 *
 * This step needs a headless Chromium, because the label is real Inter rather
 * than whatever font the machine happens to have. It is a once-in-a-blue-moon
 * tool, so Chromium is not a dependency of the project:
 *
 *   npm i --no-save playwright-core && npx playwright install chromium
 *   node scripts/render-icon-masters.mjs
 *   node scripts/build-icons.mjs
 *
 * Set CHROMIUM=/path/to/chrome to use a browser that is already installed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { decode, encode, crop, inkBounds } from './lib/png.mjs';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = join(root, 'assets/icons');

// ---- 1. the bars, cropped out of the logo ----------------------------------
const logo = decode(readFileSync(join(root, 'public/assets/logo.png')));
// Column occupancy, then the runs of ink it falls into. The bars are the first
// three; the wordmark begins after the widest gap among the early runs.
const columns = new Array(logo.width).fill(0);
for (let y = 0; y < logo.height; y++) {
  for (let x = 0; x < logo.width; x++) if (logo.data[(y * logo.width + x) * 4 + 3] > 8) columns[x]++;
}
const runs = [];
for (let x = 0, start = -1; x <= logo.width; x++) {
  const ink = x < logo.width && columns[x] > 0;
  if (ink && start < 0) start = x;
  else if (!ink && start >= 0) { runs.push([start, x - 1]); start = -1; }
}
if (runs.length < 4) throw new Error(`expected bars + wordmark, found ${runs.length} runs of ink`);
let cut = 1;
for (let i = 2; i < Math.min(runs.length, 6); i++) {
  if (runs[i][0] - runs[i - 1][1] > runs[cut][0] - runs[cut - 1][1]) cut = i;
}
const box = inkBounds(logo, { x0: runs[0][0], x1: runs[cut - 1][1] });
const mark = crop(logo, box);
writeFileSync(join(ICONS, 'mark.png'), encode(mark));
console.log(`mark.png — ${mark.width}x${mark.height}, cropped from x ${box.left}-${box.right}`);

// ---- 2. the masters --------------------------------------------------------
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { throw new Error('playwright-core is not installed — see the note at the top of this file'); }

const FACES = ['app-light', 'app-dark', 'mask-light', 'mask-dark', 'favicon', 'wordmark'];
const source = pathToFileURL(join(ICONS, 'source.html')).href;

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const context = await browser.newContext({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
const page = await context.newPage();
for (const face of FACES) {
  await page.goto(`${source}?v=${face}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const font = await page.evaluate(() => {
    const el = document.querySelector('.label');
    return el && getComputedStyle(el).fontFamily;
  });
  if (face !== 'favicon' && !/Inter/.test(font || '')) throw new Error(`Inter did not load (got ${font}) — the label would be set in the wrong face`);
  await page.waitForTimeout(150);
  const out = join(ICONS, `master-${face}.png`);
  await page.screenshot({ path: out, omitBackground: face === 'favicon' || face === 'wordmark' });
  console.log(`master-${face}.png`);
}
await browser.close();
console.log('\nNow run: node scripts/build-icons.mjs');
