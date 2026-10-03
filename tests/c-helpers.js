// Helpers for the c-*.test.js files: the compact list and its delta sync
// (public/wire.js, /api/state?v=2, /api/candidates?v=2,
// /api/candidates/sync). Made-up people only.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const { R, ROOT } = require('./helpers');

const Wire = () => require(R('public/wire.js'));

// A made-up list with every kind of value the page is sent: absent fields,
// nulls, numbers, booleans, a history that is a list, an odd object where a
// string usually is, text threads with tapbacks, email replies and bounces,
// people sharing a number, people due a follow-up, people who said no in a
// note, accents, an emoji and a lone surrogate. Deterministic.
function people(n, { prefix = 'w', seed = 7, at = Date.now() } = {}) {
  let x = seed;
  const rnd = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const iso = (daysBack) => new Date(at - daysBack * 864e5).toISOString();
  const FIRST = ['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo', 'Zoë', 'Renée'];
  const LAST = ['Test', 'Sample', 'Example', 'Madeup', 'Fixture', 'Pretend'];
  const ROLES = ['', 'Account Executive', 'Solar Consultant', 'Store Manager', 'Merchant Services Rep', 'Software Engineer', 'Outside Sales', '123'];
  const COMPANIES = ['', 'Example Payments', 'Sample Solar', 'Pretend Retail', 'Madeup Co'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const first = pick(FIRST); const last = pick(LAST);
    const c = {
      id: `${prefix}${i.toString(36)}x${Math.floor(rnd() * 1e5).toString(36)}`,
      name: `${first} ${last}${i}`, firstName: first, lastName: `${last}${i}`,
      email: `${first.toLowerCase().replace(/[^a-z]/g, '')}.${last.toLowerCase()}${i}@example.com`,
      phone: rnd() < 0.8 ? `(617) 555-${String(2000 + (i % 7000)).padStart(4, '0')}` : '',
      role: pick(ROLES), company: pick(COMPANIES), location: pick(['', 'Austin, TX', 'Boston, MA']),
      notes: pick(['', '', 'left vm', 'not interested thanks', 'referred by a friend']),
      source: pick(['csv', 'csv', 'manual', 'import']), status: 'new', addedAt: iso(30 + rnd() * 400),
    };
    if (i % 2) c.pastRoles = rnd() < 0.5 ? 'Solar sales | Door to door' : ['Retail', 'Sales'];
    const r = rnd();
    if (r < 0.55) { c.status = 'emailed'; c.lastEmailedAt = iso(rnd() * 20); c.lastSubject = 'Quick question'; c.gmailThreadId = `t${i}`; c.followUpCount = Math.floor(rnd() * 3); }
    if (r < 0.25) { c.openedAt = iso(rnd() * 60); }
    if (r < 0.08) { c.status = 'replied'; c.lastReplyAt = iso(rnd() * 5); c.emailUnread = rnd() < 0.5; c.replies = [{ id: `r${i}`, from: c.email, date: c.lastReplyAt, text: 'Sounds good — call me', kind: '' }]; }
    if (r > 0.97) { c.status = 'bounced'; c.replies = [{ id: `b${i}`, from: 'mailer-daemon@example.com', date: iso(1), text: 'Address not found', kind: 'bounce' }]; }
    if (r > 0.95 && r <= 0.97) { c.status = 'declined'; }
    if (r > 0.94 && r <= 0.95) { c.status = 'booked'; c.bookedAt = iso(-2); c.bookedEvent = 'Intro call'; c.bookedJoinUrl = 'https://example.com/j/1'; }
    if (c.phone && rnd() < 0.3) {
      const k = 1 + Math.floor(rnd() * 4);
      c.textThread = Array.from({ length: k }, (_, j) => ({ dir: j % 2 ? 'in' : 'out', ts: iso(10 - j), text: j % 2 ? pick(['Yes!', 'Who is this?', 'Call me 🙂']) : 'Hi — worth a quick call?' }));
      if (k > 2 && rnd() < 0.5) c.textThread.push({ dir: 'in', ts: iso(5), text: 'Liked “Hi”', kind: 'tapback' });
      c.lastTextedAt = c.textThread[0].ts; c.textStatus = k > 1 ? 'replied' : 'delivered';
      if (k > 1) { c.textRepliedAt = c.textThread[1].ts; c.textUnread = rnd() < 0.5; }
    }
    if (i === 3) c.notes = 'A lone surrogate \ud83d and a tab\tand quotes "x"';
    if (i === 4) c.location = { city: 'Austin', state: 'TX' };
    if (i === 5) c.location = { city: 'Boston', zip: 2108 };
    if (i === 6) c.bookedEvent = null;
    out.push(c);
  }
  return out;
}

