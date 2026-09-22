// Text (iMessage) send queue, stored under its own key "text-queue" and only
// ever changed through atomic read-modify-write, exactly like lib/queue.js.
//
// The important difference from email: THIS SERVER DOES NOT SEND. It cannot —
// iMessage only exists on a Mac. The Mac Studio runs a small relay daemon
// (see relay/) that polls, claims one message at a time, sends it through
// BlueBubbles and reports back. So the queue here is a work dispatcher:
//
//   claim()   hands the relay at most ONE due message and leases it
//   report()  records what happened to it
//   reap()    returns a lease the relay never reported (crash, sleep, reboot)
//
// Three things gate every claim, and all three matter:
//   * a daily cap, because Apple bans accounts that blast strangers — the
//     practical ceiling is around 100/day and we default well under it
//   * a randomised gap between messages, because a fixed interval is the
//     single most obvious bot signal there is
//   * the RECIPIENT's local clock, because a 6am text is both rude and,
//     under the TCPA, outside the hours you are allowed to send in
const crypto = require('crypto');
const storage = require('./storage');
const phone = require('./phone');

// Apple publishes no limit. Reported experience is that a few hundred a day to
// strangers gets iMessage disabled on the Apple ID within weeks, and ~100/day
// is the point where risk starts climbing steeply. We cap there and default
// below it; this is a reputation limit, not a technical one, so it is
// deliberately not raisable from the dashboard.
const DEFAULT_DAILY = 60;
const MAX_DAILY = 100;
const MIN_DAILY = 1;
// Gap between two messages, randomised inside the range every time.
const DEFAULT_MIN_GAP = 45;
const DEFAULT_MAX_GAP = 150;
const MIN_GAP_FLOOR = 20;
const MAX_GAP_CEILING = 1800;
const DEFAULT_START_HOUR = 9;
const DEFAULT_END_HOUR = 19;
// How long the relay has to report a claimed message before we assume it died.
const LEASE_MS = 3 * 60 * 1000;
// A message whose lease expired this many times is failed rather than retried
// forever — something about it is not working.
const MAX_CLAIM_ATTEMPTS = 3;
const DAY_MS = 24 * 3600 * 1000;
// The relay is considered online if it checked in within this long.
const RELAY_STALE_MS = 90 * 1000;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const DEFAULTS = {
  items: [],        // [{ id, phone, t, at }] pending; at = do not send before (ISO)
  leases: {},       // jobId -> { id, phone, body, t, until, attempt }
  templates: {},    // key -> { body }
  failed: [],       // [{ id, phone, error, ts, t }]
  attempts: {},     // candidate id -> expired-lease count
  sentLog: [],      // [{ id, phone, ts }] every text sent; pruned to 48h
  optOut: [],       // phone numbers that asked us to stop — never texted again
  total: 0,
  sent: 0,
  startedAt: null,
  pausedUntil: null,
  pauseKind: '',
  note: '',
  nextSendAt: null, // the randomised pacing gate
};

function normalize(raw) {
  const q = { ...structuredClone(DEFAULTS), ...(raw || {}) };
  const cutoff = Date.now() - 2 * DAY_MS;
  q.sentLog = (q.sentLog || []).filter((e) => e && new Date(e.ts).getTime() >= cutoff);
  q.leases = q.leases || {};
  q.attempts = q.attempts || {};
  q.optOut = Array.from(new Set((q.optOut || []).map((p) => phone.normalize(p)).filter(Boolean)));
  return q;
}

async function loadQ() { return normalize(await storage.getJson('text-queue')); }
const saveQ = (q) => storage.setJson('text-queue', q);

async function updateQ(mutate) {
  const { value } = await storage.updateJson('text-queue', (raw) => {
    const q = normalize(raw);
    if (mutate(q) === false) return false;
    return q;
  });
  return normalize(value);
}

