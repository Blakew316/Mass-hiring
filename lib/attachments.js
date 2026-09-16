// Files attached to every outreach email. Metadata lives on the template
// (db.template.attachments); the bytes live in their own storage entries so
// the main document stays small. The Account Executive flyer ships with the
// app and is attached from the first send; it can be removed or replaced
// from the Email Template page like any other file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');

const MAX_FILE_BYTES = 4 * 1024 * 1024;   // fits a serverless request as base64 JSON
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 3;
const ALLOWED = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' };

const BUILTIN_ID = 'builtin-account-executive';
const BUILTIN_NAME = 'Account Executive.png';
const BUILTIN_FILE = path.join(__dirname, '..', 'assets', 'attachments', 'account-executive.png');

let builtinBytes;
function builtin() {
  if (builtinBytes !== undefined) return builtinBytes;
  builtinBytes = null;
  // In the deployed bundle esbuild inlines the file (binary loader); locally
  // the require fails and the file is read from disk.
  try {
    const m = require('../assets/attachments/account-executive.png');
    const b = m && m.default ? m.default : m;
    if (b && b.length) builtinBytes = Buffer.from(b);
  } catch {}
  if (!builtinBytes) { try { builtinBytes = fs.readFileSync(BUILTIN_FILE); } catch {} }
  return builtinBytes;
}

function builtinMeta() {
  const b = builtin();
  return b ? { id: BUILTIN_ID, name: BUILTIN_NAME, type: 'image/png', size: b.length, builtin: true, addedAt: null } : null;
}
// What a template gets before anyone has touched attachments.
function defaults() {
  const m = builtinMeta();
  return m ? [m] : [];
}

function list(db) {
  return Array.isArray(db && db.template && db.template.attachments) ? db.template.attachments : [];
}

// Attachments never change once stored (a replacement gets a new id), so the
// bytes can be cached for the life of the process.
const cache = new Map();
async function bytesFor(meta) {
  if (!meta) return null;
  if (cache.has(meta.id)) return cache.get(meta.id);
  const b = meta.builtin ? builtin() : await storage.getBytes(`attachment-${meta.id}`);
  if (b) cache.set(meta.id, b);
  return b;
}

// Ready for the mailer: [{ filename, contentType, content }].
async function loadAll(db) {
  const out = [];
  for (const m of list(db)) {
    const content = await bytesFor(m);
    if (content) out.push({ filename: m.name, contentType: m.type, content });
  }
  return out;
}

function sniff(buf) {
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.slice(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return '';
}

function safeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// Validate and store the bytes; returns the metadata for the caller to
// persist on the template.
async function add(db, { name, data } = {}) {
  const content = Buffer.from(String(data || ''), 'base64');
  if (!content.length) throw new Error('The file is empty.');
  // The type comes from the bytes, never from the label the browser sent.
  const contentType = sniff(content);
  if (!ALLOWED[contentType]) throw new Error('Only PNG, JPG, GIF, WebP images and PDF files can be attached.');
  if (content.length > MAX_FILE_BYTES) throw new Error(`Attachments must be under ${MAX_FILE_BYTES / 1048576} MB each.`);
  const current = list(db);
  if (current.length >= MAX_FILES) throw new Error(`Up to ${MAX_FILES} attachments per email — remove one first.`);
  const total = current.reduce((n, a) => n + (a.size || 0), 0) + content.length;
  if (total > MAX_TOTAL_BYTES) throw new Error(`All attachments together must stay under ${MAX_TOTAL_BYTES / 1048576} MB.`);
  const id = crypto.randomBytes(8).toString('hex');
  await storage.setBytes(`attachment-${id}`, content);
  cache.set(id, content);
  let filename = safeName(name) || 'attachment';
  if (!/\.[a-z0-9]{2,5}$/i.test(filename)) filename += `.${ALLOWED[contentType]}`;
  return { id, name: filename, type: contentType, size: content.length, builtin: false, addedAt: new Date().toISOString() };
}

async function remove(meta) {
  cache.delete(meta.id);
  if (!meta.builtin) await storage.del(`attachment-${meta.id}`);
}

module.exports = { list, loadAll, bytesFor, add, remove, defaults, BUILTIN_ID, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_FILES };
