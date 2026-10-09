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

// ---- the team document, held between requests ----
// The team document ("db") is the one big thing stored — some 20 MB at
// 33,000 candidates — and nearly every request reads it. Each instance keeps
// the bytes of the last version of it that it read or wrote, under that
// version's ETag, and every read asks the store for anything newer than
// that: Netlify Blobs answers an unchanged document with a 304 and no body,
// so the read costs a round trip instead of a 20 MB download. A write drops
// what is held before it starts and keeps what it wrote once the store has
// confirmed it, under the ETag the store gave it.
//
// This is the only cache of stored data in the app, and it never answers
// without asking the store first. store.read() shares one parsed copy per
// version on top of it, keyed by the ETag handed back from here, so neither
// can serve a version the store has moved past — from this instance or any
// other.
//
// Files behave the same way: the file is read every time (another process
// may have written it), and when it is byte for byte the version held, the
// held bytes and ETag are used instead of hashing 20 MB again.
const HELD_NAMES = new Set(['db']);
const HELD_MAX = 4;                  // one per team this instance serves, within reason
// Held as UTF-8 bytes, not as a string: a document with any character past
// Latin-1 in it (a curly quote, an emoji in a text) is two bytes a character
// as a string, twice its stored size, and at 100,000 people that difference
// alone is some 85 MB of a 1 GB function. It is decoded only to be parsed.
const held = new Map();              // scoped key -> { bytes, etag, mark }

// The held document is written as ASCII, anything past it as a \u escape
// (which JSON reads back as the very same character). Decoded, its text is
// then one byte a character in memory; with a single curly quote or emoji in
// it anywhere, it would be two throughout — 125 MB rather than 63 at 100,000
// people, on every read of a new version and every write.
const PAST_ASCII = /[\u0080-\uffff]/g;
const escaped = (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
function docBytes(value, indent) {
  return Buffer.from(JSON.stringify(value, null, indent).replace(PAST_ASCII, escaped), 'latin1');
}

function hold(key, entry) {
  held.delete(key);
  held.set(key, entry);
  while (held.size > HELD_MAX) held.delete(held.keys().next().value);
}

// The stored text of an entry and the version it is. `text` is null when
// nothing is stored. `file` says it came from the local files, whose reads
// have always treated an unreadable file as no file at all.
async function readText(name) {
  const key = scopedKey(name);
  const keep = HELD_NAMES.has(String(name));
  const s = backing();
  if (s) {
    try {
      const had = keep ? held.get(key) : null;
      const r = await s.getWithMetadata(key, had && had.etag ? { type: 'arrayBuffer', etag: had.etag } : { type: 'arrayBuffer' });
      if (!r) {
        if (keep) held.delete(key);
        return { key, bytes: null, etag: null, mark: undefined };
      }
      if (r.data === null || r.data === undefined) {
        // Not modified: what this instance holds is the current version. The
        // entry asked about is the one captured above, never whatever the map
        // holds now, so a write landing meanwhile cannot pair this version's
        // ETag with another version's text. A body-less answer with nothing
        // held to stand for it is a storage fault, never an empty list.
        if (!had) throw new Error('the store answered without the entry it was asked for');
        if (held.get(key) === had) hold(key, had);
        return { key, bytes: had.bytes, etag: had.etag, mark: had.mark };
      }
      // `mark` is the marker the last write left (see setJsonIfMatch): null
      // when an entry predates markers.
      const entry = { key, bytes: Buffer.from(r.data), etag: r.etag || null, mark: (r.metadata && r.metadata.w) || null };
      if (keep) {
        // A store that sends no ETag with reads (the local Netlify dev server)
        // has nothing to ask "anything newer?" with, so nothing is held.
        if (entry.etag) hold(key, entry); else held.delete(key);
      }
      return entry;
    } catch (err) { throw err && err.storage ? err : blobFailure(err); }
  }
  let bytes;
  try { bytes = fs.readFileSync(filePath(key)); } catch {
    if (keep) held.delete(key);
    return { key, bytes: null, etag: null, file: true };
  }
  // Compared as bytes: hashing 20 MB costs more than comparing it.
  const had = keep ? held.get(key) : null;
  if (had && had.bytes.equals(bytes)) return { key, bytes: had.bytes, etag: had.etag, file: true };
  const etag = fileEtag(bytes);
  if (keep) hold(key, { bytes, etag, mark: undefined });
  return { key, bytes, etag, file: true };
}

// What readText() found, parsed. A file that does not parse reads as no file,
// as it always has; a stored blob that does not parse is a storage fault.
// Either way that text is not kept: the next read fetches it afresh.
function parseEntry(entry) {
  if (entry.bytes === null) return { value: null, etag: null, mark: entry.mark };
  try { return { value: JSON.parse(entry.bytes.toString('utf8')), etag: entry.etag, mark: entry.mark }; }
  catch (err) {
    const h = held.get(entry.key);
    if (h && h.bytes === entry.bytes) held.delete(entry.key);
    if (entry.file) return { value: null, etag: null };
    throw blobFailure(err);
  }
}

async function getJson(key) {
  if (HELD_NAMES.has(String(key))) return parseEntry(await readText(key)).value;
  key = scopedKey(key);
  const s = backing();
  if (s) {
    try { return await s.get(key, { type: 'json' }); }
    catch (err) { throw blobFailure(err); }
  }
  try { return JSON.parse(fs.readFileSync(filePath(key), 'utf8')); } catch { return null; }
}

async function setJson(key, value) {
  const keep = HELD_NAMES.has(String(key));
  key = scopedKey(key);
  if (keep) held.delete(key);
  const s = backing();
  if (s) {
    try {
      if (!keep) { await s.setJSON(key, value); return; }
      // The text is made here rather than by setJSON, once, so that what is
      // held is exactly what was stored.
      const bytes = docBytes(value);
      const r = await s.set(key, bytes);
      if (r && r.etag) hold(key, { bytes, etag: r.etag, mark: null });
      return;
    } catch (err) { throw blobFailure(err); }
  }
  ensureDirFor(filePath(key));
  const tmp = `${filePath(key)}.${process.pid}.tmp`;
  const bytes = keep ? docBytes(value, 2) : Buffer.from(JSON.stringify(value, null, 2));
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, filePath(key));
  if (keep) hold(key, { bytes, etag: fileEtag(bytes), mark: undefined });
}