// The pace actually used, clamped to what is safe. Blank means "the default".
function limits(settings = {}) {
  const num = (v, dflt) => { const s = String(v ?? '').trim(); const n = Number(s); return s === '' || !Number.isFinite(n) ? dflt : n; };
  const dailyLimit = clamp(Math.round(num(settings.textDailyLimit, DEFAULT_DAILY)), MIN_DAILY, MAX_DAILY);
  let minGap = clamp(Math.round(num(settings.textMinGap, DEFAULT_MIN_GAP)), MIN_GAP_FLOOR, MAX_GAP_CEILING);
  let maxGap = clamp(Math.round(num(settings.textMaxGap, DEFAULT_MAX_GAP)), MIN_GAP_FLOOR, MAX_GAP_CEILING);
  if (maxGap < minGap) maxGap = minGap;   // a typo must never invert the range
  const startHour = clamp(Math.round(num(settings.textStartHour, DEFAULT_START_HOUR)), 0, 23);
  let endHour = clamp(Math.round(num(settings.textEndHour, DEFAULT_END_HOUR)), 1, 24);
  if (endHour <= startHour) endHour = Math.min(24, startHour + 1);
  const days = settings.textSunday ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6];
  return { dailyLimit, minGap, maxGap, startHour, endHour, days, dailyMax: MAX_DAILY };
}

// Stored form of the texting settings, clamped the same way, so Settings can
// never display a number the queue would quietly ignore.
function normalizeTextSettings(settings) {
  const out = {};
  const norm = (key, lo, hi) => {
    if (!(key in settings)) return;
    const str = String(settings[key] ?? '').trim();
    if (str === '') { out[key] = ''; return; }
    const n = Number(str);
    out[key] = Number.isFinite(n) ? String(clamp(Math.round(n), lo, hi)) : '';
  };
  norm('textDailyLimit', MIN_DAILY, MAX_DAILY);
  norm('textMinGap', MIN_GAP_FLOOR, MAX_GAP_CEILING);
  norm('textMaxGap', MIN_GAP_FLOOR, MAX_GAP_CEILING);
  norm('textStartHour', 0, 23);
  norm('textEndHour', 1, 24);
  return out;
}

function templateKey(t) {
  return crypto.createHash('sha1').update(String(t.body || '')).digest('hex').slice(0, 12);
}

const sentWithin = (q, ms) => q.sentLog.filter((e) => new Date(e.ts).getTime() >= Date.now() - ms);
const sentWithin24h = (q) => sentWithin(q, DAY_MS);
const sentToday = (q) => sentWithin24h(q).length;
const recentIds = (q) => new Set(sentWithin24h(q).map((e) => e.id));
const recentPhones = (q) => new Set(sentWithin24h(q).map((e) => e.phone));

// When the 24h window next drops below the cap, so the dashboard can say when
// texting resumes instead of just "paused".
function dailyResumeAt(q, dailyLimit) {
  const times = sentWithin24h(q).map((e) => new Date(e.ts).getTime()).sort((a, b) => a - b);
  const surplus = times.length - dailyLimit;
  if (surplus < 0) return null;
  return new Date(times[surplus] + DAY_MS + 1000);
}