async function body(s, method, url, payload, headers = {}) {
  const r = await fetch(s.base + url, {
    method,
    headers: { cookie: s.cookie, ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, tag: r.headers.get('etag') || '', text, json, headers: r.headers };
}

// What the page used to be sent: the old state's list, order and due list.
async function legacy(s) {
  const r = await body(s, 'GET', '/api/state');
  if (r.status !== 200) throw new Error(`/api/state answered ${r.status}`);
  return { candidates: r.json.candidates, priority: r.json.texting.priority, dueIds: r.json.followUp.dueIds, text: r.text, json: r.json };
}

async function fullCopy(s, team = 'maverick') {
  const r = await body(s, 'GET', '/api/candidates?v=2');
  if (r.status !== 200) throw new Error(`/api/candidates?v=2 answered ${r.status}`);
  return Wire().fromFull(r.json, team);
}

// One sync of `copy`, applied as the page applies it. Returns the new copy,
// what kind of answer it was, and the answer itself.
async function syncCopy(s, copy, extra = {}) {
  const W = Wire();
  const r = await body(s, 'POST', '/api/candidates/sync?v=2', { ...W.syncBody(copy), ...extra });
  if (r.status !== 200) throw new Error(`sync answered ${r.status}: ${r.text.slice(0, 200)}`);
  const msg = r.json;
  let next; let kind;
  if (msg.same) { kind = 'same'; if (!W.sameAs(copy, msg)) throw new Error('same, but not the same'); next = W.adopt(copy, msg); }
  else if (msg.ch) { kind = msg.p ? 'delta+places' : 'delta'; next = await W.applyDelta(copy, msg); }
  else { kind = 'full'; next = await W.fromFull(msg, copy.t); }
  return { copy: next, kind, msg, bytes: r.text.length };
}

// What the page would put back into the state from a copy.
function asState(copy) {
  const W = Wire();
  return { candidates: copy.cands, priority: W.priorityOf(copy), dueIds: W.dueIdsOf(copy) };
}
const J = (v) => JSON.stringify(v);
// Two copies hold the same thing: people, side values, order, digests, version.
function sameCopy(a, b) {
  const x = asState(a); const y = asState(b);
  const diffs = [];
  if (J(x.candidates) !== J(y.candidates)) diffs.push('people');
  if (J(x.priority) !== J(y.priority)) diffs.push('texting order');
  if (J(x.dueIds) !== J(y.dueIds)) diffs.push('due list');
  if (J(a.sides) !== J(b.sides)) diffs.push('sides');
  for (const k of ['t', 'v', 'nb', 'n', 'o', 'rh', 'rn']) if (a[k] !== b[k]) diffs.push(k);
  if (J(a.d) !== J(b.d)) diffs.push('digests');
  return diffs;
}

// Every bucket of a copy, as it holds it, against the server's digests.
async function badBuckets(copy) {
  const W = Wire();
  const all = new Set(Array.from({ length: copy.nb }, (_, b) => b));
  const texts = W.bucketTexts(copy, all);
  const bad = [];
  for (const b of all) if (await W.digest(texts.get(b) || '', W.DIGEST) !== copy.d[b]) bad.push(b);
  return bad;
}

// The time, held still in this process (the server's): `at` in a window
// that has plenty of it left, so two requests a moment apart are answered
// for the same ten minutes.
const RealDate = Date;
function holdClock(at) {
  const shift = at - RealDate.now();
  class Held extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + shift); else super(...a); }
    static now() { return RealDate.now() + shift; }
  }
  global.Date = Held;
  return () => { global.Date = RealDate; };
}
const WINDOW = 10 * 60 * 1000;
const midWindow = () => Math.floor(RealDate.now() / WINDOW) * WINDOW + WINDOW + 2 * 60 * 1000;

