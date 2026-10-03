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
//  - small builders for made-up candidates (example.com, 555 numbers).
const { R } = require('./helpers');

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

const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString();

module.exports = { ADMIN, guardOutside, stubSenders, as, addTeam, inTeam, getState, ago, daysAgo };
