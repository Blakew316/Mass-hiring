// Persistence adapter. Everything the user configures (API keys, Google
// tokens, Calendly, candidates) is stored SERVER-SIDE here — never in the
// browser — so it follows them across devices and sessions.
//
//   local / VPS : JSON files under data/ (easy to back up)
//   Netlify     : Netlify Blobs (function filesystems are ephemeral)
//
// Netlify configures Blobs automatically for modern-format functions (see
// netlify/functions/api.mjs). If it is not configured, every read and write
// FAILS with a storage error rather than quietly using the function's /tmp:
// /tmp is one instance's scratch space, so a list read from it is empty and a
// list written to it is gone at the next cold start — candidates that seem to
// have been saved, then vanish. Set CRM_ALLOW_EPHEMERAL_STORAGE=1 only for a
// throwaway test deployment. Blobs errors are likewise thrown, never papered
// over: a failed read must not look like an empty database.
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
const allowEphemeral = () => process.env.CRM_ALLOW_EPHEMERAL_STORAGE === '1';

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

// The Blobs store for this operation, or null when running from files. On
// Netlify with no Blobs, that is an error, not a reason to use /tmp.
function backing() {
  const s = store();
  if (s || !onNetlify || allowEphemeral()) return s;
  throw blobFailure(new Error(`permanent storage is not available here${blobError ? ` (${blobError})` : ''}`));
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
  const s = backing();
  if (s) {
    try { return await s.get(key, { type: 'json' }); }
    catch (err) { throw blobFailure(err); }
  }
  try { return JSON.parse(fs.readFileSync(filePath(key), 'utf8')); } catch { return null; }
}

async function setJson(key, value) {
  key = scopedKey(key);
  const s = backing();
  if (s) {
    try { await s.setJSON(key, value); return; }
    catch (err) { throw blobFailure(err); }
  }
  ensureDirFor(filePath(key));
  const tmp = `${filePath(key)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath(key));
}

// ---- conditional writes (optimistic concurrency) ----
// A read returns the entry's ETag; a write can be made conditional on it so
// two writers that both loaded the same version cannot overwrite each other:
// the second one is told (modified=false) and re-applies its change on top of
// the newer version (see updateJson). Locally the ETag is a hash of the file.
const fileEtag = (text) => crypto.createHash('sha1').update(text).digest('hex');

async function getJsonWithEtag(key) {
  key = scopedKey(key);
  const s = backing();
  if (s) {
    try {
      const r = await s.getWithMetadata(key, { type: 'json' });
      // `mark` is the marker the last write left (see setJsonIfMatch):
      // undefined when nothing was found, null when an entry predates markers.
      return r
        ? { value: r.data, etag: r.etag || null, mark: (r.metadata && r.metadata.w) || null }
        : { value: null, etag: null, mark: undefined };
    } catch (err) { throw blobFailure(err); }
  }
  try {
    const text = fs.readFileSync(filePath(key), 'utf8');
    return { value: JSON.parse(text), etag: fileEtag(text) };
  } catch { return { value: null, etag: null }; }
}

// Returns true when written; false when the entry changed since it was read
// (or, with etag null, when the entry now exists). Nothing is written on false.
//
// `etag` and `mark` describe the version that was read (getJsonWithEtag).
// Every write stores a one-off marker in the blob's metadata, and it does
// three jobs:
//  - The Blobs client reports ANY answer to a conditional write other than
//    412 as a success — a 500 or a 403 included — so a write that comes back
//    without an ETag is confirmed by finding its marker before anyone is told
//    it saved.
//  - A 412 can be our own write: the answer was lost and the client sent the
//    same request again. Finding our marker there means it landed.
//  - A store that sends no ETag with reads (the local Netlify dev server does
//    not) still tells versions apart: nobody has written since our read if
//    the marker is the one we read.
async function setJsonIfMatch(key, value, etag, mark) {
  key = scopedKey(key);
  const s = backing();
  if (s) {
    try {
      const w = crypto.randomBytes(8).toString('hex');
      const ours = (meta) => Boolean(meta && meta.metadata && meta.metadata.w === w);
      const put = async (cond) => {
        const r = await s.setJSON(key, value, { ...cond, metadata: { w } });
        if (r.modified === false) return false;
        if (r.etag) return true;
        if (ours(await s.getMetadata(key))) return true;
        throw new Error('the save could not be confirmed');
      };
      if (await put(etag ? { onlyIfMatch: etag } : { onlyIfNew: true })) return true;

      // Rejected. The check after it may not fail quietly: a stale read plus a
      // failed check must never add up to "safe to overwrite".
      const meta = await s.getMetadata(key);
      if (ours(meta)) return true;
      if (!meta) return false;                           // gone since: re-read
      const current = meta.etag || null;
      const nowMark = (meta.metadata && meta.metadata.w) || null;
      // Is what is stored still the version we read? By ETag when both sides
      // have one; otherwise by marker — and never when our read found nothing,
      // because "missing" is not a version of something that exists.
      const same = etag && current
        ? current === etag
        : mark !== undefined && nowMark === (mark || null);
      if (!same) return false;                           // a real change: re-read and re-apply
      // The same version, yet the condition failed or could not be stated. Try
      // again, still conditional, on the tag exactly as the store reports it
      // now (and without a weak W/ prefix a proxy may have added).
      if (current) {
        if (await put({ onlyIfMatch: current })) return true;
        const strong = current.replace(/^W\//, '');
        if (strong !== current && await put({ onlyIfMatch: strong })) return true;
      }
      const again = await s.getMetadata(key);
      if (ours(again)) return true;
      if (!again || (again.etag || null) !== current || ((again.metadata && again.metadata.w) || null) !== nowMark) return false;
      // Unchanged, and the store will not take a condition: write, and say so
      // in the function log.
      console.warn(`[storage] conditional write on "${key}" not possible (etag ${current ? 'present' : 'absent'}); writing the version just checked`);
      const r = await s.setJSON(key, value, { metadata: { w } });
      if (r.etag || ours(await s.getMetadata(key))) return true;
      throw new Error('the save could not be confirmed');
    } catch (err) { throw err && err.storage ? err : blobFailure(err); }
  }
  ensureDirFor(filePath(key));
  let current = null;
  try { current = fileEtag(fs.readFileSync(filePath(key), 'utf8')); } catch {}
  if ((current || null) !== (etag || null)) return false;
  // Write to a temporary file and rename it into place, so a crash half-way
  // through leaves the old list rather than half of one.
  const tmp = `${filePath(key)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath(key));
  return true;
}

