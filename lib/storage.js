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
const tenant = require('./tenant');

let blobs = null;
try { blobs = require('@netlify/blobs'); } catch { blobs = null; }

const onNetlify = Boolean(
  process.env.NETLIFY || process.env.NETLIFY_BLOBS_CONTEXT || process.env.AWS_LAMBDA_FUNCTION_NAME
);
const DATA_DIR = onNetlify ? '/tmp/crm-data' : path.join(__dirname, '..', 'data');
const STORE_NAME = 'crm-data';

// ---- whose data is this? ----
// Every entry below belongs to exactly one team, and the team comes from the
// async context rather than from the caller, so no call site can forget it.
// A team-scoped read or write with no team in context THROWS: silently falling
// back to a shared key is how one team ends up looking at another team's
// candidates, and that must not be possible by accident.
//
// The one exception is the team registry itself, which has to be readable
// before we know which team the request is for.
const GLOBAL_KEYS = new Set(['teams', 'login-guard']);

// Team Maverick's data predates teams entirely: it is stored under the bare
// key names this app has always used. Rather than copy several megabytes of
// candidates, attachments and tokens into a new namespace on some unlucky cold
// start -- a migration that can only ever lose data, never gain any -- that
// team keeps its keys exactly where they are, and every team created since
// lives under t/<id>/. The mapping is one line and the data never moves.
const LEGACY_TEAM_ID = tenant.LEGACY_ID;

function scopedKey(key) {
  const k = String(key);
  if (GLOBAL_KEYS.has(k)) return k;
  const team = tenant.currentOrThrow(`storage entry "${k}"`);
  return team === LEGACY_TEAM_ID ? k : `t/${team}/${k}`;
}

// Where a team's entries start. '' for the legacy team, whose keys are the
// bare ones -- which is why purgeTeam() below never lists by prefix alone.
function teamPrefix(team) {
  return team === LEGACY_TEAM_ID ? '' : `t/${team}/`;
}

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

// A scoped key contains slashes (t/<id>/db), so locally it becomes a path a
// couple of directories deep. Every writer creates that directory first.
function filePath(key) {
  return path.join(DATA_DIR, `${key}.json`);
}

function binPath(key) {
  return path.join(DATA_DIR, `${key}.bin`);
}

function ensureDirFor(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

async function getJson(key) {
  key = scopedKey(key);
  const s = store();
  if (s) {
    try { return await s.get(key, { type: 'json' }); }
    catch (err) { throw blobFailure(err); }
  }
  try { return JSON.parse(fs.readFileSync(filePath(key), 'utf8')); } catch { return null; }
}

async function setJson(key, value) {
  key = scopedKey(key);
  const s = store();
  if (s) {
    try { await s.setJSON(key, value); return; }
    catch (err) { throw blobFailure(err); }
  }
  ensureDirFor(filePath(key));
  fs.writeFileSync(filePath(key), JSON.stringify(value, null, 2));
}

// ---- conditional writes (optimistic concurrency) ----
// A read returns the entry's ETag; a write can be made conditional on it so
// two writers that both loaded the same version cannot overwrite each other:
// the second one is told (modified=false) and re-applies its change on top of
// the newer version (see updateJson). Locally the ETag is a hash of the file.
const fileEtag = (text) => crypto.createHash('sha1').update(text).digest('hex');

async function getJsonWithEtag(key) {
  key = scopedKey(key);
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
  key = scopedKey(key);
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
  ensureDirFor(filePath(key));
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

// ---- binary entries (email attachments) ----
async function getBytes(key) {
  key = scopedKey(key);
  const s = store();
  if (s) {
    try {
      const ab = await s.get(key, { type: 'arrayBuffer' });
      return ab ? Buffer.from(ab) : null;
    } catch (err) { throw blobFailure(err); }
  }
  try { return fs.readFileSync(binPath(key)); } catch { return null; }
}

async function setBytes(key, buffer) {
  key = scopedKey(key);
  const s = store();
  if (s) {
    try {
      const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      await s.set(key, ab);
      return;
    } catch (err) { throw blobFailure(err); }
  }
  ensureDirFor(binPath(key));
  fs.writeFileSync(binPath(key), buffer);
}

async function del(key) {
  key = scopedKey(key);
  const s = store();
  if (s) {
    try { await s.delete(key); return; }
    catch (err) { throw blobFailure(err); }
  }
  try { fs.unlinkSync(filePath(key)); } catch {}
  try { fs.unlinkSync(binPath(key)); } catch {}
}

// ---- deleting a team ----
// The documents a team can own. Everything else it stores hangs off one of
// these, and attachments are found by prefix because their ids are arbitrary.
const TEAM_KEYS = ['db', 'queue', 'text-queue', 'tokens', 'relay', 'session'];
const ATTACHMENT_PREFIX = 'attachment-';

// Keys under a prefix, unscoped (the prefix is already absolute).
async function listRaw(prefix) {
  const s = store();
  if (s) {
    try {
      const r = await s.list({ prefix });
      return (r && r.blobs ? r.blobs : []).map((b) => b.key);
    } catch (err) { throw blobFailure(err); }
  }
  const out = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), child); continue; }
      const m = child.match(/^(.*)\.(json|bin)$/);
      if (m && m[1].startsWith(prefix)) out.push(m[1]);
    }
  };
  walk(DATA_DIR, '');
  return [...new Set(out)];
}

// Erase everything the team in context owns, and nothing else.
//
// For a team under t/<id>/ that is simply "everything with this prefix". The
// legacy team has no prefix -- its keys are the bare ones -- so listing by
// prefix there would sweep up every other team's data and the team registry
// itself. It gets an explicit list instead, which is why TEAM_KEYS exists.
async function purgeTeam() {
  const team = tenant.currentOrThrow('a team purge');
  const prefix = teamPrefix(team);
  const keys = prefix
    ? await listRaw(prefix)
    : [...TEAM_KEYS, ...(await listRaw(ATTACHMENT_PREFIX))];
  const s = store();
  let removed = 0;
  for (const key of keys) {
    if (GLOBAL_KEYS.has(key)) continue;   // never the registry, whatever a listing says
    if (s) {
      try { await s.delete(key); removed++; } catch { /* already gone */ }
    } else {
      let hit = false;
      try { fs.unlinkSync(filePath(key)); hit = true; } catch {}
      try { fs.unlinkSync(binPath(key)); hit = true; } catch {}
      if (hit) removed++;
    }
  }
  return { removed };
}

// Where data is going right now, and whether it will survive a redeploy /
// cold start. Surfaced in /api/state so the dashboard can warn the user.
async function backend() {
  if (!onNetlify) return { kind: 'file', persistent: true, deployed: false, error: null };
  if (store()) return { kind: 'netlify-blobs', persistent: true, deployed: true, error: null };
  return { kind: 'ephemeral', persistent: false, deployed: true, error: blobError };
}

module.exports = {
  getJson, setJson, getJsonWithEtag, setJsonIfMatch, updateJson, getBytes, setBytes, del, backend, onNetlify,
  purgeTeam, scopedKey,
};
