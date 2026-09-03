// Server-side send queue with its own storage record (key "queue") that only
// this module writes, so dashboard activity can never overwrite sending
// progress. An append-only log of every send (both the queue and immediate
// sends) is the source of truth for "already emailed" and for the rolling
// 24-hour count, which makes every path idempotent: a candidate is never
// emailed twice even if the candidate document is written concurrently.
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
const DAY_MS = 24 * 3600 * 1000;
const MAX_TRANSIENT_ATTEMPTS = 2;
const SEND_TIMEOUT_MS = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const QUEUE_DEFAULTS = {
  items: [],        // [{ id, t }] pending, in order; t = template key
  templates: {},    // key -> { subject, body }
  failed: [],       // [{ id, email, error, ts, t }]
  attempts: {},     // id -> transient failure count
  sentLog: [],      // [{ id, email, ts }] every send, both paths; pruned to 48h
  total: 0,         // current campaign size (for the progress bar)
  sent: 0,
  startedAt: null,
  pausedUntil: null,
  note: '',
  runningUntil: null,
};

async function loadQ() {
  const raw = (await storage.getJson('queue')) || {};
  const q = { ...structuredClone(QUEUE_DEFAULTS), ...raw };
  const cutoff = Date.now() - 2 * DAY_MS;
  q.sentLog = (q.sentLog || []).filter((e) => e && new Date(e.ts).getTime() >= cutoff);
  return q;
}
const saveQ = (q) => storage.setJson('queue', q);

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

function sentWithin24h(q) {
  const cutoff = Date.now() - DAY_MS;
  return q.sentLog.filter((e) => new Date(e.ts).getTime() >= cutoff);
}
const sentToday = (q) => sentWithin24h(q).length;
const recentlySentIds = (q) => new Set(sentWithin24h(q).map((e) => e.id));

function retryAfterFrom(message) {
  const m = String(message || '').match(/retry after ([0-9T:.\-Z+]+)/i);
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d;
}

// How to react to a failed send.
//   rate      – Gmail is throttling (or the daily cap, which the API also
//               reports this way with a far-off retry time): pause, keep item
//   daily     – SMTP wording for the 24h cap: pause an hour, keep item
//   transient – timeout / 5xx / network: retry a limited number of times
//   other     – a real problem with this recipient/message: mark failed
function classifySendError(err) {
  const m = String((err && err.message) || err || '');
  const status = err && err.status;
  if (status === 429 || /rate.?limit|rateLimitExceeded|userRateLimitExceeded|quota exceeded|units per minute|too many requests|user-rate/i.test(m)) return 'rate';
  if (/daily (user )?sending limit|dailyLimitExceeded|5\.4\.5/i.test(m)) return 'daily';
  if ((status && status >= 500) || err?.name === 'AbortError' || /timed out|timeout|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(m)) return 'transient';
  return 'other';
}