// ---------- queue edits (callers wrap these in updateQ) ----------
function enqueue(q, db, ids, template, { ignoreQuietHours = false } = {}) {
  const known = new Map(db.candidates.map((c) => [c.id, c]));
  const queued = new Set(q.items.map((i) => i.id));
  const leased = new Set(Object.values(q.leases).map((l) => l.id));
  const recent = recentIds(q);
  // Every number already spoken for — sent in the last day, waiting in the
  // queue, or out with the relay right now. Two candidate rows that share a
  // number must never both be texted, whether they arrive in one import or
  // two, so this set is built from the stored queue and not just this batch.
  const takenPhones = new Set([
    ...recentPhones(q),
    ...q.items.map((i) => i.phone),
    ...Object.values(q.leases).map((l) => l.phone),
  ]);
  const blocked = new Set(q.optOut);
  const t = template ? templateKey(template) : null;
  if (t) q.templates[t] = { body: String(template.body || '') };
  const added = [];
  const skipped = { noPhone: 0, optedOut: 0, alreadyTexted: 0, queued: 0 };
  for (const id of ids) {
    const c = known.get(id);
    if (!c) continue;
    if (queued.has(id) || leased.has(id)) { skipped.queued += 1; continue; }
    const p = phone.normalize(c.phone);
    if (!p) { skipped.noPhone += 1; continue; }
    if (blocked.has(p)) { skipped.optedOut += 1; continue; }
    // Dedupe on the number as well as the person: two candidate rows sharing a
    // phone must not both get a text.
    if (recent.has(id) || takenPhones.has(p)) { skipped.alreadyTexted += 1; continue; }
    queued.add(id); takenPhones.add(p);
    // `now` means: skip the quiet-hour window and the pace gate for this one.
    // It exists so a test message can be sent at any hour without moving the
    // settings that protect everybody else. The daily cap still applies.
    added.push(ignoreQuietHours ? { id, phone: p, t, at: null, now: 1 } : { id, phone: p, t, at: null });
  }
  if (!q.items.length && added.length) {
    q.total = 0; q.sent = 0; q.startedAt = new Date().toISOString(); q.failed = [];
  }
  // Ahead of any campaign already waiting — the whole point is an immediate answer.
  if (ignoreQuietHours) q.items.unshift(...added);
  else q.items.push(...added);
  q.total += added.length;
  q.note = '';
  pruneTemplates(q);
  return { added: added.length, skipped };
}

function clearQueue(q) {
  q.items = []; q.leases = {}; q.total = q.sent; q.startedAt = null;
  q.pausedUntil = null; q.pauseKind = ''; q.note = ''; q.attempts = {};
  pruneTemplates(q);
}

function retryFailed(q, db) {
  const known = new Map(db.candidates.map((c) => [c.id, c]));
  const recent = recentIds(q);
  const queued = new Set(q.items.map((i) => i.id));
  const blocked = new Set(q.optOut);
  const again = q.failed.filter((f) => known.has(f.id) && !recent.has(f.id) && !queued.has(f.id) && !blocked.has(f.phone));
  q.failed = [];
  q.attempts = {};
  if (!q.items.length && again.length) { q.total = 0; q.sent = 0; q.startedAt = new Date().toISOString(); }
  for (const f of again) q.items.push({ id: f.id, phone: f.phone, t: f.t || null, at: null });
  q.total += again.length;
  q.note = '';
  return again.length;
}

function pruneTemplates(q) {
  const used = new Set([
    ...q.items.map((i) => i.t),
    ...q.failed.map((f) => f.t),
    ...Object.values(q.leases).map((l) => l.t),
  ].filter(Boolean));
  for (const k of Object.keys(q.templates)) if (!used.has(k)) delete q.templates[k];
}

function recordSent(q, id, number, ts = new Date().toISOString()) {
  q.sentLog.push({ id, phone: number, ts });
  q.items = q.items.filter((i) => i.id !== id);
  delete q.attempts[id];
}

function fail(q, { id, phone: number, error, t }) {
  q.failed = [...q.failed, { id, phone: number, error: String(error || 'Unknown error'), ts: new Date().toISOString(), t: t || null }].slice(-200);
  q.items = q.items.filter((i) => i.id !== id);
  delete q.attempts[id];
}

// Someone asked us to stop. Blocks the number everywhere, now and later.
function addOptOut(q, number) {
  const p = phone.normalize(number);
  if (!p) return false;
  if (!q.optOut.includes(p)) q.optOut.push(p);
  q.items = q.items.filter((i) => i.phone !== p);
  for (const [jobId, l] of Object.entries(q.leases)) if (l.phone === p) delete q.leases[jobId];
  return true;
}

