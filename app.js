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
const apollo = require('./lib/apollo');
const attachments = require('./lib/attachments');
const address = require('./lib/email-address');
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

function maskedSettings(s, fromAddress) {
  return {
    ...s,
    // Show the pace the queue will really use (a value saved before the caps
    // existed, or typed past them, is displayed already clamped).
    ...queue.normalizePaceSettings({ dailyLimit: s.dailyLimit, perMinute: s.perMinute }, fromAddress),
    smtpPass: s.smtpPass ? '••••••••' : '',
    googleClientSecret: s.googleClientSecret ? '••••••••' : '',
    calendlySigningKey: s.calendlySigningKey ? '••••••••' : '',
    calendlyToken: s.calendlyToken ? '••••••••' : '',
    apolloApiKey: s.apolloApiKey ? '••••••••' : '',
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

// Who is due a follow-up: emailed, never answered, not followed up too
// recently or too often. The dashboard's "Follow up with N" uses this list.
function followUpSettings(settings) {
  // Blank means "use the default"; a deliberate 0 means no follow-ups at all.
  const num = (v, dflt) => { const s = String(v ?? '').trim(); const n = Number(s); return s === '' || !Number.isFinite(n) ? dflt : n; };
  const days = Math.min(30, Math.max(1, num(settings.followUpDays, 3) || 3));
  const max = Math.min(5, Math.max(0, num(settings.maxFollowUps, 2)));
  return { days, max };
}
function followUpDueIds(db) {
  const { days, max } = followUpSettings(db.settings);
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  return db.candidates
    .filter((c) => c.status === 'emailed' && c.lastEmailedAt && new Date(c.lastEmailedAt).getTime() <= cutoff && (c.followUpCount || 0) < max)
    .map((c) => c.id);
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
    events: db.events.filter((e) => store.FEED_TYPES.has(e.type)).sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 60),
    lastError: lastError ? lastError.message : '',
    template: db.template,
    followUp: { template: db.followUp, dueIds: followUpDueIds(db), ...followUpSettings(db.settings) },
    settings: maskedSettings(db.settings, sendingNow.from),
    google: await google.status(db.settings),
    sending: sendingNow,
    stats: stats(db),
    baseUrl: google.baseUrl(),
    storage: await storage.backend(),
    auth: { required: auth.required() },
    queue: queue.status(await queue.loadQ(), db.settings, sendingNow.from),
    maxImmediate: MAX_PER_REQUEST,
    interviews: db.interviews || [],
    apollo: { configured: Boolean(db.settings.apolloApiKey), maxPerPull: apollo.MAX_PER_PULL, batch: apollo.ENRICH_BATCH },
    calendly: {
      syncEnabled: Boolean(db.settings.calendlyToken),
      webhook: Boolean(db.settings.calendlySigningKey),
      lastSyncAt: db.calendlyLastSyncAt || null,
      error: db.calendlySyncError || '',
    },
  });
}));

// ---------- Settings & template ----------
// Numeric settings are stored within the range the app honours, and the
// caller is told what was adjusted, so a typed 100/min never silently becomes
// a different number on the dashboard.
const NUMERIC_SETTINGS = {
  ...Object.fromEntries(['dailyLimit', 'perMinute'].map((k) => [k, null])),   // ranges live in lib/queue.js
  followUpDays: [1, 30],
  maxFollowUps: [0, 5],
};
const SETTING_LABELS = { dailyLimit: 'Daily send limit', perMinute: 'Emails per minute', followUpDays: 'Follow up after (days)', maxFollowUps: 'Follow-ups per person' };
// Why a number was changed, in words that match the setting.
const SETTING_REASONS = {
  dailyLimit: 'that is the most Google allows this account in a day',
  perMinute: 'that is the most the Gmail API allows in a minute',
  followUpDays: 'follow-ups can wait between 1 and 30 days',
  maxFollowUps: 'between 0 and 5 follow-ups per person',
};

