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

module.exports = { getJson, setJson, del, backend, onNetlify };
