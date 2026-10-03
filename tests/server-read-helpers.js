// Helpers for the server-read tests (tests/server-read-*.test.js).
//
// What they add to tests/helpers.js:
//  - a guard on fetch that refuses every call leaving this machine, so a read
//    route that starts reaching Google, ntfy, Calendly or Apollo fails the test
//    instead of reaching them;
//  - stubs for every module function that would send something, recording
//    what was asked of them so a test can say "nothing was sent";
//  - a second (third...) team made the way the app makes one, and requests
//    signed in as it;
//  - another instance of the app: a separate process on the same storage,
//    as Netlify runs several copies of the function at once (elsewhere());
//  - a snapshot of every stored file, to tell whether anything was written;
//  - small builders for made-up candidates (example.com, 555 numbers).
const { R, ROOT } = require('./helpers');

const ADMIN = 'test-password';   // the APP_PASSWORD startApp() sets by default

// Only localhost may be fetched. Install before startApp() so nothing slips
// through while the app starts.
function guardOutside() {
  const real = global.fetch;
  const refused = [];
  global.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (!/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) {
      refused.push(url);
      throw new Error(`test refused an outside call to ${url}`);
    }
    return real(input, init);
  };
  return refused;
}

// Everything that sends, recorded rather than sent. Call after startApp()
// (which has already put Google's status and the mailer's status in place).
function stubSenders() {
  const sent = { email: [], gmail: [], push: [], calendly: [], apollo: [] };
  const mailer = require(R('lib/mailer.js'));
  mailer.sendEmail = async (_settings, message) => { sent.email.push(message); return { via: 'gmail-api', threadId: 'test-thread', messageId: '<test@example.com>' }; };
  const google = require(R('lib/google.js'));
  google.gmailSend = async (_settings, message) => { sent.gmail.push(message); return { id: 'test', threadId: 'test-thread', messageId: '<test@example.com>' }; };
  google.findSentTo = async () => false;
  require(R('lib/notify.js')).pushToPhone = async (_settings, msg) => { sent.push.push(msg); return { sent: true }; };
  const calendly = require(R('lib/calendly.js'));
  calendly.registerWebhook = async (...a) => { sent.calendly.push(a); throw new Error('calendly is stubbed in tests'); };
  calendly.listInterviews = async (...a) => { sent.calendly.push(a); return { interviews: [], schedulingUrl: '', skipped: 0, complete: true }; };
  const apollo = require(R('lib/apollo.js'));
  apollo.search = async (...a) => { sent.apollo.push(a); throw new Error('apollo is stubbed in tests'); };
  apollo.enrich = async (...a) => { sent.apollo.push(a); throw new Error('apollo is stubbed in tests'); };
  sent.count = () => sent.email.length + sent.gmail.length + sent.push.length + sent.calendly.length + sent.apollo.length;
  return sent;
}

// Requests carrying a given cookie (or none: signed out).
function as(s, cookie) {
  const call = (method, url, body, extra = {}) => fetch(s.base + url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = async (method, url, body, extra) => {
    const r = await call(method, url, body, extra);
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: r.status, body: parsed, text, headers: r.headers };
  };
  return { cookie, call, json };
}

// A new team, made from Settings by someone already signed in (the way the
// app does it: admin password, a name and a PIN), then signed in to.
async function addTeam(s, { name, pin }) {
  const made = await s.json('POST', '/api/teams/create', { adminPassword: ADMIN, name, pin });
  if (made.status !== 200 || !made.body || !made.body.team) throw new Error(`could not make team ${name}: ${made.status} ${JSON.stringify(made.body)}`);
  const id = made.body.team.id;
  const cookie = await s.signIn(pin, id);
  if (!cookie || !cookie.startsWith('crm_auth=')) throw new Error(`could not sign in to ${id}`);
  return { id, name, pin, made: made.body, ...as(s, cookie) };
}

// Run fn with `teamId` as the team in context (for writing a team's data
// directly from the test).
function inTeam(teamId, fn) {
  return require(R('lib/tenant.js')).run(teamId, fn);
}

// GET /api/state, with its tag.
async function getState(client, tag) {
  const r = await client.call('GET', '/api/state', null, tag ? { 'If-None-Match': tag } : {});
  const text = await r.text();
  return { status: r.status, tag: r.headers.get('etag') || '', cache: r.headers.get('cache-control') || '', text, body: r.status === 200 && text ? JSON.parse(text) : null };
}

// Run `fn` in a separate Node process on the same storage: another instance
// of the deployed function, as far as the app under test can tell (Netlify
// runs several at once, all reading and writing the one store). `fn` is an
// async function, called as fn(modules, arg) inside `teamId`'s context; it
// must not use anything from the test's own scope — pass data through `arg`
// (JSON). What it returns comes back as JSON. The process refuses every fetch,
// so nothing it does can reach outside this machine.
function elsewhere(teamId, fn, arg = null) {
  const { execFile } = require('child_process');
  const src = `
    const path = require('path');
    const R = (p) => path.join(${JSON.stringify(ROOT)}, p);
    global.fetch = async (u) => { throw new Error('the other instance refused an outside call to ' + u); };
    const mods = {
      R,
      tenant: require(R('lib/tenant.js')),
      storage: require(R('lib/storage.js')),
      store: require(R('lib/store.js')),
      teams: require(R('lib/teams.js')),
      textQueue: require(R('lib/text-queue.js')),
      salesiq: require(R('lib/salesiq.js')),
      onboarding: require(R('lib/onboarding.js')),
      backups: require(R('lib/backups.js')),
    };
    Promise.resolve()
      .then(() => mods.tenant.run(${JSON.stringify(teamId)}, () => (${fn.toString()})(mods, ${JSON.stringify(arg)})))
      .then((v) => { process.stdout.write(JSON.stringify(v === undefined ? null : v)); process.exit(0); },
        (e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(1); });
  `;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', src], { env: process.env, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`the other instance failed: ${stderr || err.message}`));
      try { resolve(stdout ? JSON.parse(stdout) : null); } catch (e) { reject(e); }
    });
  });
}

// Every stored file under ROOT/data with its size and modification time, to
// tell whether anything at all was written.
function dataSnapshot() {
  const fs = require('fs');
  const path = require('path');
  const dir = R('data');
  let files = [];
  try { files = fs.readdirSync(dir, { recursive: true }); } catch { return ''; }
  return files.map(String).filter((f) => /\.(json|bin)$/.test(f)).sort()
    .map((f) => { const st = fs.statSync(path.join(dir, f)); return `${f}:${st.size}:${st.mtimeMs}`; }).join('|');
}

const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString();

module.exports = { ADMIN, guardOutside, stubSenders, as, addTeam, inTeam, getState, elsewhere, dataSnapshot, ago, daysAgo };