app.post('/api/settings', asyncRoute(async (req, res) => {
  const db = await store.load();
  const before = { ...db.settings };
  const sender = (await mailer.sendStatus(db.settings)).from;
  const allowed = ['calendlyUrl', 'fromName', 'gmailSignature', 'dailyLimit', 'perMinute', 'followUpDays', 'maxFollowUps', 'ntfyTopic', 'smtpUser', 'smtpPass',
    'googleClientId', 'googleClientSecret', 'calendlySigningKey', 'calendlyToken', 'apolloApiKey', 'lastSheetUrl', 'timeZone'];
  const adjusted = [];
  for (const k of allowed) {
    if (!(k in req.body) || req.body[k] === '••••••••') continue;
    const v = req.body[k];
    let val = typeof v === 'boolean' ? v : String(v ?? '').trim();
    if (k in NUMERIC_SETTINGS && val !== '') {
      const range = NUMERIC_SETTINGS[k];
      const stored = range
        ? (Number.isFinite(Number(val)) ? String(Math.min(range[1], Math.max(range[0], Math.round(Number(val))))) : '')
        : queue.normalizePaceSettings({ [k]: val }, sender)[k];
      if (stored !== val) adjusted.push({ key: k, label: SETTING_LABELS[k] || k, from: val, to: stored, reason: SETTING_REASONS[k] || '' });
      val = stored;
    }
    db.settings[k] = val;
  }
  await store.save(db);
  // A raised daily limit lifts the daily-limit pause at once instead of waiting
  // it out; new mail credentials lift the "not set up" pause.
  const kinds = [];
  if (db.settings.dailyLimit !== before.dailyLimit) kinds.push('daily');
  if (['smtpUser', 'smtpPass', 'googleClientId', 'googleClientSecret'].some((k) => db.settings[k] !== before[k])) kinds.push('not-ready');
  if (kinds.length) await queue.updateQ((f) => queue.clearPause(f, kinds) || false);
  res.json({ ok: true, settings: maskedSettings(db.settings, sender), adjusted });
}));

app.post('/api/template', asyncRoute(async (req, res) => {
  const db = await store.load();
  db.template = {
    ...db.template,   // attachments are managed by their own routes
    subject: String(req.body.subject ?? db.template.subject),
    body: String(req.body.body ?? db.template.body),
  };
  await store.save(db);
  res.json({ ok: true, template: db.template });
}));

app.post('/api/template/reset', asyncRoute(async (_req, res) => {
  const db = await store.load();
  db.template = { ...structuredClone(store.DEFAULT_TEMPLATE), attachments: db.template.attachments };
  await store.save(db);
  res.json({ ok: true, template: db.template });
}));

app.post('/api/followup', asyncRoute(async (req, res) => {
  const fresh = await store.update((d) => {
    d.followUp = {
      subject: String(req.body.subject ?? d.followUp.subject),
      body: String(req.body.body ?? d.followUp.body),
    };
  });
  res.json({ ok: true, followUp: fresh.followUp });
}));
app.post('/api/followup/reset', asyncRoute(async (_req, res) => {
  const fresh = await store.update((d) => { d.followUp = structuredClone(store.DEFAULT_FOLLOW_UP); });
  res.json({ ok: true, followUp: fresh.followUp });
}));

// ---------- Attachments (sent with every email) ----------
const publicAttachment = ({ id, name, type, size, builtin }) => ({ id, name, type, size, builtin: Boolean(builtin) });

app.post('/api/template/attachments', asyncRoute(async (req, res) => {
  const db = await store.load();
  const meta = await attachments.add(db, req.body || {});
  let fresh;
  try {
    // The limits are enforced here too: between the check above and this
    // commit another upload may have landed, and the commit is what counts.
    fresh = await store.update((d) => {
      const current = attachments.list(d);
      attachments.checkRoom(current, meta.size);
      d.template.attachments = [...current, meta];
    });
  } catch (err) {
    await attachments.discard(meta);   // the bytes were stored but never attached
    throw err;
  }
  res.json({ ok: true, attachment: publicAttachment(meta), attachments: attachments.list(fresh).map(publicAttachment) });
}));

