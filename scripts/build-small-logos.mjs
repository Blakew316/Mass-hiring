/* Makes the logo copies the dashboard shows, public/assets/logo-510.png and
 * logo-dark-510.png, from public/assets/logo.png and logo-dark.png.
 *
 * The masters are 1125 pixels wide and the dashboard never shows the logo
 * wider than 170 CSS pixels (the sign-in card; the sidebar is 168). 510 is
 * that at three device pixels to one, the densest phone screen there is, so
 * the copy is as sharp as the master anywhere it is shown, for a quarter of
 * the bytes (35 KB rather than 136).
 *
 * The masters stay where they are, unchanged: build-dark-logo.mjs and the icon
 * scripts read logo.png, and pages loaded before this change still ask for
 * both by name.
 *
 * Run after replacing the logo, and after build-dark-logo.mjs:
 *   node scripts/build-small-logos.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decode, encode, resize } from './lib/png.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIDTH = 510;

for (const name of ['logo', 'logo-dark']) {
  const master = decode(readFileSync(join(root, `public/assets/${name}.png`)));
  const height = Math.round(master.height * (WIDTH / master.width));
  const out = join(root, `public/assets/${name}-${WIDTH}.png`);
  const png = encode(resize(master, WIDTH, height));
  writeFileSync(out, png);
  console.log(`Wrote ${out} — ${WIDTH}x${height}, ${Math.round(png.length / 1024)} KB (master ${master.width}x${master.height})`);
}
