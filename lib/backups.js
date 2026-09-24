// Copies of a team's candidate list, kept apart from the live one.
//
// The live list is one document that every send, reply and booking rewrites.
// Everything in lib/store.js is built so that no write can lose anybody, but
// "cannot happen" is a claim about code, and a hiring pipeline is worth more
// than a claim. So once a day the scheduled worker copies the list to a
// separate entry nothing else ever writes, and the last few weeks of copies
// are kept. Restoring never replaces the live list: it only adds back people
// who are in a copy and not on the list now, so it cannot undo anybody's work.
const storage = require('./storage');
const store = require('./store');
const tenant = require('./tenant');
const teams = require('./teams');

const INDEX_KEY = 'backups';
const PREFIX = 'backup-';
// Kept separately, so pressing Back up now twenty times cannot push the
// daily history out.
const KEEP = { daily: 20, manual: 10 };  // about three weeks of daily copies
const DAILY_MS = 20 * 3600 * 1000;       // "daily", with slack for a late minute

async function list() {
  const idx = await storage.getJson(INDEX_KEY);
  return idx && Array.isArray(idx.list) ? idx.list : [];
}

// Copy the list now. `db` may be a document the caller already loaded.
async function snapshot(reason = 'manual', db = null) {
  const d = db || await store.load();
  const at = new Date().toISOString();
  // The time, plus a few random characters: two copies in the same
  // millisecond must not share a key and quietly replace one another.
  const key = `${PREFIX}${at.replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
  // Candidates and the saved messages: what would hurt to lose. Settings are
  // left out on purpose — they hold passwords and tokens, and a copy of a
  // secret is one more place for it to leak from.
  await storage.setJson(key, {
    at,
    reason,
    count: d.candidates.length,
    candidates: d.candidates,
    emailTemplates: d.emailTemplates || [],
    textTemplates: d.textTemplates || [],
  });
  let dropped = [];
  try {
    await storage.updateJson(INDEX_KEY, (cur) => {
      const prev = cur && Array.isArray(cur.list) ? cur.list : [];
      const all = [{ key, at, reason, count: d.candidates.length }, ...prev.filter((b) => b.key !== key)];
      const kept = [];
      const seen = { daily: 0, manual: 0 };
      for (const b of all) {
        const kind = b.reason === 'daily' ? 'daily' : 'manual';
        if (seen[kind]++ < KEEP[kind]) kept.push(b); else dropped.push(b);
      }
      return { list: kept };
    });
  } catch (err) {
    // A copy nobody can find is one nobody will ever delete.
    await storage.del(key).catch(() => {});
    throw err;
  }
  for (const b of dropped) await storage.del(b.key).catch(() => {});
  // The team may have been deleted while this copy was being made. Its data
  // is gone, and so must this be.
  if (!tenant.isLegacy() && !(await teams.byId(tenant.current()).catch(() => null))) {
    await storage.del(key).catch(() => {});
    await storage.del(INDEX_KEY).catch(() => {});
    throw new Error('That team no longer exists.');
  }
  return { key, at, reason, count: d.candidates.length };
}

// The scheduled worker's daily copy: only when the newest is a day old.
async function maybeDaily() {
  const newest = (await list()).find((b) => b.reason === 'daily');
  if (newest && Date.now() - Date.parse(newest.at) < DAILY_MS) return null;
  return snapshot('daily');
}

// Who is in the copy but not on the list now — matched by id, and by email
// address ignoring capitals, so nobody is ever added twice. Anyone deleted
// on purpose since is left out: restoring must not bring back somebody who
// was removed after saying "take me off your list".
const emailOf = (c) => String((c && c.email) || '').trim().toLowerCase();
function missingFrom(db, copy) {
  const ids = new Set(db.candidates.map((c) => c.id));
  const emails = new Set(db.candidates.map(emailOf).filter(Boolean));
  const gone = Array.isArray(db.removedCandidates) ? db.removedCandidates : [];
  const goneIds = new Set(gone.map((r) => r.id));
  const goneEmails = new Set(gone.map(emailOf).filter(Boolean));
  const missing = [];
  let deleted = 0;
  for (const c of copy.candidates || []) {
    if (!c || !c.id || ids.has(c.id) || (emailOf(c) && emails.has(emailOf(c)))) continue;
    if (goneIds.has(c.id) || (emailOf(c) && goneEmails.has(emailOf(c)))) { deleted++; continue; }
    missing.push(c);
  }
  return Object.assign(missing, { deleted });
}

async function restoreMissing(key, { dryRun = false } = {}) {
  if (!(await list()).some((b) => b.key === key)) throw new Error('That backup no longer exists.');
  const copy = await storage.getJson(key);
  if (!copy || !Array.isArray(copy.candidates)) throw new Error('That backup could not be read.');
  if (dryRun) {
    const m = missingFrom(await store.load(), copy);
    return { missing: m.length, deleted: m.deleted, restored: 0, at: copy.at, names: m.slice(0, 5).map((c) => c.name || c.email) };
  }
  let restored = 0;
  let deleted = 0;
  await store.update((db) => {
    const back = missingFrom(db, copy);
    restored = back.length;
    deleted = back.deleted;
    if (!back.length) return false;
    db.candidates.push(...back.map((c) => structuredClone(c)));
  });
  return { missing: restored, deleted, restored, at: copy.at };
}

module.exports = { list, snapshot, maybeDaily, restoreMissing, missingFrom, KEEP, PREFIX };
