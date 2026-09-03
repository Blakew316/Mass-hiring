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
  };
}

// ---------- App state ----------
app.get('/api/state', asyncRoute(async (_req, res) => {
  const db = await store.load();
  const lastError = db.events.find((e) => e.type === 'error' && Date.now() - new Date(e.ts).getTime() < 24 * 3600 * 1000);
  res.json({
    candidates: db.candidates,
    events: db.events.filter((e) => store.FEED_TYPES.has(e.type)).slice(0, 60),
    lastError: lastError ? lastError.message : '',
    template: db.template,
    settings: maskedSettings(db.settings),
    google: await google.status(db.settings),
    sending: await mailer.sendStatus(db.settings),
    stats: stats(db),
    baseUrl: google.baseUrl(),
    storage: await storage.backend(),
    auth: { required: auth.required() },
  });
}));

// ---------- Settings & template ----------
app.post('/api/settings', asyncRoute(async (req, res) => {
  const db = await store.load();
  const allowed = ['calendlyUrl', 'fromName', 'gmailSignature', 'ntfyTopic', 'smtpUser', 'smtpPass',
    'googleClientId', 'googleClientSecret', 'calendlySigningKey', 'lastSheetUrl', 'timeZone'];
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
const MAX_PER_REQUEST = 8;

app.post('/api/send', asyncRoute(async (req, res) => {
  const db = await store.load();
  const ids = (Array.isArray(req.body.candidateIds) ? req.body.candidateIds : []).slice(0, MAX_PER_REQUEST);
  if (!ids.length) throw new Error('No candidates selected.');
  // Optional per-send override lets the compose window customize one batch
  // without changing the saved default template.
  const template = req.body.template || db.template;
  if (!db.settings.trackingSecret) db.settings.trackingSecret = crypto.randomBytes(16).toString('hex');
  const signature = await google.getSignature(db.settings, { refresh: true });
  const results = [];
  for (const id of ids) {
    const c = db.candidates.find((x) => x.id === id);
    if (!c) { results.push({ id, ok: false, error: 'Not found' }); continue; }
    try {
      const trackingUrl = `${google.baseUrl()}/webhooks/open/${tracking.token(db.settings, c.id)}.gif`;
      const msg = renderEmail(template, c, db.settings, { signature, trackingUrl });
      const sent = await mailer.sendEmail(db.settings, { to: c.email, ...msg });
      if (c.status === 'new') c.status = 'emailed';
      c.lastEmailedAt = new Date().toISOString();
      if (sent.threadId) c.gmailThreadId = sent.threadId;
      results.push({ id, ok: true, email: c.email });
    } catch (err) {
      results.push({ id, ok: false, email: c.email, error: err.message });
    }
    if (ids.length > 1) await sleep(150);
  }
  await store.save(db);
  res.json({ ok: true, results, maxPerRequest: MAX_PER_REQUEST });
}));

// ---------- Open tracking pixel (public; token is signed) ----------
app.get('/webhooks/open/:token', asyncRoute(async (req, res) => {
  const db = await store.load();
  const id = tracking.verify(db.settings, req.params.token);
  const c = id && db.candidates.find((x) => x.id === id);
  if (c && !c.openedAt) {
    c.openedAt = new Date().toISOString();
    await store.save(db);
    await store.addEvent('opened', `${c.name || c.email} opened your email.`, c.id);
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
app.post('/api/replies/check', asyncRoute(async (_req, res) => {
  const db = await store.load();
  const g = await google.status(db.settings);
  if (!g.connected) return res.json({ ok: true, checked: 0, replies: 0, unavailable: 'Google not connected' });
  const pool = db.candidates
    .filter((c) => c.status === 'emailed' && c.gmailThreadId)
    .sort((a, b) => String(a.repliesCheckedAt || '').localeCompare(String(b.repliesCheckedAt || '')))
    .slice(0, 20);
  const replied = [];
  let scopeError = '';
  for (const c of pool) {
    try {
      const r = await google.threadHasReply(db.settings, c.gmailThreadId, g.email);
      c.repliesCheckedAt = new Date().toISOString();
      if (r.replied) {
        c.status = 'replied';
        c.repliedAt = new Date().toISOString();
        replied.push(c);
      }
    } catch (err) {
      if (err.scope) { scopeError = 'Reconnect Google (Settings) to allow reply detection.'; break; }
      c.repliesCheckedAt = new Date().toISOString();
      if (err.gone) c.gmailThreadId = '';
    }
  }
  await store.save(db);
  for (const c of replied) {
    await store.addEvent('replied', `${c.name || c.email} replied to your email.`, c.id);
    try {
      await notify.pushToPhone(db.settings, {
        title: `💬 ${c.name || c.email} replied`,
        message: `${c.role ? c.role + (c.company ? ' @ ' + c.company : '') + ' — ' : ''}check your inbox.`,
        tags: 'speech_balloon',
      });
    } catch {}
  }
  res.json({ ok: true, checked: pool.length, replies: replied.length, scopeError });
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
  const token = String(req.body.token || '').trim();
  const publicUrl = String(req.body.publicUrl || google.baseUrl()).trim();
  if (!token) throw new Error('Paste your Calendly Personal Access Token first.');
  if (!publicUrl || publicUrl.includes('localhost')) {
    throw new Error('Calendly needs a public URL to reach this app. Deploy it (or tunnel with ngrok) and enter that URL.');
  }
  const result = await calendly.registerWebhook(token, publicUrl);
  if (result.signingKey) db.settings.calendlySigningKey = result.signingKey;
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

  const c = db.candidates.find((x) => x.email.toLowerCase() === inviteeEmail);

  if (event === 'invitee.created') {
    if (c) {
      c.status = 'booked';
      c.bookedAt = startTime || new Date().toISOString();
      await store.save(db);
    }
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
    if (c && c.status === 'booked') {
      c.status = 'emailed';
      c.bookedAt = null;
      await store.save(db);
    }
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

// ---------- Phone notification test ----------
app.post('/api/test-notification', asyncRoute(async (_req, res) => {
  const db = await store.load();
  const r = await notify.pushToPhone(db.settings, {
    title: 'Wholesale Payments Hiring CRM',
    message: 'Test notification — you are all set. Booking alerts will arrive here.',
    tags: 'white_check_mark',
  });
  if (!r.sent) throw new Error(r.reason);
  res.json({ ok: true });
}));

// JSON errors everywhere (including failures inside the auth middleware), so
// the dashboard can show the message instead of an HTML stack page.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: err.message || 'Unexpected error' });
});

module.exports = app;
