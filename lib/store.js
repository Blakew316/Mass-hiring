// App data access on top of the storage adapter (files locally, Netlify
// Blobs when deployed). load() always reads fresh — handlers mutate the
// returned object and pass it back to save().
const storage = require('./storage');

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

const DEFAULTS = {
  candidates: [],
  events: [],
  template: DEFAULT_TEMPLATE,
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
    lastSheetUrl: '',
    timeZone: '',
    trackingSecret: '',
    dailyLimit: '',
    perMinute: '',
  },
};

// Only candidate signals belong in the activity feed. Anything else that
// older versions logged (connections, imports, sends) is dropped on load.
const FEED_TYPES = new Set(['opened', 'replied', 'booked', 'canceled']);
const KEPT_TYPES = new Set([...FEED_TYPES, 'error']);

async function load() {
  const raw = (await storage.getJson('db')) || {};
  // Fill any missing keys so older data keeps working after upgrades.
  const db = { ...structuredClone(DEFAULTS), ...raw };
  db.settings = structuredClone(DEFAULTS.settings);
  // Only known settings survive, so keys removed in later versions fall away.
  for (const k of Object.keys(db.settings)) {
    if (raw.settings && raw.settings[k] != null) db.settings[k] = raw.settings[k];
  }
  db.template = { ...structuredClone(DEFAULTS.template), ...(raw.template || {}) };
  migrateTemplate(db.template);
  db.events = (db.events || []).filter((e) => e && KEPT_TYPES.has(e.type));
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

async function save(db) {
  await storage.setJson('db', db);
}

async function addEvent(type, message, candidateId = null) {
  const db = await load();
  db.events.unshift({ id: rid(), ts: new Date().toISOString(), type, message, candidateId });
  db.events = db.events.slice(0, 200);
  await save(db);
}

// Load, mutate, save — keep the mutator free of slow work so the window in
// which another writer could be overwritten stays tiny.
async function update(mutator) {
  const db = await load();
  await mutator(db);
  await save(db);
  return db;
}

function rid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

module.exports = { load, save, update, addEvent, rid, DEFAULT_TEMPLATE, FEED_TYPES };
