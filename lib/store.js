// App data access on top of the storage adapter (files locally, Netlify
// Blobs when deployed). load() always reads fresh — handlers mutate the
// returned object and pass it back to save().
const crypto = require('crypto');
const storage = require('./storage');
const tenant = require('./tenant');
const attachments = require('./attachments');
const presets = require('./presets');

const DEFAULT_TEMPLATE = {
  subject: 'Quick question, {{firstName}} — open to something new?',
  body: [
    'Hi {{firstName}},',
    '',
    "I hope you're doing well! I'm reaching out because we're growing our team and your background as a {{role}} caught my attention.",
    '',
    "Are you currently looking for another role, or open to hearing about a new position? I'd love to set up a quick chat to tell you more about what we're building and see if it could be a fit.",
    '',
    "If you're interested, grab any time that works for you on my calendar — the booking link is right below.",
  ].join('\n'),
};

// Second touch for people who never answered. Sent as a reply in the same
// conversation, so {{originalSubject}} keeps the thread together.
const DEFAULT_FOLLOW_UP = {
  subject: 'Re: {{originalSubject}}',
  body: [
    'Hi {{firstName}},',
    '',
    "Just following up on my note below — we're still growing the team and I'd love to connect if you're open to it.",
    '',
    "If the timing isn't right, no worries at all. Otherwise, grab any time on my calendar and we can talk it through.",
  ].join('\n'),
};

// The iMessage first touch. Kept short on purpose: a text that runs past a
// couple of hundred characters reads as a broadcast, and the whole point of
// this channel is that it does not. The opt-out line is not decoration — under
// the TCPA an easy way to stop is what keeps a recruiting text lawful.
const DEFAULT_TEXT_TEMPLATE = {
  body: "Hi {{firstName}}, this is Blake with Wholesale Payments. I came across your sales background and we're adding closers to the team — worth a quick 10-minute call this week?\n\n(Reply STOP and I won't text again.)",
};

// What a brand-new team's first text says. The default above introduces Blake
// by name and names his company, which is right for the team that wrote it and
// wrong for everybody else — a new team must not open by claiming to be
// someone it is not. This one says nothing it cannot know, and the team edits
// it before they send anything anyway.
const NEW_TEAM_TEXT_TEMPLATE = {
  body: "Hi {{firstName}}, I came across your sales background and we're adding closers to the team — worth a quick 10-minute call this week?\n\n(Reply STOP and I won't text again.)",
};

const DEFAULTS = {
  candidates: [],
  events: [],
  template: DEFAULT_TEMPLATE,
  followUp: DEFAULT_FOLLOW_UP,
  textTemplate: DEFAULT_TEXT_TEMPLATE,
  // Saved templates to reuse (lib/presets.js). The default of each kind is
  // the template/textTemplate above, under a name.
  emailTemplates: [],
  textTemplates: [],
  templateDefaults: { email: '', text: '' },
  settings: {
    calendlyUrl: '',
    fromName: 'Blake Woodruff',
    gmailSignature: true,
    ntfyTopic: '',
    smtpUser: '',
    smtpPass: '',
    googleClientId: '',
    googleClientSecret: '',
    calendlySigningKey: '',
    // Every registration mints a new key. Keeping only the newest orphaned any
    // subscription that outlived a cleanup, so the ones we have issued are all
    // kept and any of them may verify a call. Newest first, bounded.
    calendlySigningKeys: [],
    apolloApiKey: '',
    calendlyToken: '',
    lastSheetUrl: '',
    timeZone: '',
    // True only while a team is still holding the starter email it was given
    // on the day it was created. The setup checklist reads it, so a new team
    // is not told it has personalized a letter nobody on it has read. A team
    // that predates this flag never had one, so it is never nagged.
    templateSeeded: false,
    trackingSecret: '',
    dailyLimit: '',
    perMinute: '',
    followUpDays: '',
    maxFollowUps: '',
    // ---- texting via the Mac relay (see lib/text-queue.js) ----
    relayToken: '',
    // The Sales IQ connection token (app.js). Listed here only so load() keeps
    // it; being a known setting does not make it writable through
    // /api/settings, which takes the keys it names and no others.
    salesiqToken: '',
    textDailyLimit: '',
    textMinGap: '',
    textMaxGap: '',
    textStartHour: '',
    textEndHour: '',
    textSunday: false,
  },
  interviews: [],
  calendlyLastSyncAt: null,
  calendlySyncError: '',
};

