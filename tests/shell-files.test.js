// The shell's files, without a browser: every file the service worker
// precaches exists and is served; public/sw.js is exactly what
// scripts/build-sw.mjs makes of the current files (so its build stamp is the
// hash of the shell, and a deploy that changed the shell gets a new worker);
// the manifest is valid and its icons exist at the sizes it claims; every file
// index.html points at exists; and netlify.toml's header rules keep JS, CSS and
// HTML revalidating while icons and launch screens are held for a year.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { R, startApp, ok, done, crash } = require('./helpers');
const {
  precacheList, buildStamp, workerText, pngSize, headerRules, rulesFor, revalidates, immutable,
} = require('./shell-helpers');

const OFFSET = 160;
const file = (p) => R(path.join('public', p === '/' ? 'index.html' : p));

// scripts/build-sw.mjs, run in a copy that holds only the template and the
// precached files, so this checkout's public/sw.js is never rewritten.
function buildInCopy(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-sw-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  for (const f of ['build-sw.mjs', 'sw.template.js']) fs.copyFileSync(R(`scripts/${f}`), path.join(dir, 'scripts', f));
  for (const p of precacheList(fs.readFileSync(R('scripts/sw.template.js'), 'utf8')).filter((x) => x !== '/')) {
    const to = path.join(dir, 'public', p);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(file(p), to);
  }
  if (mutate) mutate(dir);
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts/build-sw.mjs')], { cwd: dir, encoding: 'utf8' });
  const outPath = path.join(dir, 'public/sw.js');
  const out = r.status === 0 && fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out, log: `${r.stdout}${r.stderr}` };
}