app.delete('/api/template/attachments/:id', asyncRoute(async (req, res) => {
  const db = await store.load();
  const meta = attachments.list(db).find((a) => a.id === req.params.id);
  if (!meta) throw new Error('Attachment not found.');
  const fresh = await store.update((d) => { d.template.attachments = attachments.list(d).filter((a) => a.id !== meta.id); });
  // Already unreferenced: a failure to delete the bytes must not fail the
  // request, or a retry would report "not found" and leave them anyway.
  await attachments.discard(meta);
  res.json({ ok: true, attachments: attachments.list(fresh).map(publicAttachment) });
}));

// Put the flyer that ships with the app back after it was removed.
app.post('/api/template/attachments/restore-builtin', asyncRoute(async (_req, res) => {
  const meta = attachments.builtinMeta();
  if (!meta) throw new Error('The built-in flyer is not available in this build.');
  const fresh = await store.update((d) => {
    const current = attachments.list(d).filter((a) => a.id !== meta.id);
    attachments.checkRoom(current, meta.size);
    d.template.attachments = [meta, ...current];
  });
  res.json({ ok: true, attachments: attachments.list(fresh).map(publicAttachment) });
}));

// Thumbnail for the template page (as a data URL, so no binary response handling).
app.get('/api/template/attachments/:id/preview', asyncRoute(async (req, res) => {
  const db = await store.load();
  const meta = attachments.list(db).find((a) => a.id === req.params.id);
  if (!meta) throw new Error('Attachment not found.');
  const bytes = await attachments.bytesFor(meta);
  if (!bytes) throw new Error('Attachment data is missing — remove it and add the file again.');
  res.set('Cache-Control', 'private, max-age=3600');
  res.json({ ok: true, dataUrl: `data:${meta.type};base64,${bytes.toString('base64')}` });
}));

// ---------- Import (Google Sheet / CSV / spreadsheet / paste) ----------
const MAX_IMPORT_ROWS = 50000;
const IMPORT_FIELDS = ['name', 'firstName', 'lastName', 'role', 'company', 'phone', 'location', 'notes', 'pastRoles'];

// Rows → { headers, rows, lines, mapping, confidence, headerless, skipped }.
// The header row is searched for (title lines above it are skipped); when
// there is none, headers are synthesised and the columns are recognised from
// their contents. `noHeader` is for continuation pieces of a big file.
function toPreview(allRows, { noHeader = false, lines: givenLines = null } = {}) {
  const src = Array.isArray(allRows) ? allRows : [];
  const srcLines = Array.isArray(givenLines) && givenLines.length === src.length ? givenLines : (src.lines || src.map((_, i) => i + 1));
  const rows = [];
  const lines = [];
  src.forEach((r, i) => {
    if (!Array.isArray(r)) return;
    const cells = r.slice(0, csv.MAX_COLUMNS).map(csv.cleanCell);
    if (cells.some(Boolean)) { rows.push(cells); lines.push(srcLines[i]); }
  });
  if (!rows.length) throw new Error('No rows found in that file — it appears to be empty.');
  if (rows.length > MAX_IMPORT_ROWS + 1) throw new Error(`That is more than ${MAX_IMPORT_ROWS.toLocaleString()} rows — split the file and import it in parts.`);
  const found = noHeader ? { index: -1, headerless: true } : csv.findHeader(rows);
  const headerRow = found.index >= 0 ? rows[found.index] : null;
  const width = headerRow ? Math.max(headerRow.length, 1) : rows.reduce((w, r) => Math.max(w, r.length), 0);
  const headers = headerRow
    ? headerRow.map((h, i) => h || `Column ${i + 1}`)
    : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  const dataStart = found.index >= 0 ? found.index + 1 : 0;
  const data = rows.slice(dataStart).map((r) => { while (r.length < width) r.push(''); return r; });
  const dataLines = lines.slice(dataStart);
  const { mapping, confidence } = csv.guessMapping(headerRow ? headerRow : headers.map(() => ''), data);
  // "skipped" counts physical lines above the header (blank lines included).
  const skipped = found.index > 0 ? Math.max(found.index, (lines[found.index] || found.index + 1) - 1) : 0;
  return { headers, rows: data, lines: dataLines, mapping, confidence, headerless: found.headerless, skipped };
}

