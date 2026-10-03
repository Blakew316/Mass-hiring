// Helpers shared by the server-write tests (the routes that change what is
// stored: candidate edits, texting replies and read marks, the Mac relay,
// settings, the Gmail reply check, the Calendly sync, manual add and import).
//
// Nothing here may reach the outside world. Every module function that would
// (Gmail, the mailer, the ntfy push, Calendly, Apollo) is replaced before the
// app is loaded, and fetch itself refuses any host but this machine, so a
// future refactor that calls out by some other road fails loudly in the test
// instead of emailing, texting or pushing to a real person.
const { R, startApp, ago } = require('./helpers');

// Process-wide secrets belong to one real deployment; a test must never pick
// them up from the shell it happens to run in.
for (const k of ['RELAY_TOKEN', 'NTFY_TOPIC', 'SMTP_USER', 'SMTP_PASS', 'CALENDLY_SIGNING_KEY', 'APOLLO_API_KEY', 'BASE_URL', 'URL', 'NETLIFY', 'NETLIFY_BLOBS_CONTEXT', 'AWS_LAMBDA_FUNCTION_NAME']) delete process.env[k];

const outsideCalls = [];
function guardFetch() {
  if (globalThis.fetch && globalThis.fetch.guarded) return;
  const real = globalThis.fetch;
  const guarded = (input, init) => {
    const href = typeof input === 'string' ? input : (input && input.url) || String(input);
    let host = '';
    try { host = new URL(href).hostname; } catch { host = ''; }
    if (host !== 'localhost' && host !== '127.0.0.1') {
      outsideCalls.push(href);
      return Promise.reject(new Error(`test refused an outside call to ${host || href}`));
    }
    return real(input, init);
  };
  guarded.guarded = true;
  globalThis.fetch = guarded;
}

// What the app tried to tell the outside world, recorded instead of sent.
const pushes = [];
const sentMail = [];

function stubEverything() {
  const google = require(R('lib/google.js'));
  google.gmailSend = async (_s, message) => { sentMail.push(message); throw new Error('tests never send email'); };
  google.getSignature = async () => '';
  google.fetchSheetRows = async () => { throw new Error('tests never read a real sheet'); };
  google.threadReplies = async () => ({ limited: false, replies: [] });
  google.recentInboundThreads = async () => new Set();
  const mailer = require(R('lib/mailer.js'));
  mailer.sendEmail = async (_s, message) => { sentMail.push(message); throw new Error('tests never send email'); };
  const notify = require(R('lib/notify.js'));
  notify.pushToPhone = async (_settings, msg) => { pushes.push(msg); return { sent: true }; };
  const calendly = require(R('lib/calendly.js'));
  calendly.listInterviews = async () => ({ interviews: [], skipped: [], complete: true, schedulingUrl: '' });
  calendly.registerWebhook = async () => { throw new Error('tests never register a real webhook'); };
  const apollo = require(R('lib/apollo.js'));
  for (const k of Object.keys(apollo)) if (typeof apollo[k] === 'function' && /search|enrich/i.test(k)) apollo[k] = async () => { throw new Error('tests never call Apollo'); };
  return { google, mailer, notify, calendly, apollo };
}

// The app, signed in to Team Maverick, with everything outside stubbed out
// before app.js is first required. wipe:false joins the data already there
// (a second instance, see secondInstance below).
async function start(offset, { wipe = true } = {}) {
  process.env.APP_PASSWORD = 'test-password';
  require(R('lib/tenant.js')).adopt('maverick');
  guardFetch();
  const mods = stubEverything();
  const s = await startApp({ offset, wipe });
  // startApp's own stubs replaced a few of ours (status, sendStatus, thread
  // reads); put the quiet versions back where they differ.
  mods.google.threadReplies = async () => ({ limited: false, replies: [] });
  mods.google.recentInboundThreads = async () => new Set();
  return { ...s, ...mods, pushes, sentMail, outsideCalls };
}