// Leases the relay never reported on: put the work back, or fail it once it
// has had enough goes.
function reap(q, now = Date.now()) {
  let returned = 0;
  const done = recentPhones(q);
  for (const [jobId, l] of Object.entries(q.leases)) {
    if (new Date(l.until).getTime() > now) continue;
    delete q.leases[jobId];
    // It may in fact have gone out and been reported through another path.
    if (done.has(l.phone)) continue;
    const n = (q.attempts[l.id] || 0) + 1;
    q.attempts[l.id] = n;
    if (n >= MAX_CLAIM_ATTEMPTS) {
      fail(q, { id: l.id, phone: l.phone, t: l.t, error: 'The Mac relay claimed this message but never reported back — check that the relay and BlueBubbles are running.' });
      continue;
    }
    if (!q.items.some((i) => i.id === l.id)) q.items.unshift({ id: l.id, phone: l.phone, t: l.t, at: null });
    returned += 1;
  }
  return returned;
}

// ---------- the relay's claim ----------
// Deliberately hands out AT MOST ONE message per call. The relay polls every
// few seconds, so one-at-a-time is no slower, and it is the only way the
// randomised gap can actually be enforced: a batch would be sent back to back
// by the relay however carefully we paced the handout.
function claim(q, db, { now = Date.now(), render } = {}) {
  // `changed` tells the caller whether anything was actually modified. The
  // relay polls constantly and usually finds nothing to do; without this every
  // poll would rewrite the queue record for no reason.
  let changed = reap(q, now) > 0;
  if (q.pausedUntil && new Date(q.pausedUntil).getTime() > now) {
    return { job: null, reason: 'paused', until: q.pausedUntil, changed };
  }
  const { dailyLimit, minGap, maxGap, startHour, endHour, days } = limits(db.settings);
  if (sentToday(q) >= dailyLimit) {
    const resume = dailyResumeAt(q, dailyLimit);
    return { job: null, reason: 'daily-limit', until: resume ? resume.toISOString() : null, changed };
  }
  // A message marked "now" is not held behind the gap between sends — waiting
  // two minutes to find out whether the Mac works at all is not a test.
  const urgent = q.items.some((i) => i.now);
  if (!urgent && q.nextSendAt && new Date(q.nextSendAt).getTime() > now) {
    return { job: null, reason: 'paced', until: q.nextSendAt, changed };
  }
  if (!q.items.length) return { job: null, reason: 'empty', changed };

  const byId = new Map(db.candidates.map((c) => [c.id, c]));
  const blocked = new Set(q.optOut);
  const recent = recentIds(q);
  const recentP = recentPhones(q);
  const at = new Date(now);
  let quiet = 0;

  for (let i = 0; i < q.items.length; i++) {
    const it = q.items[i];
    const c = byId.get(it.id);
    // Dropped from the list, already texted, or opted out since being queued.
    if (!c || recent.has(it.id) || recentP.has(it.phone) || blocked.has(it.phone)) {
      q.items.splice(i, 1); i -= 1; changed = true; continue;
    }
    if (it.at && new Date(it.at).getTime() > now) { quiet += 1; continue; }
    if (!it.now && !phone.withinHours(it.phone, { startHour, endHour, days }, at)) {
      // Not their hours yet — park it until their morning and move on.
      it.at = phone.nextWindowStart(it.phone, { startHour, endHour, days }, at).toISOString();
      quiet += 1; changed = true; continue;
    }
    const tpl = (it.t && q.templates[it.t]) || null;
    const body = render ? render(tpl, c) : String((tpl && tpl.body) || '');
    if (!body.trim()) { q.items.splice(i, 1); i -= 1; changed = true; fail(q, { id: it.id, phone: it.phone, t: it.t, error: 'The text template is empty.' }); continue; }
    const jobId = crypto.randomBytes(12).toString('hex');
    q.items.splice(i, 1);
    q.leases[jobId] = {
      id: it.id, phone: it.phone, body, t: it.t || null,
      until: new Date(now + LEASE_MS).toISOString(),
      attempt: (q.attempts[it.id] || 0) + 1,
    };
    // Randomised, not fixed: a metronome is the clearest bot tell there is.
    const gap = minGap + Math.floor(Math.random() * (maxGap - minGap + 1));
    q.nextSendAt = new Date(now + gap * 1000).toISOString();
    return { job: { jobId, phone: it.phone, body, candidateId: it.id, name: c.name || '' }, reason: 'ok', gap, changed: true };
  }
  return { job: null, reason: quiet ? 'quiet-hours' : 'empty', changed };
}

