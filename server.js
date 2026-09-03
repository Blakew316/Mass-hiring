require('dotenv').config();
const express = require('express');
const path = require('path');

const store = require('./lib/store');
const csv = require('./lib/csv');
const google = require('./lib/google');
const mailer = require('./lib/mailer');
const notify = require('./lib/notify');
const calendly = require('./lib/calendly');
const { renderEmail } = require('./lib/template');

const app = express();
const PORT = process.env.PORT || 3000;

// Keep the raw body around so Calendly webhook signatures can be verified.
app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(express.static(path.join(__dirname, 'public')));

const asyncRoute = (fn) => (req, res) => fn(req, res).catch((err) => {
  res.status(400).json({ error: err.message || String(err) });
});

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
  const db = store.load();
  res.json({
    candidates: db.candidates,
    events: db.events.slice(0, 60),
    template: db.template,
    settings: maskedSettings(db.settings),
    google: google.status(db.settings),
    sending: mailer.sendStatus(db.settings),
    stats: stats(db),
    baseUrl: (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, ''),
  });
}));

// ---------- Settings & template ----------
app.post('/api/settings', asyncRoute(async (req, res) => {
  const db = store.load();
  const allowed = ['senderName', 'calendlyUrl', 'ntfyTopic', 'smtpUser', 'smtpPass',
    'googleClientId', 'googleClientSecret', 'calendlySigningKey', 'lastSheetUrl'];
  for (const k of allowed) {
    if (k in req.body && req.body[k] !== '••••••••') db.settings[k] = String(req.body[k] ?? '').trim();
  }
  store.save();
  res.json({ ok: true, settings: maskedSettings(db.settings) });
}));

app.post('/api/template', asyncRoute(async (req, res) => {
  const db = store.load();
  db.template = {
    subject: String(req.body.subject ?? db.template.subject),
    body: String(req.body.body ?? db.template.body),
  };
  store.save();
  res.json({ ok: true, template: db.template });
}));

app.post('/api/template/reset', asyncRoute(async (_req, res) => {
  const db = store.load();
  db.template = structuredClone(store.DEFAULT_TEMPLATE);
  store.save();
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
  const db = store.load();
  const { rows, via } = await google.fetchSheetRows(req.body.url, db.settings);
  db.settings.lastSheetUrl = String(req.body.url || '').trim();
  store.save();
  res.json({ ...toPreview(rows), via });
}));

app.post('/api/import/csv', asyncRoute(async (req, res) => {
  const rows = csv.parseCsv(String(req.body.text || ''));
  res.json({ ...toPreview(rows), via: 'csv' });
}));

app.post('/api/import/commit', asyncRoute(async (req, res) => {
  const db = store.load();
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
  store.save();
  store.addEvent('import', `Imported ${added} candidate${added === 1 ? '' : 's'} (${skipped} skipped as duplicates/invalid).`);
  res.json({ ok: true, added, skipped });
}));

// ---------- Candidates ----------
app.post('/api/candidates', asyncRoute(async (req, res) => {
  const db = store.load();
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
  store.save();
  store.addEvent('add', `Added ${c.name || c.email} manually.`, c.id);
  res.json({ ok: true, candidate: c });
}));

app.patch('/api/candidates/:id', asyncRoute(async (req, res) => {
  const db = store.load();
  const c = db.candidates.find((x) => x.id === req.params.id);
  if (!c) throw new Error('Candidate not found.');
  const fields = ['name', 'firstName', 'lastName', 'email', 'role', 'company', 'phone', 'notes', 'status'];
  for (const f of fields) if (f in req.body) c[f] = String(req.body[f] ?? '').trim();
  store.save();
  res.json({ ok: true, candidate: c });
}));

app.delete('/api/candidates/:id', asyncRoute(async (req, res) => {
  const db = store.load();
  const idx = db.candidates.findIndex((x) => x.id === req.params.id);
  if (idx === -1) throw new Error('Candidate not found.');
  db.candidates.splice(idx, 1);
  store.save();
  res.json({ ok: true });
}));

// ---------- Personalized preview & send ----------
app.post('/api/preview', asyncRoute(async (req, res) => {
  const db = store.load();
  const c = db.candidates.find((x) => x.id === req.body.candidateId);
  if (!c) throw new Error('Candidate not found.');
  const template = req.body.template || db.template;
  res.json(renderEmail(template, c, db.settings));
}));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.post('/api/send', asyncRoute(async (req, res) => {
  const db = store.load();
  const ids = Array.isArray(req.body.candidateIds) ? req.body.candidateIds : [];
  if (!ids.length) throw new Error('No candidates selected.');
  // Optional per-send override lets the compose modal customize one email
  // without changing the saved default template.
  const template = req.body.template || db.template;
  const results = [];
  for (const id of ids) {
    const c = db.candidates.find((x) => x.id === id);
    if (!c) { results.push({ id, ok: false, error: 'Not found' }); continue; }
    try {
      const msg = renderEmail(template, c, db.settings);
      const sent = await mailer.sendEmail(db.settings, { to: c.email, ...msg });
      c.status = c.status === 'new' ? 'emailed' : c.status;
      c.lastEmailedAt = new Date().toISOString();
      store.save();
      store.addEvent('email', `Emailed ${c.name || c.email} ("${msg.subject}") via ${sent.via}.`, c.id);
      results.push({ id, ok: true, email: c.email });
    } catch (err) {
      results.push({ id, ok: false, email: c.email, error: err.message });
    }
    // Gentle throttle keeps Gmail happy on batch sends.
    if (ids.length > 1) await sleep(1200);
  }
  res.json({ ok: true, results });
}));