// Made-up people. Numbers are 555 exchanges outside the 0100-0199 block, so
// the app treats them as textable (the fictional block is refused outright).
const NAMES = [
  ['Avery', 'Quinn'], ['Jordan', 'Blake'], ['Casey', 'Morgan'], ['Riley', 'Parker'],
  ['Taylor', 'Reese'], ['Morgan', 'Ellis'], ['Jamie', 'Rowan'], ['Drew', 'Hollis'],
  ['Skyler', 'Vance'], ['Peyton', 'Lowell'],
];
function person(n, extra = {}) {
  const [firstName, lastName] = NAMES[(n - 1) % NAMES.length];
  return {
    id: `p${n}`,
    name: `${firstName} ${lastName}`,
    firstName,
    lastName,
    email: `${firstName}.${lastName}`.toLowerCase() + '@example.com',
    phone: `(617) 555-2${String(n).padStart(3, '0')}`,
    role: 'Account Executive',
    company: 'Example Payments',
    location: 'Boston, MA',
    notes: '',
    pastRoles: '',
    status: 'new',
    source: 'csv',
    addedAt: ago(5000 + n),
    lastEmailedAt: null,
    bookedAt: null,
    ...extra,
  };
}

async function seed(s, candidates, more = null) {
  await s.store.update((d) => {
    d.candidates = candidates.map((c) => structuredClone(c));
    d.events = [];
    if (more) more(d);
  });
}

const plain = (x) => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What the page reads. Every test reads /api/state through here and through
// pick(), so if the way the page fetches its state changes (a compact list,
// deltas), this is the one place to rebuild the full picture the page has.
async function state(s, json = s.json) {
  const r = await json('GET', '/api/state');
  if (r.status !== 200) throw new Error(`/api/state answered ${r.status}`);
  return r.body;
}
const pick = (list, id) => (list || []).find((c) => c.id === id) || null;

// What the server stored.
async function stored(s) { return plain(await s.store.load()); }
async function storedCandidate(s, id) { return pick((await stored(s)).candidates, id); }
async function storedEvents(s, type = null, candidateId = undefined) {
  return (await stored(s)).events.filter((e) => (!type || e.type === type) && (candidateId === undefined || e.candidateId === candidateId));
}
async function textQueue(s) {
  return plain(await require(R('lib/text-queue.js')).loadQ());
}

// The whole of a team's stored state that these routes can touch, for "this
// changed nothing" checks: the document, the text queue and the email queue.
// Compared literally: should the store ever keep bookkeeping of its own (a
// revision number, a change stamp), leave it out here rather than in each test.
async function everything(s) {
  const storage = require(R('lib/storage.js'));
  return {
    db: await stored(s),
    textQueue: plain(await storage.getJson('text-queue')),
    queue: plain(await storage.getJson('queue')),
  };
}

