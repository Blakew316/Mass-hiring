// The Express app. Run locally via server.js, or on Netlify wrapped as a
// serverless function (netlify/functions/api.js).
require('dotenv').config();
const express = require('express');
const path = require('path');

const store = require('./lib/store');
const storage = require('./lib/storage');
const auth = require('./lib/auth');
const csv = require('./lib/csv');
const google = require('./lib/google');
const mailer = require('./lib/mailer');
const notify = require('./lib/notify');
const calendly = require('./lib/calendly');
const tracking = require('./lib/tracking');
const queue = require('./lib/queue');
const crypto = require('crypto');
const { renderEmail } = require('./lib/template');

const app = express();
// Exact-case routes only, so /API/... cannot reach a handler by a path the
// auth guard would classify differently.
app.set('case sensitive routing', true);

// Keep the raw body around so Calendly webhook signatures can be verified.
app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(auth.middleware);

const asyncRoute = (fn) => (req, res) => fn(req, res).catch((err) => {
  res.status(400).json({ error: err.message || String(err) });
});

// ---------- Sign-in (only enforced when APP_PASSWORD is set) ----------
app.get('/api/auth/status', asyncRoute(async (req, res) => {
  res.json({
    required: auth.required(),
    setupRequired: auth.setupRequired(),
    authed: await auth.isAuthed(req),
  });
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  if (auth.setupRequired()) {
    return res.status(403).json({ error: 'Set APP_PASSWORD in Netlify first.', setupRequired: true });
  }
  if (!auth.required()) return res.json({ ok: true });
  const locked = auth.loginLockedFor(req);
  if (locked) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(locked / 60)} min.` });
  }
  if (!auth.checkPassword(req.body.password)) {
    auth.recordLoginFailure(req);
    await auth.failDelay();
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  auth.clearLoginFailures(req);
  await auth.setSessionCookie(req, res);
  res.json({ ok: true });
}));

// Signs out every device (the session salt rotates).
app.post('/api/logout', asyncRoute(async (req, res) => {
  await auth.revokeAllSessions(req, res);
  res.json({ ok: true });
}));

function maskedSettings(s) {
  return {
    ...s,
    smtpPass: s.smtpPass ? '••••••••' : '',
    googleClientSecret: s.googleClientSecret ? '••••••••' : '',
    calendlySigningKey: s.calendlySigningKey ? '••••••••' : '',
    calendlyToken: s.calendlyToken ? '••••••••' : '',
  };
}

function stats(db) {
  const by = (st) => db.candidates.filter((c) => c.status === st).length;
  return {
    total: db.candidates.length,
    new: by('new'),
    emailed: by('emailed'),
    replied: by('replied'),
    booked: by('booked'),
    declined: by('declined'),
    bounced: by('bounced'),
  };
}

// Immediate sends (small selections) go out at most this many per request.
const MAX_PER_REQUEST = 8;

// ---------- App state ----------
app.get('/api/state', asyncRoute(async (_req, res) => {
  const db = await store.load();
  const lastError = db.events.find((e) => e.type === 'error' && Date.now() - new Date(e.ts).getTime() < 24 * 3600 * 1000);
  const sendingNow = await mailer.sendStatus(db.settings);
  res.json({
    candidates: db.candidates,
    events: db.events.filter((e) => store.FEED_TYPES.has(e.type)).slice(0, 60),
    lastError: lastError ? lastError.message : '',
    template: db.template,
    settings: maskedSettings(db.settings),
    google: await google.status(db.settings),
    sending: sendingNow,
    stats: stats(db),
    baseUrl: google.baseUrl(),
    storage: await storage.backend(),
    auth: { required: auth.required() },
    queue: queue.status(await queue.loadQ(), db.settings, sendingNow.from),
    maxImmediate: MAX_PER_REQUEST,
    interviews: db.interviews || [],
    calendly: {
      syncEnabled: Boolean(db.settings.calendlyToken),
      webhook: Boolean(db.settings.calendlySigningKey),
      lastSyncAt: db.calendlyLastSyncAt || null,
      error: db.calendlySyncError || '',
    },
  });
}));

// ---------- Settings & template ----------
app.post('/api/settings', asyncRoute(async (req, res) => {
  const db = await store.load();
  const allowed = ['calendlyUrl', 'fromName', 'gmailSignature', 'dailyLimit', 'perMinute', 'ntfyTopic', 'smtpUser', 'smtpPass',
    'googleClientId', 'googleClientSecret', 'calendlySigningKey', 'calendlyToken', 'lastSheetUrl', 'timeZone'];
  for (const k of allowed) {
    if (!(k in req.body) || req.body[k] === '••••••••') continue;
    const v = req.body[k];
    db.settings[k] = typeof v === 'boolean' ? v : String(v ?? '').trim();
  }
  await store.save(db);
  res.json({ ok: true, settings: maskedSettings(db.settings) });
}));

app.post('/api/template', asyncRoute(async (req, res) => {
  const db = await store.load();
  db.template = {
    subject: String(req.body.subject ?? db.template.subject),
    body: String(req.body.body ?? db.template.body),
  };
  await store.save(db);
  res.json({ ok: true, template: db.template });
}));

app.post('/api/template/reset', asyncRoute(async (_req, res) => {
  const db = await store.load();
  db.template = structuredClone(store.DEFAULT_TEMPLATE);
  await store.save(db);
  res.json({ ok: true, template: db.template });
}));

// ---------- Import (Google Sheet / CSV) ----------
function toPreview(rows) {
  if (!rows.length) throw new Error('No rows found.');
  const headers = rows[0].map((h, i) => String(h || '').trim() || `Column ${i + 1}`);
  return {
    headers,
    rows: rows.slice(1),
    mapping: csv.guessMapping(rows[0]),
  };
}

app.post('/api/import/sheet', asyncRoute(async (req, res) => {
  const db = await store.load();
  const { rows, via } = await google.fetchSheetRows(req.body.url, db.settings);
  db.settings.lastSheetUrl = String(req.body.url || '').trim();
  await store.save(db);
  res.json({ ...toPreview(rows), via });
}));

app.post('/api/import/csv', asyncRoute(async (req, res) => {
  const rows = csv.parseCsv(String(req.body.text || ''));
  res.json({ ...toPreview(rows), via: 'csv' });
}));

app.post('/api/import/commit', asyncRoute(async (req, res) => {
  const db = await store.load();
  const { rows, mapping, source } = req.body;
  const pick = (row, key) => {
    const idx = mapping[key];
    return idx != null && idx >= 0 ? String(row[idx] ?? '').trim() : '';
  };
  const existing = new Set(db.candidates.map((c) => c.email.toLowerCase()));
  let added = 0, skipped = 0;
  for (const row of rows) {
    const email = pick(row, 'email');
    if (!email || !email.includes('@')) { skipped++; continue; }
    if (existing.has(email.toLowerCase())) { skipped++; continue; }
    existing.add(email.toLowerCase());
    const firstName = pick(row, 'firstName');
    const lastName = pick(row, 'lastName');
    const name = pick(row, 'name') || [firstName, lastName].filter(Boolean).join(' ');
    db.candidates.push({
      id: store.rid(),
      name, firstName, lastName, email,
      role: pick(row, 'role'),
      company: pick(row, 'company'),
      phone: pick(row, 'phone'),
      notes: pick(row, 'notes'),
      status: 'new',
      source: source || 'import',
      addedAt: new Date().toISOString(),
      lastEmailedAt: null,
      bookedAt: null,
    });
    added++;
  }
  await store.save(db);
  res.json({ ok: true, added, skipped });
}));

// ---------- Candidates ----------
app.post('/api/candidates', asyncRoute(async (req, res) => {
  const db = await store.load();
  const b = req.body;
  if (!b.email || !String(b.email).includes('@')) throw new Error('A valid email is required.');
  if (db.candidates.some((c) => c.email.toLowerCase() === String(b.email).toLowerCase())) {
    throw new Error('A candidate with that email already exists.');
  }
  const c = {
    id: store.rid(),
    name: String(b.name || '').trim(),
    firstName: String(b.firstName || '').trim(),
    lastName: String(b.lastName || '').trim(),
    email: String(b.email).trim(),
    role: String(b.role || '').trim(),
    company: String(b.company || '').trim(),
    phone: String(b.phone || '').trim(),
    notes: String(b.notes || '').trim(),
    status: 'new',
    source: 'manual',
    addedAt: new Date().toISOString(),
    lastEmailedAt: null,
    bookedAt: null,
  };
  db.candidates.push(c);
  await store.save(db);
  res.json({ ok: true, candidate: c });
}));

app.patch('/api/candidates/:id', asyncRoute(async (req, res) => {
  const db = await store.load();
  const c = db.candidates.find((x) => x.id === req.params.id);
  if (!c) throw new Error('Candidate not found.');
  const fields = ['name', 'firstName', 'lastName', 'email', 'role', 'company', 'phone', 'notes', 'status'];
  for (const f of fields) if (f in req.body) c[f] = String(req.body[f] ?? '').trim();
  await store.save(db);
  res.json({ ok: true, candidate: c });
}));

app.delete('/api/candidates/:id', asyncRoute(async (req, res) => {
  const db = await store.load();
  const idx = db.candidates.findIndex((x) => x.id === req.params.id);
  if (idx === -1) throw new Error('Candidate not found.');
  db.candidates.splice(idx, 1);
  await store.save(db);
  res.json({ ok: true });
}));

// ---------- Personalized preview & send ----------
app.post('/api/preview', asyncRoute(async (req, res) => {
  const db = await store.load();
  const c = db.candidates.find((x) => x.id === req.body.candidateId);
  if (!c) throw new Error('Candidate not found.');
  const template = req.body.template || db.template;
  const signature = await google.getSignature(db.settings);
  res.json(renderEmail(template, c, db.settings, { signature }));
}));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sending happens in small batches driven by the browser: a serverless
// request has a 10s limit, so each call sends at most MAX_PER_REQUEST
// emails, refreshes the signature once, and saves once.
app.post('/api/send', asyncRoute(async (req, res) => {
  const started = Date.now();
  const db = await store.load();
  const q = await queue.loadQ();   // read-only snapshot; every change below goes through queue.updateQ
  const ids = (Array.isArray(req.body.candidateIds) ? req.body.candidateIds : []).slice(0, MAX_PER_REQUEST);
  if (!ids.length) throw new Error('No candidates selected.');
  const template = req.body.template || db.template;
  const st = await mailer.sendStatus(db.settings);
  if (!st.ready) throw new Error(st.reason || 'Email is not set up.');
  const { dailyLimit, perMinute } = queue.limits(db.settings, st.from);
  const results = [];
  const deferAll = (kind, retryAt, error) => {
    for (const id of ids.filter((x) => !results.some((r) => r.id === x))) {
      const rc = db.candidates.find((x) => x.id === id);
      results.push({ id, ok: false, retry: true, kind, retryAt: retryAt.toISOString(), email: rc ? rc.email : '', error });
    }
  };
  // Respect an active Gmail pause, the daily cap and the shared per-minute pace before touching Gmail.
  if (q.pausedUntil && new Date(q.pausedUntil).getTime() > Date.now()) {
    deferAll('rate', new Date(q.pausedUntil), q.note || 'Gmail asked us to slow down.');
    return res.json({ ok: true, results, maxPerRequest: MAX_PER_REQUEST });
  }
  if (queue.sentToday(q) >= dailyLimit) {
    deferAll('daily', new Date(Date.now() + 3600 * 1000), `Daily limit of ${dailyLimit} reached.`);
    return res.json({ ok: true, results, maxPerRequest: MAX_PER_REQUEST });
  }
  let paceLeft = perMinute - queue.sentInLastMinute(q);
  if (paceLeft <= 0) {
    deferAll('rate', new Date(Date.now() + 20 * 1000), `Pacing to ${perMinute} emails per minute.`);
    return res.json({ ok: true, results, maxPerRequest: MAX_PER_REQUEST });
  }
  if (!db.settings.trackingSecret) {
    await store.update((d) => { if (!d.settings.trackingSecret) d.settings.trackingSecret = crypto.randomBytes(16).toString('hex'); });
    db.settings.trackingSecret = (await store.load()).settings.trackingSecret;
  }
  const signature = await google.getSignature(db.settings, { refresh: true });
  const recent = queue.recentlySentIds(q);
  const patches = {};
  for (const id of ids) {
    const c = db.candidates.find((x) => x.id === id);
    if (!c) { results.push({ id, ok: false, error: 'Not found' }); continue; }
    if (recent.has(id)) { results.push({ id, ok: true, email: c.email, skipped: 'already emailed in the last 24 hours' }); continue; }
    if (q.items.some((i) => i.id === id)) { results.push({ id, ok: false, queued: true, email: c.email, error: 'Already in the sending queue.' }); continue; }
    const left = 6500 - (Date.now() - started);
    if (left < 2500) { deferAll('budget', new Date(), 'Continuing in the next batch.'); break; }
    if (paceLeft <= 0) { deferAll('rate', new Date(Date.now() + 20 * 1000), `Pacing to ${perMinute} emails per minute.`); break; }
    const attemptAt = new Date().toISOString();
    try {
      const trackingUrl = `${google.baseUrl()}/webhooks/open/${tracking.token(db.settings, c.id)}.gif`;
      const msg = renderEmail(template, c, db.settings, { signature, trackingUrl });
      const sent = await queue.sendWithDeadline(db.settings, { to: c.email, ...msg }, Math.min(queue.SEND_TIMEOUT_MS, left - 300), { via: st.via });
      await queue.updateQ((f) => queue.recordSent(f, c.id, c.email));
      paceLeft -= 1;
      patches[c.id] = { lastEmailedAt: new Date().toISOString(), gmailThreadId: sent.threadId || '' };
      results.push({ id, ok: true, email: c.email });
    } catch (err) {
      const kind = queue.classifySendError(err);
      if (kind === 'rate' || kind === 'daily') {
        const hinted = queue.retryAfterFrom(err.message);
        const retryAt = new Date(Math.max(hinted ? hinted.getTime() : 0, Date.now() + (kind === 'daily' ? 3600 : 60) * 1000));
        const note = kind === 'daily' ? 'Gmail reports the daily sending limit is reached.' : 'Gmail asked us to slow down.';
        await queue.updateQ((f) => { f.pausedUntil = retryAt.toISOString(); f.note = note; });
        deferAll(kind, retryAt, err.message);
        break;
      }
      if (err.name === 'AbortError' && st.via === 'gmail-api') {
        // Outcome unknown: the queue checks the Sent folder before deciding — never a blind resend.
        await queue.updateQ((f) => queue.deferUnverified(f, c.id, c.email, attemptAt));
        results.push({ id, ok: false, queued: true, email: c.email, error: 'Timed out — Gmail will be checked and the send finished in the background.' });
        continue;
      }
      if (err.name === 'AbortError') { results.push({ id, ok: false, email: c.email, error: queue.TIMEOUT_UNKNOWN, kind }); continue; }
      results.push({ id, ok: false, email: c.email, error: err.message, kind });
    }
    await sleep(400);
  }
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
  res.json({ ok: true, results, maxPerRequest: MAX_PER_REQUEST });
}));

// ---------- Send queue (large sends; drained by the scheduled function) ----------
app.post('/api/queue', asyncRoute(async (req, res) => {
  const db = await store.load();
  const ids = Array.isArray(req.body.candidateIds) ? req.body.candidateIds : [];
  if (!ids.length) throw new Error('No candidates selected.');
  const st = await mailer.sendStatus(db.settings);
  if (!st.ready) throw new Error(st.reason || 'Email is not set up.');
  let added = 0;
  const q = await queue.updateQ((f) => { added = queue.enqueue(f, db, ids, req.body.template || null); });
  res.json({ ok: true, added, queue: queue.status(q, db.settings, st.from) });
}));

app.delete('/api/queue', asyncRoute(async (_req, res) => {
  const db = await store.load();
  const q = await queue.updateQ((f) => queue.clearQueue(f));
  res.json({ ok: true, queue: queue.status(q, db.settings, null) });
}));

app.post('/api/queue/retry-failed', asyncRoute(async (_req, res) => {
  const db = await store.load();
  let added = 0;
  const q = await queue.updateQ((f) => { added = queue.retryFailed(f, db); });
  res.json({ ok: true, added, queue: queue.status(q, db.settings, null) });
}));

// On Netlify the scheduler drains the queue; locally (no scheduler) the
// dashboard calls this once a minute while a queue is active.
app.post('/api/queue/run', asyncRoute(async (_req, res) => {
  // Deployed: the scheduled function drains the queue. Under `netlify dev`
  // schedules never fire, so the dashboard's ticks drive it there as well.
  if (storage.onNetlify && !process.env.NETLIFY_DEV && !process.env.NETLIFY_LOCAL) return res.json({ ok: true, skipped: true });
  const r = await queue.processQueue({ budgetMs: 20000 });
  res.json({ ok: true, ...r });
}));

// ---------- Open tracking pixel (public; token is signed) ----------
app.get('/webhooks/open/:token', asyncRoute(async (req, res) => {
  const db = await store.load();
  const id = tracking.verify(db.settings, req.params.token);
  const c = id && db.candidates.find((x) => x.id === id);
  if (c && !c.openedAt) {
    let first = false;
    await store.update((fresh) => {
      const fc = fresh.candidates.find((x) => x.id === id);
      if (fc && !fc.openedAt) { fc.openedAt = new Date().toISOString(); first = true; }
    });
    if (first) await store.addEvent('opened', `${c.name || c.email} opened your email.`, c.id);
  }
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(tracking.GIF);
}));

// ---------- Reply detection (Gmail thread headers, a few at a time) ----------
// Local, cheap: (re)classify stored replies; drop bounces/auto-replies from
// the record, fix the status, and remove feed lines that were not real replies.
function reclassifyCandidate(c) {
  const all = (c.replies || []).map((r) => ({ ...r, kind: r.kind !== undefined ? r.kind : google.classifyReply(r) }));
  const real = all.filter((r) => !r.kind);
  const bounced = all.some((r) => r.kind === 'bounce');
  c.replies = all;
  c.lastReplyAt = real.length ? real[real.length - 1].date || c.lastReplyAt : null;
  if (c.status === 'replied' && !real.length) {
    c.status = bounced ? 'bounced' : 'emailed';
    c.repliedAt = null;
    return { fixed: true };
  }
  if (c.status === 'emailed' && bounced && !real.length) { c.status = 'bounced'; return { fixed: true }; }
  return { fixed: false };
}

app.post('/api/replies/check', asyncRoute(async (_req, res) => {
  const db = await store.load();
  const g = await google.status(db.settings);
  if (!g.connected) return res.json({ ok: true, checked: 0, replies: 0, unavailable: 'Google not connected' });
  const byCheck = (a, b) => String(a.repliesCheckedAt || '').localeCompare(String(b.repliesCheckedAt || ''));
  const withThread = db.candidates.filter((c) => c.gmailThreadId);
  const waiting = withThread.filter((c) => c.status === 'emailed').sort(byCheck).slice(0, 20);
  // Replies saved before the read permission existed have no text: refetch them.
  const backfill = withThread.filter((c) => (c.replies || []).some((r) => !r.text && !r.kind && !r.textFetched)).slice(0, 8);
  const conversing = withThread.filter((c) => c.status === 'replied').sort(byCheck).slice(0, 5);
  const seen = new Set();
  const pool = [...backfill, ...waiting, ...conversing].filter((c) => !seen.has(c.id) && seen.add(c.id));
  const results = {};   // id -> { gone, limited, replies }
  let scopeError = '';
  let limitedAny = false;
  for (const c of pool) {
    try {
      const r = await google.threadReplies(db.settings, c.gmailThreadId, g.email);
      results[c.id] = { gone: false, limited: r.limited, replies: r.replies };
      if (r.limited) limitedAny = true;
    } catch (err) {
      if (err.scope) { scopeError = 'Reconnect Google (Settings) to allow reply detection.'; break; }
      results[c.id] = { gone: Boolean(err.gone), replies: [] };
    }
  }
  const now = new Date().toISOString();
  const announce = [];
  await store.update((fresh) => {
    for (const [id, r] of Object.entries(results)) {
      const fc = fresh.candidates.find((x) => x.id === id);
      if (!fc) continue;
      fc.repliesCheckedAt = now;
      if (r.gone) { fc.gmailThreadId = ''; continue; }
      const existing = new Map((fc.replies || []).map((x) => [x.id, x]));
      const before = new Set(existing.keys());
      for (const rep of r.replies) {
        const prev = existing.get(rep.id) || {};
        // textFetched: the full message was read once; if it has no readable
        // text (attachment-only), stop re-fetching it every minute.
        existing.set(rep.id, {
          ...prev, ...rep,
          text: rep.text || prev.text || '',
          snippet: rep.snippet || prev.snippet || '',
          textFetched: Boolean(prev.textFetched) || !r.limited,
        });
      }
      fc.replies = [...existing.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-10);
      const fresh_real = fc.replies.filter((x) => !x.kind);
      const newReal = fresh_real.filter((x) => !before.has(x.id));
      const bounced = fc.replies.some((x) => x.kind === 'bounce');
      if (fresh_real.length) {
        fc.lastReplyAt = fresh_real[fresh_real.length - 1].date || now;
        if (fc.status === 'emailed' || fc.status === 'bounced') { fc.status = 'replied'; fc.repliedAt = fc.repliedAt || now; }
        if (newReal.length) announce.push({ c: fc, reply: newReal[newReal.length - 1] });
      } else if (bounced && fc.status === 'emailed') {
        fc.status = 'bounced';
      }
    }
    // Housekeeping for everyone marked replied: bounces/auto-replies are not replies.
    const cleaned = new Set();
    for (const c of fresh.candidates) {
      if (!(c.replies || []).length) continue;
      if (reclassifyCandidate(c).fixed) cleaned.add(c.id);
    }
    if (cleaned.size) fresh.events = fresh.events.filter((e) => !(e.type === 'replied' && cleaned.has(e.candidateId)));
  });
  for (const { c, reply } of announce) {
    const preview = (reply.text || reply.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    await store.addEvent('replied', `${c.name || c.email} replied${preview ? `: “${preview}${preview.length === 140 ? '…' : ''}”` : '.'}`, c.id);
    try {
      await notify.pushToPhone(db.settings, {
        title: `💬 ${c.name || c.email} replied`,
        message: preview || 'Check your inbox.',
        tags: 'speech_balloon',
      });
    } catch {}
  }
  res.json({ ok: true, checked: pool.length, replies: announce.length, scopeError: scopeError || (limitedAny ? 'Reconnect Google (Settings) to see reply text in the dashboard.' : '') });
}));

// ---------- Google OAuth ----------
// Used by the dashboard button: returns the consent URL (and sets the state
// cookie) so the browser only navigates once everything server-side worked.
app.get('/api/google/auth-url', asyncRoute(async (req, res) => {
  const db = await store.load();
  const st = await google.status(db.settings);
  if (!st.configured) throw new Error('Enter your Google OAuth Client ID and Secret first, then save.');
  const state = auth.issueOauthState(req, res);
  res.json({ url: google.authUrl(db.settings, state) });
}));

app.get('/auth/google', asyncRoute(async (req, res) => {
  const db = await store.load();
  const st = await google.status(db.settings);
  if (!st.configured) return res.redirect('/#settings?error=google-not-configured');
  const state = auth.issueOauthState(req, res);
  res.redirect(google.authUrl(db.settings, state));
}));

app.get('/auth/google/callback', asyncRoute(async (req, res) => {
  const db = await store.load();
  if (req.query.error) return res.redirect('/#settings?error=' + encodeURIComponent(req.query.error));
  // The state round-trip stops a forged callback from binding someone else's
  // Google account to this dashboard.
  if (!auth.consumeOauthState(req, res, req.query.state)) {
    return res.redirect('/#settings?error=' + encodeURIComponent('Sign-in session expired or did not match — please click Connect Google again.'));
  }
  // A wrong client secret etc. must land the user back in Settings with the
  // message, not on a bare JSON page.
  try {
    await google.exchangeCode(req.query.code, db.settings);
  } catch (err) {
    return res.redirect('/#settings?error=' + encodeURIComponent(`${err.message} — check the OAuth Client ID and Secret, save, and try again.`));
  }
  res.redirect('/#settings?connected=1');
}));

app.post('/auth/google/disconnect', asyncRoute(async (_req, res) => {
  await google.clearTokens();
  res.json({ ok: true });
}));

// ---------- Calendly ----------
app.post('/api/calendly/register-webhook', asyncRoute(async (req, res) => {
  const db = await store.load();
  const provided = String(req.body.token || '').trim();
  const token = provided && provided !== '••••••••' ? provided : (db.settings.calendlyToken || '');
  const publicUrl = String(req.body.publicUrl || google.baseUrl()).trim();
  if (!token) throw new Error('Paste your Calendly Personal Access Token first.');
  if (!publicUrl || publicUrl.includes('localhost')) {
    throw new Error('Calendly needs a public URL to reach this app. Deploy it (or tunnel with ngrok) and enter that URL.');
  }
  const result = await calendly.registerWebhook(token, publicUrl);
  if (result.signingKey) db.settings.calendlySigningKey = result.signingKey;
  db.settings.calendlyToken = token;
  if (!db.settings.calendlyUrl && result.schedulingUrl) db.settings.calendlyUrl = result.schedulingUrl;
  await store.save(db);
  res.json({ ok: true, ...result, signingKey: undefined });
}));

// Interview times are shown in the user's own time zone (auto-saved from the
// browser), both in the activity feed and on the phone.
function formatWhen(iso, timeZone) {
  if (!iso) return 'time TBD';
  const opts = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  try { return new Date(iso).toLocaleString('en-US', { ...opts, timeZone: timeZone || 'UTC' }); }
  catch { return new Date(iso).toLocaleString('en-US', { ...opts, timeZone: 'UTC' }); }
}

let lastSignatureWarning = 0;

// Who booked? Email first — including addresses learned from earlier
// bookings — then a unique full-name match, because people often book with
// a different address (work vs personal) than the one on the sheet.
const normEmail = (e) => String(e || '').trim().toLowerCase();
const normName = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function matchCandidate(candidates, email, name) {
  const e = normEmail(email);
  if (e) {
    const byEmail = candidates.find((c) => normEmail(c.email) === e || (c.altEmails || []).some((a) => normEmail(a) === e));
    if (byEmail) return byEmail;
  }
  const n = normName(name);
  if (n.length >= 4) {
    const byName = candidates.filter((c) => normName(c.name) === n || normName(`${c.firstName || ''}${c.lastName || ''}`) === n);
    if (byName.length === 1) return byName[0];
  }
  return null;
}
// Remember the address they booked with so replies and later bookings match.
function learnEmail(c, email) {
  const e = normEmail(email);
  if (!e || normEmail(c.email) === e) return;
  c.altEmails = Array.from(new Set([...(c.altEmails || []), e]));
}

// Manual link from the Interviews tile for the rare booking the matcher
// could not place (different name and address).
app.post('/api/interviews/link', asyncRoute(async (req, res) => {
  const { uri, inviteeEmail, candidateId } = req.body || {};
  let linked = null;
  await store.update((fresh) => {
    const c = fresh.candidates.find((x) => x.id === candidateId);
    if (!c) throw new Error('Candidate not found.');
    const iv = (fresh.interviews || []).find((i) => i.uri === uri && normEmail(i.inviteeEmail) === normEmail(inviteeEmail));
    if (!iv) throw new Error('That interview is no longer listed — sync and try again.');
    iv.candidateId = c.id;
    learnEmail(c, inviteeEmail);
    if (iv.status === 'active') {
      c.status = 'booked';
      c.bookedAt = iv.start;
      c.bookedEvent = iv.name;
      c.calendlyEventUri = iv.uri;
      c.bookedJoinUrl = iv.joinUrl || '';
    }
    linked = { id: c.id, name: c.name, email: c.email };
  });
  res.json({ ok: true, candidate: linked });
}));

app.post('/webhooks/calendly', asyncRoute(async (req, res) => {
  const db = await store.load();
  const signingKey = db.settings.calendlySigningKey || process.env.CALENDLY_SIGNING_KEY || '';
  if (!signingKey) {
    return res.status(401).json({ error: 'Calendly webhook is not registered (no signing key). Use "Enable booking alerts" in Settings.' });
  }
  if (!calendly.verifySignature(signingKey, req.get('Calendly-Webhook-Signature'), req.rawBody)) {
    // Surface a key mismatch in the activity feed (throttled so a flood of
    // bogus calls can't spam it).
    if (Date.now() - lastSignatureWarning > 10 * 60 * 1000) {
      lastSignatureWarning = Date.now();
      await store.addEvent('error', 'Rejected a Calendly webhook call with an invalid signature. If bookings stop showing up, click "Enable booking alerts" in Settings to re-register.');
    }
    return res.status(401).json({ error: 'Invalid Calendly signature' });
  }
  const event = req.body.event;
  const p = req.body.payload || {};
  const inviteeEmail = String(p.email || '').toLowerCase();
  const inviteeName = p.name || inviteeEmail || 'Someone';
  const eventName = (p.scheduled_event && p.scheduled_event.name) || 'Interview';
  const startTime = p.scheduled_event && p.scheduled_event.start_time;
  const when = formatWhen(startTime, db.settings.timeZone);

  const c = matchCandidate(db.candidates, inviteeEmail, p.name);

  if (event === 'invitee.created') {
    const ev = p.scheduled_event || {};
    await store.update((fresh) => {
      const fc = c && fresh.candidates.find((x) => x.id === c.id);
      if (fc) {
        learnEmail(fc, inviteeEmail);
        fc.status = 'booked';
        fc.bookedAt = startTime || new Date().toISOString();
        fc.bookedEvent = eventName;
        fc.calendlyEventUri = ev.uri || '';
        fc.bookedJoinUrl = (ev.location && ev.location.join_url) || '';
      }
      fresh.interviews = (fresh.interviews || []).filter((i) => !(i.uri === ev.uri && String(i.inviteeEmail || '').toLowerCase() === inviteeEmail));
      if (ev.uri) {
        fresh.interviews.push({
          uri: ev.uri, name: eventName, status: 'active', start: startTime || new Date().toISOString(), end: ev.end_time || null,
          joinUrl: (ev.location && ev.location.join_url) || null, inviteeName: p.name || '', inviteeEmail: p.email || '',
          candidateId: c ? c.id : null, rescheduleUrl: p.reschedule_url || '', cancelUrl: p.cancel_url || '',
        });
        fresh.interviews.sort((x, y) => String(x.start).localeCompare(String(y.start)));
      }
    });
    await store.addEvent('booked', `${inviteeName} booked "${eventName}" — ${when}.`, c ? c.id : null);
    try {
      await notify.pushToPhone(db.settings, {
        title: `📅 ${inviteeName} booked an interview`,
        message: `${eventName} — ${when}${c && c.role ? `\n${c.role}${c.company ? ' @ ' + c.company : ''}` : ''}`,
        tags: 'tada,calendar',
      });
    } catch (err) {
      await store.addEvent('error', `Phone notification failed: ${err.message}`);
    }
  } else if (event === 'invitee.canceled') {
    const evUri = (p.scheduled_event && p.scheduled_event.uri) || '';
    await store.update((fresh) => {
      const fc = c && fresh.candidates.find((x) => x.id === c.id);
      if (fc && fc.status === 'booked') {
        fc.status = (fc.replies || []).some((r) => !r.kind) ? 'replied' : 'emailed';
        fc.bookedAt = null; fc.bookedEvent = ''; fc.calendlyEventUri = ''; fc.bookedJoinUrl = '';
      }
      for (const i of fresh.interviews || []) {
        if (i.uri === evUri && String(i.inviteeEmail || '').toLowerCase() === inviteeEmail) i.status = 'canceled';
      }
    });
    await store.addEvent('canceled', `${inviteeName} canceled "${eventName}".`, c ? c.id : null);
    try {
      await notify.pushToPhone(db.settings, {
        title: `❌ ${inviteeName} canceled`,
        message: `${eventName} was canceled.`,
        priority: 'default',
        tags: 'x',
      });
    } catch {}
  }
  res.json({ ok: true });
}));

// ---------- Calendly sync: pull scheduled interviews, match to candidates ----------
const DAY_MS = 24 * 3600 * 1000;
app.post('/api/calendly/sync', asyncRoute(async (_req, res) => {
  const db = await store.load();
  const token = db.settings.calendlyToken;
  if (!token) return res.json({ ok: true, unavailable: 'Add your Calendly token in Settings to sync interviews.' });
  let result;
  try {
    result = await calendly.listInterviews(token, {
      minStart: new Date(Date.now() - 14 * DAY_MS),
      maxStart: new Date(Date.now() + 120 * DAY_MS),
    });
  } catch (err) {
    await store.update((d) => { d.calendlySyncError = err.message; d.calendlyLastSyncAt = new Date().toISOString(); });
    return res.json({ ok: false, error: err.message });
  }
  const announce = [];
  await store.update((fresh) => {
    const list = [];
    for (const ev of result.interviews) {
      if (!ev.invitees.length) {
        list.push({ uri: ev.uri, name: ev.name, status: ev.status, start: ev.start, end: ev.end, joinUrl: ev.joinUrl, inviteeName: '', inviteeEmail: '', candidateId: null });
      }
      for (const inv of ev.invitees) {
        const c = matchCandidate(fresh.candidates, inv.email, inv.name);
        if (c) learnEmail(c, inv.email);
        const active = ev.status === 'active' && inv.status !== 'canceled';
        list.push({
          uri: ev.uri, name: ev.name, status: active ? 'active' : 'canceled', start: ev.start, end: ev.end,
          joinUrl: ev.joinUrl, inviteeName: inv.name || '', inviteeEmail: inv.email || '',
          candidateId: c ? c.id : null, rescheduleUrl: inv.rescheduleUrl || '', cancelUrl: inv.cancelUrl || '',
        });
        if (!c) continue;
        if (active) {
          const isNew = c.calendlyEventUri !== ev.uri;
          if (isNew || c.status !== 'booked') {
            c.status = 'booked';
            c.bookedAt = ev.start;
            c.bookedEvent = ev.name;
            c.calendlyEventUri = ev.uri;
            c.bookedJoinUrl = ev.joinUrl || '';
            if (isNew) announce.push({ c, ev });
          }
        } else if (c.calendlyEventUri === ev.uri && c.status === 'booked') {
          c.status = (c.replies && c.replies.length) ? 'replied' : 'emailed';
          c.bookedAt = null; c.bookedEvent = ''; c.calendlyEventUri = ''; c.bookedJoinUrl = '';
          announce.push({ c, ev, canceled: true });
        }
      }
    }
    fresh.interviews = list.sort((a, b) => String(a.start).localeCompare(String(b.start)));
    fresh.calendlyLastSyncAt = new Date().toISOString();
    fresh.calendlySyncError = '';
  });
  for (const a of announce) {
    const who = a.c.name || a.c.email;
    await store.addEvent(
      a.canceled ? 'canceled' : 'booked',
      a.canceled ? `${who} canceled "${a.ev.name}".` : `${who} booked "${a.ev.name}" — ${formatWhen(a.ev.start, db.settings.timeZone)}.`,
      a.c.id
    );
  }
  res.json({ ok: true, interviews: result.interviews.length, newBookings: announce.filter((a) => !a.canceled).length });
}));

// ---------- Phone notification test ----------
app.post('/api/test-notification', asyncRoute(async (_req, res) => {
  const db = await store.load();
  const r = await notify.pushToPhone(db.settings, {
    title: 'Wholesale Payments Hiring CRM',
    message: 'Test notification — you are all set. Booking alerts will arrive here.',
    tags: 'white_check_mark',
  });
  if (!r.sent) throw new Error(r.reason);
  // A working push retires any earlier "notification failed" warning.
  await store.update((d) => { d.events = d.events.filter((e) => !(e.type === 'error' && /notification failed/i.test(e.message || ''))); });
  res.json({ ok: true });
}));

// JSON errors everywhere (including failures inside the auth middleware), so
// the dashboard can show the message instead of an HTML stack page.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: err.message || 'Unexpected error' });
});

module.exports = app;
