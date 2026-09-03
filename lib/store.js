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
    '',
    'Best,',
    '{{senderName}}',
  ].join('\n'),
};

const DEFAULTS = {
  candidates: [],
  events: [],
  template: DEFAULT_TEMPLATE,
  settings: {
    senderName: '',
    calendlyUrl: '',
    ntfyTopic: '',
    smtpUser: '',
    smtpPass: '',
    googleClientId: '',
    googleClientSecret: '',
    calendlySigningKey: '',
    lastSheetUrl: '',
  },
};

async function load() {
  const raw = (await storage.getJson('db')) || {};
  // Fill any missing keys so older data keeps working after upgrades.
  const db = { ...structuredClone(DEFAULTS), ...raw };
  db.settings = { ...structuredClone(DEFAULTS.settings), ...(raw.settings || {}) };
  db.template = { ...structuredClone(DEFAULTS.template), ...(raw.template || {}) };
  return db;
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

function rid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

module.exports = { load, save, addEvent, rid, DEFAULT_TEMPLATE };
