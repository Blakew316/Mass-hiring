// Server-side send queue with its own storage record (key "queue") that is
// only ever changed through atomic read-modify-write (updateQ), so the
// scheduled drain, the dashboard's Stop/queue buttons and immediate sends can
// never overwrite each other's progress. An append-only log of every send
// (both the queue and immediate sends) is the source of truth for "already
// emailed", for the rolling 24-hour count and for the per-minute pace, which
// makes every path idempotent: a candidate is never emailed twice.
//
// Drained by the scheduled function (netlify/src/send-queue.mjs) every
// minute at a pace Gmail tolerates; honours Gmail's "retry after" and the
// account's daily limit.
const crypto = require('crypto');
const store = require('./store');
const storage = require('./storage');
const google = require('./google');
const mailer = require('./mailer');
const notify = require('./notify');
const tracking = require('./tracking');
const attachments = require('./attachments');
const { renderEmail } = require('./template');

// Google Workspace: 2,000 messages and 2,000 unique external recipients per
// user per rolling 24h (500 on trial); free Gmail: 500. Those are Google's
// hard ceilings — a higher Daily send limit cannot be honoured, so it is
// capped there. The defaults keep headroom for normal email.
const DEFAULT_DAILY_WORKSPACE = 1800;
const DEFAULT_DAILY_GMAIL = 400;
const MAX_DAILY_WORKSPACE = 2000;
const MAX_DAILY_GMAIL = 500;
const MIN_DAILY = 20;
// Gmail API: 6,000 quota units per minute per user (100 per send) on current
// Cloud projects, i.e. about 60 sends a minute. Asking for more only earns
// "User-rate limit exceeded" pauses, so Emails per minute is capped at 60.
const DEFAULT_PER_MINUTE = 30;
const MAX_PER_MINUTE = 60;
const MIN_PAUSE_MS = 60 * 1000;
const MAX_PAUSE_MS = 30 * 60 * 1000;
const NOT_READY_PAUSE_MS = 15 * 60 * 1000;
const PACE_WINDOW_MS = 55 * 1000;   // "per minute" measured over 55 s so back-to-back runs are not short-changed
const DAY_MS = 24 * 3600 * 1000;
const MAX_TRANSIENT_ATTEMPTS = 2;
const SEND_TIMEOUT_MS = 8000;
// A send is only started when the whole timeout still fits: over SMTP the
// deadline cannot actually cancel the transmission, so a send cut short is an
// email that probably went out and cannot be told apart from one that failed.
const WRITE_RESERVE_MS = 1500;      // time kept for the writes after the last send
const PACE_WAIT_MS = 500;           // how long a worker waits for the per-minute window to free a slot
const MAX_WORKERS = 6;              // parallel sends inside one run; 60 a minute needs several in flight
const MAX_SMTP_WORKERS = 2;         // App Password path: one connection per send, so keep it gentle

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const QUEUE_DEFAULTS = {
  items: [],        // [{ id, t, f }] pending, in order; t = template key, f = 1 for a follow-up
  templates: {},    // key -> { subject, body }
  failed: [],       // [{ id, email, error, ts, t }]
  attempts: {},     // id -> transient failure count
  sentLog: [],      // [{ id, email, ts }] every send, both paths; pruned to 48h
  unverified: {},   // id -> { email, since }: a Gmail send timed out; look in Sent before sending again
  total: 0,         // current campaign size (for the progress bar)
  sent: 0,
  startedAt: null,
  pausedUntil: null,
  pauseKind: '',    // why: daily | rate | not-ready | '' (so a changed setting can lift the right pause)
  note: '',
  runningUntil: null,
  ratePauses: 0,    // consecutive throttles without a retry time → escalating pause
};

function normalize(raw) {
  const q = { ...structuredClone(QUEUE_DEFAULTS), ...(raw || {}) };
  const cutoff = Date.now() - 2 * DAY_MS;
  q.sentLog = (q.sentLog || []).filter((e) => e && new Date(e.ts).getTime() >= cutoff);
  q.unverified = q.unverified || {};
  q.attempts = q.attempts || {};
  return q;
}