// ---------- Google OAuth ----------
app.get('/auth/google', (req, res) => {
  const db = store.load();
  const st = google.status(db.settings);
  if (!st.configured) return res.redirect('/#settings?error=google-not-configured');
  res.redirect(google.authUrl(db.settings));
});

app.get('/auth/google/callback', asyncRoute(async (req, res) => {
  const db = store.load();
  if (req.query.error) return res.redirect('/#settings?error=' + encodeURIComponent(req.query.error));
  await google.exchangeCode(req.query.code, db.settings);
  store.addEvent('google', 'Connected Google account.');
  res.redirect('/#settings?connected=1');
}));

app.post('/auth/google/disconnect', asyncRoute(async (_req, res) => {
  google.clearTokens();
  store.addEvent('google', 'Disconnected Google account.');
  res.json({ ok: true });
}));

// ---------- Calendly ----------
app.post('/api/calendly/register-webhook', asyncRoute(async (req, res) => {
  const db = store.load();
  const token = String(req.body.token || '').trim();
  const publicUrl = String(req.body.publicUrl || process.env.BASE_URL || '').trim();
  if (!token) throw new Error('Paste your Calendly Personal Access Token first.');
  if (!publicUrl || publicUrl.includes('localhost')) {
    throw new Error('Calendly needs a public URL to reach this app. Deploy it (or tunnel with ngrok) and enter that URL.');
  }
  const result = await calendly.registerWebhook(token, publicUrl);
  if (result.signingKey) db.settings.calendlySigningKey = result.signingKey;
  if (!db.settings.calendlyUrl && result.schedulingUrl) db.settings.calendlyUrl = result.schedulingUrl;
  store.save();
  store.addEvent('calendly', `Registered Calendly webhook at ${result.url}.`);
  res.json({ ok: true, ...result, signingKey: undefined });
}));

app.post('/webhooks/calendly', asyncRoute(async (req, res) => {
  const db = store.load();
  const signingKey = db.settings.calendlySigningKey || process.env.CALENDLY_SIGNING_KEY || '';
  if (!calendly.verifySignature(signingKey, req.get('Calendly-Webhook-Signature'), req.rawBody)) {
    return res.status(401).json({ error: 'Invalid Calendly signature' });
  }
  const event = req.body.event;
  const p = req.body.payload || {};
  const inviteeEmail = String(p.email || '').toLowerCase();
  const inviteeName = p.name || inviteeEmail || 'Someone';
  const eventName = (p.scheduled_event && p.scheduled_event.name) || 'Interview';
  const startTime = p.scheduled_event && p.scheduled_event.start_time;
  const when = startTime
    ? new Date(startTime).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'time TBD';

  const c = db.candidates.find((x) => x.email.toLowerCase() === inviteeEmail);

  if (event === 'invitee.created') {
    if (c) {
      c.status = 'booked';
      c.bookedAt = startTime || new Date().toISOString();
      store.save();
    }
    store.addEvent('booked', `${inviteeName} booked "${eventName}" — ${when}.`, c ? c.id : null);
    try {
      await notify.pushToPhone(db.settings, {
        title: `📅 ${inviteeName} booked an interview`,
        message: `${eventName} — ${when}${c && c.role ? `\n${c.role}${c.company ? ' @ ' + c.company : ''}` : ''}`,
        tags: 'tada,calendar',
      });
    } catch (err) {
      store.addEvent('error', `Phone notification failed: ${err.message}`);
    }
  } else if (event === 'invitee.canceled') {
    if (c && c.status === 'booked') {
      c.status = 'emailed';
      c.bookedAt = null;
      store.save();
    }
    store.addEvent('canceled', `${inviteeName} canceled "${eventName}".`, c ? c.id : null);
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
  const db = store.load();
  const r = await notify.pushToPhone(db.settings, {
    title: 'Wholesale Payments Hiring CRM',
    message: 'Test notification — you are all set. Booking alerts will arrive here.',
    tags: 'white_check_mark',
  });
  if (!r.sent) throw new Error(r.reason);
  res.json({ ok: true });
}));

app.listen(PORT, () => {
  console.log(`Hiring CRM running → http://localhost:${PORT}`);
});
