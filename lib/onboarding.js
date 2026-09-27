// Onboarding docs — WPI Hire, built into this app rather than living on a site
// of its own: the onboarding pipeline, hiring into BambooHR, the new-hire
// paperwork packet and its signed returns.
//
// WPI Hire kept four collections in its own Blobs store — candidates added by
// hand or from a resume, corrections to BambooHR's details, a record of every
// packet sent, and every completed paperwork submission — and took its
// configuration from environment variables. Here all of it is one document
// per team, next to the rest of the team's data, and the configuration is set
// on the page and kept on the server like every other setting. The one team
// that predates teams (lib/tenant.js) still inherits the old environment
// variables, the same way its mail login does; nobody else ever does.
//
// Records keep WPI Hire's shapes exactly, so the page code that reads them is
// WPI Hire's own.
const crypto = require('crypto');
const storage = require('./storage');
const tenant = require('./tenant');

const KEY = 'onboarding';
const SECRET_KEY = 'onboarding-secret';
// The signed copies of a completed packet, one entry per document, encrypted.
const FILE_PREFIX = 'onboarding-file-';
// WPI Hire's own bound on every collection.
const LIMIT = 2000;

const COLLECTIONS = ['candidates', 'overrides', 'sends', 'hires'];

const DEFAULT_COMPANY = {
  name: 'WPI Inc.',
  address: '7602 University Ave, Lubbock, Texas 79423',
  hrName: 'WPI Onboarding',
};
const DEFAULT_TIMEZONE = 'America/Chicago';

const lower = (s) => String(s || '').trim().toLowerCase();
const str = (v, max = 300) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

// ---------------- the stored document ----------------

function blankSettings() {
  return {
    bambooSubdomain: '',
    bambooApiKey: '',
    companyName: '',
    companyAddress: '',
    companyEin: '',
    hrName: '',
    hrEmail: '',
    paperworkInbox: '',
    ccEmail: '',
    timezone: '',
  };
}

function blank() {
  return { v: 1, candidates: [], overrides: [], sends: [], hires: [], settings: blankSettings() };
}

function normalize(raw) {
  const doc = blank();
  if (!raw || typeof raw !== 'object') return doc;
  for (const name of COLLECTIONS) {
    doc[name] = (Array.isArray(raw[name]) ? raw[name] : [])
      .filter((r) => r && typeof r === 'object' && r.id !== undefined && r.id !== null && String(r.id) !== '')
      .slice(0, LIMIT);
  }
  const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  for (const k of Object.keys(doc.settings)) doc.settings[k] = typeof s[k] === 'string' ? s[k] : '';
  return doc;
}

async function load() {
  return normalize(await storage.getJson(KEY));
}

// Read, change, write — conditional on nobody else having written in between,
// and re-run on top of their version if they did. Keep mutators free of side
// effects; returning false writes nothing.
async function update(mutator) {
  const { value } = await storage.updateJson(KEY, (current) => {
    const doc = normalize(current);
    return mutator(doc) === false ? false : doc;
  });
  return normalize(value);
}

// WPI Hire's collection operations, one for one.
function readCollection(doc, name) {
  return doc[name] || [];
}

// Insert or replace a record by id, newest first, with a bounded history.
async function upsertRecord(name, record) {
  await update((doc) => {
    const without = doc[name].filter((r) => String(r.id) !== String(record.id));
    doc[name] = [record, ...without].slice(0, LIMIT);
  });
  return record;
}

async function deleteRecord(name, id) {
  let removed = false;
  await update((doc) => {
    const next = doc[name].filter((r) => String(r.id) !== String(id));
    removed = next.length !== doc[name].length;
    if (!removed) return false;
    doc[name] = next;
  });
  return removed;
}

// ---------------- configuration ----------------
// What the page set, then — for the original team only — what WPI Hire's
// environment variables said, then WPI Hire's own defaults.
function envFor(name) {
  return tenant.isLegacy() ? str(process.env[name] || '', 500) : '';
}

function resolved(settings) {
  const s = settings || blankSettings();
  const pick = (own, env, fallback = '') => str(own, 500) || envFor(env) || fallback;
  return {
    bambooSubdomain: pick(s.bambooSubdomain, 'BAMBOOHR_SUBDOMAIN'),
    bambooApiKey: pick(s.bambooApiKey, 'BAMBOOHR_API_KEY'),
    company: {
      name: pick(s.companyName, 'COMPANY_NAME', DEFAULT_COMPANY.name),
      address: pick(s.companyAddress, 'COMPANY_ADDRESS', DEFAULT_COMPANY.address),
      hrName: pick(s.hrName, 'HR_CONTACT_NAME', DEFAULT_COMPANY.hrName),
      hrEmail: pick(s.hrEmail, 'HR_CONTACT_EMAIL'),
      ein: pick(s.companyEin, 'COMPANY_EIN'),
    },
    paperworkInbox: pick(s.paperworkInbox, 'PAPERWORK_INBOX'),
    ccEmail: pick(s.ccEmail, 'MAIL_CC'),
    timezone: pick(s.timezone, 'COMPANY_TIMEZONE', DEFAULT_TIMEZONE),
  };
}

function live(settings) {
  const r = resolved(settings);
  return Boolean(r.bambooSubdomain && r.bambooApiKey);
}