async function loadQ() {
  return normalize(await storage.getJson('queue'));
}
// Plain overwrite — for tests/tools only; application code goes through updateQ.
const saveQ = (q) => storage.setJson('queue', q);

// Atomic edit: the mutator runs on the latest stored version and is retried
// if someone else wrote in between. Return false from it to change nothing.
async function updateQ(mutate) {
  const { value } = await storage.updateJson('queue', (raw) => {
    const q = normalize(raw);
    if (mutate(q) === false) return false;
    return q;
  });
  return normalize(value);
}

function isGmailConsumer(address) {
  return /@(gmail|googlemail)\.com$/i.test(String(address || ''));
}

// The pace actually used. Settings outside what Gmail allows are clamped, and
// the caps are returned too so the UI can say so instead of quietly showing a
// different number from the one that was typed.
function limits(settings, fromAddress) {
  const consumer = isGmailConsumer(fromAddress);
  const dailyMax = consumer ? MAX_DAILY_GMAIL : MAX_DAILY_WORKSPACE;
  const fallback = consumer ? DEFAULT_DAILY_GMAIL : DEFAULT_DAILY_WORKSPACE;
  const dailyLimit = clamp(Number(settings.dailyLimit) || fallback, MIN_DAILY, dailyMax);
  const perMinute = clamp(Number(settings.perMinute) || DEFAULT_PER_MINUTE, 1, MAX_PER_MINUTE);
  return { dailyLimit, perMinute, dailyMax, perMinuteMax: MAX_PER_MINUTE, dailyMin: MIN_DAILY };
}

// Stored form of the pace settings: '' means "use the default", anything else
// is kept within the range the queue will honour, so what Settings shows after
// saving is exactly what the dashboard will do.
function normalizePaceSettings(settings, fromAddress) {
  const out = {};
  const norm = (key, lo, hi) => {
    const raw = settings[key];
    if (raw === undefined) return;
    const str = String(raw ?? '').trim();
    if (str === '') { out[key] = ''; return; }
    const n = Number(str);
    out[key] = Number.isFinite(n) ? String(clamp(Math.round(n), lo, hi)) : '';
  };
  // Free Gmail tops out at 500 a day, Workspace at 2,000: clamp to whichever
  // account is actually sending, so Settings cannot show a number the queue
  // would ignore.
  norm('dailyLimit', MIN_DAILY, isGmailConsumer(fromAddress) ? MAX_DAILY_GMAIL : MAX_DAILY_WORKSPACE);
  norm('perMinute', 1, MAX_PER_MINUTE);
  return out;
}

// When the rolling 24-hour count next drops below the daily limit: the moment
// the oldest surplus send ages out of the window. null when not at the limit.
function dailyResumeAt(q, dailyLimit) {
  const times = sentWithin24h(q).map((e) => new Date(e.ts).getTime()).sort((a, b) => a - b);
  const surplus = times.length - dailyLimit;   // how many must age out before one more may go
  if (surplus < 0) return null;
  return new Date(times[surplus] + DAY_MS + 1000);
}

// Lift a pause of the given kind(s) — e.g. the daily pause once the limit was
// raised, or the not-set-up pause once Google is connected.
function clearPause(q, kinds) {
  const list = Array.isArray(kinds) ? kinds : [kinds];
  if (!q.pausedUntil || !list.includes(q.pauseKind || '')) return false;
  q.pausedUntil = null; q.pauseKind = ''; q.note = '';
  return true;
}

function templateKey(t) {
  return crypto.createHash('sha1').update(`${t.subject || ''}\n${t.body || ''}`).digest('hex').slice(0, 12);
}

function sentWithin(q, ms) {
  const cutoff = Date.now() - ms;
  return q.sentLog.filter((e) => new Date(e.ts).getTime() >= cutoff);
}
const sentWithin24h = (q) => sentWithin(q, DAY_MS);
const sentToday = (q) => sentWithin24h(q).length;
const sentInLastMinute = (q) => sentWithin(q, PACE_WINDOW_MS).length;
const recentlySentIds = (q) => new Set(sentWithin24h(q).map((e) => e.id));