function rowsFromBody(body) {
  if (Array.isArray(body.rows)) return body.rows;
  if (typeof body.text === 'string') return csv.parseCsv(body.text, { delimiter: body.delimiter || undefined });
  throw new Error('Nothing to import — send the file text or its rows.');
}

app.post('/api/import/sheet', asyncRoute(async (req, res) => {
  const db = await store.load();
  const { rows, via } = await google.fetchSheetRows(req.body.url, db.settings);
  await store.update((d) => { d.settings.lastSheetUrl = String(req.body.url || '').trim(); });
  res.json({ ...toPreview(rows), via });
}));
app.post('/api/import/csv', asyncRoute(async (req, res) => {
  const body = req.body || {};
  res.json({ ...toPreview(rowsFromBody(body), { noHeader: Boolean(body.noHeader), lines: body.lines }), via: body.via || 'csv' });
}));

// The one place that decides what each row means. Used by the dry run the
// dashboard shows before importing and by the import itself, so the numbers
// the user sees are the numbers they get.
//   new        – a usable address not yet in the list
//   existing   – already in the list (optionally enriched with blank fields)
//   duplicate  – the same address earlier in this same file
//   invalid    – no usable email address anywhere in the row
const emailKey = (e) => (address.normalize(e) || String(e || '').trim().toLowerCase());
function analyzeImport(candidates, rows, mapping, { lines = null, headerless = false } = {}) {
  const m = mapping || {};
  const col = (row, key) => (m[key] != null && m[key] >= 0 ? csv.cleanCell(row[m[key]]) : '');
  // Every address a person is known by (the one on file plus any they booked with).
  const byEmail = new Map();
  for (const c of candidates) {
    for (const e of [c.email, ...(c.altEmails || [])]) { const k = emailKey(e); if (k && !byEmail.has(k)) byEmail.set(k, c); }
  }
  // A shifted row may carry its address in another column — but only when the
  // file has just one column of addresses, so a "Referred by" column can never
  // be mistaken for the candidate's own.
  const emailColumns = rows.length
    ? rows[0].map((_, i) => i).filter((i) => i !== m.email && csv.scoreColumn(rows.map((r) => r[i])).email >= 0.3)
    : [];
  const allowShift = emailColumns.length === 0;
  const rowNumber = (idx) => (lines && lines[idx] ? lines[idx] : idx + (headerless ? 1 : 2));
  const seen = new Set();
  const out = [];
  rows.forEach((row, idx) => {
    if (!Array.isArray(row)) return;
    let email = address.normalize(col(row, 'email'));
    let shifted = false;
    if (!email && allowShift) {
      const found = row.map((v) => address.normalize(v)).filter(Boolean);
      if (found.length === 1) { email = found[0]; shifted = true; }
    }
    let firstName = col(row, 'firstName');
    let lastName = col(row, 'lastName');
    let name = col(row, 'name');
    // "Doe, Jane" in a name column: keep the person, not the comma.
    const lf = name && !firstName && !lastName ? csv.splitLastFirst(name) : null;
    if (lf) { firstName = lf.firstName; lastName = lf.lastName; name = `${lf.firstName} ${lf.lastName}`; }
    const fields = {
      name: name || [firstName, lastName].filter(Boolean).join(' '),
      firstName, lastName,
      role: col(row, 'role'), company: col(row, 'company'), phone: col(row, 'phone'),
      location: col(row, 'location'), notes: col(row, 'notes'), pastRoles: col(row, 'pastRoles'),
    };
    const rowNo = rowNumber(idx);
    if (!email) { out.push({ idx, row: rowNo, kind: 'invalid', cell: col(row, 'email') || row.find((v) => String(v || '').includes('@')) || '', fields }); return; }
    const key = emailKey(email);
    if (seen.has(key)) { out.push({ idx, row: rowNo, kind: 'duplicate', email, fields }); return; }
    seen.add(key);
    const existing = byEmail.get(key);
    if (existing) {
      const fill = {};
      for (const k of IMPORT_FIELDS) if (fields[k] && !String(existing[k] || '').trim()) fill[k] = fields[k];
      out.push({ idx, row: rowNo, kind: 'existing', email, fields, existing, fill, shifted });
      return;
    }
    out.push({ idx, row: rowNo, kind: 'new', email, fields, shifted });
  });
  return out;
}