(async () => {
  const template = fs.readFileSync(R('scripts/sw.template.js'), 'utf8');
  const worker = workerText();
  const listed = precacheList(template);

  // ---------- the precache list ----------
  ok(Array.isArray(listed) && listed.length >= 10, 'the template has a precache list', listed);
  ok(JSON.stringify(precacheList(worker)) === JSON.stringify(listed), 'public/sw.js precaches the same files as the template');
  for (const p of ['/', '/index.html', '/app.js', '/styles.css', '/mobile.css', '/icons.js', '/manifest.webmanifest', '/assets/logo.png', '/assets/logo-dark.png']) {
    ok(listed.includes(p), `the shell includes ${p}`);
  }
  const missing = listed.filter((p) => !fs.existsSync(file(p)));
  ok(missing.length === 0, 'every precached file exists in public/', missing);

  // ---------- the build stamp ----------
  const stamp = buildStamp(worker);
  ok(/^[0-9a-f]{10}$/.test(stamp || ''), 'public/sw.js carries a stamped build, not the placeholder', stamp);
  const hash = crypto.createHash('sha1');
  for (const p of listed.filter((x) => x !== '/')) hash.update(p).update(fs.readFileSync(file(p)));
  const expected = hash.digest('hex').slice(0, 10);
  ok(stamp === expected, 'the build stamp is the hash of the precached files as they are now (run npm run build:sw)', { stamp, expected });
  ok(/GENERATED FILE/.test(worker) && /const BUILD = '[0-9a-f]{10}'/.test(worker), 'public/sw.js says it is generated');

  const fresh = buildInCopy();
  ok(fresh.status === 0 && fresh.out === worker, 'public/sw.js is byte for byte what scripts/build-sw.mjs makes of the current files', fresh.log);

  const freshStamp = buildStamp(fresh.out);
  const shellChanged = buildInCopy((dir) => fs.appendFileSync(path.join(dir, 'public/app.js'), '\n// a change\n'));
  ok(freshStamp && shellChanged.status === 0 && buildStamp(shellChanged.out) !== freshStamp, 'a change to a shell file gives a new build', buildStamp(shellChanged.out));
  const serverOnly = buildInCopy((dir) => {
    fs.writeFileSync(path.join(dir, 'app.js'), '// a server-only change\n');
    fs.mkdirSync(path.join(dir, 'public/splash'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'public/splash/new.png'), 'x');
  });
  ok(freshStamp && serverOnly.status === 0 && buildStamp(serverOnly.out) === freshStamp, 'a server-only change (or a picture outside the shell) keeps the same build', buildStamp(serverOnly.out));
  const gone = buildInCopy((dir) => fs.rmSync(path.join(dir, 'public/icons.js')));
  ok(gone.status !== 0 && gone.out === null, 'a missing shell file stops the build instead of shipping a worker that cannot install', gone.status);

  // ---------- index.html points only at files that exist ----------
  const html = fs.readFileSync(R('public/index.html'), 'utf8');
  const tags = [...html.matchAll(/<(link|script|img)\b[^>]*>/g)].map((m) => m[0]);
  const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? m[1] : null; };
  const local = [];
  for (const t of tags) {
    const ref = attr(t, 'src') || (/^<link/.test(t) ? attr(t, 'href') : null);
    if (ref && ref.startsWith('/') && !ref.startsWith('//')) local.push({ tag: t, ref: ref.split(/[?#]/)[0] });
  }
  ok(local.length > 30, 'index.html references its own files', local.length);
  const broken = local.filter((l) => !fs.existsSync(R(path.join('public', l.ref)))).map((l) => l.ref);
  ok(broken.length === 0, 'every file index.html loads or links exists', broken);

  const loaded = local.filter((l) => /^<script/.test(l.tag) || (/^<link/.test(l.tag) && /rel="stylesheet"/.test(l.tag))).map((l) => l.ref);
  const notCached = loaded.filter((r) => !listed.includes(r));
  ok(loaded.length >= 8 && notCached.length === 0, 'every script and stylesheet index.html loads is in the shell cache (else the offline app is half a page)', notCached);
  const css = fs.readFileSync(R('public/styles.css'), 'utf8');
  const cssRefs = [...css.matchAll(/url\(["']?(\/[^"')]+)["']?\)/g)].map((m) => m[1]);
  ok(cssRefs.every((r) => listed.includes(r) && fs.existsSync(R(path.join('public', r)))), 'pictures styles.css draws are in the shell cache', cssRefs);
  ok(local.some((l) => l.ref === '/assets/logo.png') && listed.includes('/assets/logo.png'), 'the logo the page shows is cached with the shell');

  const sizeErrors = [];
  for (const l of local.filter((x) => /rel="(apple-touch-icon|icon)"/.test(x.tag) && attr(x.tag, 'sizes'))) {
    const s = pngSize(fs.readFileSync(R(path.join('public', l.ref))));
    if (!s || `${s.width}x${s.height}` !== attr(l.tag, 'sizes')) sizeErrors.push(`${l.ref} says ${attr(l.tag, 'sizes')}, is ${s && `${s.width}x${s.height}`}`);
  }
  ok(sizeErrors.length === 0, 'every icon is the size its link says', sizeErrors);
  const splash = local.filter((x) => /rel="apple-touch-startup-image"/.test(x.tag));
  const splashErrors = [];
  for (const l of splash) {
    const name = l.ref.match(/\/splash\/(\d+)x(\d+)-(light|dark)\.png$/);
    const media = attr(l.tag, 'media') || '';
    const dw = Number((media.match(/device-width: (\d+)px/) || [])[1]);
    const dh = Number((media.match(/device-height: (\d+)px/) || [])[1]);
    const dpr = Number((media.match(/pixel-ratio: (\d+)/) || [])[1]);
    const s = pngSize(fs.readFileSync(R(path.join('public', l.ref))));
    if (!name || !s || s.width !== Number(name[1]) || s.height !== Number(name[2])
      || dw * dpr !== s.width || dh * dpr !== s.height || !media.includes(`prefers-color-scheme: ${name[3]}`)) {
      splashErrors.push(l.ref);
    }
  }
  ok(splash.length >= 20 && splashErrors.length === 0, 'every launch screen exists at the exact pixel size of the device it is for, light and dark', splashErrors);

  // ---------- the manifest ----------
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(R('public/manifest.webmanifest'), 'utf8')); } catch (e) { manifest = null; }
  ok(manifest && typeof manifest === 'object', 'the manifest is valid JSON');
  ok(local.some((l) => l.ref === '/manifest.webmanifest' && /rel="manifest"/.test(l.tag)), 'index.html links the manifest');
  ok(manifest.name && manifest.short_name && manifest.start_url === '/' && manifest.scope === '/' && manifest.display === 'standalone',
    'the manifest installs as a standalone app over the whole site', { start_url: manifest.start_url, scope: manifest.scope, display: manifest.display });
  const iconErrors = [];
  for (const icon of manifest.icons || []) {
    const f = R(path.join('public', icon.src));
    const s = fs.existsSync(f) ? pngSize(fs.readFileSync(f)) : null;
    if (!s || `${s.width}x${s.height}` !== icon.sizes || icon.type !== 'image/png') iconErrors.push(icon.src);
  }
  ok((manifest.icons || []).length >= 2 && iconErrors.length === 0, 'every manifest icon exists as a PNG of the size it claims', iconErrors);
  const sizes = (purpose) => (manifest.icons || []).filter((i) => (i.purpose || 'any').split(' ').includes(purpose)).map((i) => i.sizes);
  ok(sizes('any').includes('192x192') && sizes('any').includes('512x512'), 'the manifest has 192 and 512 pixel icons', sizes('any'));
  ok(sizes('maskable').length > 0, 'the manifest has a maskable icon', sizes('maskable'));
  const views = new Set([...html.matchAll(/class="nav-item[^"]*"\s+data-view="([^"]+)"/g)].map((m) => m[1]));
  const shortcutErrors = (manifest.shortcuts || []).filter((sc) => {
    const view = (sc.url || '').replace(/^\/#/, '');
    return !views.has(view) || (sc.icons || []).some((i) => !fs.existsSync(R(path.join('public', i.src))));
  }).map((sc) => sc.url);
  ok(shortcutErrors.length === 0, 'every manifest shortcut opens a page the app has, with an icon that exists', shortcutErrors);

  // ---------- netlify.toml ----------
  const toml = fs.readFileSync(R('netlify.toml'), 'utf8');
  const rules = headerRules(toml);
  const rule = (f) => rules.find((r) => r.for === f);
  ok(/publish\s*=\s*"public"/.test(toml) && /command\s*=\s*"[^"]*npm run build[^"]*"/.test(toml), 'Netlify publishes public/ after npm run build (which stamps the worker)');
  ok(/directory\s*=\s*"netlify\/functions"/.test(toml) && /included_files\s*=\s*\[[^\]]*netlify\/functions\/api\/chunks\/\*\.mjs/.test(toml), 'the function ships with its chunks');
  for (const f of ['/*.js', '/*.css', '/']) {
    ok(rule(f) && revalidates(rule(f).values['Cache-Control']), `${f} revalidates on every load`, rule(f));
  }
  const sw = rule('/sw.js');
  ok(sw && revalidates(sw.values['Cache-Control']) && sw.values['Service-Worker-Allowed'] === '/', 'sw.js revalidates and may control the whole site', sw);
  for (const f of ['/icons/*', '/splash/*']) {
    ok(rule(f) && immutable(rule(f).values['Cache-Control']), `${f} is held for a year, immutable`, rule(f));
  }
  const man = rule('/manifest.webmanifest');
  ok(man && /^application\/manifest\+json/.test(man.values['Content-Type'] || '') && revalidates(man.values['Cache-Control']), 'the manifest is served as a manifest, revalidated', man);
  for (const f of ['/assessment/*', '/paperwork/*']) {
    ok(rule(f) && revalidates(rule(f).values['Cache-Control']), `${f} is never served stale`, rule(f));
  }
  ok(/noindex/.test((rule('/paperwork/*') || { values: {} }).values['X-Robots-Tag'] || ''), 'the paperwork portal is kept out of search indexes');

  // Nothing that changes under the same name may be held as immutable, and
  // nothing in the shell may be given a lifetime of its own.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const pub = R('public');
  const code = walk(pub).map((f) => `/${path.relative(pub, f).split(path.sep).join('/')}`).filter((p) => /\.(js|css|html|webmanifest)$/.test(p));
  const stale = code.concat(listed).filter((p) => rulesFor(rules, p).some((r) => {
    const cc = r.values['Cache-Control'];
    return cc && (immutable(cc) || !revalidates(cc));
  }));
  ok(code.length > 10 && stale.length === 0, 'no rule lets a browser keep a script, stylesheet, page or shell file without asking', stale);
  const pictures = walk(R('public/icons')).concat(walk(R('public/splash'))).map((f) => `/${path.relative(pub, f).split(path.sep).join('/')}`);
  ok(pictures.every((p) => rulesFor(rules, p).some((r) => immutable(r.values['Cache-Control']))), 'every icon and launch screen is covered by an immutable rule');

  // ---------- served ----------
  const s = await startApp({ offset: OFFSET });
  const typeFor = (p) => (p === '/' || p.endsWith('.html') ? /text\/html/ : p.endsWith('.js') ? /javascript/ : p.endsWith('.css') ? /text\/css/
    : p.endsWith('.png') ? /image\/png/ : p.endsWith('.webmanifest') ? /json/ : /./);
  const unserved = [];
  for (const p of listed) {
    const r = await fetch(s.base + p);
    const body = Buffer.from(await r.arrayBuffer());
    if (r.status !== 200 || !typeFor(p).test(r.headers.get('content-type') || '') || !body.equals(fs.readFileSync(file(p)))) unserved.push(`${p} ${r.status} ${r.headers.get('content-type')}`);
  }
  ok(unserved.length === 0, 'every precached file is served signed out, as itself, with the right type', unserved);
  const swRes = await fetch(`${s.base}/sw.js`);
  ok(swRes.status === 200 && /javascript/.test(swRes.headers.get('content-type') || '') && (await swRes.text()) === worker, 'sw.js is served from the site root');
  const mRes = await fetch(`${s.base}/manifest.webmanifest`);
  let served = null;
  try { served = await mRes.json(); } catch (e) { served = null; }
  ok(mRes.status === 200 && served && served.start_url === '/', 'the served manifest parses');
  await s.close();
  done();
})().catch(crash);