function retryAfterFrom(message) {
  const m = String(message || '').match(/retry after ([0-9T:.\-Z+]+)/i);
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d;
}

// How to react to a failed send.
//   daily     – the 24h cap in SMTP wording (5.4.5 / "daily sending limit|quota")
//               or the API's dailyLimitExceeded: pause an hour, keep item
//   rate      – Gmail is throttling (or the daily cap, which the API also
//               reports as 429 with a far-off retry time): pause, keep item
//   transient – timeout / 5xx / network: retry a limited number of times
//   other     – a real problem with this recipient/message: mark failed
function classifySendError(err) {
  if (err && err.invalidAddress) return 'other';   // a bad address never becomes valid by waiting
  const m = String((err && err.message) || err || '');
  const status = err && err.status;
  const reason = String((err && err.reason) || '');
  if (reason === 'dailyLimitExceeded' || /daily (user )?sending (limit|quota)|dailyLimitExceeded|5\.4\.5/i.test(m)) return 'daily';
  // Gmail reports per-minute quota as 403 rateLimitExceeded/userRateLimitExceeded
  // and mail-sending throttles (incl. the daily cap) as 429 "User-rate limit exceeded".
  if (/^(rateLimitExceeded|userRateLimitExceeded)$/.test(reason)) return 'rate';
  if (status === 429 || /rate.?limit|rateLimitExceeded|userRateLimitExceeded|quota exceeded|units per minute|too many requests|user-rate/i.test(m)) return 'rate';
  if ((status && status >= 500) || (err && err.name === 'AbortError') || /timed out|timeout|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(m)) return 'transient';
  return 'other';
}

