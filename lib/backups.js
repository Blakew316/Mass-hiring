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

const INDEX_KEY = 'backups';
const PREFIX = 'backup-';
const KEEP = 20;                         // about three weeks of daily copies
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
  await storage.updateJson(INDEX_KEY, (cur) => {
    const prev = cur && Array.isArray(cur.list) ? cur.list : [];
    const all = [{ key, at, reason, count: d.candidates.length }, ...prev.filter((b) => b.key !== key)];
    dropped = all.slice(KEEP);
    return { list: all.slice(0, KEEP) };
  });
  for (const b of dropped) await storage.del(b.key).catch(() => {});
  return { key, at, reason, count: d.candidates.length };
}

// The scheduled worker's daily copy: only when the newest is a day old.
async function maybeDaily() {
  const [newest] = await list();
  if (newest && Date.now() - Date.parse(newest.at) < DAILY_MS) return null;
  return snapshot('daily');
}

// Who is in the copy but not on the list now — matched by id, and by email
// address ignoring capitals, so nobody is ever added twice.
function missingFrom(db, copy) {
  const ids = new Set(db.candidates.map((c) => c.id));
  const emails = new Set(db.candidates.map((c) => String(c.email || '').trim().toLowerCase()).filter(Boolean));
  return (copy.candidates || []).filter((c) => c && c.id && !ids.has(c.id)
    && !emails.has(String(c.email || '').trim().toLowerCase()));
}

async function restoreMissing(key, { dryRun = false } = {}) {
  if (!(await list()).some((b) => b.key === key)) throw new Error('That backup no longer exists.');
  const copy = await storage.getJson(key);
  if (!copy || !Array.isArray(copy.candidates)) throw new Error('That backup could not be read.');
  if (dryRun) return { missing: missingFrom(await store.load(), copy).length, restored: 0, at: copy.at };
  let restored = 0;
  await store.update((db) => {
    const back = missingFrom(db, copy);
    restored = back.length;
    if (!back.length) return false;
    db.candidates.push(...back.map((c) => structuredClone(c)));
  });
  return { missing: restored, restored, at: copy.at };
}

module.exports = { list, snapshot, maybeDaily, restoreMissing, missingFrom, KEEP, PREFIX };