// What the relay tells us happened. status: sent | failed | not-imessage
function report(q, { jobId, status, error }) {
  const lease = q.leases[jobId];
  if (!lease) return { ok: false, reason: 'unknown-or-expired-job' };
  delete q.leases[jobId];
  if (status === 'sent') {
    recordSent(q, lease.id, lease.phone);
    q.sent += 1;
    q.total = Math.max(q.total, q.sent);
    if (!q.items.length && !Object.keys(q.leases).length) q.startedAt = null;   // the run is done
    return { ok: true, status: 'sent', candidateId: lease.id, phone: lease.phone };
  }
  if (status === 'not-imessage') {
    fail(q, { id: lease.id, phone: lease.phone, t: lease.t, error: 'Not reachable on iMessage — this number has no iMessage account.' });
    return { ok: true, status: 'not-imessage', candidateId: lease.id, phone: lease.phone };
  }
  fail(q, { id: lease.id, phone: lease.phone, t: lease.t, error: error || 'The Mac relay could not send this message.' });
  return { ok: true, status: 'failed', candidateId: lease.id, phone: lease.phone };
}

function status(q, settings = {}, relay = null) {
  const { dailyLimit, minGap, maxGap, startHour, endHour, days, dailyMax } = limits(settings);
  const pausedUntil = q.pausedUntil && new Date(q.pausedUntil).getTime() > Date.now() ? q.pausedUntil : null;
  const today = sentToday(q);
  const resume = dailyResumeAt(q, dailyLimit);
  const lastSeen = relay && relay.lastSeenAt ? new Date(relay.lastSeenAt).getTime() : 0;
  return {
    pending: q.items.length,
    leased: Object.keys(q.leases).length,
    total: q.total,
    sent: q.sent,
    failed: q.failed.length,
    failures: q.failed.slice(-5).map((f) => ({ phone: phone.display(f.phone), error: f.error })),
    sentToday: today,
    remainingToday: Math.max(0, dailyLimit - today),
    resumeAt: resume ? resume.toISOString() : null,
    nextSendAt: q.nextSendAt,
    dailyLimit, dailyMax, minGap, maxGap, startHour, endHour,
    sunday: days.includes(0),
    optOut: q.optOut.length,
    pausedUntil,
    pauseKind: pausedUntil ? (q.pauseKind || '') : '',
    note: pausedUntil || !q.pauseKind ? (q.note || '') : '',
    startedAt: q.startedAt,
    active: q.items.length > 0 || Object.keys(q.leases).length > 0,
    relay: {
      online: Boolean(lastSeen && Date.now() - lastSeen < RELAY_STALE_MS),
      lastSeenAt: relay && relay.lastSeenAt ? relay.lastSeenAt : null,
      host: (relay && relay.host) || '',
      version: (relay && relay.version) || '',
      backend: (relay && relay.backend) || '',
      bluebubbles: relay ? relay.bluebubbles !== false : true,
      error: (relay && relay.error) || '',
    },
  };
}

module.exports = {
  loadQ, saveQ, updateQ, limits, normalizeTextSettings, templateKey,
  enqueue, clearQueue, retryFailed, recordSent, fail, addOptOut, reap, claim, report, status,
  sentToday, dailyResumeAt, recentIds,
  DEFAULT_DAILY, MAX_DAILY, MIN_DAILY, LEASE_MS, MAX_CLAIM_ATTEMPTS, RELAY_STALE_MS,
  DEFAULT_MIN_GAP, DEFAULT_MAX_GAP,
};
