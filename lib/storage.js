// Persistence adapter. Everything the user configures (API keys, Google
// tokens, Calendly, candidates) is stored SERVER-SIDE here — never in the
// browser — so it follows them across devices and sessions.
//
//   local / VPS : JSON files under data/ (easy to back up)
//   Netlify     : Netlify Blobs (function filesystems are ephemeral)
//
// Netlify configures Blobs automatically for modern-format functions (see
// netlify/functions/api.mjs). If it is still not configured we fall back to
// /tmp so the app runs, but backend() reports persistent=false and the UI
// shows a warning. Once a Blobs store exists, its errors are thrown, never
// papered over: a failed read must not look like an empty database, or the
// next save would overwrite the real data with defaults.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let blobs = null;
try { blobs = require('@netlify/blobs'); } catch { blobs = null; }

const onNetlify = Boolean(
  process.env.NETLIFY || process.env.NETLIFY_BLOBS_CONTEXT || process.env.AWS_LAMBDA_FUNCTION_NAME
);
const DATA_DIR = onNetlify ? '/tmp/crm-data' : path.join(__dirname, '..', 'data');
const STORE_NAME = 'crm-data';

let blobError = null;

// A store handle per operation (cheap, no network) so the runtime's current
// credentials are always used. Strong consistency: a save is visible to the
// very next read, from any device.
function store() {
  if (!onNetlify || !blobs) return null;
  try {
    const s = blobs.getStore({ name: STORE_NAME, consistency: 'strong' });
    blobError = null;
    return s;
  } catch (err) {
    blobError = err.message || String(err);
    return null;
  }
}

function blobFailure(err) {
  const msg = err && err.message ? err.message : String(err);
  const e = new Error(`Storage error (Netlify Blobs): ${msg}. Nothing was changed — please retry.`);
  e.storage = true;
  return e;
}

function filePath(key) {
  return path.join(DATA_DIR, `${key}.json`);
}

async function getJson(key) {
  const s = store();
  if (s) {
    try { return await s.get(key, { type: 'json' }); }
    catch (err) { throw blobFailure(err); }
  }
  try { return JSON.parse(fs.readFileSync(filePath(key), 'utf8')); } catch { return null; }
}

async function setJson(key, value) {
  const s = store();
  if (s) {
    try { await s.setJSON(key, value); return; }
    catch (err) { throw blobFailure(err); }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filePath(key), JSON.stringify(value, null, 2));
}

// ---- conditional writes (optimistic concurrency) ----
// A read returns the entry's ETag; a write can be made conditional on it so
// two writers that both loaded the same version cannot overwrite each other:
// the second one is told (modified=false) and re-applies its change on top of
// the newer version (see updateJson). Locally the ETag is a hash of the file.
const fileEtag = (text) => crypto.createHash('sha1').update(text).digest('hex');

async function getJsonWithEtag(key) {
  const s = store();
  if (s) {
    try {
      const r = await s.getWithMetadata(key, { type: 'json' });
      return r ? { value: r.data, etag: r.etag || null } : { value: null, etag: null };
    } catch (err) { throw blobFailure(err); }
  }
  try {
    const text = fs.readFileSync(filePath(key), 'utf8');
    return { value: JSON.parse(text), etag: fileEtag(text) };
  } catch { return { value: null, etag: null }; }
}

// Returns true when written; false when the entry changed since `etag` was read
// (or, with etag null, when the entry now exists). Nothing is written on false.
async function setJsonIfMatch(key, value, etag) {
  const s = store();
  if (s) {
    try {
      const r = await s.setJSON(key, value, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
      if (r.modified !== false) return true;
      // Rejected, yet the stored version is still the one we read: the
      // condition itself misfired (not a real race). Write plainly rather than
      // lock the app out — a genuine concurrent change shows a different ETag.
      const meta = await s.getMetadata(key).catch(() => null);
      const current = meta ? (meta.etag || null) : null;
      if ((current || null) === (etag || null)) {
        console.warn(`[storage] conditional write on "${key}" rejected with an unchanged ETag; writing unconditionally`);
        await s.setJSON(key, value);
        return true;
      }
      return false;
    } catch (err) { throw blobFailure(err); }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let current = null;
  try { current = fileEtag(fs.readFileSync(filePath(key), 'utf8')); } catch {}
  if ((current || null) !== (etag || null)) return false;
  fs.writeFileSync(filePath(key), JSON.stringify(value, null, 2));
  return true;
}

// Read-modify-write that retries on a concurrent change. `mutate(current)`
// returns the value to store, or false to store nothing.
async function updateJson(key, mutate, { attempts = 8 } = {}) {
  for (let i = 0; ; i++) {
    const { value, etag } = await getJsonWithEtag(key);
    const next = mutate(value);
    if (next === false) return { value, written: false };
    if (await setJsonIfMatch(key, next, etag)) return { value: next, written: true };
    if (i >= attempts - 1) {
      const e = new Error('Storage is busy — another change landed at the same moment. Please try again.');
      e.conflict = true; e.status = 409;
      throw e;
    }
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 120 * (i + 1)));
  }
}

async function del(key) {
  const s = store();
  if (s) {
    try { await s.delete(key); return; }
    catch (err) { throw blobFailure(err); }
  }
  try { fs.unlinkSync(filePath(key)); } catch {}
}

// Where data is going right now, and whether it will survive a redeploy /
// cold start. Surfaced in /api/state so the dashboard can warn the user.
async function backend() {
  if (!onNetlify) return { kind: 'file', persistent: true, deployed: false, error: null };
  if (store()) return { kind: 'netlify-blobs', persistent: true, deployed: true, error: null };
  return { kind: 'ephemeral', persistent: false, deployed: true, error: blobError };
}

module.exports = { getJson, setJson, getJsonWithEtag, setJsonIfMatch, updateJson, del, backend, onNetlify };
