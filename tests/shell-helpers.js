// Helpers for the shell tests: the page, the service worker, the manifest,
// the Netlify headers and the function bundle. See helpers.js for the shared
// ones (startApp, launch, ok, ...).
const http = require('http');
const fs = require('fs');
const { R, port } = require('./helpers');

// Chromium's own background traffic (component updates, safe browsing) has
// nothing to do with the app and only makes noise. No proxy either: Chromium
// takes one from the environment, and whatever it still sends of its own
// would leave the machine through it. The app is on localhost and needs none.
const QUIET = ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--no-proxy-server'];

// The precache list and the build stamp, read out of a worker script the way
// scripts/build-sw.mjs reads the template.
function precacheList(text) {
  const listed = String(text).match(/const PRECACHE = \[([\s\S]*?)\];/);
  if (!listed) return null;
  return [...listed[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}
function buildStamp(text) {
  const m = String(text).match(/const BUILD = '([^']*)'/);
  return m ? m[1] : null;
}
const workerText = () => fs.readFileSync(R('public/sw.js'), 'utf8');

// Width and height from a PNG's header.
function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// netlify.toml's [[headers]] rules, as [{ for, values }]. Just enough TOML
// for that file: quoted strings, one per line.
function headerRules(toml) {
  const rules = [];
  let cur = null;
  let inValues = false;
  for (const raw of String(toml).split('\n')) {
    const line = raw.replace(/^\s+|\s+$/g, '');
    if (!line || line.startsWith('#')) continue;
    if (line === '[[headers]]') { cur = { for: null, values: {} }; rules.push(cur); inValues = false; continue; }
    if (line === '[headers.values]') { inValues = Boolean(cur); continue; }
    if (/^\[/.test(line)) { cur = null; inValues = false; continue; }
    const m = line.match(/^("?)([A-Za-z0-9_.-]+)\1\s*=\s*"([^"]*)"/);
    if (!m || !cur) continue;
    if (inValues) cur.values[m[2]] = m[3];
    else if (m[2] === 'for') cur.for = m[3];
  }
  return rules;
}
// Which rules apply to a path. '*' is taken to match anything, slashes too —
// the broader reading, so a check that nothing matches is the stricter one.
function rulesFor(rules, pathname) {
  return rules.filter((r) => {
    const re = new RegExp(`^${r.for.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return re.test(pathname);
  });
}
const revalidates = (cc) => /\bmax-age=0\b/.test(cc || '') && /\bmust-revalidate\b/.test(cc || '');
const immutable = (cc) => /\bimmutable\b/.test(cc || '') && /\bmax-age=31536000\b/.test(cc || '');

// Serve the app through a front door that can stand a different sw.js in
// for the one on disk (what a deploy of a new shell looks like to a browser
// that already has the old one), that can drop every connection (no network,
// for the page and its service worker alike — the browser's offline switch
// does not reliably reach a worker's own fetches), and that writes down what
// actually reached the server. Everything else is the app itself.
async function frontDoor(app, offset) {
  let worker = null;
  let down = false;
  const seen = [];             // { method, url, cookie, status, at }
  const server = http.createServer((req, res) => {
    if (down) { req.socket.destroy(); return; }
    const entry = { method: req.method, url: req.url, cookie: /crm_auth=/.test(req.headers.cookie || ''), status: 0, at: Date.now() };
    seen.push(entry);
    res.on('finish', () => { entry.status = res.statusCode; });
    if (req.url.startsWith('/__signal/')) { res.writeHead(204); res.end(); return; }
    if (worker !== null && req.url.split('?')[0] === '/sw.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=UTF-8', 'cache-control': 'no-cache' });
      res.end(worker);
      return;
    }
    app(req, res);
  });
  const p = port(offset);
  await new Promise((resolve) => server.listen(p, resolve));
  return {
    base: `http://localhost:${p}`,
    // null: the real public/sw.js again.
    setWorker(text) { worker = text; },
    // The worker on disk with a different build stamp: a new version of the
    // shell, as far as any browser can tell. One line is added: when it
    // decides to take over from the version in charge (skipWaiting, the only
    // way a waiting worker can), it says so to the front door, so a test can
    // see the decision even when the browser is slow to carry it out.
    newBuild(stamp) {
      worker = `${workerText().replace(/const BUILD = '[^']*'/, `const BUILD = '${stamp}'`)}
;(() => { const take = self.skipWaiting.bind(self); self.skipWaiting = () => { fetch('/__signal/take-over?build=' + BUILD).catch(() => {}); return take(); }; })();
`;
      return stamp;
    },
    // When each build was told to take over, as [{ build, at }].
    tookOver: () => seen.filter((x) => x.url.startsWith('/__signal/take-over')).map((x) => ({ build: new URL(x.url, 'http://x').searchParams.get('build'), at: x.at })),
    setDown(v) { down = Boolean(v); },
    seen,
    close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }),
  };
}

// Nothing leaves the machine. The font stylesheet is answered with an empty
// one so the page is drawn the same with or without a network.
async function keepInside(ctx) {
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return route.continue();
    if (u.hostname === 'fonts.googleapis.com') return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return route.abort();
  });
}

// A page on the app with its problems written down: page errors, and
// same-origin requests that failed or came back 4xx/5xx — the page's own and
// the service worker's. A request cut off by the page navigating away is not
// a failure (ERR_ABORTED).
async function openShell(browser, base, {
  cookie = '', phone = false, colorScheme = 'light', at = '/', theme = null, waitUntil = 'networkidle',
} = {}) {
  const ctx = await browser.newContext({
    ...(phone
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
      : { viewport: { width: 1440, height: 900 } }),
    colorScheme,
  });
  if (cookie) {
    const [name, value] = cookie.split('=');
    await ctx.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
  }
  if (theme) await ctx.addInitScript((t) => { try { localStorage.setItem('wp-theme', t); } catch (e) { /* none */ } }, theme);
  await keepInside(ctx);
  const origin = new URL(base).origin;
  const errors = [];
  const failures = [];
  ctx.on('requestfailed', (r) => {
    const f = r.failure();
    if (!r.url().startsWith(origin) || (f && /ERR_ABORTED/.test(f.errorText))) return;
    failures.push(`${r.method()} ${r.url().slice(origin.length)} ${f ? f.errorText : ''}`);
  });
  ctx.on('response', (r) => {
    if (r.url().startsWith(origin) && r.status() >= 400) failures.push(`${r.request().method()} ${r.url().slice(origin.length)} → ${r.status()}`);
  });
  const page = await ctx.newPage();
  let loads = 0;
  page.on('load', () => { loads += 1; });
  page.on('pageerror', (e) => errors.push(e.message));
  const response = at === null ? null : await page.goto(base + at, { waitUntil });
  return { ctx, page, errors, failures, response, loads: () => loads };
}

// How much of a region is drawn in something other than its background, and
// how far the drawing is from it in brightness: a logo that failed to load,
// or is navy on near-black, scores near zero on one or the other.
async function inkIn(page, clip) {
  const png = await page.screenshot({ clip });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const lum = (i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    const bg = lum(0);
    let inked = 0;
    let far = 0;
    for (let i = 0; i < d.length; i += 4) {
      const diff = Math.abs(lum(i) - bg);
      if (diff > 0.08) inked += 1;
      if (diff > far) far = diff;
    }
    return { background: bg, inked: inked / (d.length / 4), contrast: far };
  }, png.toString('base64'));
}

// The caches the service worker keeps, as { name: [pathname, ...] }.
const cacheContents = (page) => page.evaluate(async () => {
  const out = {};
  for (const n of await caches.keys()) out[n] = (await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname);
  return out;
});

// Wait for a condition in node, not a fixed sleep.
async function until(fn, { timeout = 10000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, every));
  }
}

module.exports = {
  QUIET, precacheList, buildStamp, workerText, pngSize, headerRules, rulesFor, revalidates, immutable,
  frontDoor, keepInside, openShell, inkIn, cacheContents, until,
};