function summarize(analysis) {
  const count = (k) => analysis.filter((a) => a.kind === k).length;
  return {
    total: analysis.length,
    newCount: count('new'),
    existing: count('existing'),
    updatable: analysis.filter((a) => a.kind === 'existing' && Object.keys(a.fill).length).length,
    duplicate: count('duplicate'),
    invalid: count('invalid'),
    shifted: analysis.filter((a) => a.shifted).length,
    invalidSamples: analysis.filter((a) => a.kind === 'invalid').slice(0, 10).map((a) => ({ row: a.row, cell: String(a.cell || '').slice(0, 80), name: a.fields.name })),
    existingSamples: analysis.filter((a) => a.kind === 'existing').slice(0, 5).map((a) => ({ email: a.email, name: a.existing.name || a.fields.name })),
  };
}

// Dry run: exactly what the import would do, against the list as it is now.
app.post('/api/import/preview', asyncRoute(async (req, res) => {
  const db = await store.load();
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (rows.length > MAX_IMPORT_ROWS) throw new Error(`Check at most ${MAX_IMPORT_ROWS.toLocaleString()} rows at a time.`);
  res.json({ ok: true, ...summarize(analyzeImport(db.candidates, rows, req.body.mapping, { lines: req.body.lines, headerless: Boolean(req.body.headerless) })) });
}));

app.post('/api/import/commit', asyncRoute(async (req, res) => {
  const { rows, mapping, source } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) throw new Error('Nothing to import.');
  if (rows.length > MAX_IMPORT_ROWS) throw new Error(`Import at most ${MAX_IMPORT_ROWS.toLocaleString()} rows at a time.`);
  const updateExisting = req.body.updateExisting !== false;
  let result = null;
  // Decided against the latest version of the list, retried on a concurrent
  // change, so a send running in the background can never make rows vanish.
  await store.update((db) => {
    const analysis = analyzeImport(db.candidates, rows, mapping, { lines: req.body.lines, headerless: Boolean(req.body.headerless) });
    let added = 0, updated = 0;
    const now = new Date().toISOString();
    for (const a of analysis) {
      if (a.kind === 'new') {
        db.candidates.push({
          id: store.rid(),
          ...a.fields,
          email: a.email,
          status: 'new',
          source: source || 'import',
          addedAt: now,
          lastEmailedAt: null,
          bookedAt: null,
        });
        added++;
      } else if (a.kind === 'existing' && updateExisting && Object.keys(a.fill).length) {
        Object.assign(a.existing, a.fill);
        updated++;
      }
    }
    result = { ok: true, added, updated, ...summarize(analysis) };
  });
  res.json(result);
}));

// ---------- Apollo (adds candidates without a spreadsheet) ----------
// Searching is free and only reports how many people match; revealing an
// email costs one Apollo credit, so the dashboard asks for that separately
// and in small slices, and every answer says what was actually spent.
const APOLLO_IDS_PER_REQUEST = 10;

app.post('/api/apollo/search', asyncRoute(async (req, res) => {
  const db = await store.load();
  const found = await apollo.search(db.settings, req.body || {}, { page: req.body && req.body.page });
  res.json({ ok: true, ...found, maxPerPull: apollo.MAX_PER_PULL, perRequest: APOLLO_IDS_PER_REQUEST });
}));

