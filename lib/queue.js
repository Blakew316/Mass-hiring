// Server-side send queue. Large sends are queued and drained a few at a time
// by the scheduled function (netlify/src/send-queue.mjs, every minute), at a
// pace Gmail tolerates, honouring "retry after" throttles and the account's
// rolling 24-hour sending limit. The browser can close; progress lives in the
// data store and shows on the dashboard.
const crypto = require('crypto');
const store = require('./store');
const google = require('./google');
const mailer = require('./mailer');
const notify = require('./notify');
const tracking = require('./tracking');
const { renderEmail } = require('./template');

// Google Workspace allows 2,000 messages per user per rolling 24 hours (500 on
// free Gmail / trial accounts). Defaults keep headroom for normal email.
const DEFAULT_DAILY_LIMIT = 1800;
const DEFAULT_PER_MINUTE = 6;
const MIN_PAUSE_MS = 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// A single send may never hold the run past its budget.
function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`Send timed out after ${ms}ms (transient)`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function limits(settings) {
  const dailyLimit = clamp(Number(settings.dailyLimit) || DEFAULT_DAILY_LIMIT, 20, 2000);
  const perMinute = clamp(Number(settings.perMinute) || DEFAULT_PER_MINUTE, 1, 12);
  return { dailyLimit, perMinute };
}

// What kind of failure Gmail reported.
//   rate  – slow down (per-minute API quota or Gmail's sending throttle); retry later
//   daily – the account's 24-hour sending limit; retry much later
//   other – a real problem with this recipient/message
function classifySendError(message) {
  const m = String(message || '');
  if (/daily (user )?sending limit|dailyLimitExceeded|daily limit/i.test(m)) return 'daily';
  if (/rate.?limit|rateLimitExceeded|quota exceeded|units per minute|too many requests|\b429\b|backendError|user-rate|timed out.*transient/i.test(m)) return 'rate';
  return 'other';
}

