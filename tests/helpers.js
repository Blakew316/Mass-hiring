// Shared helpers for the regression tests in this folder.
//
// Every test runs against a repo at ROOT (default: this checkout), so a copy
// of the repo can be tested without touching another. Ports come from
// PORT_BASE (default 4100) plus a fixed offset per test, so two copies can be
// tested at once on different bases. Tests use made-up people only and keep
// their data in ROOT/data, which they wipe: never point ROOT at a checkout
// whose data/ matters.
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(process.env.ROOT || path.join(__dirname, '..'));
const R = (p) => path.join(ROOT, p);
const port = (offset) => Number(process.env.PORT_BASE || 4100) + offset;

// Playwright is not a dependency of the app (Netlify would install it on
// every build); point PLAYWRIGHT_CORE at an installed playwright-core.
function playwright() {
  const where = process.env.PLAYWRIGHT_CORE || 'playwright-core';
  return require(where);
}
const CHROMIUM = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const launch = (opts = {}) => playwright().chromium.launch({ executablePath: CHROMIUM, ...opts });

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log(`PASS ${msg}`); }
  else { fail++; console.log(`FAIL ${msg}${extra !== undefined ? `  → ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`.slice(0, 600) : ''}`); }
  return Boolean(cond);
}
function done() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
function crash(e) { console.log(`FAIL suite crashed → ${e && e.stack ? e.stack : e}`); process.exit(2); }

function wipeData() { fs.rmSync(R('data'), { recursive: true, force: true }); }

// Google and the mailer reach the outside world; tests answer for them.
function stubOutside({ email = 'blake@wholesalepayments.com', connected = true } = {}) {
  const google = require(R('lib/google.js'));
  google.status = async () => ({ connected, configured: connected, email: connected ? email : '' });
  google.threadMessages = async () => ({ limited: false, messages: [] });
  google.threadReplies = async () => ({ limited: false, replies: [] });
  google.recentInboundThreads = async () => new Set();
  require(R('lib/mailer.js')).sendStatus = async () => ({ ready: connected, from: `Blake Woodruff <${email}>`, via: 'gmail-api', reason: '' });
  return google;
}

// Start the app for one team, signed in. Call before requiring anything else
// from ROOT so the tenant and password are in place.
async function startApp({ offset = 0, password = 'test-password', team = 'maverick', wipe = true, stub = true } = {}) {
  process.env.APP_PASSWORD = password;
  require(R('lib/tenant.js')).adopt(team);
  if (wipe) wipeData();
  if (stub) stubOutside();
  const store = require(R('lib/store.js'));
  const app = require(R('app.js'));
  const p = port(offset);
  const server = await new Promise((resolve) => { const s = app.listen(p, () => resolve(s)); });
  const base = `http://localhost:${p}`;
  const signIn = async (pw = password, teamId = team) => {
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw, team: teamId }) });
    return (r.headers.get('set-cookie') || '').split(';')[0];
  };
  const cookie = await signIn();
  const call = async (method, url, body, extra = {}) => fetch(base + url, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = async (method, url, body) => { const r = await call(method, url, body); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };
  return { base, port: p, cookie, signIn, call, json, store, app, server, close: () => new Promise((r) => server.close(r)) };
}

// A signed-in browser page on the app.
async function openPage(browser, s, { phone = false, path: at = '/' } = {}) {
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
    : { viewport: { width: 1440, height: 900 } });
  const [name, value] = s.cookie.split('=');
  await ctx.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(s.base + at, { waitUntil: 'networkidle' });
  return { ctx, page, errors };
}

const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

module.exports = { ROOT, R, port, playwright, launch, ok, done, crash, wipeData, stubOutside, startApp, openPage, ago };