// The code this stage started from, as a separate copy (git archive of the
// commit before it) in a folder of this process's own, with this checkout's
// node_modules. Made once per test file, removed when it exits.
const BASE_COMMIT = process.env.C_BASE_COMMIT || 'c4d38a2';
let baseDir = null;
function baseCopy() {
  if (baseDir) return baseDir;
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-base-'));
  process.on('exit', () => { try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* gone */ } });
  execFileSync('sh', ['-c', `git -C ${JSON.stringify(ROOT)} archive ${BASE_COMMIT} | tar -x -C ${JSON.stringify(baseDir)}`]);
  fs.symlinkSync(fs.realpathSync(path.join(ROOT, 'node_modules')), path.join(baseDir, 'node_modules'));
  return baseDir;
}

// An app from `root` in its own process, on `port`, signed-in-able with
// `password`, its data a copy of `data` (a data directory), the outside
// world stubbed as the tests stub it, and its clock held at `now` (ms)
// when given — movable afterwards with POST /__clock?at=<ms>.
function serve({ root, port, data, password = 'test-password', team = 'maverick', now = null }) {
  if (data && path.resolve(data) !== path.resolve(root, 'data')) {
    fs.rmSync(path.join(root, 'data'), { recursive: true, force: true });
    fs.cpSync(data, path.join(root, 'data'), { recursive: true });
  }
  const src = `
    const path = require('path');
    const http = require('http');
    const root = ${JSON.stringify(root)};
    process.env.APP_PASSWORD = ${JSON.stringify(password)};
    process.env.BASE_URL = 'http://localhost:3000';
    const RealDate = Date;
    let held = ${now === null ? 'null' : Number(now)};
    class Held extends RealDate {
      constructor(...a) { if (a.length === 0) super(held === null ? RealDate.now() : held); else super(...a); }
      static now() { return held === null ? RealDate.now() : held; }
    }
    global.Date = Held;
    const real = global.fetch;
    global.fetch = (u, o) => (/^http:\\/\\/(localhost|127\\.0\\.0\\.1)[:/]/.test(String((u && u.url) || u)) ? real(u, o) : Promise.reject(new Error('outside call refused')));
    require(path.join(root, 'lib/tenant.js')).adopt(${JSON.stringify(team)});
    const google = require(path.join(root, 'lib/google.js'));
    google.status = async () => ({ connected: true, configured: true, email: 'blake@wholesalepayments.com' });
    google.threadMessages = async () => ({ limited: false, messages: [] });
    google.threadReplies = async () => ({ limited: false, replies: [] });
    google.recentInboundThreads = async () => new Set();
    google.gmailSend = async () => { throw new Error('tests never send email'); };
    const mailer = require(path.join(root, 'lib/mailer.js'));
    mailer.sendStatus = async () => ({ ready: true, from: 'Blake Woodruff <blake@wholesalepayments.com>', via: 'gmail-api', reason: '' });
    mailer.sendEmail = async () => { throw new Error('tests never send email'); };
    require(path.join(root, 'lib/notify.js')).pushToPhone = async () => ({ ok: true });
    const app = require(path.join(root, 'app.js'));
    http.createServer((req, res) => {
      if (req.url.startsWith('/__clock')) {
        const at = new URL(req.url, 'http://x').searchParams.get('at');
        held = at === 'real' ? null : Number(at);
        res.end('ok');
        return;
      }
      app(req, res);
    }).listen(${port}, () => process.stdout.write('ready\\n'));
  `;
  const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const base = `http://localhost:${port}`;
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(); });
    child.on('exit', (code) => reject(new Error(`server at ${root} exited ${code}: ${err}`)));
  });
  return ready.then(async () => {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password, team }) });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    return {
      base, cookie, child, err: () => err,
      clock: (at) => fetch(`${base}/__clock?at=${at}`),
      close: () => new Promise((r) => { child.once('exit', r); child.kill(); }),
    };
  });
}

module.exports = { Wire, people, body, legacy, fullCopy, syncCopy, asState, sameCopy, badBuckets, holdClock, midWindow, WINDOW, RealDate, J, baseCopy, serve, BASE_COMMIT };