function retryAfterFrom(message) {
  const m = String(message || '').match(/retry after ([0-9T:.\-Z+]+)/i);
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sentInLast24h(db) {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return db.candidates.filter((c) => c.lastEmailedAt && new Date(c.lastEmailedAt).getTime() >= cutoff).length;
}

function enqueue(db, ids, template) {
  const queued = new Set(db.queue || []);
  const known = new Set(db.candidates.map((c) => c.id));
  const added = [];
  for (const id of ids) {
    if (known.has(id) && !queued.has(id)) { queued.add(id); added.push(id); }
  }
  db.queue = [...(db.queue || []), ...added];
  if (template) db.queueTemplate = { subject: String(template.subject || ''), body: String(template.body || '') };
  db.queueFailed = db.queueFailed || [];
  db.queueStartedAt = db.queueStartedAt || new Date().toISOString();
  db.queueNote = '';
  return added.length;
}

function clearQueue(db) {
  db.queue = [];
  db.queueTemplate = null;
  db.queueStartedAt = null;
  db.sendPausedUntil = null;
  db.queueNote = '';
}

function retryFailed(db) {
  const ids = (db.queueFailed || []).map((f) => f.id);
  db.queueFailed = [];
  return enqueue(db, ids, null);
}

function status(db) {
  const { dailyLimit, perMinute } = limits(db.settings);
  const pending = (db.queue || []).length;
  const startedAt = db.queueStartedAt || null;
  const sentSinceStart = startedAt
    ? db.candidates.filter((c) => c.lastEmailedAt && c.lastEmailedAt >= startedAt).length
    : 0;
  const pausedUntil = db.sendPausedUntil && new Date(db.sendPausedUntil).getTime() > Date.now() ? db.sendPausedUntil : null;
  return {
    pending,
    sentSinceStart,
    failed: (db.queueFailed || []).length,
    failures: (db.queueFailed || []).slice(-5),
    sentToday: sentInLast24h(db),
    dailyLimit,
    perMinute,
    pausedUntil,
    note: db.queueNote || '',
    startedAt,
    active: pending > 0,
  };
}

// One drain step: sends up to perMinute emails (never past the daily limit)
// inside the time budget, then merges results into a freshly loaded copy so
// edits made in the dashboard meanwhile are not overwritten.
async function processQueue({ budgetMs = 7000, maxSends } = {}) {
  const started = Date.now();
  const db = await store.load();
  const { dailyLimit, perMinute } = limits(db.settings);
  const queue = db.queue || [];
  if (!queue.length) return { processed: 0, reason: 'empty' };
  if (db.sendPausedUntil && new Date(db.sendPausedUntil).getTime() > Date.now()) {
    return { processed: 0, reason: 'paused', until: db.sendPausedUntil };
  }
  const remainingToday = dailyLimit - sentInLast24h(db);
  if (remainingToday <= 0) {
    db.queueNote = `Daily limit of ${dailyLimit} reached — sending resumes automatically as the 24-hour window frees up.`;
    db.sendPausedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await store.save(db);
    return { processed: 0, reason: 'daily-limit' };
  }

  const n = Math.min(queue.length, maxSends || perMinute, remainingToday);
  if (!db.settings.trackingSecret) db.settings.trackingSecret = crypto.randomBytes(16).toString('hex');
  const signature = await google.getSignature(db.settings); // cached copy: no extra API units per run
  const template = db.queueTemplate || db.template;

  const touched = {};
  const done = [];
  const failed = [];
  let pauseUntil = null;
  let note = '';

  for (let i = 0; i < n; i++) {
    if (Date.now() - started > budgetMs) break;
    const id = queue[i];
    const c = db.candidates.find((x) => x.id === id);
    if (!c) { done.push(id); continue; }
    try {
      const trackingUrl = `${google.baseUrl()}/webhooks/open/${tracking.token(db.settings, c.id)}.gif`;
      const msg = renderEmail(template, c, db.settings, { signature, trackingUrl });
      const left = budgetMs - (Date.now() - started);
      if (left < 1500) break;
      const sent = await withTimeout(mailer.sendEmail(db.settings, { to: c.email, ...msg }), Math.min(8000, left));
      touched[id] = {
        status: c.status === 'new' ? 'emailed' : c.status,
        lastEmailedAt: new Date().toISOString(),
        gmailThreadId: sent.threadId || c.gmailThreadId || '',
      };
      done.push(id);
    } catch (err) {
      const kind = classifySendError(err.message);
      if (kind === 'rate') {
        const hinted = retryAfterFrom(err.message);
        const at = Math.max(hinted ? hinted.getTime() : 0, Date.now() + MIN_PAUSE_MS);
        pauseUntil = new Date(at);
        note = 'Gmail asked us to slow down — sending resumes automatically in a minute or two.';
        break;
      }
      if (kind === 'daily') {
        pauseUntil = new Date(Date.now() + 60 * 60 * 1000);
        note = 'Gmail reports the daily sending limit is reached — sending resumes automatically.';
        break;
      }
      failed.push({ id, email: c.email, error: err.message, ts: new Date().toISOString() });
      done.push(id);
    }
    if (i < n - 1) await sleep(400);
  }

  const fresh = await store.load();
  for (const [id, patch] of Object.entries(touched)) {
    const c = fresh.candidates.find((x) => x.id === id);
    if (c) Object.assign(c, patch);
  }
  const doneSet = new Set(done);
  fresh.queue = (fresh.queue || []).filter((id) => !doneSet.has(id));
  fresh.queueFailed = [...(fresh.queueFailed || []), ...failed].slice(-200);
  fresh.sendPausedUntil = pauseUntil ? pauseUntil.toISOString() : null;
  fresh.queueNote = note;
  if (!fresh.settings.trackingSecret) fresh.settings.trackingSecret = db.settings.trackingSecret;
  const finished = fresh.queue.length === 0 && (fresh.queueStartedAt || db.queueStartedAt);
  const total = finished ? fresh.candidates.filter((c) => c.lastEmailedAt && c.lastEmailedAt >= (fresh.queueStartedAt || db.queueStartedAt)).length : 0;
  if (finished) { fresh.queueStartedAt = null; fresh.queueTemplate = null; }
  await store.save(fresh);

  if (finished && total > 0) {
    try {
      await notify.pushToPhone(fresh.settings, {
        title: '✉️ Outreach finished',
        message: `${total} email${total === 1 ? '' : 's'} sent${fresh.queueFailed.length ? `, ${fresh.queueFailed.length} failed (see dashboard)` : ''}.`,
        priority: 'default',
        tags: 'white_check_mark',
      });
    } catch {}
  }
  return { processed: Object.keys(touched).length, failed: failed.length, remaining: fresh.queue.length, pausedUntil: fresh.sendPausedUntil };
}

module.exports = { withTimeout, enqueue, clearQueue, retryFailed, status, processQueue, classifySendError, retryAfterFrom, limits, sentInLast24h };