// ---- conditional writes (optimistic concurrency) ----
// A read returns the entry's ETag; a write can be made conditional on it so
// two writers that both loaded the same version cannot overwrite each other:
// the second one is told (modified=false) and re-applies its change on top of
// the newer version (see updateJson). Locally the ETag is a hash of the file.
const fileEtag = (text) => crypto.createHash('sha1').update(text).digest('hex');

async function getJsonWithEtag(key) {
  if (HELD_NAMES.has(String(key))) return parseEntry(await readText(key));
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

// The stored text and its version, unparsed, for a caller that keeps its own
// parsed copy per version (store.read()) and parses only what it has not
// seen. Only for the held document.
async function getTextWithEtag(key) {
  if (!HELD_NAMES.has(String(key))) throw new Error(`getTextWithEtag is only for the team document, not "${key}"`);
  return readText(key);
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
  const keep = HELD_NAMES.has(String(key));
  key = scopedKey(key);
  // Whatever happens next, what was held may no longer be current. (Only
  // the files need it after this: on Blobs it is not kept alive while the
  // new version is made and written.)
  const s = backing();
  const had = keep && !s ? held.get(key) : null;
  if (keep) held.delete(key);
  if (s) {
    try {
      const w = crypto.randomBytes(8).toString('hex');
      // The held document's text is made here, once, so that what is kept is
      // exactly what was stored; anything else is written as it always was.
      const bytes = keep ? docBytes(value) : null;
      const write = (opts) => (keep ? s.set(key, bytes, opts) : s.setJSON(key, value, opts));
      let stored = null;               // the ETag the store gave our write, once known
      const ours = (meta) => {
        if (!(meta && meta.metadata && meta.metadata.w === w)) return false;
        if (meta.etag) stored = meta.etag;
        return true;
      };
      const put = async (cond) => {
        const r = await write({ ...cond, metadata: { w } });
        if (r.modified === false) return false;
        if (r.etag) { stored = r.etag; return true; }
        if (ours(await s.getMetadata(key))) return true;
        throw new Error('the save could not be confirmed');
      };
      const attempt = async () => {
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
        const r = await write({ metadata: { w } });
        if (r.etag) { stored = r.etag; return true; }
        if (ours(await s.getMetadata(key))) return true;
        throw new Error('the save could not be confirmed');
      };
      const written = await attempt();
      if (written && keep && stored) hold(key, { bytes, etag: stored, mark: w });
      return written;
    } catch (err) { throw err && err.storage ? err : blobFailure(err); }
  }
  ensureDirFor(filePath(key));
  let current = null;
  try {
    const onDisk = fs.readFileSync(filePath(key));
    current = had && had.bytes.equals(onDisk) ? had.etag : fileEtag(onDisk);
  } catch {}
  if ((current || null) !== (etag || null)) return false;
  // Write to a temporary file and rename it into place, so a crash half-way
  // through leaves the old list rather than half of one.
  const tmp = `${filePath(key)}.${process.pid}.tmp`;
  const bytes = keep ? docBytes(value, 2) : Buffer.from(JSON.stringify(value, null, 2));
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, filePath(key));
  if (keep) hold(key, { bytes, etag: fileEtag(bytes), mark: undefined });
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
  held.delete(key);
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
// The reply check's and the Calendly sync's own small records (where the
// search got to, who was read when, when the sync last ran) go with them.
const TEAM_KEYS = ['db', 'queue', 'text-queue', 'tokens', 'relay', 'session', 'backups', 'salesiq', 'salesiq-secret', 'onboarding', 'onboarding-secret',
  'reply-cursor', 'reply-checked', 'calendly-sync'];
const ATTACHMENT_PREFIX = 'attachment-';
const BACKUP_PREFIX = 'backup-';
// Signed onboarding paperwork, one entry per document (lib/onboarding.js).
const ONBOARDING_FILE_PREFIX = 'onboarding-file-';

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
    : [...TEAM_KEYS, ...(await listRaw(ATTACHMENT_PREFIX)), ...(await listRaw(BACKUP_PREFIX)), ...(await listRaw(ONBOARDING_FILE_PREFIX))];
  const s = backing();
  let removed = 0;
  for (const key of keys) {
    if (GLOBAL_KEYS.has(key)) continue;   // never the registry, whatever a listing says
    held.delete(key);
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
  getJson, setJson, getJsonWithEtag, getTextWithEtag, parseEntry, setJsonIfMatch, updateJson, getBytes, setBytes, del, backend, onNetlify,
  purgeTeam, scopedKey, list, teamIdsWithData,
};