app.post('/api/apollo/import', asyncRoute(async (req, res) => {
  const db = await store.load();
  const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).slice(0, APOLLO_IDS_PER_REQUEST);
  if (!ids.length) throw new Error('No Apollo records were selected.');
  const sending = await mailer.sendStatus(db.settings);
  const ownDomain = String(sending.from || db.settings.smtpUser || '').split('@')[1] || '';
  const { matches, credits } = await apollo.enrich(db.settings, ids);
  const { rows, skipped } = apollo.toRows(matches, { ownDomain, ownCompany: String((req.body && req.body.ownCompany) || '') });
  const fields = ['email', 'name', 'firstName', 'lastName', 'role', 'company', 'phone', 'location', 'pastRoles', 'notes'];
  const mapping = Object.fromEntries(fields.map((f, i) => [f, i]));
  const table = rows.map((r) => fields.map((f) => r[f] || ''));
  let result = null;
  await store.update((fresh) => {
    const analysis = analyzeImport(fresh.candidates, table, mapping, { headerless: true });
    let added = 0;
    let updated = 0;
    const now = new Date().toISOString();
    for (const a of analysis) {
      if (a.kind === 'new') {
        fresh.candidates.push({
          id: store.rid(),
          ...a.fields,
          email: a.email,
          status: 'new',
          source: 'apollo',
          addedAt: now,
          lastEmailedAt: null,
          bookedAt: null,
        });
        added += 1;
      } else if (a.kind === 'existing' && Object.keys(a.fill).length) {
        Object.assign(a.existing, a.fill);
        updated += 1;
      }
    }
    result = {
      ok: true,
      added,
      updated,
      credits,
      alreadyKnown: analysis.filter((a) => a.kind === 'existing').length,
      skippedOwnCompany: skipped.ownCompany,
      skippedNoEmail: skipped.noEmail,
      sample: analysis.filter((a) => a.kind === 'new').slice(0, 3).map((a) => ({ name: a.fields.name, role: a.fields.role, company: a.fields.company })),
    };
  });
  res.json(result);
}));

