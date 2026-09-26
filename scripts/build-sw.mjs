/* Stamps scripts/sw.template.js into public/sw.js with a hash of the shell.
 *
 *   node scripts/build-sw.mjs
 *
 * The hash is of the files the worker precaches, not of the deploy — so a
 * change to the server alone leaves the shell cache alone, and nobody gets a
 * pointless re-download and an update prompt for a backend-only push.
 *
 * Run it whenever public/ changes. `npm run build` does both this and the
 * function bundle, and that is what Netlify runs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const template = readFileSync(join(root, 'scripts/sw.template.js'), 'utf8');

const listed = template.match(/const PRECACHE = \[([\s\S]*?)\];/);
if (!listed) throw new Error('could not find the PRECACHE list in scripts/sw.template.js');
const files = [...listed[1].matchAll(/'([^']+)'/g)]
  .map((m) => m[1])
  .filter((p) => p !== '/');                 // '/' and '/index.html' are one file

const hash = createHash('sha1');
for (const path of files) hash.update(path).update(readFileSync(join(root, 'public', path)));
const build = hash.digest('hex').slice(0, 10);

// The quotes matter: the word also appears in the file's own comment, and
// replacing that one instead would leave the constant unstamped.
const marker = "'__BUILD__'";
if (!template.includes(marker)) throw new Error('scripts/sw.template.js has no ' + marker + ' to stamp');
const out = template
  .replace(marker, `'${build}'`)
  .replace('/* WPI Outreach — the service worker.',
    '/* WPI Outreach — the service worker.\n *\n * GENERATED FILE — edit scripts/sw.template.js instead.');
writeFileSync(join(root, 'public/sw.js'), out);
console.log(`Wrote public/sw.js — shell ${build}, ${files.length} precached files`);
