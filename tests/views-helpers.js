// Helpers for the views-*.test.js files: what the screens show on a laptop
// and on a phone, for a list made up for the test.
//
// Everything that could reach the outside world is answered here instead:
// Google/Gmail, the mailer, phone pushes, Calendly and Apollo are replaced
// with recorders, the process's own fetch refuses anything that is not this
// machine, and the browser is not allowed off localhost either (no fonts, no
// service worker). Nothing these tests do can send an email or a text.
const { R, ago } = require('./helpers');

// Call after startApp() (which has already stubbed google.status and the
// mailer's sendStatus). Returns the recorders.
function stubEverything() {
  const google = require(R('lib/google.js'));
  const mailer = require(R('lib/mailer.js'));
  const notify = require(R('lib/notify.js'));
  const calendly = require(R('lib/calendly.js'));
  const apollo = require(R('lib/apollo.js'));
  const rec = { sent: [], pushes: [], outside: [], threads: {} };
  const refuse = (what) => async () => { rec.outside.push(what); throw new Error(`test: ${what} is not allowed here`); };
  mailer.sendEmail = async (_settings, msg) => {
    rec.sent.push(msg);
    return { messageId: `<test-${rec.sent.length}@example.com>`, threadId: msg.threadId || `thread-test-${rec.sent.length}` };
  };
  notify.pushToPhone = async (_settings, m) => { rec.pushes.push(m); return { ok: true }; };
  google.gmailSend = refuse('gmailSend');
  google.accessToken = refuse('accessToken');
  google.fetchSheetRows = refuse('fetchSheetRows');
  google.findSentTo = refuse('findSentTo');
  google.getSignature = async () => '';
  // A Gmail conversation is whatever the test put in rec.threads[threadId].
  google.threadMessages = async (_settings, threadId) => {
    const messages = (rec.threads[threadId] || []).map((m, i) => ({
      id: `${threadId}-${i}`, from: m.dir === 'out' ? 'blake@wholesalepayments.com' : 'them@example.com',
      subject: m.subject || 'Quick question', messageId: `<${threadId}-${i}@example.com>`, snippet: m.text.slice(0, 80), kind: '', ...m,
    }));
    const last = messages[messages.length - 1];
    return { messages, limited: false, lastMessageId: last ? last.messageId : '', lastSubject: last ? last.subject : '' };
  };
  calendly.registerWebhook = refuse('calendly.registerWebhook');
  calendly.listInterviews = refuse('calendly.listInterviews');
  apollo.search = refuse('apollo.search');
  apollo.enrich = refuse('apollo.enrich');
  const realFetch = global.fetch;
  global.fetch = (url, opts) => {
    const u = String((url && url.url) || url);
    if (!/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u)) { rec.outside.push(u); return Promise.reject(new Error(`test: no outside calls (${u})`)); }
    return realFetch(url, opts);
  };
  return rec;
}

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const LAPTOP = { viewport: { width: 1440, height: 900 } };

// A page on the app. Signed in with `cookie` (the test's own session unless
// told otherwise); `signedIn: false` waits only for the page to load.
async function open(browser, s, { phone = false, at = '/', cookie = s.cookie, signedIn = true, init = null } = {}) {
  const ctx = await browser.newContext({ ...(phone ? PHONE : LAPTOP), serviceWorkers: 'block' });
  if (cookie) {
    const [name, value] = cookie.split('=');
    await ctx.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
  }
  await ctx.route((u) => !u.href.startsWith(s.base), (r) => r.abort());
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(s.base + at, { waitUntil: 'domcontentloaded' });
  if (signedIn) await ready(page);
  return { ctx, page, errors };
}

// The app has its state on screen: the header controls are only mounted once
// /api/state has answered and been drawn.
async function ready(page, timeout = 20000) {
  await page.waitForFunction(() => {
    const login = document.querySelector('#loginScreen');
    return document.querySelector('.bell') && login && login.hidden;
  }, null, { timeout });
  await page.waitForTimeout(50);
}

const text = (page, sel) => page.evaluate((q) => { const el = document.querySelector(q); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
const texts = (page, sel) => page.evaluate((q) => [...document.querySelectorAll(q)].map((el) => el.textContent.replace(/\s+/g, ' ').trim()), sel);
// Each match as its children's texts joined by a space ("2 Completed" rather
// than "2Completed" for a number and a label in two blocks).
const cells = (page, sel) => page.evaluate((q) => [...document.querySelectorAll(q)].map((el) =>
  (el.children.length ? [...el.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ') : el.textContent.replace(/\s+/g, ' ').trim())), sel);

// Wait until fn() (run in the page) returns something truthy; returns it, or
// null when it never did (so a test can report what it saw instead of dying).
async function waitIn(page, fn, arg, timeout = 8000) {
  try { const h = await page.waitForFunction(fn, arg, { timeout, polling: 50 }); return await h.jsonValue(); } catch { return null; }
}
async function waitText(page, sel, want, timeout = 8000) {
  const got = await waitIn(page, ([q, w, isRe]) => {
    const el = document.querySelector(q);
    if (!el) return false;
    const t = el.textContent.replace(/\s+/g, ' ').trim();
    return (isRe ? new RegExp(w).test(t) : t === w) ? t || ' ' : false;
  }, [sel, want instanceof RegExp ? want.source : want, want instanceof RegExp], timeout);
  return got !== null;
}

// Wait on the server side.
async function until(fn, timeout = 8000, every = 60) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, every));
  }
}

// What the page does when the device comes back online: it asks again.
// Resolves once that answer has come back (whatever it was).
async function poke(page, how = 'online') {
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/state'), { timeout: 10000 }).catch(() => null);
  await page.evaluate((h) => {
    if (h === 'online') window.dispatchEvent(new Event('online'));
    else document.dispatchEvent(new Event('visibilitychange'));
  }, how);
  const r = await answered;
  await page.waitForTimeout(150);
  return r;
}

// The sidebar on a laptop; on a phone the tab bar, which holds some pages
// behind Inbox/Hiring/More.
async function go(page, view) {
  await page.evaluate((v) => document.querySelector(`.nav-item[data-view="${v}"]`).click(), view);
  await page.waitForFunction((v) => document.querySelector(`#view-${v}.active`), view, { timeout: 5000 });
}

// The JSON the page reads, as the signed-in test sees it.
async function state(s) { return (await s.json('GET', '/api/state')).body; }
const byId = (st, id) => (st.candidates || []).find((c) => c.id === id);

// A made-up person. Phone numbers are 555 numbers; the 555-01xx block is the
// one the app refuses to text, so anyone who needs to be textable gets a
// 555-02xx number (these tests never let a text leave the queue).
function person(id, name, extra = {}) {
  const [first, ...rest] = name.split(' ');
  return {
    id, name, firstName: first, lastName: rest.join(' '),
    email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@example.com`,
    status: 'new', addedAt: ago(20000), source: 'csv', ...extra,
  };
}

module.exports = { stubEverything, open, ready, text, texts, cells, waitIn, waitText, until, poke, go, state, byId, person };