// The relay's side: a bearer token, never the dashboard cookie.
async function relayToken(s) {
  const r = await s.json('POST', '/api/texts/relay-token');
  if (r.status !== 200 || !r.body.token) throw new Error(`could not make a relay token: ${r.status}`);
  return r.body.token;
}
async function relay(s, token, path, body = {}) {
  const r = await fetch(`${s.base}/api/relay/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// A second team, signed in on its own cookie.
async function secondTeam(s, name = 'Harbor Crew', pin = '4826') {
  const made = await s.json('POST', '/api/teams/create', { adminPassword: 'test-password', name, pin });
  if (made.status !== 200) throw new Error(`could not make a second team: ${made.status} ${JSON.stringify(made.body)}`);
  const id = made.body.team.id;
  const cookie = await s.signIn(pin, id);
  const call = (method, url, body) => fetch(s.base + url, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = async (method, url, body) => { const r = await call(method, url, body); return { status: r.status, body: await r.json().catch(() => null) }; };
  const tenant = require(R('lib/tenant.js'));
  const inTeam = (fn) => tenant.run(id, fn);
  return { id, cookie, call, json, inTeam };
}

// The page's own 30-second poll (public/app.js refresh()): it keeps the tag of
// the state on screen and asks "anything newer than this?". A 304 means no,
// and the page goes on showing what it has — so a 304 after a write would
// leave the change off the screen. Returns what the page would then show.
// Like state() above, this is the one place to change if the way the page
// polls changes (a compact list, deltas merged into the copy it keeps).
function pagePoller(s, { base = s.base, cookie = s.cookie } = {}) {
  let tag = '';
  let shown = null;
  return async function poll() {
    const r = await fetch(`${base}/api/state`, { headers: { cookie, ...(tag ? { 'if-none-match': tag } : {}) } });
    if (r.status === 304 && shown) return { fresh: false, state: shown };
    if (r.status !== 200) throw new Error(`/api/state answered ${r.status}`);
    shown = await r.json();
    tag = r.headers.get('etag') || '';
    return { fresh: true, state: shown };
  };
}

// A second copy of the app in its own process, on its own port, sharing this
// one's storage — as two instances of the deployed function do, or the
// scheduled worker beside the dashboard. Nothing in it reaches the outside
// world either (it runs start() too). Driven over HTTP like the first; a few
// commands go in on stdin as JSON lines and are answered the same way:
//   { cmd: 'gmail', threads, changed }  what its Gmail answers from now on
//   { cmd: 'report' }                   { pushes, outside, mail } it recorded
// Never send it two writes at once alongside the first instance: the local
// file store's conditional write is atomic within one process only (on
// Netlify Blobs it is atomic across instances), so a cross-process race
// would test the test adapter, not the app.
function secondInstance(offset) {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [__filename, '--instance', String(offset)], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let errText = '';
  const waiting = [];
  const answers = [];
  child.stderr.on('data', (d) => { errText = (errText + d).slice(-4000); });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;   // the app's own logging
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (!msg || !msg.__instance) continue;
      if (waiting.length) waiting.shift().resolve(msg); else answers.push(msg);
    }
  });
  const next = () => new Promise((resolve, reject) => {
    if (answers.length) return resolve(answers.shift());
    const t = setTimeout(() => reject(new Error(`second instance did not answer: ${errText}`)), 20000);
    waiting.push({ resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
  child.on('exit', (code) => { for (const w of waiting.splice(0)) w.resolve({ __instance: true, error: `exited ${code}: ${errText}` }); });
  const ask = async (msg) => { child.stdin.write(`${JSON.stringify(msg)}\n`); return next(); };
  return next().then((hello) => {
    if (!hello.ready) throw new Error(`second instance did not start: ${hello.error || errText}`);
    return {
      base: hello.base,
      ask,
      stop: () => new Promise((resolve) => { child.once('exit', () => resolve()); child.stdin.end(); setTimeout(() => child.kill('SIGKILL'), 3000).unref(); }),
    };
  });
}

// Run as the second instance: node server-write-helpers.js --instance <offset>
if (require.main === module && process.argv[2] === '--instance') {
  const say = (o) => process.stdout.write(`${JSON.stringify({ __instance: true, ...o })}\n`);
  (async () => {
    const s = await start(Number(process.argv[3]), { wipe: false });
    let threads = {};
    let changed = [];
    s.google.threadReplies = async (_settings, threadId) => ({ limited: false, replies: (threads[threadId] || []).map((m) => ({ ...m })) });
    s.google.recentInboundThreads = async () => { const set = new Set(changed); set.complete = true; return set; };
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      let m = {};
      try { m = JSON.parse(line); } catch { return say({ error: 'bad command' }); }
      if (m.cmd === 'gmail') { threads = m.threads || {}; changed = m.changed || []; return say({ ok: true }); }
      if (m.cmd === 'report') return say({ pushes: s.pushes, outside: s.outsideCalls, mail: s.sentMail.length });
      return say({ error: `unknown command ${m.cmd}` });
    });
    rl.on('close', () => { s.close().finally(() => process.exit(0)); });
    say({ ready: true, base: s.base });
  })().catch((e) => { say({ error: String((e && e.stack) || e) }); process.exit(2); });
}

module.exports = {
  start, person, seed, plain, same, state, pick, stored, storedCandidate, storedEvents,
  textQueue, everything, relayToken, relay, secondTeam, pagePoller, secondInstance, pushes, sentMail, outsideCalls, ago,
};