// Texting used to keep only their side of it — what we sent lived in the
// queue's lease and was thrown away on delivery, so there was never a
// conversation to read, just a column of replies with nothing to reply to.
// One thread holds both halves, oldest first.
// The one key that used to be stored becomes the first entry in the ring, so
// an account that is already registered keeps working without re-registering.
const CALENDLY_KEYS_MAX = 8;
function migrateCalendlyKeys(st) {
  const ring = Array.isArray(st.calendlySigningKeys) ? st.calendlySigningKeys.filter((k) => typeof k === 'string' && k) : [];
  if (st.calendlySigningKey && !ring.includes(st.calendlySigningKey)) ring.unshift(st.calendlySigningKey);
  st.calendlySigningKeys = [...new Set(ring)].slice(0, CALENDLY_KEYS_MAX);
  // The singular field stays the newest, so anything still reading it is right.
  if (!st.calendlySigningKey && st.calendlySigningKeys.length) st.calendlySigningKey = st.calendlySigningKeys[0];
}

// Record a newly issued key without losing the ones already in use.
function addCalendlyKey(st, key) {
  if (!key) return;
  st.calendlySigningKeys = [key, ...(st.calendlySigningKeys || []).filter((k) => k !== key)].slice(0, CALENDLY_KEYS_MAX);
  st.calendlySigningKey = key;
}

const THREAD_MAX = 50;
function migrateThread(c) {
  if (!Array.isArray(c.textThread)) {
    c.textThread = (c.textReplies || [])
      .filter((r) => r && r.ts)
      .map((r) => ({ dir: 'in', ts: r.ts, text: String(r.text || '') }));
  }
  delete c.textReplies;
  c.textThread.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (c.textThread.length > THREAD_MAX) c.textThread = c.textThread.slice(-THREAD_MAX);
}

// Add a message to someone's thread, keeping it ordered and bounded.
function addToThread(c, dir, text, at = null) {
  const ts = at && !Number.isNaN(new Date(at).getTime()) ? new Date(at).toISOString() : new Date().toISOString();
  const body = String(text || '');
  if (!Array.isArray(c.textThread)) c.textThread = [];
  // The relay re-reads a window of chat.db, so the same inbound line can be
  // reported twice; a message is the same message if it matches to the second.
  if (c.textThread.some((m) => m.dir === dir && m.ts === ts && m.text === body)) return false;
  c.textThread.push({ dir, ts, text: body });
  c.textThread.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (c.textThread.length > THREAD_MAX) c.textThread = c.textThread.slice(-THREAD_MAX);
  return true;
}

// Only candidate signals belong in the activity feed. Anything else that
// older versions logged (connections, imports, sends) is dropped on load.
const FEED_TYPES = new Set(['opened', 'replied', 'booked', 'canceled', 'texted', 'text-read', 'text-replied', 'text-optout']);
// Which channel each one came through, so the feed can be filtered by it.
// Bookings and cancellations belong to neither — they are the outcome both
// channels are chasing — so they show whichever way the feed is filtered.
const EVENT_CHANNEL = {
  opened: 'email', replied: 'email',
  texted: 'text', 'text-read': 'text', 'text-replied': 'text', 'text-optout': 'text',
  booked: 'both', canceled: 'both',
};
const KEPT_TYPES = new Set([...FEED_TYPES, 'error']);