// What the page is shown: every value, except the API key, which is only
// ever reported as set or not.
function publicSettings(settings) {
  const s = settings || blankSettings();
  const r = resolved(s);
  const key = r.bambooApiKey;
  return {
    bambooSubdomain: s.bambooSubdomain,
    bambooApiKeySet: Boolean(key),
    bambooApiKeyHint: key ? `••••${key.slice(-4)}` : '',
    bambooFromEnv: !s.bambooSubdomain && Boolean(r.bambooSubdomain),
    companyName: s.companyName,
    companyAddress: s.companyAddress,
    companyEin: s.companyEin,
    hrName: s.hrName,
    hrEmail: s.hrEmail,
    paperworkInbox: s.paperworkInbox,
    ccEmail: s.ccEmail,
    timezone: s.timezone,
    // What applies when a field is left empty, for the placeholders.
    effective: {
      bambooSubdomain: r.bambooSubdomain,
      companyName: r.company.name,
      companyAddress: r.company.address,
      companyEin: r.company.ein,
      hrName: r.company.hrName,
      hrEmail: r.company.hrEmail,
      paperworkInbox: r.paperworkInbox,
      ccEmail: r.ccEmail,
      timezone: r.timezone,
    },
  };
}

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// ---------------- keys ----------------
// Two keys, made the first time either is needed and never changed after:
// one signs paperwork links (every link already sent was signed with it), the
// other encrypts the signed copies kept here. They live in an entry of their
// own so the open portal routes can check a link before reading anything else.
async function readSecret() {
  const v = await storage.getJson(SECRET_KEY);
  return v && typeof v.secret === 'string' && typeof v.fileKey === 'string' ? v : null;
}

async function ensureSecret() {
  const have = await readSecret();
  if (have) return have;
  await storage.setJsonIfMatch(SECRET_KEY, {
    secret: crypto.randomBytes(32).toString('hex'),
    fileKey: crypto.randomBytes(32).toString('hex'),
  }, null);
  // Whoever got there first, theirs is the one kept.
  return readSecret();
}

// ---------------- signed copies, encrypted at rest ----------------
// A completed packet carries the hire's Social Security number, bank-free
// but still the most sensitive thing this app holds. Each signed PDF is kept
// sealed with AES-256-GCM under the team's own key: unreadable without it, and
// any tampering with the stored bytes makes opening it fail outright rather
// than hand back an altered document.
const FILE_KEY_RE = /^[A-Za-z0-9-]{1,80}$/;

function fileKeyFor(reference, docKey) {
  if (!FILE_KEY_RE.test(String(reference)) || !FILE_KEY_RE.test(String(docKey))) throw new Error('Invalid document reference.');
  return `${FILE_PREFIX}${reference}-${docKey}`;
}

function seal(buffer, keyHex, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([Buffer.from('WPE1'), iv, cipher.getAuthTag(), body]);
}

function open(sealed, keyHex, aad) {
  if (!Buffer.isBuffer(sealed) || sealed.length < 32 || sealed.subarray(0, 4).toString() !== 'WPE1') throw new Error('This stored document is unreadable.');
  const iv = sealed.subarray(4, 16);
  const tag = sealed.subarray(16, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(32)), decipher.final()]);
}

async function storeSignedCopy(reference, docKey, buffer) {
  const keys = await ensureSecret();
  const key = fileKeyFor(reference, docKey);
  await storage.setBytes(key, seal(buffer, keys.fileKey, key));
}

async function readSignedCopy(reference, docKey) {
  const key = fileKeyFor(reference, docKey);
  const [keys, sealed] = await Promise.all([readSecret(), storage.getBytes(key)]);
  if (!keys || !sealed) return null;
  return open(sealed, keys.fileKey, key);
}

async function deleteSignedCopies(record) {
  for (const f of (record && record.files) || []) {
    try { await storage.del(fileKeyFor(record.reference, f.key)); } catch { /* already gone */ }
  }
}

// ---------------- for the rest of the app ----------------

// Where each person has got to, by email, for the Candidates page: sent a
// packet, and signed it.
function summary(doc) {
  const byEmail = {};
  for (const send of doc.sends) {
    const e = lower(send.email || send.id);
    if (!e) continue;
    byEmail[e] = { sentAt: send.sentAt || null };
  }
  for (const h of doc.hires) {
    const e = lower(h.email);
    if (!e) continue;
    const cur = byEmail[e] || {};
    if (!cur.signedAt || String(h.signedAt || '') > String(cur.signedAt)) {
      byEmail[e] = { ...cur, signedAt: h.signedAt || null, reference: h.reference || '' };
    }
  }
  return { byEmail };
}

// What a backup copies: every record, and the settings without the API key.
function backupCopy(doc) {
  if (!doc) return null;
  const settings = { ...(doc.settings || {}) };
  delete settings.bambooApiKey;
  return { candidates: doc.candidates || [], overrides: doc.overrides || [], sends: doc.sends || [], hires: doc.hires || [], settings };
}

module.exports = {
  KEY, SECRET_KEY, FILE_PREFIX, COLLECTIONS, DEFAULT_TIMEZONE,
  load, update, normalize, blank, blankSettings,
  readCollection, upsertRecord, deleteRecord,
  resolved, live, publicSettings, validTimezone,
  readSecret, ensureSecret,
  storeSignedCopy, readSignedCopy, deleteSignedCopies, fileKeyFor, seal, open,
  summary, backupCopy, lower, str,
};
