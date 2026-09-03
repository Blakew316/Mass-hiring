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
const { renderEmail } = require('./template');

// Google Workspace: 2,000 messages and 2,000 unique external recipients per
// user per rolling 24h (500 on trial); free Gmail: 500. Defaults keep headroom.
const DEFAULT_DAILY_WORKSPACE = 1800;
const DEFAULT_DAILY_GMAIL = 400;
const DEFAULT_PER_MINUTE = 6;
const MIN_PAUSE_MS = 60 * 1000;
const MAX_PAUSE_MS = 30 * 60 * 1000;
const PACE_WINDOW_MS = 55 * 1000;   // "per minute" measured over 55 s so back-to-back runs are not short-changed
const DAY_MS = 24 * 3600 * 1000;
const MAX_TRANSIENT_ATTEMPTS = 2;
const SEND_TIMEOUT_MS = 8000;
const WRITE_RESERVE_MS = 1500;      // time kept for the writes after the last send

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const QUEUE_DEFAULTS = {
  items: [],        // [{ id, t }] pending, in order; t = template key
  templates: {},    // key -> { subject, body }
  failed: [],       // [{ id, email, error, ts, t }]
  attempts: {},     // id -> transient failure count
  sentLog: [],      // [{ id, email, ts }] every send, both paths; pruned to 48h
  unverified: {},   // id -> { email, since }: a Gmail send timed out; look in Sent before sending again
  total: 0,         // current campaign size (for the progress bar)
  sent: 0,
  startedAt: null,
  pausedUntil: null,
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

function limits(settings, fromAddress) {
  const fallback = isGmailConsumer(fromAddress) ? DEFAULT_DAILY_GMAIL : DEFAULT_DAILY_WORKSPACE;
  const dailyLimit = clamp(Number(settings.dailyLimit) || fallback, 20, 2000);
  const perMinute = clamp(Number(settings.perMinute) || DEFAULT_PER_MINUTE, 1, 12);
  return { dailyLimit, perMinute };
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

// ---------- queue edits (callers wrap these in updateQ) ----------
function enqueue(q, db, ids, template) {
  const known = new Set(db.candidates.map((c) => c.id));
  const queued = new Set(q.items.map((i) => i.id));
  const recent = recentlySentIds(q);
  const t = template ? templateKey(template) : null;
  if (t) q.templates[t] = { subject: String(template.subject || ''), body: String(template.body || '') };
  const added = [];
  for (const id of ids) {
    if (!known.has(id) || queued.has(id) || recent.has(id)) continue;
    queued.add(id);
    added.push({ id, t });
  }
  if (!q.items.length && added.length) { q.total = 0; q.sent = 0; q.startedAt = new Date().toISOString(); q.failed = []; }
  q.items.push(...added);
  q.total += added.length;
  q.note = '';
  pruneTemplates(q);
  return added.length;
}

function clearQueue(q) {
  q.items = []; q.total = q.sent; q.startedAt = null; q.pausedUntil = null; q.note = ''; q.attempts = {}; q.unverified = {};
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
  for (const f of toRetry) q.items.push({ id: f.id, t: f.t || null });
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
function deferUnverified(q, id, email, since) {
  q.unverified[id] = { email, since };
  if (!q.items.some((i) => i.id === id)) {
    if (!q.items.length) { q.total = 0; q.sent = 0; q.startedAt = new Date().toISOString(); }
    q.items.push({ id, t: null });
    q.total += 1;
  }
}

function status(q, settings, fromAddress) {
  const { dailyLimit, perMinute } = limits(settings, fromAddress);
  const pausedUntil = q.pausedUntil && new Date(q.pausedUntil).getTime() > Date.now() ? q.pausedUntil : null;
  return {
    pending: q.items.length,
    total: q.total,
    sent: q.sent,
    failed: q.failed.length,
    failures: q.failed.slice(-5).map((f) => ({ email: f.email, error: f.error })),
    sentToday: sentToday(q),
    dailyLimit,
    perMinute,
    pausedUntil,
    note: q.note || '',
    startedAt: q.startedAt,
    active: q.items.length > 0,
  };
}

const TIMEOUT_UNKNOWN = 'The send timed out, so it may or may not have been delivered — check your Sent folder before retrying.';

// ---------- drain ----------
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
  const { dailyLimit, perMinute } = limits(db.settings, st.from);
  const remainingToday = dailyLimit - sentToday(q);
  if (!st.ready || remainingToday <= 0) {
    await release({
      note: !st.ready
        ? (st.reason || 'Email is not set up — sending is paused.')
        : `Daily limit of ${dailyLimit} reached — sending resumes automatically as the 24-hour window frees up.`,
      pausedUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    return { processed: 0, reason: st.ready ? 'daily-limit' : 'not-ready' };
  }
  // The pace is shared by every path (immediate sends count too) and holds
  // however often the drain is invoked.
  const paceLeft = perMinute - sentInLastMinute(q);
  if (paceLeft <= 0) { await release(); return { processed: 0, reason: 'paced' }; }

  if (!db.settings.trackingSecret) {
    await store.update((d) => { if (!d.settings.trackingSecret) d.settings.trackingSecret = crypto.randomBytes(16).toString('hex'); });
    db.settings.trackingSecret = (await store.load()).settings.trackingSecret;
  }
  const signature = await google.getSignature(db.settings); // cached: no extra API units per run
  const n = Math.min(q.items.length, maxSends || perMinute, remainingToday, paceLeft);
  const recent = recentlySentIds(q);

  const patches = {};        // candidate id -> { lastEmailedAt, gmailThreadId }
  const done = new Set();    // leave the queue: sent, skipped or failed
  const newFailed = [];
  const attemptInc = {};
  const newUnverified = {};
  let pauseUntil = null;
  let note = '';
  let processed = 0;
  let anySuccess = false;
  let ratePauses = q.ratePauses || 0;
  let latest = q;            // newest queue state seen (every write returns it)

  // Persist each send the moment it succeeds: a crash or timeout later in the
  // run can no longer resend it.
  const markSent = async (c, sent) => {
    const ts = new Date().toISOString();
    patches[c.id] = { lastEmailedAt: ts, gmailThreadId: (sent && sent.threadId) || '' };
    processed += 1; anySuccess = true; ratePauses = 0;
    done.add(c.id);
    latest = await updateQ((f) => { recordSent(f, c.id, c.email, ts); f.sent += 1; f.total = Math.max(f.total, f.sent); });
  };
  const fail = (c, item, error) => {
    newFailed.push({ id: c.id, email: c.email, error, ts: new Date().toISOString(), t: item.t || null });
    done.add(item.id);
  };

  for (let i = 0; i < n; i++) {
    const left = budgetMs - (Date.now() - started);
    if (left < SEND_TIMEOUT_MS + WRITE_RESERVE_MS) break;
    const item = q.items[i];
    // Re-check against the newest state: Stop pressed during the run ends it;
    // an item someone else already handled (immediate send, clear) is left alone.
    if (!latest.items.length) break;
    if (!latest.items.some((it) => it.id === item.id)) continue;
    const c = db.candidates.find((x) => x.id === item.id);
    if (!c || recent.has(item.id) || recentlySentIds(latest).has(item.id)) { done.add(item.id); continue; }   // gone, or already emailed today

    // Outcome of an earlier attempt unknown: did it reach Sent?
    const unv = q.unverified[item.id];
    if (unv) {
      if (st.via !== 'gmail-api') { fail(c, item, TIMEOUT_UNKNOWN); continue; }
      try {
        const found = await google.findSentTo(db.settings, c.email, new Date(unv.since).getTime());
        if (found) { await markSent(c, found); if (i < n - 1) await sleep(200); continue; }
      } catch (err) {
        fail(c, item, `${TIMEOUT_UNKNOWN} (Gmail could not be checked: ${err.message})`);
        continue;
      }
    }

    const template = (item.t && q.templates[item.t]) || db.template;
    const attemptAt = new Date().toISOString();
    try {
      const trackingUrl = `${google.baseUrl()}/webhooks/open/${tracking.token(db.settings, c.id)}.gif`;
      const msg = renderEmail(template, c, db.settings, { signature, trackingUrl });
      const sent = await sendWithDeadline(db.settings, { to: c.email, ...msg }, Math.min(SEND_TIMEOUT_MS, left - WRITE_RESERVE_MS), { via: st.via });
      await markSent(c, sent);
    } catch (err) {
      const kind = classifySendError(err);
      if (kind === 'rate') {
        const hinted = retryAfterFrom(err.message);
        if (!hinted) ratePauses += 1;
        const backoff = Math.min(MAX_PAUSE_MS, MIN_PAUSE_MS * 2 ** Math.max(0, ratePauses - 1));
        pauseUntil = new Date(Math.max(hinted ? hinted.getTime() : 0, Date.now() + (hinted ? MIN_PAUSE_MS : backoff)));
        note = hinted && hinted.getTime() - Date.now() > 3600 * 1000
          ? `Gmail has paused sending until ${hinted.toLocaleString('en-US', { timeZone: db.settings.timeZone || 'UTC', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })} (daily limit) — it resumes automatically.`
          : 'Gmail asked us to slow down — sending resumes automatically in a few minutes.';
        break;
      }
      if (kind === 'daily') {
        pauseUntil = new Date(Date.now() + 60 * 60 * 1000);
        note = 'Gmail reports the daily sending limit is reached — sending resumes automatically.';
        break;
      }
      if (kind === 'transient' && err.name === 'AbortError') {
        // Unknown outcome. Gmail API: verify against Sent next run. SMTP: no way to check — never resend blindly.
        if (st.via === 'gmail-api') {
          newUnverified[item.id] = { email: c.email, since: attemptAt };
          pauseUntil = new Date(Date.now() + MIN_PAUSE_MS);
          note = 'A send did not complete — checking whether it went out, then continuing.';
          break;
        }
        fail(c, item, TIMEOUT_UNKNOWN);
        continue;
      }
      if (kind === 'transient') {
        attemptInc[item.id] = (attemptInc[item.id] || 0) + 1;
        if ((q.attempts[item.id] || 0) + attemptInc[item.id] < MAX_TRANSIENT_ATTEMPTS) {
          pauseUntil = new Date(Date.now() + MIN_PAUSE_MS);
          note = 'A send did not complete — retrying shortly.';
          break;
        }
      }
      fail(c, item, err.message);
    }
    if (i < n - 1) await sleep(400);
  }

  // Merge this run's outcome into whatever the queue looks like NOW: a Stop or
  // new enqueues made during the run are respected, not overwritten.
  let finished = false;
  q = await updateQ((f) => {
    f.items = f.items.filter((it) => !done.has(it.id));
    if (newFailed.length) f.failed = [...f.failed, ...newFailed].slice(-200);
    for (const [id, inc] of Object.entries(attemptInc)) f.attempts[id] = (f.attempts[id] || 0) + inc;
    for (const id of done) { delete f.attempts[id]; delete f.unverified[id]; }
    for (const [id, u] of Object.entries(newUnverified)) if (f.items.some((it) => it.id === id)) f.unverified[id] = u;
    if (pauseUntil) { f.pausedUntil = pauseUntil.toISOString(); f.note = note; }
    else if (anySuccess) { f.pausedUntil = null; f.note = ''; }
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
        if (fc.status === 'new') fc.status = 'emailed';
        fc.lastEmailedAt = p.lastEmailedAt;
        if (p.gmailThreadId) fc.gmailThreadId = p.gmailThreadId;
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
  return { processed, remaining: q.items.length, pausedUntil: q.pausedUntil, failed: q.failed.length };
}

module.exports = {
  loadQ, saveQ, updateQ, limits, enqueue, clearQueue, retryFailed, recordSent, deferUnverified, status, processQueue,
  classifySendError, retryAfterFrom, sentToday, sentInLastMinute, recentlySentIds, sendWithDeadline, SEND_TIMEOUT_MS, TIMEOUT_UNKNOWN,
};
