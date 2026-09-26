/* Makes every shipped icon size from the masters in assets/icons/.
 *
 * No dependencies: the masters are already rendered (see
 * scripts/render-icon-masters.mjs), and this only scales them down, which
 * scripts/lib/png.mjs does with an area filter.
 *
 *   node scripts/build-icons.mjs
 *
 * What comes out, and who asks for it:
 *   app-{light,dark}-{120,152,167,180}   iOS home screen (apple-touch-icon).
 *                                        180 is the iPhone; the rest are iPads
 *                                        and older phones.
 *   app-{light,dark}-{192,512}           the web app manifest, and Android.
 *   maskable-{light,dark}-{192,512}      Android launchers that mask to a
 *                                        circle; the artwork sits at 75% so
 *                                        none of it is cut off.
 *   favicon-{16,32,48,180}               browser tabs and bookmarks: the bars
 *                                        alone, transparent, so one file reads
 *                                        on a light or a dark tab strip.
 *
 * And the iOS launch screens, into public/splash/. iOS will not scale a
 * near-match: each device and orientation needs the exact pixel size, chosen by
 * an exact media query, or it shows a blank frame instead. Unlike the home
 * screen icon, these DO honour prefers-color-scheme, so there are two of each —
 * the one moment where the artwork really does follow the phone's theme.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decode, encode, resize, solid, tint, blend, trim } from './lib/png.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FROM = join(root, 'assets/icons');
const TO = join(root, 'public/icons');
const SPLASH = join(root, 'public/splash');

const APPLE = [120, 152, 167, 180];
const WEB = [192, 512];
const PLAN = [
  ['master-app-light.png', 'app-light', [...APPLE, ...WEB]],
  ['master-app-dark.png', 'app-dark', [...APPLE, ...WEB]],
  ['master-mask-light.png', 'maskable-light', WEB],
  ['master-mask-dark.png', 'maskable-dark', WEB],
  ['master-favicon.png', 'favicon', [16, 32, 48, 180]],
];

mkdirSync(TO, { recursive: true });
// Start clean, so a size that is no longer in the plan does not linger in the
// deploy and get served to somebody's home screen forever.
for (const f of readdirSync(TO)) if (f.endsWith('.png')) rmSync(join(TO, f));

let bytes = 0;
for (const [master, name, sizes] of PLAN) {
  const img = decode(readFileSync(join(FROM, master)));
  if (img.width !== img.height) throw new Error(`${master} is ${img.width}x${img.height} — icons must be square`);
  for (const size of sizes) {
    if (size > img.width) throw new Error(`${master} is only ${img.width}px, cannot make a ${size}px icon from it`);
    const png = encode(resize(img, size, size));
    writeFileSync(join(TO, `${name}-${size}.png`), png);
    bytes += png.length;
  }
}
const n = PLAN.reduce((t, [, , s]) => t + s.length, 0);
console.log(`Wrote ${n} icons to public/icons — ${(bytes / 1024).toFixed(0)} KB in total`);

/* ---------------- launch screens ---------------- */

// The CSS viewport and pixel ratio of every iPhone and iPad still in use, which
// is what iOS matches its media query against. Portrait only: a launch screen
// is on screen for a moment, and nobody starts this app in landscape. A device
// that is not on this list gets a blank frame, not a broken one.
const DEVICES = [
  [440, 956, 3], [430, 932, 3], [428, 926, 3], [420, 912, 3], [402, 874, 3],
  [393, 852, 3], [390, 844, 3], [375, 812, 3], [414, 896, 3], [414, 896, 2],
  [414, 736, 3], [375, 667, 2],
  [1032, 1376, 2], [1024, 1366, 2], [834, 1194, 2], [820, 1180, 2], [768, 1024, 2],
];
// background, and the ink the wordmark is tinted with. These are --bg and
// --navy from styles.css; the splash has to be the page's own background or the
// hand-off into the app blinks.
const THEMES = [['light', '#e8eaf0', '#141b4d'], ['dark', '#131519', '#eceef6']];

mkdirSync(SPLASH, { recursive: true });
for (const f of readdirSync(SPLASH)) if (f.endsWith('.png')) rmSync(join(SPLASH, f));

const markArt = trim(decode(readFileSync(join(FROM, 'master-favicon.png'))));
const wordArt = trim(decode(readFileSync(join(FROM, 'master-wordmark.png'))));

let splashBytes = 0;
for (const [theme, bg, ink] of THEMES) {
  const word = tint(wordArt, ink);
  for (const [cssW, cssH, dpr] of DEVICES) {
    const w = cssW * dpr, h = cssH * dpr;
    const canvas = solid(w, h, bg);
    const markH = Math.round(w * 0.30);
    const mark = resize(markArt, Math.round(markH * (markArt.width / markArt.height)), markH);
    const wordW = Math.round(w * 0.46);
    const wm = resize(word, wordW, Math.round(wordW * (word.height / word.width)));
    const gap = Math.round(w * 0.075);
    const blockH = mark.height + gap + wm.height;
    // A touch above centre, where the eye expects it.
    const top = Math.round((h - blockH) / 2 - h * 0.04);
    blend(canvas, mark, Math.round((w - mark.width) / 2), top);
    blend(canvas, wm, Math.round((w - wm.width) / 2), top + mark.height + gap);
    const png = encode(canvas);
    writeFileSync(join(SPLASH, `${w}x${h}-${theme}.png`), png);
    splashBytes += png.length;
  }
}
console.log(`Wrote ${DEVICES.length * THEMES.length} launch screens to public/splash — ${(splashBytes / 1024).toFixed(0)} KB in total`);

/* ---------------- and the link tags that point at them ----------------
 * Written straight into index.html between the markers, because a launch
 * screen iOS cannot find is the same as no launch screen at all, and a list
 * maintained by hand beside a list generated by a script drifts apart. */
const links = [];
for (const [cssW, cssH, dpr] of DEVICES) {
  for (const [theme] of THEMES) {
    const media = `(prefers-color-scheme: ${theme}) and (device-width: ${cssW}px) and (device-height: ${cssH}px) `
      + `and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)`;
    links.push(`<link rel="apple-touch-startup-image" media="${media}" href="/splash/${cssW * dpr}x${cssH * dpr}-${theme}.png">`);
  }
}
const indexPath = join(root, 'public/index.html');
const html = readFileSync(indexPath, 'utf8');
const START = '<!-- splash:start -->', END = '<!-- splash:end -->';
const a = html.indexOf(START), b = html.indexOf(END);
if (a < 0 || b < 0) throw new Error(`public/index.html is missing the ${START} / ${END} markers`);
writeFileSync(indexPath, html.slice(0, a + START.length) + '\n' + links.join('\n') + '\n' + html.slice(b));
console.log(`Wrote ${links.length} apple-touch-startup-image tags into public/index.html`);