// A send is cancelled for real when it overruns (the fetch carries the
// signal), so a timeout is not silently delivered later.
async function sendWithDeadline(settings, message, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await mailer.sendEmail(settings, message, { signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) { const e = new Error(`Send timed out after ${ms}ms`); e.name = 'AbortError'; throw e; }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- queue edits (all persist the queue record) ----------
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
  q.items = []; q.total = q.sent; q.startedAt = null; q.pausedUntil = null; q.note = ''; q.attempts = {};
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

// Record an immediate (non-queue) send so both paths share one truth.
function recordSent(q, id, email) {
  q.sentLog.push({ id, email, ts: new Date().toISOString() });
  q.items = q.items.filter((i) => i.id !== id);
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

// ---------- drain ----------
async function processQueue({ budgetMs = 20000, maxSends } = {}) {
  const started = Date.now();
  let q = await loadQ();
  if (!q.items.length) return { processed: 0, reason: 'empty' };
  if (q.runningUntil && new Date(q.runningUntil).getTime() > Date.now()) return { processed: 0, reason: 'running' };
  if (q.pausedUntil && new Date(q.pausedUntil).getTime() > Date.now()) return { processed: 0, reason: 'paused', until: q.pausedUntil };

  // Short lease so two drains (scheduler + a local dashboard) never overlap.
  q.runningUntil = new Date(Date.now() + budgetMs + 5000).toISOString();
  await saveQ(q);

  const db = await store.load();
  const st = await mailer.sendStatus(db.settings);
  const { dailyLimit, perMinute } = limits(db.settings, st.from);
  const remainingToday = dailyLimit - sentToday(q);
  if (!st.ready || remainingToday <= 0) {
    q.note = !st.ready
      ? (st.reason || 'Email is not set up — sending is paused.')
      : `Daily limit of ${dailyLimit} reached — sending resumes automatically as the 24-hour window frees up.`;
    q.pausedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    q.runningUntil = null;
    await saveQ(q);
    return { processed: 0, reason: st.ready ? 'daily-limit' : 'not-ready' };
  }

  if (!db.settings.trackingSecret) {
    await store.update((d) => { if (!d.settings.trackingSecret) d.settings.trackingSecret = crypto.randomBytes(16).toString('hex'); });
    db.settings.trackingSecret = (await store.load()).settings.trackingSecret;
  }
  const signature = await google.getSignature(db.settings); // cached: no extra API units per run
  const n = Math.min(q.items.length, maxSends || perMinute, remainingToday);
  const recent = recentlySentIds(q);

  const patches = {};   // candidate id -> { lastEmailedAt, gmailThreadId }
  const done = new Set();
  let pauseUntil = null;
  let note = '';
  let processed = 0;

  for (let i = 0; i < n; i++) {
    const left = budgetMs - (Date.now() - started);
    if (left < SEND_TIMEOUT_MS + 500) break;
    const item = q.items[i];
    const c = db.candidates.find((x) => x.id === item.id);
    if (!c || recent.has(item.id)) { done.add(item.id); continue; }   // gone, or already emailed today
    const template = (item.t && q.templates[item.t]) || db.template;
    try {
      const trackingUrl = `${google.baseUrl()}/webhooks/open/${tracking.token(db.settings, c.id)}.gif`;
      const msg = renderEmail(template, c, db.settings, { signature, trackingUrl });
      const sent = await sendWithDeadline(db.settings, { to: c.email, ...msg }, Math.min(SEND_TIMEOUT_MS, left - 500));
      q.sentLog.push({ id: c.id, email: c.email, ts: new Date().toISOString() });
      patches[c.id] = { lastEmailedAt: new Date().toISOString(), gmailThreadId: sent.threadId || '' };
      q.sent += 1;
      processed += 1;
      done.add(item.id);
    } catch (err) {
      const kind = classifySendError(err);
      if (kind === 'rate') {
        const hinted = retryAfterFrom(err.message);
        pauseUntil = new Date(Math.max(hinted ? hinted.getTime() : 0, Date.now() + MIN_PAUSE_MS));
        note = hinted && hinted.getTime() - Date.now() > 3600 * 1000
          ? `Gmail has paused sending until ${hinted.toLocaleString('en-US', { timeZone: db.settings.timeZone || 'UTC', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })} (daily limit) — it resumes automatically.`
          : 'Gmail asked us to slow down — sending resumes automatically in a minute or two.';
        break;
      }
      if (kind === 'daily') {
        pauseUntil = new Date(Date.now() + 60 * 60 * 1000);
        note = 'Gmail reports the daily sending limit is reached — sending resumes automatically.';
        break;
      }
      if (kind === 'transient') {
        q.attempts[item.id] = (q.attempts[item.id] || 0) + 1;
        if (q.attempts[item.id] < MAX_TRANSIENT_ATTEMPTS) {
          pauseUntil = new Date(Date.now() + MIN_PAUSE_MS);
          note = 'A send did not complete — retrying shortly.';
          break;
        }
      }
      q.failed.push({ id: c.id, email: c.email, error: err.message, ts: new Date().toISOString(), t: item.t || null });
      delete q.attempts[item.id];
      done.add(item.id);
    }
    if (i < n - 1) await sleep(400);
  }

  // Queue record first (source of truth for "sent"), then candidate fields.
  q.items = q.items.filter((it) => !done.has(it.id));
  q.pausedUntil = pauseUntil ? pauseUntil.toISOString() : null;
  q.note = note;
  q.runningUntil = null;
  const finished = q.items.length === 0 && q.startedAt;
  if (finished) { q.startedAt = null; q.attempts = {}; }
  pruneTemplates(q);
  await saveQ(q);

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
  loadQ, saveQ, limits, enqueue, clearQueue, retryFailed, recordSent, status, processQueue,
  classifySendError, retryAfterFrom, sentToday, recentlySentIds, sendWithDeadline, SEND_TIMEOUT_MS,
};
