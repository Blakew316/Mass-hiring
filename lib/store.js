// App data access on top of the storage adapter (files locally, Netlify
// Blobs when deployed). load() always reads fresh — handlers mutate the
// returned object and pass it back to save().
const storage = require('./storage');
const attachments = require('./attachments');

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

const DEFAULTS = {
  candidates: [],
  events: [],
  template: DEFAULT_TEMPLATE,
  followUp: DEFAULT_FOLLOW_UP,
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
    apolloApiKey: '',
    calendlyToken: '',
    lastSheetUrl: '',
    timeZone: '',
    trackingSecret: '',
    dailyLimit: '',
    perMinute: '',
    followUpDays: '',
    maxFollowUps: '',
  },
  interviews: [],
  calendlyLastSyncAt: null,
  calendlySyncError: '',
};

// Only candidate signals belong in the activity feed. Anything else that
// older versions logged (connections, imports, sends) is dropped on load.
const FEED_TYPES = new Set(['opened', 'replied', 'booked', 'canceled']);
const KEPT_TYPES = new Set([...FEED_TYPES, 'error']);

// The version each loaded document came from, so save() can refuse to
// overwrite a newer version written by someone else in the meantime.
const ETAG = Symbol('etag');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function load() {
  const { value, etag } = await storage.getJsonWithEtag('db');
  const raw = value || {};
  // Fill any missing keys so older data keeps working after upgrades.
  const db = { ...structuredClone(DEFAULTS), ...raw };
  db.settings = structuredClone(DEFAULTS.settings);
  // Only known settings survive, so keys removed in later versions fall away.
  for (const k of Object.keys(db.settings)) {
    if (raw.settings && raw.settings[k] != null) db.settings[k] = raw.settings[k];
  }
  db.template = { ...structuredClone(DEFAULTS.template), ...(raw.template || {}) };
  // Attachments: what was saved, or the built-in flyer until someone changes them.
  db.template.attachments = Array.isArray(raw.template && raw.template.attachments) ? raw.template.attachments : attachments.defaults();
  db.followUp = { ...structuredClone(DEFAULT_FOLLOW_UP), ...(raw.followUp || {}) };
  migrateTemplate(db.template);
  db.events = (db.events || []).filter((e) => e && KEPT_TYPES.has(e.type));
  Object.defineProperty(db, ETAG, { value: etag, enumerable: false, writable: true });
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
  const etag = db[ETAG];
  if (etag === undefined) { await storage.setJson('db', db); return; }
  const ok = await storage.setJsonIfMatch('db', db, etag);
  if (!ok) {
    const e = new Error('Someone else saved changes at the same moment — please try again.');
    e.conflict = true; e.status = 409;
    throw e;
  }
}

// `at` is when the thing happened (a reply's date, a booking's time) so the
// feed stays in true order even when it is noticed later; defaults to now.
async function addEvent(type, message, candidateId = null, at = null) {
  const when = at && !Number.isNaN(new Date(at).getTime()) ? new Date(at).toISOString() : new Date().toISOString();
  await update((db) => {
    db.events.unshift({ id: rid(), ts: when, type, message, candidateId });
    db.events.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    db.events = db.events.slice(0, 200);
  });
}

// Load, mutate, save — retried on a concurrent change, so the mutation is
// always applied on top of the latest version. Keep the mutator free of slow
// work and side effects: it may run more than once.
async function update(mutator, attempts = 8) {
  for (let i = 0; ; i++) {
    const db = await load();
    await mutator(db);
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

module.exports = { load, save, update, addEvent, rid, DEFAULT_TEMPLATE, DEFAULT_FOLLOW_UP, FEED_TYPES };