// The send is raced against a timer, so a stalled connection (SMTP has no
// abort signal; token refreshes don't either) can never overrun the function's
// time limit. The fetch-based Gmail path is also cancelled via the signal.
// A timeout means the OUTCOME IS UNKNOWN — the message may have gone out.
async function sendWithDeadline(settings, message, ms, { via } = {}) {
  const ctrl = new AbortController();
  const timeoutError = () => { const e = new Error(`Send timed out after ${ms}ms`); e.name = 'AbortError'; e.via = via || ''; return e; };
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { ctrl.abort(); reject(timeoutError()); }, ms); });
  const send = mailer.sendEmail(settings, message, { signal: ctrl.signal });
  send.catch(() => {});   // if the timer wins, the late rejection must not become an unhandled error
  try {
    return await Promise.race([send, timeout]);
  } catch (err) {
    if (ctrl.signal.aborted && err.name !== 'AbortError') throw timeoutError();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// What a successful send changes on the candidate (both paths use this).
function applySentPatch(c, p) {
  if (c.status === 'new') c.status = 'emailed';
  c.lastEmailedAt = p.lastEmailedAt;
  if (p.gmailThreadId) c.gmailThreadId = p.gmailThreadId;
  if (p.messageId) c.messageId = p.messageId;
  if (p.lastSubject !== undefined && !p.followUp) c.lastSubject = p.lastSubject;
  if (p.followUp) {
    c.followUpCount = (c.followUpCount || 0) + 1;
    c.lastFollowUpAt = p.lastEmailedAt;
  }
}

// ---------- queue edits (callers wrap these in updateQ) ----------
function enqueue(q, db, ids, template, { followUp = false } = {}) {
  const known = new Map(db.candidates.map((c) => [c.id, c]));
  const queued = new Set(q.items.map((i) => i.id));
  const recent = recentlySentIds(q);
  const t = template ? templateKey(template) : null;
  if (t) q.templates[t] = { subject: String(template.subject || ''), body: String(template.body || '') };
  const added = [];
  for (const id of ids) {
    const c = known.get(id);
    if (!c || queued.has(id) || recent.has(id)) continue;
    // A follow-up only goes to someone who was emailed and never answered.
    if (followUp && c.status !== 'emailed') continue;
    queued.add(id);
    added.push(followUp ? { id, t, f: 1 } : { id, t });
  }
  if (!q.items.length && added.length) { q.total = 0; q.sent = 0; q.startedAt = new Date().toISOString(); q.failed = []; }
  q.items.push(...added);
  q.total += added.length;
  q.note = '';
  pruneTemplates(q);
  return added.length;
}

function clearQueue(q) {
  q.items = []; q.total = q.sent; q.startedAt = null; q.pausedUntil = null; q.pauseKind = ''; q.note = ''; q.attempts = {}; q.unverified = {};
  pruneTemplates(q);
}

function retryFailed(q, db) {
  const known = new Set(db.candidates.map((c) => c.id));
  const recent = recentlySentIds(q);
  const queued = new Set(q.items.map((i) => i.id));
  const toRetry = q.failed.filter((f) => known.has(f.id) && !recent.has(f.id) && !queued.has(f.id));
  q.failed = [];
  q.attempts = {};
  if (!q.items.length && toRetry.length) { q.total = 0; q.sent = 0; q.startedAt = new Date().toISOString(); }
  for (const f of toRetry) q.items.push({ id: f.id, t: f.t || null, ...(f.f ? { f: 1 } : {}) });
  q.total += toRetry.length;
  q.note = '';
  return toRetry.length;
}

function pruneTemplates(q) {
  const used = new Set([...q.items.map((i) => i.t), ...q.failed.map((f) => f.t)].filter(Boolean));
  for (const k of Object.keys(q.templates)) if (!used.has(k)) delete q.templates[k];
}

// Record a send (either path) so both share one truth.
function recordSent(q, id, email, ts = new Date().toISOString()) {
  q.sentLog.push({ id, email, ts });
  q.items = q.items.filter((i) => i.id !== id);
  delete q.attempts[id];
  delete q.unverified[id];
}

// A Gmail send whose outcome is unknown: hand it to the queue, which checks
// the Sent folder before deciding whether to send.
// It carries the words that were being sent and whether it was a follow-up:
// if Sent shows nothing, the queue sends THAT message — not whichever template
// happens to be the default by then, and not a follow-up turned into a fresh
// outreach email.
function deferUnverified(q, id, email, since, template = null, { followUp = false } = {}) {
  q.unverified[id] = { email, since };
  const t = template ? templateKey(template) : null;
  if (t) q.templates[t] = { subject: String(template.subject || ''), body: String(template.body || '') };
  const item = { id, t, ...(followUp ? { f: 1 } : {}) };
  const queued = q.items.find((i) => i.id === id);
  if (queued) { if (t) queued.t = t; if (followUp) queued.f = 1; return; }
  if (!q.items.length) { q.total = 0; q.sent = 0; q.startedAt = new Date().toISOString(); }
  q.items.push(item);
  q.total += 1;
}

function status(q, settings, fromAddress) {
  const { dailyLimit, perMinute, dailyMax, perMinuteMax } = limits(settings, fromAddress);
  const pausedUntil = q.pausedUntil && new Date(q.pausedUntil).getTime() > Date.now() ? q.pausedUntil : null;
  const today = sentToday(q);
  const resume = dailyResumeAt(q, dailyLimit);
  const inWindow = sentWithin24h(q).map((e) => new Date(e.ts).getTime());
  const windowFreesAt = inWindow.length ? new Date(Math.min(...inWindow) + DAY_MS + 1000) : null;
  return {
    pending: q.items.length,
    total: q.total,
    sent: q.sent,
    failed: q.failed.length,
    failures: q.failed.slice(-5).map((f) => ({ email: f.email, error: f.error })),
    sentToday: today,
    remainingToday: Math.max(0, dailyLimit - today),
    resumeAt: resume ? resume.toISOString() : null,   // when the 24h window next frees a slot (only at the limit)
    windowFreesAt: windowFreesAt ? windowFreesAt.toISOString() : null,   // when the oldest send of the window ages out
    dailyLimit,
    dailyMax,
    perMinute,
    perMinuteMax,
    pausedUntil,
    pauseKind: pausedUntil ? (q.pauseKind || '') : '',
    note: pausedUntil || !q.pauseKind ? (q.note || '') : '',
    startedAt: q.startedAt,
    active: q.items.length > 0,
  };
}

const TIMEOUT_UNKNOWN = 'The send timed out, so it may or may not have been delivered — check your Sent folder before retrying.';

// ---------- drain ----------
// One run sends up to `perMinute` emails inside its time budget using a few
// parallel workers (Gmail's quota is per minute, not per connection, and one
// sequential send at a time could never reach 60 a minute in 20 seconds).
// Every successful send is written to the queue record straight away — a
// crash or timeout later in the run can no longer resend it — through one
// serialized writer so the workers never fight over the record's ETag.
async function processQueue({ budgetMs = 20000, maxSends } = {}) {
  const started = Date.now();
  // Take the run lease atomically (nothing is written when there is nothing to do).
  let reason = '';
  let q = await updateQ((f) => {
    const now = Date.now();
    if (!f.items.length) { reason = 'empty'; return false; }
    if (f.runningUntil && new Date(f.runningUntil).getTime() > now) { reason = 'running'; return false; }
    if (f.pausedUntil && new Date(f.pausedUntil).getTime() > now) { reason = 'paused'; return false; }
    f.runningUntil = new Date(now + budgetMs + 5000).toISOString();
  });
  if (reason) return { processed: 0, reason, until: q.pausedUntil };
  const release = (patch) => updateQ((f) => { f.runningUntil = null; Object.assign(f, patch || {}); });

  const db = await store.load();
  const st = await mailer.sendStatus(db.settings);
  const { dailyLimit, perMinute, dailyMax } = limits(db.settings, st.from);
  const remainingToday = dailyLimit - sentToday(q);
  if (!st.ready) {
    await release({
      note: st.reason || 'Email is not set up — sending is paused.',
      pausedUntil: new Date(Date.now() + NOT_READY_PAUSE_MS).toISOString(),
      pauseKind: 'not-ready',
    });
    return { processed: 0, reason: 'not-ready' };
  }
  if (remainingToday <= 0) {
    // Not a Gmail throttle: this is the Daily send limit from Settings. Pause
    // exactly until the 24-hour window frees a slot, and say how to send more.
    const resume = dailyResumeAt(q, dailyLimit) || new Date(Date.now() + 15 * 60 * 1000);
    await release({
      note: `Daily limit of ${dailyLimit} reached — sending resumes automatically as the 24-hour window frees up`
        + (dailyLimit < dailyMax ? ` (Gmail allows up to ${dailyMax.toLocaleString('en-US')} a day; raise the limit in Settings → Sending pace to send more today).` : '.'),
      pausedUntil: resume.toISOString(),
      pauseKind: 'daily',
    });
    return { processed: 0, reason: 'daily-limit', until: resume.toISOString() };
  }
  // The pace is shared by every path (immediate sends count too) and holds
  // however often the drain is invoked. Everything counted against the rolling
  // window: what was stored when the run began, plus this run's own sends.
  const windowSends = q.sentLog.map((e) => new Date(e.ts).getTime()).filter((t) => t >= Date.now() - PACE_WINDOW_MS);
  const inWindow = () => { const from = Date.now() - PACE_WINDOW_MS; return windowSends.filter((t) => t >= from); };
  const paceRoom = () => perMinute - inWindow().length;
  const nextSlotAt = () => { const w = inWindow(); return w.length ? Math.min.apply(null, w) + PACE_WINDOW_MS : Date.now(); };
  const usableMs = budgetMs - (SEND_TIMEOUT_MS + WRITE_RESERVE_MS);
  // Nothing to do only when the window frees no slot before this run must end;
  // otherwise the workers below wait for it.
  if (paceRoom() <= 0 && nextSlotAt() - Date.now() > usableMs) { await release(); return { processed: 0, reason: 'paced' }; }

  if (!db.settings.trackingSecret) {
    await store.update((d) => { if (!d.settings.trackingSecret) d.settings.trackingSecret = tracking.newSecret(); });
    db.settings.trackingSecret = (await store.load()).settings.trackingSecret;
  }
  const signature = await google.getSignature(db.settings); // cached: no extra API units per run
  const files = await attachments.loadAll(db);              // cached bytes; attached to every email
  // Refresh the access token once up front, so parallel workers never all
  // start with an expired token and race to refresh it.
  if (st.via === 'gmail-api' && typeof google.accessToken === 'function') { try { await google.accessToken(db.settings); } catch {} }
  // How many items this run may touch. The per-minute pace itself is enforced
  // per send below against the rolling window, not by a fixed plan, so sends
  // that age out of the window during the run free up room immediately.
  const plan = Math.min(q.items.length, remainingToday, maxSends || Infinity);
  const recent = recentlySentIds(q);

  const patches = {};        // candidate id -> { lastEmailedAt, gmailThreadId, ... }
  const done = new Set();    // leave the queue: sent, skipped or failed
  const newFailed = [];
  const attemptInc = {};
  const newUnverified = {};
  let pauseUntil = null;
  let pauseKind = '';
  let note = '';             // shown on the dashboard; with pauseUntil it explains the pause, alone it explains an early stop
  let processed = 0;
  let anySuccess = false;
  let ratePauses = q.ratePauses || 0;
  let latest = q;            // newest queue state seen (every write returns it)
  let halt = false;          // stop starting sends (Stop pressed, Gmail said slow down, or an outcome is unknown)

  // Serialized, coalescing writer: sends that finish while a write is in
  // flight are recorded together in the next one.
  let pendingSent = [];
  let chain = Promise.resolve();
  // A failed write must never reject the chain: that would skip every later
  // write AND the final merge, and the next run would send those emails again.
  // The batch goes back in the line of things to record, the merge below is a
  // last attempt at storing it, and no further sends are started meanwhile.
  const persistSent = (entry) => {
    pendingSent.push(entry);
    chain = chain.then(async () => {
      if (!pendingSent.length) return;
      const batch = pendingSent; pendingSent = [];
      try {
        latest = await updateQ((f) => {
          for (const e of batch) { recordSent(f, e.id, e.email, e.ts); f.sent += 1; }
          f.total = Math.max(f.total, f.sent);
        });
      } catch (err) {
        pendingSent = batch.concat(pendingSent);
        halt = true;
        if (!pauseUntil) note = `Sends could not be saved (${err.message}) — the run stopped early and continues shortly.`;
      }
    });
    return chain;
  };
  const markSent = async (c, sent, { followUp = false, subject = '' } = {}) => {
    const ts = new Date().toISOString();
    patches[c.id] = {
      lastEmailedAt: ts,
      gmailThreadId: (sent && sent.threadId) || '',
      messageId: (sent && sent.messageId) || '',
      // Unknown when it was found in Sent rather than sent here: leave the
      // subject the next follow-up quotes as it was, never blank it.
      lastSubject: subject || undefined,
      followUp,
    };
    processed += 1; anySuccess = true; ratePauses = 0;
    done.add(c.id);
    await persistSent({ id: c.id, email: c.email, ts });
  };
  const fail = (c, item, error) => {
    newFailed.push({ id: c.id, email: c.email, error, ts: new Date().toISOString(), t: item.t || null, ...(item.f ? { f: 1 } : {}) });
    done.add(item.id);
  };
  const pause = (kind, until, why) => {
    // The first throttle of the run decides the pause; later ones (from sends
    // already in flight) must not escalate it further.
    if (pauseUntil && kind !== 'gmail-daily') return;
    if (kind === 'gmail-daily' && pauseKind === 'gmail-daily') return;
    pauseUntil = until; pauseKind = kind; note = why; halt = true;
  };

  const sendOne = async (item, left) => {
    const c = db.candidates.find((x) => x.id === item.id);
    if (!c || recent.has(item.id) || recentlySentIds(latest).has(item.id)) { done.add(item.id); return; }   // gone, or already emailed today

    // Outcome of an earlier attempt unknown: did it reach Sent?
    const unv = q.unverified[item.id];
    if (unv) {
      if (st.via !== 'gmail-api') { fail(c, item, TIMEOUT_UNKNOWN); return; }
      try {
        const found = await google.findSentTo(db.settings, c.email, new Date(unv.since).getTime());
        if (found) { await markSent(c, found, { followUp: Boolean(item.f) }); return; }
      } catch (err) {
        fail(c, item, `${TIMEOUT_UNKNOWN} (Gmail could not be checked: ${err.message})`);
        return;
      }
    }

    const followUp = Boolean(item.f);
    const template = (item.t && q.templates[item.t]) || (followUp ? db.followUp : db.template);
    if (followUp && c.status !== 'emailed') { done.add(item.id); return; }   // answered or booked meanwhile
    const attemptAt = new Date().toISOString();
    try {
      const trackingUrl = `${google.baseUrl()}${tracking.pixelPath(db.settings, c.id)}`;
      const msg = renderEmail(template, c, db.settings, { signature, trackingUrl });
      // A follow-up replies inside the original conversation when we know it.
      const thread = followUp && c.messageId
        ? { threadId: c.gmailThreadId || undefined, inReplyTo: c.messageId, references: c.messageId }
        : {};
      const sent = await sendWithDeadline(db.settings, { to: c.email, ...msg, ...thread, attachments: followUp ? [] : files }, Math.min(SEND_TIMEOUT_MS, left - WRITE_RESERVE_MS), { via: st.via });
      await markSent(c, sent, { followUp, subject: msg.subject });
    } catch (err) {
      const kind = classifySendError(err);
      if (kind === 'rate') {
        const hinted = retryAfterFrom(err.message);
        if (!pauseUntil && !hinted) ratePauses += 1;
        const backoff = Math.min(MAX_PAUSE_MS, MIN_PAUSE_MS * 2 ** Math.max(0, ratePauses - 1));
        const until = new Date(Math.max(hinted ? hinted.getTime() : 0, Date.now() + (hinted ? MIN_PAUSE_MS : backoff)));
        pause('rate', until, hinted && hinted.getTime() - Date.now() > 3600 * 1000
          ? `Gmail has paused sending until ${hinted.toLocaleString('en-US', { timeZone: db.settings.timeZone || 'UTC', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })} (its daily limit) — it resumes automatically.`
          : 'Gmail asked us to slow down — sending resumes automatically in a few minutes.');
        return;
      }
      if (kind === 'daily') {
        // Google itself refusing, not the Daily send limit in Settings, so it
        // gets its own pause kind: raising that setting must not lift it.
        pause('gmail-daily', new Date(Date.now() + 60 * 60 * 1000), 'Gmail itself reports the account has reached its daily sending limit — sending resumes automatically once Google allows it again.');
        return;
      }
      if (kind === 'transient' && err.name === 'AbortError') {
        // Unknown outcome. Gmail API: verify against Sent next run. SMTP: no way to check — never resend blindly.
        if (st.via === 'gmail-api') {
          newUnverified[item.id] = { email: c.email, since: attemptAt };
          if (!pauseUntil) note = 'A send did not complete — checking whether it went out, then continuing.';
          halt = true;   // no pause: the next run (within a minute) does the check
          return;
        }
        fail(c, item, TIMEOUT_UNKNOWN);
        return;
      }
      if (kind === 'transient') {
        attemptInc[item.id] = (attemptInc[item.id] || 0) + 1;
        if ((q.attempts[item.id] || 0) + attemptInc[item.id] < MAX_TRANSIENT_ATTEMPTS) {
          if (!pauseUntil) note = 'A send did not complete — retrying shortly.';
          halt = true;   // stays first in line for the next run
          return;
        }
      }
      fail(c, item, err.message);
    }
  };

  // Workers pull the next planned item until the plan, the budget or a halt
  // ends the run, waiting whenever the per-minute window is full.
  let cursor = 0;
  const worker = async (index) => {
    if (index) await sleep(index * 120);   // stagger the first sends a little
    for (;;) {
      if (halt) return;
      let left = budgetMs - (Date.now() - started);
      // Only start a send that can run its full deadline: one cut short cannot
      // be told apart from one that was delivered.
      if (left < SEND_TIMEOUT_MS + WRITE_RESERVE_MS) return;
      if (cursor >= plan) return;
      if (paceRoom() <= 0) {
        // Wait for the oldest send to leave the window, unless the budget ends first.
        const wait = Math.max(0, nextSlotAt() - Date.now());
        if (wait > left - (SEND_TIMEOUT_MS + WRITE_RESERVE_MS)) return;
        await sleep(Math.min(PACE_WAIT_MS, wait + 50));
        continue;
      }
      windowSends.push(Date.now());        // claim the slot first, so workers cannot overshoot together
      const slot = windowSends.length - 1;
      const item = q.items[cursor++];
      // Re-check against the newest state: Stop pressed during the run ends it;
      // an item someone else already handled (immediate send, clear) is left alone.
      if (!latest.items.length) { halt = true; return; }
      if (!latest.items.some((it) => it.id === item.id)) { windowSends[slot] = 0; continue; }
      left = budgetMs - (Date.now() - started);
      const before = processed;
      await sendOne(item, left);
      if (processed === before) windowSends[slot] = 0;   // nothing went out: give the slot back
    }
  };
  // SMTP opens a fresh connection per send, and Gmail tolerates only a few at
  // once per account, so the App-Password path keeps to two workers.
  const workers = clamp(Math.min(Math.ceil(plan / 6), Math.ceil(perMinute / 10)), 1, st.via === 'gmail-api' ? MAX_WORKERS : MAX_SMTP_WORKERS);
  await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)));
  await chain;   // every recorded send is on disk before the merge below

  // Merge this run's outcome into whatever the queue looks like NOW: a Stop or
  // new enqueues made during the run are respected, not overwritten.
  let finished = false;
  const unsaved = pendingSent; pendingSent = [];   // sends a failed write could not store
  q = await updateQ((f) => {
    for (const e of unsaved) { recordSent(f, e.id, e.email, e.ts); f.sent += 1; }
    f.total = Math.max(f.total, f.sent);
    f.items = f.items.filter((it) => !done.has(it.id));
    if (newFailed.length) f.failed = [...f.failed, ...newFailed].slice(-200);
    for (const [id, inc] of Object.entries(attemptInc)) f.attempts[id] = (f.attempts[id] || 0) + inc;
    for (const id of done) { delete f.attempts[id]; delete f.unverified[id]; }
    for (const [id, u] of Object.entries(newUnverified)) if (f.items.some((it) => it.id === id)) f.unverified[id] = u;
    if (pauseUntil) { f.pausedUntil = pauseUntil.toISOString(); f.pauseKind = pauseKind; f.note = note; }
    else if (note) { f.pausedUntil = null; f.pauseKind = ''; f.note = note; }
    else if (anySuccess) { f.pausedUntil = null; f.pauseKind = ''; f.note = ''; }
    f.ratePauses = ratePauses;
    f.runningUntil = null;
    finished = f.items.length === 0 && Boolean(f.startedAt);
    if (finished) { f.startedAt = null; f.attempts = {}; f.unverified = {}; }
    pruneTemplates(f);
  });

  if (Object.keys(patches).length) {
    await store.update((fresh) => {
      for (const [id, p] of Object.entries(patches)) {
        const fc = fresh.candidates.find((x) => x.id === id);
        if (!fc) continue;
        applySentPatch(fc, p);
      }
    });
  }

  if (finished && q.sent > 0) {
    try {
      await notify.pushToPhone(db.settings, {
        title: '✉️ Outreach finished',
        message: `${q.sent} email${q.sent === 1 ? '' : 's'} sent${q.failed.length ? `, ${q.failed.length} failed (see dashboard)` : ''}.`,
        priority: 'default',
        tags: 'white_check_mark',
      });
    } catch {}
  }
  return { processed, remaining: q.items.length, pausedUntil: q.pausedUntil, failed: q.failed.length, workers };
}

module.exports = {
  loadQ, saveQ, updateQ, limits, normalizePaceSettings, dailyResumeAt, clearPause, enqueue, clearQueue, retryFailed, recordSent, deferUnverified,
  applySentPatch, status, processQueue, classifySendError, retryAfterFrom, sentToday, sentInLastMinute, recentlySentIds, sendWithDeadline,
  SEND_TIMEOUT_MS, WRITE_RESERVE_MS, TIMEOUT_UNKNOWN, MAX_PER_MINUTE, DEFAULT_PER_MINUTE, MAX_DAILY_WORKSPACE, MAX_DAILY_GMAIL,
};
