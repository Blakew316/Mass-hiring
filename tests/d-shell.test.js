// The static shell asks nothing of another site. Without a browser: no tag in
// index.html and no url() in its stylesheets points off the site; Inter is
// declared from this site's own woff2 files (latin and latin-ext, swap, with
// the SIL OFL licence beside them) under a year-long immutable rule; the logos
// the page shows are the 510-pixel copies scripts/build-small-logos.mjs makes
// of the masters, which are kept; images not needed for the first screen are
// lazy; and the worker's build stamp is the hash of exactly the files it
// precaches. In a browser: a signed-in load (laptop and phone, light and dark,
// its service worker's install included) and the Onboarding docs page make no
// request off the site at all; Onboarding is drawn in Inter from /assets/fonts;
// the dashboard alone fetches no font file; the Add to Home Screen icon is
// fetched only once the hint is shown; and the worker keeps the font
// cache-first, offline too, and clears the old Google font cache when it
// activates without touching the pictures it keeps.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { R, startApp, launch, ok, done, crash, ago } = require('./helpers');
const {
  QUIET, precacheList, buildStamp, workerText, pngSize, headerRules, rulesFor, immutable, frontDoor, cacheContents, until,
} = require('./shell-helpers');

const OFFSET = 200;
const pub = (p) => R(path.join('public', p));
const FONT = '/assets/fonts/inter-v20-latin.woff2';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

// An address the page might ask for, judged as the browser would: anything
// that is not data:/blob: and not this machine is another site.
const offSite = (u) => {
  let url;
  try { url = new URL(u); } catch (e) { return false; }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return false;
  return url.hostname !== 'localhost' && url.hostname !== '127.0.0.1';
};

// scripts/build-small-logos.mjs, run in a copy holding only the script, the
// PNG helpers and the two masters, so this checkout's copies are never
// rewritten. Returns what it wrote.
function smallLogosInCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd-logos-'));
  fs.mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'public/assets'), { recursive: true });
  fs.copyFileSync(R('scripts/build-small-logos.mjs'), path.join(dir, 'scripts/build-small-logos.mjs'));
  fs.copyFileSync(R('scripts/lib/png.mjs'), path.join(dir, 'scripts/lib/png.mjs'));
  for (const f of ['logo.png', 'logo-dark.png']) fs.copyFileSync(pub(`assets/${f}`), path.join(dir, 'public/assets', f));
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts/build-small-logos.mjs')], { cwd: dir, encoding: 'utf8' });
  const read = (f) => { try { return fs.readFileSync(path.join(dir, 'public/assets', f)); } catch (e) { return null; } };
  const out = { status: r.status, log: `${r.stdout}${r.stderr}`, light: read('logo-510.png'), dark: read('logo-dark-510.png') };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