// The version each loaded document came from, so save() can refuse to
// overwrite a newer version written by someone else in the meantime.
const ETAG = Symbol('etag');
const MARK = Symbol('mark');
// Who was on the list when it was loaded, and whom this request has been
// asked to delete. save() refuses to write a list that is missing anybody
// else: no bug, stale read or half-built document can quietly drop a
// candidate. Removing one goes through removeCandidate(), and nothing else.
const LOADED_IDS = Symbol('loadedIds');
const REMOVED = Symbol('removed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function load() {
  const { value, etag, mark } = await storage.getJsonWithEtag('db');
  // A team with nothing stored has not been seeded — a creation that failed
  // part way, or a document since removed. Falling through to the built-in
  // defaults would hand them one particular team's sender name, flyer and
  // opening line, which is the one thing a new team must never start with.
  // Those defaults belong to the team that shipped with them, and nobody else.
  const raw = value || (tenant.isLegacy() ? {} : blankTeamDocument());
  // Fill any missing keys so older data keeps working after upgrades.
  const db = { ...structuredClone(DEFAULTS), ...raw };
  db.settings = structuredClone(DEFAULTS.settings);
  // Only known settings survive, so keys removed in later versions fall away.
  for (const k of Object.keys(db.settings)) {
    if (raw.settings && raw.settings[k] != null) db.settings[k] = raw.settings[k];
  }
  migrateCalendlyKeys(db.settings);
  db.template = { ...structuredClone(DEFAULTS.template), ...(raw.template || {}) };
  // Attachments: what was saved, or the built-in flyer until someone changes them.
  db.template.attachments = Array.isArray(raw.template && raw.template.attachments) ? raw.template.attachments : attachments.defaults();
  db.followUp = { ...structuredClone(DEFAULT_FOLLOW_UP), ...(raw.followUp || {}) };
  db.textTemplate = { ...structuredClone(DEFAULT_TEXT_TEMPLATE), ...(raw.textTemplate || {}) };
  migrateTemplate(db.template);
  presets.normalize(db);
  db.events = (db.events || []).filter((e) => e && KEPT_TYPES.has(e.type));
  if (!Array.isArray(db.candidates)) db.candidates = [];
  for (const c of db.candidates) migrateThread(c);
  Object.defineProperty(db, ETAG, { value: etag, enumerable: false, writable: true });
  Object.defineProperty(db, MARK, { value: mark, enumerable: false, writable: true });
  Object.defineProperty(db, LOADED_IDS, { value: new Set(db.candidates.map((c) => c && c.id).filter(Boolean)), enumerable: false });
  Object.defineProperty(db, REMOVED, { value: new Set(), enumerable: false });
  return db;
}

// Earlier versions signed off with "Best,\n{{senderName}}"; the signature now
// comes from the connected Gmail account, so strip the old sign-off from any
// template saved before that change.
function migrateTemplate(t) {
  const hasToken = /\{\{\s*senderName\s*\}\}/i;
  if (hasToken.test(t.body)) {
    t.body = t.body
      .replace(/\n*[ \t]*(best|thanks|thank you|regards|kind regards|warm regards|cheers|sincerely)[^\n]*\n[ \t]*\{\{\s*senderName\s*\}\}[ \t]*$/i, '')
      .replace(/\{\{\s*senderName\s*\}\}/gi, '')
      .replace(/[ \t]+$/gm, '')
      .trimEnd();
  }
  if (hasToken.test(t.subject)) t.subject = t.subject.replace(/\{\{\s*senderName\s*\}\}/gi, '').replace(/\s+/g, ' ').trim();
}

// Conditional on the version load() returned: if another writer saved in
// between, nothing is written and a 409 asks the caller to try again, rather
// than silently discarding their change. Objects not from load() write plainly.
async function save(db) {
  assertNobodyLost(db);
  const etag = db[ETAG];
  if (etag === undefined) { await storage.setJson('db', db); return; }
  const ok = await storage.setJsonIfMatch('db', db, etag, db[MARK]);
  if (!ok) {
    const e = new Error('Someone else saved changes at the same moment — please try again.');
    e.conflict = true; e.status = 409;
    throw e;
  }
}

// Take one person off the list, on purpose. The only sanctioned way. Who
// was removed is remembered (id and address only), so restoring a backup
// never brings them back.
const REMOVED_KEEP = 5000;
function removeCandidate(db, id) {
  const idx = db.candidates.findIndex((x) => x.id === id);
  if (idx === -1) return null;
  const [gone] = db.candidates.splice(idx, 1);
  if (db[REMOVED]) db[REMOVED].add(id);
  if (!Array.isArray(db.removedCandidates)) db.removedCandidates = [];
  db.removedCandidates.unshift({ id: gone.id, email: gone.email || '', at: new Date().toISOString() });
  db.removedCandidates = db.removedCandidates.slice(0, REMOVED_KEEP);
  return gone;
}