// ---------- Candidates ----------
app.post('/api/candidates', asyncRoute(async (req, res) => {
  const db = await store.load();
  const b = req.body;
  const email = address.normalize(b.email);
  if (!email) throw new Error('A valid email address is required.');
  if (db.candidates.some((c) => c.email.toLowerCase() === email.toLowerCase())) {
    throw new Error('A candidate with that email already exists.');
  }
  const c = {
    id: store.rid(),
    name: String(b.name || '').trim(),
    firstName: String(b.firstName || '').trim(),
    lastName: String(b.lastName || '').trim(),
    email,
    role: String(b.role || '').trim(),
    company: String(b.company || '').trim(),
    phone: String(b.phone || '').trim(),
    location: String(b.location || '').trim(),
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
  const fields = ['name', 'firstName', 'lastName', 'role', 'company', 'phone', 'location', 'notes', 'status'];
  for (const f of fields) if (f in req.body) c[f] = String(req.body[f] ?? '').trim();
  if ('email' in req.body) {
    const email = address.normalize(req.body.email);
    if (!email) throw new Error('That is not a valid email address.');
    c.email = email;
  }
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
  const followUp = Boolean(req.body.followUp);
  const template = req.body.template || (followUp ? db.followUp : db.template);
  const signature = await google.getSignature(db.settings);
  // A follow-up replies to the subject that person actually received; for the
  // preview of someone not yet emailed, show what the outreach subject would be.
  const cand = followUp && !c.lastSubject ? { ...c, lastSubject: renderEmail(db.template, c, db.settings).subject } : c;
  res.json({ ...renderEmail(template, cand, db.settings, { signature }), attachments: followUp ? [] : attachments.list(db).map(publicAttachment), followUp });
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
  const followUp = Boolean(req.body.followUp);
  const template = req.body.template || (followUp ? db.followUp : db.template);
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
  // Respect an active pause, the daily cap and the shared per-minute pace before touching Gmail.
  if (q.pausedUntil && new Date(q.pausedUntil).getTime() > Date.now()) {
    // A daily pause lasts hours, so the browser must hand the emails to the
    // queue at once instead of waiting it out as if it were a throttle.
    const daily = q.pauseKind === 'daily' || q.pauseKind === 'gmail-daily';
    deferAll(daily ? 'daily' : 'rate', new Date(q.pausedUntil), q.note || (daily ? 'The daily sending limit is reached.' : 'Gmail asked us to slow down.'));
    return res.json({ ok: true, results, maxPerRequest: MAX_PER_REQUEST });
  }
  if (queue.sentToday(q) >= dailyLimit) {
    deferAll('daily', queue.dailyResumeAt(q, dailyLimit) || new Date(Date.now() + 3600 * 1000), `Daily limit of ${dailyLimit} reached — it frees up as the 24-hour window moves on.`);
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
  const files = await attachments.loadAll(db);
  const recent = queue.recentlySentIds(q);
  const patches = {};
  for (const id of ids) {
    const c = db.candidates.find((x) => x.id === id);
    if (!c) { results.push({ id, ok: false, error: 'Not found' }); continue; }
    if (recent.has(id)) { results.push({ id, ok: true, email: c.email, skipped: 'already emailed in the last 24 hours' }); continue; }
    if (followUp && c.status !== 'emailed') { results.push({ id, ok: true, email: c.email, skipped: `no follow-up: ${c.status === 'new' ? 'not emailed yet' : c.status}` }); continue; }
    if (q.items.some((i) => i.id === id)) { results.push({ id, ok: false, queued: true, email: c.email, error: 'Already in the sending queue.' }); continue; }
    const left = 6500 - (Date.now() - started);
    if (left < 2500) { deferAll('budget', new Date(), 'Continuing in the next batch.'); break; }
    if (paceLeft <= 0) { deferAll('rate', new Date(Date.now() + 20 * 1000), `Pacing to ${perMinute} emails per minute.`); break; }
    const attemptAt = new Date().toISOString();
    try {
      const trackingUrl = `${google.baseUrl()}/webhooks/open/${tracking.token(db.settings, c.id)}.gif`;
      const msg = renderEmail(template, c, db.settings, { signature, trackingUrl });
      const thread = followUp && c.messageId ? { threadId: c.gmailThreadId || undefined, inReplyTo: c.messageId, references: c.messageId } : {};
      const sent = await queue.sendWithDeadline(db.settings, { to: c.email, ...msg, ...thread, attachments: followUp ? [] : files }, Math.min(queue.SEND_TIMEOUT_MS, left - 300), { via: st.via });
      await queue.updateQ((f) => queue.recordSent(f, c.id, c.email));
      paceLeft -= 1;
      patches[c.id] = { lastEmailedAt: new Date().toISOString(), gmailThreadId: sent.threadId || '', messageId: sent.messageId || '', lastSubject: msg.subject, followUp };
      results.push({ id, ok: true, email: c.email });
    } catch (err) {
      const kind = queue.classifySendError(err);
      if (kind === 'rate' || kind === 'daily') {
        const hinted = queue.retryAfterFrom(err.message);
        const retryAt = new Date(Math.max(hinted ? hinted.getTime() : 0, Date.now() + (kind === 'daily' ? 3600 : 60) * 1000));
        const note = kind === 'daily'
          ? 'Gmail itself reports the account has reached its daily sending limit — sending resumes automatically once Google allows it again.'
          : 'Gmail asked us to slow down — sending resumes automatically in a few minutes.';
        await queue.updateQ((f) => { f.pausedUntil = retryAt.toISOString(); f.pauseKind = kind === 'daily' ? 'gmail-daily' : 'rate'; f.note = note; });
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
        if (fc) queue.applySentPatch(fc, p);
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
  const followUp = Boolean(req.body.followUp);
  const template = req.body.template || (followUp ? db.followUp : null);
  const q = await queue.updateQ((f) => { added = queue.enqueue(f, db, ids, template, { followUp }); });
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
    await store.addEvent('replied', `${c.name || c.email} replied${preview ? `: “${preview}${preview.length === 140 ? '…' : ''}”` : '.'}`, c.id, reply.date || null);
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
  try { await queue.updateQ((f) => queue.clearPause(f, 'not-ready') || false); } catch {}
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
    await store.addEvent('booked', `${inviteeName} booked "${eventName}" — ${when}.`, c ? c.id : null, p.created_at || null);
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
            if (isNew) announce.push({ c, ev, at: inv.createdAt || null });
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
      a.c.id,
      a.at || null
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