// Read-modify-write that retries on a concurrent change. `mutate(current)`
// returns the value to store, or false to store nothing.
async function updateJson(key, mutate, { attempts = 8 } = {}) {
  for (let i = 0; ; i++) {
    const { value, etag, mark } = await getJsonWithEtag(key);
    const next = mutate(value);
    if (next === false) return { value, written: false };
    if (await setJsonIfMatch(key, next, etag, mark)) return { value: next, written: true };
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
  const s = backing();
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
  const s = backing();
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
  const s = backing();
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
const TEAM_KEYS = ['db', 'queue', 'text-queue', 'tokens', 'relay', 'session', 'backups'];
const ATTACHMENT_PREFIX = 'attachment-';
const BACKUP_PREFIX = 'backup-';

// Keys under a prefix, unscoped (the prefix is already absolute).
async function listRaw(prefix) {
  const s = backing();
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
    : [...TEAM_KEYS, ...(await listRaw(ATTACHMENT_PREFIX)), ...(await listRaw(BACKUP_PREFIX))];
  const s = backing();
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

// Every team id that still has anything stored under t/<id>/ — including a
// team deleted while something was writing to it. A new team is never given
// one of these ids, so it can never start life holding someone else's data.
async function teamIdsWithData() {
  const keys = await listRaw('t/');
  return new Set(keys.map((k) => k.split('/')[1]).filter(Boolean));
}

// Keys under a prefix, scoped to the team in context. Used for backups.
async function list(prefix) {
  const scoped = scopedKey(prefix);
  const keys = await listRaw(scoped);
  return keys.filter((k) => k.startsWith(scoped)).map((k) => k.slice(scoped.length - String(prefix).length));
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
  purgeTeam, scopedKey, list, teamIdsWithData,
};
