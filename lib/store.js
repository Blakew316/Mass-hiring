// Tiny JSON-file data store. Single-user tool, so a flat file keeps the app
// dependency-free and easy to back up (data/db.json is gitignored).
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

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

let db = null;

function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    db = {};
  }
  // Fill any missing keys so older db files keep working after upgrades.
  db = { ...structuredClone(DEFAULTS), ...db };
  db.settings = { ...structuredClone(DEFAULTS.settings), ...(db.settings || {}) };
  db.template = { ...structuredClone(DEFAULTS.template), ...(db.template || {}) };
  return db;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function addEvent(type, message, candidateId = null) {
  const d = load();
  d.events.unshift({ id: rid(), ts: new Date().toISOString(), type, message, candidateId });
  d.events = d.events.slice(0, 200);
  save();
}

function rid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

module.exports = { load, save, addEvent, rid, DEFAULT_TEMPLATE };