function assertNobodyLost(db) {
  if (!Array.isArray(db.candidates)) {
    throw Object.assign(new Error('Refusing to save: the candidate list is missing from this change. Nothing was written.'), { status: 500 });
  }
  const loaded = db[LOADED_IDS];
  if (!loaded || !loaded.size) return;
  const now = new Set(db.candidates.map((c) => c && c.id));
  const removed = db[REMOVED] || new Set();
  const lost = [...loaded].filter((id) => !now.has(id) && !removed.has(id));
  if (lost.length) {
    console.error(`[store] refused a save that would have dropped ${lost.length} candidate(s)`);
    throw Object.assign(new Error(`Refusing to save: this change would have removed ${lost.length} candidate${lost.length === 1 ? '' : 's'} nobody asked to delete. Nothing was written.`), { status: 500, guard: true });
  }
}

// How much history the feed keeps. Texting runs at a fraction of email's
// volume, so a window small enough to hold a day of email opens would hold
// almost no texting at all.
const EVENT_LIMIT = 400;

// Add a feed line to a database you are already holding open. For a caller
// that is inside an update() anyway, this saves a second read-and-write of the
// whole record — which matters on the open-tracking pixel, where it happens
// once per recipient per email.
function pushEvent(db, type, message, candidateId = null, at = null) {
  const when = at && !Number.isNaN(new Date(at).getTime()) ? new Date(at).toISOString() : new Date().toISOString();
  db.events.unshift({ id: rid(), ts: when, type, message, candidateId });
  db.events.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  db.events = db.events.slice(0, EVENT_LIMIT);
}

// `at` is when the thing happened (a reply's date, a booking's time) so the
// feed stays in true order even when it is noticed later; defaults to now.
async function addEvent(type, message, candidateId = null, at = null) {
  await update((db) => pushEvent(db, type, message, candidateId, at));
}

// Drop feed entries matching a predicate. Used to retire a warning once the
// thing it warned about has demonstrably been fixed — a banner that outlives
// its problem teaches people to ignore banners.
async function clearEvents(match) {
  let removed = 0;
  await update((db) => {
    const before = db.events.length;
    db.events = db.events.filter((e) => !match(e));
    removed = before - db.events.length;
  });
  return removed;
}

// Load, mutate, save — retried on a concurrent change, so the mutation is
// always applied on top of the latest version. Keep the mutator free of slow
// work and side effects: it may run more than once.
// A mutator that returns false has found nothing to change, and nothing is
// written: every write rewrites the whole list, and a write that changes
// nothing only gives a real change one more thing to collide with.
async function update(mutator, attempts = 8) {
  for (let i = 0; ; i++) {
    const db = await load();
    if ((await mutator(db)) === false) return db;
    try { await save(db); return db; }
    catch (err) {
      if (!err.conflict || i >= attempts - 1) throw err;
      await sleep(30 + Math.random() * 120 * (i + 1));
    }
  }
}

function rid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// The first document a new team gets. Written explicitly rather than left to
// load()'s defaults, because those defaults are the ones this app shipped with
// for one person: his sender name, his flyer, a text message that introduces
// him by name. A new team starts with none of it — no candidates, no history,
// no connections, no attachment — and its own tracking secret, so one team's
// open-tracking links can never be forged with another team's.
function blankTeamDocument() {
  const db = structuredClone(DEFAULTS);
  db.template = { ...structuredClone(DEFAULT_TEMPLATE), attachments: [] };
  db.followUp = structuredClone(DEFAULT_FOLLOW_UP);
  db.textTemplate = structuredClone(NEW_TEAM_TEXT_TEMPLATE);
  db.settings.fromName = '';
  db.settings.templateSeeded = true;
  db.settings.trackingSecret = crypto.randomBytes(32).toString('hex');
  return db;
}

// Create that document for the team currently in context. Refuses to run over
// a team that already has one, so a retry can never wipe a team's work.
async function seedTeam() {
  // Only if nothing is there: conditional on the entry being new, so even a
  // race with another creation can never write over a team's work.
  if (!(await storage.setJsonIfMatch('db', blankTeamDocument(), null))) {
    throw new Error('That team already has data — refusing to overwrite it.');
  }
  return true;
}

module.exports = { load, save, update, removeCandidate, addEvent, pushEvent, clearEvents, addToThread, addCalendlyKey, seedTeam, blankTeamDocument, THREAD_MAX, CALENDLY_KEYS_MAX, rid, DEFAULT_TEMPLATE, DEFAULT_FOLLOW_UP, DEFAULT_TEXT_TEMPLATE, NEW_TEAM_TEXT_TEMPLATE, FEED_TYPES, EVENT_CHANNEL };