(async () => {
  const html = fs.readFileSync(pub('index.html'), 'utf8');
  const template = fs.readFileSync(R('scripts/sw.template.js'), 'utf8');
  const worker = workerText();
  const listed = precacheList(template);
  const css = (p) => fs.readFileSync(pub(p), 'utf8');
  const sheets = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)].map((m) => (m[0].match(/\shref="([^"]*)"/) || [])[1]).filter(Boolean);

  // ---------- nothing in the shell points off the site ----------
  const tags = [...html.matchAll(/<(link|script|img|source|iframe|video|audio)\b[^>]*>/g)].map((m) => m[0]);
  const outward = tags.filter((t) => [...t.matchAll(/\s(?:src|href|srcset)="([^"]*)"/g)].some((m) => /^(https?:)?\/\//.test(m[1])));
  ok(tags.length > 30 && outward.length === 0, 'no tag in index.html loads or links anything from another site', outward);
  ok(!/fonts\.(googleapis|gstatic)\.com/.test(html), 'index.html no longer mentions Google Fonts');
  ok(sheets.length >= 4 && sheets.every((p) => p.startsWith('/')), 'every stylesheet index.html loads is the site\'s own', sheets);
  const own = sheets.filter((p) => p.startsWith('/') && !p.startsWith('//'));
  const urls = own.flatMap((p) => [...css(p).matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => ({ sheet: p, ref: m[1] })));
  const foreign = urls.filter((u) => !u.ref.startsWith('data:') && !(u.ref.startsWith('/') && !u.ref.startsWith('//')));
  ok(urls.length > 5 && foreign.length === 0, 'every url() in those stylesheets is a data: picture or a file on this site', foreign);
  const missing = urls.filter((u) => u.ref.startsWith('/') && !fs.existsSync(pub(u.ref.split(/[?#]/)[0]))).map((u) => u.ref);
  ok(missing.length === 0, 'and every file they point at exists', missing);
  const imports = own.filter((p) => /@import\b/.test(css(p)));
  ok(imports.length === 0, 'no stylesheet pulls in another (@import)', imports);
  const shellText = listed.filter((p) => p !== '/' && /\.(js|css|html|webmanifest)$/.test(p)).filter((p) => /fonts\.(googleapis|gstatic)\.com/.test(fs.readFileSync(pub(p), 'utf8')));
  ok(shellText.length === 0, 'no precached file mentions Google Fonts', shellText);

  // ---------- Inter, from this site ----------
  const faces = [...css('styles.css').matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
  const prop = (face, name) => { const m = face.match(new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+)`)); return m ? m[1].trim() : null; };
  const inter = faces.filter((f) => /^['"]?Inter['"]?$/.test(prop(f, 'font-family') || ''));
  ok(inter.length === 8 && inter.length === faces.length, 'styles.css declares Inter, and only Inter, in eight faces (four weights, two alphabets)', faces.length);
  const weights = [...new Set(inter.map((f) => prop(f, 'font-weight')))].sort();
  ok(JSON.stringify(weights) === JSON.stringify(['400', '500', '600', '700']), 'at the four weights Google\'s stylesheet served', weights);
  ok(inter.every((f) => prop(f, 'font-display') === 'swap'), 'every face is font-display: swap, so text is never held back for it');
  ok(inter.every((f) => /U\+/.test(prop(f, 'unicode-range') || '')), 'every face keeps its unicode-range, so a file is fetched only for letters it has');
  const srcs = [...new Set(inter.map((f) => ((prop(f, 'src') || '').match(/url\(["']?([^"')]+)["']?\)/) || [])[1]))];
  ok(srcs.length === 2 && srcs.every((s) => /^\/assets\/fonts\/[^/]+\.woff2$/.test(s)), 'from two woff2 files under /assets/fonts', srcs);
  const latin = inter.filter((f) => /U\+0000-00FF/.test(prop(f, 'unicode-range')));
  const latinExt = inter.filter((f) => /U\+0100-02BA/.test(prop(f, 'unicode-range')));
  ok(latin.length === 4 && latinExt.length === 4 && latin.every((f) => /latin\.woff2/.test(prop(f, 'src'))) && latinExt.every((f) => /latin-ext\.woff2/.test(prop(f, 'src'))),
    'latin and latin-ext, each at every weight, each from its own file');
  const woff2 = srcs.filter((s) => fs.existsSync(pub(s)) && fs.readFileSync(pub(s)).subarray(0, 4).toString('latin1') === 'wOF2');
  ok(woff2.length === srcs.length, 'both files are there, and are WOFF2', woff2);
  const ofl = fs.existsSync(pub('assets/fonts/OFL.txt')) ? fs.readFileSync(pub('assets/fonts/OFL.txt'), 'utf8') : '';
  ok(/The Inter Project Authors/.test(ofl) && /SIL OPEN FONT LICENSE Version 1\.1/.test(ofl), 'the SIL Open Font License, with Inter\'s copyright, is beside them');

  const rules = headerRules(fs.readFileSync(R('netlify.toml'), 'utf8'));
  const fontFiles = fs.readdirSync(pub('assets/fonts')).filter((f) => f.endsWith('.woff2')).map((f) => `/assets/fonts/${f}`);
  const notHeld = fontFiles.filter((p) => !rulesFor(rules, p).some((r) => immutable(r.values['Cache-Control'])));
  ok(fontFiles.length === 2 && notHeld.length === 0, 'netlify.toml holds the font files for a year, immutable', notHeld);
  ok(srcs.every((s) => !listed.includes(s)), 'the font files are not in the shell\'s install (most devices never draw them)');

  // ---------- the logos ----------
  const size = (f) => pngSize(fs.readFileSync(pub(`assets/${f}`)));
  const master = size('logo.png');
  const masterDark = size('logo-dark.png');
  ok(master && masterDark && master.width > 1000, 'the masters are kept, full size', { master, masterDark });
  const small = size('logo-510.png');
  const smallDark = size('logo-dark-510.png');
  const height = Math.round(master.height * (510 / master.width));
  ok(small && small.width === 510 && small.height === height && smallDark && smallDark.width === 510 && smallDark.height === height,
    `the copies are 510 pixels wide, in the masters' proportion (510x${height})`, { small, smallDark });
  const built = smallLogosInCopy();
  ok(built.status === 0 && built.light && built.light.equals(fs.readFileSync(pub('assets/logo-510.png')))
    && built.dark && built.dark.equals(fs.readFileSync(pub('assets/logo-dark-510.png'))),
  'and are byte for byte what scripts/build-small-logos.mjs makes of the masters', built.log);
  ok(Buffer.byteLength(fs.readFileSync(pub('assets/logo-510.png'))) < 0.4 * Buffer.byteLength(fs.readFileSync(pub('assets/logo.png'))),
    'the light copy is well under half the master\'s download');
  const logoTags = tags.filter((t) => /^<img/.test(t) && /\/assets\/logo/.test(t));
  ok(logoTags.length === 4 && logoTags.every((t) => /src="\/assets\/logo-510\.png"/.test(t)), 'every logo in index.html is the 510-pixel copy', logoTags);
  ok(/content:\s*url\("\/assets\/logo-dark-510\.png"\)/.test(css('styles.css')) && !/logo(-dark)?\.png/.test(css('styles.css')), 'the dark theme draws the dark 510-pixel copy, and no stylesheet asks for a master');
  ok(listed.includes('/assets/logo-510.png') && listed.includes('/assets/logo-dark-510.png') && !listed.includes('/assets/logo.png') && !listed.includes('/assets/logo-dark.png'),
    'the worker precaches the copies, not the masters', listed);

  // ---------- lazy pictures ----------
  const imgOf = (re) => tags.find((t) => /^<img/.test(t) && re.test(t)) || '';
  const lazy = (t) => /\sloading="lazy"/.test(t) && /\sdecoding="async"/.test(t);
  const offScreen = {
    'the setup card\'s logo': (html.match(/class="login-card setup-card-gate">\s*(<img\b[^>]*>)/) || [])[1] || '',
    'the new-team card\'s logo': (html.match(/id="newTeamForm" hidden>\s*(<img\b[^>]*>)/) || [])[1] || '',
    'the Add to Home Screen icon': imgOf(/class="install-icon"/),
  };
  const notLazy = Object.entries(offScreen).filter(([, t]) => !lazy(t)).map(([k]) => k);
  ok(notLazy.length === 0, 'pictures not needed for the first screen are loading="lazy" decoding="async"', notLazy);
  const firstScreen = [imgOf(/class="brand-logo"/), (html.match(/id="loginForm">\s*(<img\b[^>]*>)/) || [])[1] || ''];
  ok(firstScreen.every((t) => t && !/loading="lazy"/.test(t)), 'the sidebar and sign-in logos, the first thing on screen, are not lazy', firstScreen);

  // ---------- the worker's stamp ----------
  // Worked out here again, the way scripts/build-sw.mjs does: a stamp that
  // is not the hash of exactly these files would leave browsers on an old
  // shell, or reinstall it for nothing.
  const hash = crypto.createHash('sha1');
  for (const p of listed.filter((x) => x !== '/')) hash.update(p).update(fs.readFileSync(pub(p)));
  const expected = hash.digest('hex').slice(0, 10);
  ok(buildStamp(worker) === expected, `the worker's build stamp is the hash of the files it precaches (${expected})`, buildStamp(worker));
  ok(JSON.stringify(precacheList(worker)) === JSON.stringify(listed), 'and it precaches what the template lists');
  ok(listed.every((p) => p.startsWith('/') && !p.startsWith('//')), 'every precached file is on this site', listed);
  ok(!/fonts\.(googleapis|gstatic)\.com/.test(worker) && !/hostname\s*===/.test(worker), 'the worker has no rule for any other site');

  // ---------- in a browser ----------
  const s = await startApp({ offset: OFFSET });
  await s.store.update((d) => {
    d.candidates = Array.from({ length: 8 }, (_, i) => ({
      id: `d${i}`, name: `Shell Shape ${i}`, firstName: 'Shell', lastName: `Shape ${i}`,
      email: `shell.shape.${i}@example.com`, phone: `(617) 555-04${String(i).padStart(2, '0')}`,
      status: ['new', 'emailed', 'replied', 'booked'][i % 4], addedAt: ago(400 + i), source: 'csv',
    }));
  });
  const door = await frontDoor(s.app, OFFSET + 1);
  const base = door.base;
  const browser = await launch({ args: QUIET });
  const hits = (p) => door.seen.filter((x) => x.url.split('?')[0] === p).length;

  // A context that writes down every address the page and its worker ask
  // for, and lets nothing leave the machine.
  async function watched({ phone = false, dark = false, signedIn = true, ua = null } = {}) {
    const ctx = await browser.newContext({
      ...(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } }),
      ...(ua ? { userAgent: ua } : {}),
      colorScheme: dark ? 'dark' : 'light',
    });
    const asked = [];
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (offSite(u)) { asked.push(u); return route.abort(); }
      return route.continue();
    });
    ctx.on('request', (r) => { if (offSite(r.url()) && !asked.includes(r.url())) asked.push(r.url()); });
    if (signedIn) {
      const [name, value] = s.cookie.split('=');
      await ctx.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
    }
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    return { ctx, page, asked, errors };
  }
  const installed = async (page) => {
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15000 }).catch(() => {});
    const stamp = buildStamp(worker);
    return until(async () => ((await cacheContents(page))[`shell-${stamp}`] || []).length >= listed.length);
  };
  const openView = async (page, view) => {
    await page.evaluate((x) => document.querySelector(`.nav-item[data-view="${x}"]`).click(), view);
    return page.waitForFunction((x) => Boolean(document.querySelector(`#view-${x}.active`)), view, { timeout: 8000 }).then(() => true, () => false);
  };
  // Which faces the browser actually drew a piece of text in.
  const drawnIn = async (page, ctx, selector) => {
    const marked = await page.evaluate((sel) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 3));
      if (el) el.setAttribute('data-drawn-in', '');
      return el ? el.textContent.trim().slice(0, 40) : null;
    }, selector);
    if (!marked) return { text: null, fonts: [] };
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-drawn-in]' });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    await cdp.detach();
    return { text: marked, fonts: fonts.map((f) => ({ family: f.familyName, web: f.isCustomFont })) };
  };

  // ---- signed in: the load, the worker's install, then Onboarding ----
  for (const [phone, dark] of [[false, false], [false, true], [true, false], [true, true]]) {
    const label = `signed in, ${phone ? 'phone' : 'laptop'}, ${dark ? 'dark' : 'light'}`;
    const fontHitsBefore = hits(FONT);
    const hintHitsBefore = hits('/icons/app-light-120.png');
    const v = await watched({ phone, dark });
    await v.page.goto(`${base}/`, { waitUntil: 'networkidle' });
    const up = await v.page.waitForFunction(() => Boolean(document.querySelector('#view-dashboard.active')) && /\d/.test(document.querySelector('#statTotal').textContent), null, { timeout: 15000 }).then(() => true, () => false);
    ok(up, `${label}: the dashboard is up`);
    ok(await installed(v.page), `${label}: the service worker installs the shell`);
    await v.page.waitForLoadState('networkidle');
    ok(v.asked.length === 0, `${label}: the load and the worker's install ask nothing of another site`, v.asked);
    ok(hits(FONT) === fontHitsBefore, `${label}: the dashboard alone fetches no font file`, hits(FONT) - fontHitsBefore);
    if (phone) ok(hits('/icons/app-light-120.png') === hintHitsBefore, `${label}: nor the Add to Home Screen icon, which is not shown`);

    ok(await openView(v.page, 'onboarding'), `${label}: Onboarding docs opens`);
    await v.page.waitForLoadState('networkidle');
    await v.page.evaluate(() => document.fonts.ready);
    const drawn = await drawnIn(v.page, v.ctx, '#wph *');
    ok(drawn.fonts.some((f) => f.family === 'Inter' && f.web), `${label}: Onboarding is drawn in Inter, from the site`, drawn);
    const face = await v.page.evaluate(async (u) => {
      const r = await fetch(u);
      return { status: r.status, type: r.headers.get('content-type') };
    }, FONT);
    ok(face.status === 200 && /font\/woff2/.test(face.type || ''), `${label}: the font file is served as font/woff2`, face);
    ok(v.asked.length === 0, `${label}: and Onboarding asks nothing of another site either`, v.asked);
    ok(v.errors.length === 0, `${label}: no page errors`, v.errors);
    await v.ctx.close();
  }

  // ---- signed out: the sign-in screen ----
  for (const [phone, dark] of [[false, false], [true, true]]) {
    const label = `signed out, ${phone ? 'phone' : 'laptop'}, ${dark ? 'dark' : 'light'}`;
    const v = await watched({ phone, dark, signedIn: false });
    await v.page.goto(`${base}/`, { waitUntil: 'networkidle' });
    const logo = await v.page.waitForFunction(() => {
      const img = document.querySelector('#loginForm .login-logo');
      return img && !document.querySelector('#loginScreen').hidden && img.complete && img.naturalWidth;
    }, null, { timeout: 8000 }).then((h) => h.jsonValue(), () => 0);
    ok(logo === 510, `${label}: the sign-in logo is the 510-pixel copy, loaded`, logo);
    ok(v.asked.length === 0, `${label}: the sign-in screen asks nothing of another site`, v.asked);
    ok(v.errors.length === 0, `${label}: no page errors`, v.errors);
    await v.ctx.close();
  }

  // ---- the Add to Home Screen hint fetches its icon when it is shown ----
  {
    const v = await watched({ phone: true, ua: IPHONE_SAFARI });
    await v.page.goto(`${base}/`, { waitUntil: 'networkidle' });
    const shown = await v.page.waitForFunction(() => {
      const hint = document.querySelector('#wh-install-hint');
      const img = hint && hint.querySelector('.install-icon');
      return hint && !hint.hidden && img.complete && img.naturalWidth;
    }, null, { timeout: 8000 }).then((h) => h.jsonValue(), () => 0);
    ok(shown === 120, 'iPhone Safari: the Add to Home Screen hint comes up with its icon', shown);
    ok(v.asked.length === 0, 'iPhone Safari: nothing asked of another site', v.asked);
    await v.ctx.close();
  }

  // ---- the worker and the font ----
  {
    const v = await watched();
    await v.page.goto(`${base}/`, { waitUntil: 'networkidle' });
    ok(await installed(v.page), 'the worker is in charge');
    const shell = (await cacheContents(v.page))[`shell-${buildStamp(worker)}`] || [];
    ok(shell.includes('/assets/logo-510.png') && shell.includes('/assets/logo-dark-510.png') && !shell.includes('/assets/logo.png'),
      'its shell holds the 510-pixel logos, not the masters', shell);
    await openView(v.page, 'onboarding');
    await v.page.waitForLoadState('networkidle');
    const kept = await until(async () => ((await cacheContents(v.page))['fonts-v2'] || []).includes(FONT));
    ok(kept, 'the font Onboarding drew is kept in the worker\'s font cache', await cacheContents(v.page));
    const before = hits(FONT);
    const again = await v.page.evaluate(async (u) => (await fetch(u)).status, FONT);
    ok(again === 200 && hits(FONT) === before, 'asked for again, it comes from that cache: never fetched twice', hits(FONT) - before);
    door.setDown(true);
    await v.ctx.setOffline(true);
    const offline = await v.page.evaluate(async (u) => fetch(u).then((r) => r.status, () => 0), FONT);
    ok(offline === 200, 'and it is there with no connection', offline);
    const elsewhere = await v.page.evaluate(async () => fetch('/assets/fonts/no-such-face.woff2').then((r) => r.status, () => 0));
    ok(elsewhere === 0, 'while a font it never had fails cleanly offline (the stack falls back)', elsewhere);
    door.setDown(false);
    await v.ctx.setOffline(false);
    await v.ctx.close();
  }

  // ---- activation clears the old Google font cache, and keeps the pictures ----
  {
    const v = await watched();
    // No worker until the old caches are in place: the page's own
    // registration finds no script.
    const noWorker = (route) => route.fulfill({ status: 404, body: '' });
    await v.ctx.route('**/sw.js', noWorker);
    await v.page.goto(`${base}/`, { waitUntil: 'networkidle' });
    await v.page.evaluate(async () => {
      await (await caches.open('fonts-v1')).put('https://fonts.gstatic.com/s/inter/v20/old.woff2', new Response('old'));
      await (await caches.open('assets-v1')).put('/icons/favicon-48.png', new Response('kept'));
    });
    await v.ctx.unroute('**/sw.js', noWorker);
    const names = await v.page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      await navigator.serviceWorker.ready;
      for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) await new Promise((r) => setTimeout(r, 100));
      return caches.keys();
    });
    ok(!names.includes('fonts-v1'), 'a worker that activates clears the old Google font cache', names);
    ok(names.includes('assets-v1') && ((await cacheContents(v.page))['assets-v1'] || []).includes('/icons/favicon-48.png'), 'and keeps the pictures it already had', names);
    ok(v.asked.length === 0, 'nothing asked of another site', v.asked);
    await v.ctx.close();
  }

  await browser.close();
  await door.close();
  await s.close();
  done();
})().catch(crash);
