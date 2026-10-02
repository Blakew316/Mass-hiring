// The Express app. Run locally via server.js, or on Netlify wrapped as a
// serverless function (netlify/functions/api.js).
const path = require('path');
// Only when there is a file to read. dotenv looks for .env in the working
// directory and quietly does nothing when it is absent -- which is always, on
// Netlify -- so this is the same behaviour without 16 ms of every cold start
// spent loading a parser for a file that is not there.
if (require('fs').existsSync(path.join(process.cwd(), '.env'))) require('dotenv').config();
const express = require('express');

const store = require('./lib/store');
const storage = require('./lib/storage');
const auth = require('./lib/auth');
const teams = require('./lib/teams');
const tenant = require('./lib/tenant');
const csv = require('./lib/csv');
const google = require('./lib/google');
const mailer = require('./lib/mailer');
const notify = require('./lib/notify');
const replies = require('./lib/replies');
const calendly = require('./lib/calendly');
const tracking = require('./lib/tracking');
const queue = require('./lib/queue');
const apollo = require('./lib/apollo');
const attachments = require('./lib/attachments');
const address = require('./lib/email-address');
const textQueue = require('./lib/text-queue');
const phone = require('./lib/phone');
const priority = require('./lib/priority');
const backups = require('./lib/backups');
const presets = require('./lib/presets');
const salesiq = require('./lib/salesiq');
const onboarding = require('./lib/onboarding');
const onboardingRoutes = require('./lib/onboarding-routes');
const crypto = require('crypto');
const { renderEmail, renderText, escapeHtml } = require('./lib/template');

const app = express();
// Exact-case routes only, so /API/... cannot reach a handler by a path the
// auth guard would classify differently.
app.set('case sensitive routing', true);

// Keep the raw body around so Calendly webhook signatures can be verified.
app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(auth.middleware);

const asyncRoute = (fn) => (req, res) => fn(req, res).catch((err) => {
  // A conflict (409) or a storage failure is not the caller's mistake, and the
  // page treats it differently from a bad request.
  // A refusal to drop candidates is a fault that no retry will fix.
  const status = err.status === 409 ? 409 : err.storage ? 503 : (err.guard || err.status === 500) ? 500 : 400;
  res.status(status).json({ error: err.message || String(err), retry: status === 409 || status === 503 });
});

// ---------- Teams and sign-in ----------
// Sign-in is choosing a team and entering its PIN. APP_PASSWORD is the admin
// password: it is what lets you make a team or delete one, and — for Team
// Maverick, which predates teams and has no PIN of its own — it is still the
// way in. See lib/auth.js.
// What a signed-in dashboard may know about its own team.
const teamPublic = (t) => (t ? { id: t.id, name: t.name, usesAppPassword: teams.usesAppPassword(t) } : null);
// What anyone at all may know: a name to pick from the sign-in screen, and
// nothing else. Names are not secrets; which team signs in with the admin
// password — the one secret that also creates and deletes teams — is.
const teamName = (t) => (t ? { id: t.id, name: t.name } : null);

app.get('/api/auth/status', asyncRoute(async (req, res) => {
  // Nothing is created or read until a password exists: on a public deploy
  // without one the only correct answer is "finish setting this up".
  if (auth.setupRequired()) {
    return res.json({ required: false, setupRequired: true, authed: false, team: null, teams: [] });
  }
  const team = await auth.sessionTeam(req).catch(() => null);
  res.json({
    required: auth.required(),
    setupRequired: false,
    authed: Boolean(team),
    team: teamName(team),
    teams: await teams.publicList(),
    numericPins: teams.allPinsNumeric(await teams.all()),
  });
}));

// The sign-in screen needs the names to choose between. Names are not secrets
// — the PIN is — and a list you cannot see is a list you cannot sign in from.
app.get('/api/teams', asyncRoute(async (_req, res) => {
  if (auth.setupRequired()) return res.json({ teams: [], numericPins: false });
  res.json({ teams: await teams.publicList(), numericPins: teams.allPinsNumeric(await teams.all()) });
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  if (auth.setupRequired()) {
    return res.status(403).json({ error: 'Set APP_PASSWORD in Netlify first.', setupRequired: true });
  }
  const list = await teams.all();
  if (!auth.required()) {
    // No password means no way to tell two teams apart, so there is nothing
    // here to sign in to unless there is exactly one of them.
    if (list.length !== 1) {
      return res.status(403).json({ error: 'Set APP_PASSWORD before signing in — with more than one team and no password there is no way to tell who you are.', setupRequired: true });
    }
    return res.json({ ok: true, team: teamPublic(list[0]) });
  }
  let teamId = String(req.body.team || '').trim();
  // An app shell installed before teams existed posts a bare password and no
  // team. While there is only one team that is not ambiguous, so let it in
  // rather than make someone reinstall the app to sign in.
  if (!teamId && list.length === 1) teamId = list[0].id;
  const pin = req.body.pin != null ? req.body.pin : req.body.password;
  const locked = await auth.loginLockedFor(req, teamId);
  if (locked) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(locked / 60)} min.` });
  }
  const team = list.find((t) => t.id === teamId) || null;
  if (!team || !teams.verifyPin(team, pin)) {
    await auth.recordLoginFailure(req, teamId);
    await auth.failDelay(req, teamId);
    return res.status(401).json({ error: team ? 'That PIN is not right.' : 'Choose your team.' });
  }
  await auth.clearLoginFailures(req, teamId);
  auth.setSessionCookie(req, res, team);
  res.json({ ok: true, team: teamPublic(team) });
}));

// Signs this browser out. Other devices on the same team keep working — on a
// shared PIN, one person leaving must not throw the whole team out. To do
// that on purpose there is "Sign out everywhere" below.
app.post('/api/logout', asyncRoute(async (req, res) => {
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
}));

app.post('/api/teams/sign-out-all', asyncRoute(async (req, res) => {
  await auth.revokeTeamSessions(req, res, req.team.id);
  res.json({ ok: true });
}));

// ---------- making and unmaking teams ----------
// Creating a team is reachable without being signed in — you have to be able
// to make the first one from the sign-in screen — so it is the admin password
// that guards it, throttled like any other secret typed into a public page.
async function requireAdmin(req, res, given) {
  if (auth.setupRequired()) {
    res.status(403).json({ error: 'Set APP_PASSWORD in Netlify first.', setupRequired: true });
    return false;
  }
  if (!auth.required()) {
    res.status(403).json({ error: 'Set an APP_PASSWORD before making teams — without one there is nothing to stop anyone making them.' });
    return false;
  }
  const locked = await auth.loginLockedFor(req, auth.ADMIN_BUCKET);
  if (locked) {
    res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(locked / 60)} min.` });
    return false;
  }
  if (!auth.checkAdminPassword(given)) {
    await auth.recordLoginFailure(req, auth.ADMIN_BUCKET);
    await auth.failDelay(req, auth.ADMIN_BUCKET);
    res.status(401).json({ error: 'That admin password is not right.' });
    return false;
  }
  await auth.clearLoginFailures(req, auth.ADMIN_BUCKET);
  return true;
}

app.post('/api/teams/create', asyncRoute(async (req, res) => {
  if (!await requireAdmin(req, res, req.body.adminPassword)) return;
  const signedInAs = await auth.sessionTeam(req).catch(() => null);
  const team = await teams.create(
    { name: req.body.name, pin: req.body.pin },
    () => store.seedTeam(),
  );
  // Made from the sign-in screen, this is how you get in. Made from Settings
  // while already in a team, it must not tip you out of the one you are using.
  if (!signedInAs) auth.setSessionCookie(req, res, team);
  res.json({ ok: true, team: teamPublic(team), signedIn: !signedInAs });
}));

app.post('/api/teams/rename', asyncRoute(async (req, res) => {
  const name = teams.cleanName(req.body.name);
  if (!name) throw new Error('Give the team a name.');
  const team = await teams.edit(req.team.id, (t, reg) => {
    if (reg.teams.some((o) => o.id !== t.id && o.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`There is already a team called “${name}”.`);
    }
    if (t.name === name) return false;
    t.name = name;
  });
  res.json({ ok: true, team: teamPublic(team) });
}));

// Changing the PIN needs the current one — or the admin password, which is
// the way back in for a team that has forgotten theirs.
app.post('/api/teams/pin', asyncRoute(async (req, res) => {
  const next = teams.checkPin(req.body.pin);
  const current = req.body.current;
  const ok = teams.verifyPin(req.team, current) || auth.checkAdminPassword(current);
  if (!ok) {
    await auth.recordLoginFailure(req, req.team.id);
    await auth.failDelay(req, req.team.id);
    return res.status(401).json({ error: 'That is not the current PIN (the admin password works too).' });
  }
  await auth.clearLoginFailures(req, req.team.id);
  const team = await teams.edit(req.team.id, (t) => { t.pin = teams.pinRecord(next); });
  // The PIN changed, so every cookie signed under the old arrangement goes
  // with it — including, deliberately, the one in this browser.
  await auth.revokeTeamSessions(req, res, team.id);
  res.json({ ok: true, team: teamPublic(team) });
}));

// Deleting a team erases everything it owns and cannot be undone, so it wants
// the admin password AND the team's name typed out.
app.post('/api/teams/delete', asyncRoute(async (req, res) => {
  if (!await requireAdmin(req, res, req.body.adminPassword)) return;
  const id = String(req.body.id || req.team.id);
  const target = await teams.byId(id);
  if (!target) throw new Error('That team no longer exists.');
  if (teams.cleanName(req.body.confirm).toLowerCase() !== target.name.toLowerCase()) {
    throw new Error(`Type the team's name (${target.name}) to confirm.`);
  }
  const remaining = (await teams.all()).length;
  if (remaining <= 1) throw new Error('This is the only team — there would be nothing left to sign in to.');
  await teams.remove(id);
  if (id === req.team.id) auth.clearSessionCookie(req, res);
  res.json({ ok: true, signedOut: id === req.team.id });
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
    calendlySigningKeys: undefined,
    calendlyToken: s.calendlyToken ? '••••••••' : '',
    apolloApiKey: s.apolloApiKey ? '••••••••' : '',
    relayToken: s.relayToken ? '••••••••' : '',
    // The HMAC key the open-tracking pixel is signed with. Not masked but
    // removed: nothing in the browser reads it, and it is not writable through
    // /api/settings either. Anyone holding it can forge an "opened" event for
    // any candidate, which is the one thing this key protects against.
    trackingSecret: undefined,
    // The Sales IQ connection token. Removed rather than masked: the page gets
    // it, inside the connection code, only from /api/salesiq-connection when
    // Settings asks for it, never on the payload polled every 30 seconds. Nor
    // is it writable through /api/settings — it is generated, never typed.
    salesiqToken: undefined,
    // Texting pace, shown already clamped for the same reason as the email pace.
    ...textQueue.normalizeTextSettings({
      textDailyLimit: s.textDailyLimit, textMinGap: s.textMinGap, textMaxGap: s.textMaxGap,
      textStartHour: s.textStartHour, textEndHour: s.textEndHour,
    }),
  };
}

// The text queue's running order, and the reason each person is where they are.
function textPriority(db, q) {
  const ranked = priority.rank(db.candidates, {
    maxFollowUps: followUpSettings(db.settings).max,
    optOut: (q && q.optOut) || [],
  });
  const order = {};
  // rank and reason only: the score and the fit bucket are what the ranking was
  // computed from, and nothing on the page ever reads them back.
  ranked.forEach((r, i) => { order[r.id] = { rank: i + 1, reason: r.reason }; });
  const blocked = {};
  for (const c of db.candidates) {
    if (order[c.id]) continue;
    const why = priority.blockedReason(c, { optOut: new Set(((q && q.optOut) || [])) });
    if (why && why !== 'no phone number') blocked[c.id] = why;
  }
  return { order, blocked, textable: ranked.length };
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

// The feed the dashboard tile draws from. It is one chronological list, but
// the two channels run at wildly different volumes: a few thousand sent emails
// produce opens all day, so a text reply from this morning falls off the end
// within minutes and the tile looks as though texting never happens. The
// window is therefore the most recent of everything PLUS the most recent
// texting entries on top, which is what keeps the tile's Texting filter
// showing something whenever there is anything to show.
const FEED_WINDOW = 60;
const TEXT_WINDOW = 25;
// Someone doing something: writing back, booking, canceling. What Candidate
// updates is for, as opposed to opens and read receipts.
const HUMAN_TYPES = new Set(['replied', 'text-replied', 'text-optout', 'booked', 'canceled']);
function feedWindow(events) {
  const feed = (events || [])
    .filter((e) => store.FEED_TYPES.has(e.type))
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const keep = new Map(feed.slice(0, FEED_WINDOW).map((e) => [e.id, e]));
  for (const e of feed.filter((e) => store.EVENT_CHANNEL[e.type] === 'text').slice(0, TEXT_WINDOW)) keep.set(e.id, e);
  // A finished questionnaire or signed paperwork is never pushed out of view
  // by a morning of opens — and neither is a person writing back or booking.
  for (const e of feed.filter((e) => e.type === 'assessed' || e.type === 'signed').slice(0, 15)) keep.set(e.id, e);
  for (const e of feed.filter((e) => HUMAN_TYPES.has(e.type)).slice(0, 30)) keep.set(e.id, e);
  return [...keep.values()].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

// ---------- App state ----------
// What a candidate looks like to the browser. An allowlist rather than a
// spread, because the browser polls this for every candidate every 30 seconds:
// a field added to the store for the server's own use would otherwise start
// riding along on a payload that is already the largest thing the app sends.
// Anything not here is deliberately server-side only — the record the browser
// never reads (messageId, threadId, sheetRow, city, altEmails, lastFollowUpAt,
// calendlyEventUri). If the UI needs one of them, add it here on purpose.
const CANDIDATE_FIELDS = [
  'id', 'name', 'firstName', 'lastName', 'email', 'phone',
  'role', 'pastRoles', 'company', 'location', 'notes', 'source',
  'status', 'addedAt',
  'lastEmailedAt', 'openedAt', 'lastReplyAt', 'lastSubject', 'gmailThreadId',
  'emailUnread', 'followUpCount',
  'lastTextedAt', 'textStatus', 'textUnread',
  'textDeliveredAt', 'textReadAt', 'textRepliedAt',
  'bookedAt', 'bookedEvent', 'bookedJoinUrl',
];

function publicCandidate(c) {
  const out = {};
  for (const k of CANDIDATE_FIELDS) if (c[k] !== undefined) out[k] = c[k];
  const thread = c.textThread;
  // The last thing said, for the list's preview and its order: a tapback on
  // our message ("Liked …") is not what the conversation was last about.
  let last = null;
  for (let i = (thread || []).length - 1; i >= 0; i--) if (!(thread[i].dir === 'in' && thread[i].kind)) { last = thread[i]; break; }
  if (!last && thread && thread.length) last = thread[thread.length - 1];
  const real = (c.replies || []).filter((r) => !r.kind);
  const lastReply = real[real.length - 1] || null;
  // Industry is derived, never stored — it is a view of role/company/history
  // and must not drift out of date behind a saved copy of itself.
  out.industry = priority.industry(c).code;
  out.textCount = thread ? thread.length : 0;
  out.textLast = last ? { dir: last.dir, ts: last.ts, text: last.text.slice(0, 120) } : null;
  // The newest thing they wrote, for the replies list: not our own message
  // sent a moment later, not a tapback.
  let lastIn = null;
  for (let i = (thread || []).length - 1; i >= 0; i--) if (thread[i].dir === 'in' && !thread[i].kind) { lastIn = thread[i]; break; }
  out.textLastIn = lastIn ? { ts: lastIn.ts, text: lastIn.text.slice(0, 120) } : null;
  // Email's conversation lives in Gmail, so what rides along here is only
  // enough to list and sort it: how many real replies, and the last one.
  out.emailReplies = real.length;
  out.emailBounced = (c.replies || []).some((r) => r.kind === 'bounce');
  out.emailLast = lastReply
    ? { ts: lastReply.date || c.lastReplyAt || '', text: String(lastReply.text || lastReply.snippet || '').slice(0, 160) }
    : null;
  return out;
}

app.get('/api/state', asyncRoute(async (req, res) => {
  const db = await store.load();
  const lastError = db.events.find((e) => e.type === 'error' && Date.now() - new Date(e.ts).getTime() < 24 * 3600 * 1000);
  // Four independent reads. On Netlify Blobs each one is its own round trip, so
  // awaiting them in a line made this route as slow as the sum of them; nothing
  // here depends on anything else here.
  const [googleStatus, textQ, emailQ, relay, storageBackend, backupList, iq, onb] = await Promise.all([
    google.status(db.settings),
    textQueue.loadQ(),
    queue.loadQ(),
    storage.getJson('relay').catch(() => null),
    storage.backend(),
    backups.list().catch(() => []),
    salesiq.load().catch(() => salesiq.blank()),
    onboarding.load().catch(() => onboarding.blank()),
  ]);
  // Derived from the status above rather than fetching it a second time.
  const sendingNow = await mailer.sendStatus(db.settings, googleStatus);
  const payload = {
    candidates: db.candidates.map(publicCandidate),
    industries: priority.INDUSTRY_LABELS,
    events: feedWindow(db.events),
    lastError: lastError ? lastError.message : '',
    // So a banner someone has dismissed stays dismissed until a new problem.
    lastErrorId: lastError ? lastError.id : '',
    template: db.template,
    templates: presets.publicView(db),
    // Whether this team has written its own outreach letter yet, for the
    // setup checklist. A team old enough to predate the flag counts as done.
    templateEdited: !db.settings.templateSeeded,
    followUp: { template: db.followUp, dueIds: followUpDueIds(db), ...followUpSettings(db.settings) },
    settings: maskedSettings(db.settings, sendingNow.from),
    google: googleStatus,
    sending: sendingNow,
    stats: stats(db),
    baseUrl: google.baseUrl(),
    storage: storageBackend,
    backups: backupList.map((b) => ({ key: b.key, at: b.at, reason: b.reason, count: b.count })),
    auth: { required: auth.required() },
    team: teamPublic(req.team),
    queue: queue.status(emailQ, db.settings, sendingNow.from),
    maxImmediate: MAX_PER_REQUEST,
    interviews: db.interviews || [],
    apollo: { configured: Boolean(db.settings.apolloApiKey), maxPerPull: apollo.MAX_PER_PULL, batch: apollo.ENRICH_BATCH },
    texting: {
      template: db.textTemplate,
      withPhone: db.candidates.filter((c) => phone.normalize(c.phone)).length,
      // id -> { rank, score, reason } for everyone worth texting, plus why
      // anyone else is not. Sent as a small map rather than on each candidate
      // so the candidate list stays the same shape it has always been.
      priority: textPriority(db, textQ),
      queue: textQueue.status(textQ, db.settings, relay),
      tokenSet: Boolean(db.settings.relayToken || (tenant.isLegacy() && (process.env.RELAY_TOKEN || '').trim())),
    },
    calendly: {
      syncEnabled: Boolean(db.settings.calendlyToken),
      webhook: Boolean((db.settings.calendlySigningKeys || []).length || db.settings.calendlySigningKey),
      lastSyncAt: db.calendlyLastSyncAt || null,
      error: db.calendlySyncError || '',
    },
    // Where each person stands with the Sales IQ questionnaire, by address,
    // so a candidate row or an interview can say so without the whole list.
    salesiq: salesiq.summary(iq),
    // And with their onboarding paperwork: packet sent, and signed.
    onboarding: onboarding.summary(onb),
  };

  // The browser asks for this every 30 seconds and most of the time nothing
  // has changed. The body is byte-stable for a given state, so hashing it lets
  // an unchanged poll cost 304 bytes instead of megabytes — and the browser,
  // seeing no new state, skips the re-render too. Weak tag: this is semantic
  // equality of the payload, not of the bytes on any particular encoding.
  const body = JSON.stringify(payload);
  // The Mac says hello every 30 seconds, and that timestamp rode in the hash —
  // so while the relay was running, which is the normal state, the tag changed
  // on every poll and the conditional request below could never answer 304.
  // It is only ever displayed once the relay has *stopped* checking in, and by
  // then it has stopped moving; what the page actually reacts to is the
  // `online` flag beside it, which is in the hash and flips when it should.
  const stable = JSON.stringify(payload, (k, v) => (k === 'lastSeenAt' ? null : v));
  // The team goes into the hash explicitly. The payload names it too, so two
  // teams could not collide by accident — but a tag that answers 304 for the
  // wrong team would show one team the other's dashboard, and that is not a
  // thing to leave resting on a field happening to be in the body.
  const etag = `W/"${crypto.createHash('sha1').update(`${tenant.current() || '-'}:${stable}`).digest('base64url')}"`;
  res.set('ETag', etag);
  // Revalidate every time — never serve this from cache without asking.
  res.set('Cache-Control', 'no-cache, private');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  return res.type('application/json').send(body);
}));

// ---------- Settings & template ----------
// Numeric settings are stored within the range the app honours, and the
// caller is told what was adjusted, so a typed 100/min never silently becomes
// a different number on the dashboard.
const TEXT_NUMERIC = ['textDailyLimit', 'textMinGap', 'textMaxGap', 'textStartHour', 'textEndHour'];
const NUMERIC_SETTINGS = {
  ...Object.fromEntries(['dailyLimit', 'perMinute'].map((k) => [k, null])),   // ranges live in lib/queue.js
  ...Object.fromEntries(TEXT_NUMERIC.map((k) => [k, 'text'])),                // ranges live in lib/text-queue.js
  followUpDays: [1, 30],
  maxFollowUps: [0, 5],
};
const SETTING_LABELS = { dailyLimit: 'Daily send limit', perMinute: 'Emails per minute', followUpDays: 'Follow up after (days)', maxFollowUps: 'Follow-ups per person',
  textDailyLimit: 'Texts per day', textMinGap: 'Shortest gap between texts', textMaxGap: 'Longest gap between texts', textStartHour: 'Start texting at', textEndHour: 'Stop texting at' };
// Why a number was changed, in words that match the setting.
const SETTING_REASONS = {
  dailyLimit: 'that is the most Google allows this account in a day',
  perMinute: 'that is the most the Gmail API allows in a minute',
  followUpDays: 'follow-ups can wait between 1 and 30 days',
  maxFollowUps: 'between 0 and 5 follow-ups per person',
  textDailyLimit: `Apple disables iMessage on accounts that send far more than this to strangers, so the cap is ${textQueue.MAX_DAILY} a day`,
  textMinGap: 'the gap between texts is measured in seconds',
  textMaxGap: 'the gap between texts is measured in seconds, and cannot be shorter than the shortest gap',
  textStartHour: 'texting hours are whole hours of the recipient\u2019s own day',
  textEndHour: 'texting hours are whole hours of the recipient\u2019s own day',
};

app.post('/api/settings', asyncRoute(async (req, res) => {
  const sender = (await mailer.sendStatus((await store.load()).settings)).from;
  let before = null;
  let adjusted = [];
  const db = await store.update((d) => { before = { ...d.settings }; adjusted = applySettings(d, req.body, sender); });
  // A raised daily limit lifts the daily-limit pause at once instead of waiting
  // it out; new mail credentials lift the "not set up" pause.
  const kinds = [];
  if (db.settings.dailyLimit !== before.dailyLimit) kinds.push('daily');
  if (['smtpUser', 'smtpPass', 'googleClientId', 'googleClientSecret'].some((k) => db.settings[k] !== before[k])) kinds.push('not-ready');
  if (kinds.length) await queue.updateQ((f) => queue.clearPause(f, kinds) || false);
  res.json({ ok: true, settings: maskedSettings(db.settings, sender), adjusted });
}));

const SETTINGS_ALLOWED = ['calendlyUrl', 'fromName', 'gmailSignature', 'dailyLimit', 'perMinute', 'followUpDays', 'maxFollowUps', 'ntfyTopic', 'smtpUser', 'smtpPass',
  'googleClientId', 'googleClientSecret', 'calendlyToken', 'apolloApiKey', 'lastSheetUrl', 'timeZone',
  ...TEXT_NUMERIC, 'textSunday'];
// Apply a settings form to a document; returns what had to be adjusted.
function applySettings(db, body, sender) {
  const adjusted = [];
  for (const k of SETTINGS_ALLOWED) {
    if (!(k in body) || body[k] === '••••••••') continue;
    const v = body[k];
    let val = typeof v === 'boolean' ? v : String(v ?? '').trim();
    if (k in NUMERIC_SETTINGS && val !== '') {
      const range = NUMERIC_SETTINGS[k];
      const stored = range === 'text'
        ? textQueue.normalizeTextSettings({ [k]: val })[k]
        : range
          ? (Number.isFinite(Number(val)) ? String(Math.min(range[1], Math.max(range[0], Math.round(Number(val))))) : '')
          : queue.normalizePaceSettings({ [k]: val }, sender)[k];
      if (stored !== val) adjusted.push({ key: k, label: SETTING_LABELS[k] || k, from: val, to: stored, reason: SETTING_REASONS[k] || '' });
      val = stored;
    }
    db.settings[k] = val;
  }
  return adjusted;
}

// The default email: what the send window opens with and the queue falls
// back to. Kept for the editors and anything else that knows only one.
app.post('/api/template', asyncRoute(async (req, res) => {
  const db = await store.update((d) => {
    d.template = {
      ...d.template,   // attachments are managed by their own routes
      subject: String(req.body.subject ?? d.template.subject),
      body: String(req.body.body ?? d.template.body),
    };
    // Somebody has now written this team's letter, whatever it says.
    d.settings.templateSeeded = false;
    touchDefault(d, 'email');
    presets.normalize(d);   // the named default follows, in this reply too
  });
  res.json({ ok: true, template: db.template, templates: presets.publicView(db) });
}));

app.post('/api/template/reset', asyncRoute(async (_req, res) => {
  const db = await store.update((d) => {
    d.template = { ...structuredClone(store.DEFAULT_TEMPLATE), attachments: d.template.attachments };
    touchDefault(d, 'email');
    presets.normalize(d);   // the named default follows, in this reply too
  });
  res.json({ ok: true, template: db.template, templates: presets.publicView(db) });
}));

function touchDefault(db, kind) {
  const p = db[presets.KINDS[kind].list].find((x) => x.id === db.templateDefaults[kind]);
  if (p) p.updatedAt = new Date().toISOString();
}

// ---------- Saved templates (email and text) ----------
// Every change is a retried read-modify-write of the team's document, and the
// answer carries the whole list, so the page never has to guess what is saved.
const templateKind = (req) => {
  const kind = String(req.params.kind || '');
  if (!Object.hasOwn(presets.KINDS, kind)) throw new Error('Unknown kind of template.');
  return kind;
};
const templatesReply = (db, extra = {}) => ({
  ok: true, ...extra, templates: presets.publicView(db), template: db.template, textTemplate: db.textTemplate,
});
app.post('/api/templates/:kind', asyncRoute(async (req, res) => {
  const kind = templateKind(req);
  let made = null;
  const db = await store.update((d) => { made = presets.create(d, kind, req.body || {}); });
  res.json(templatesReply(db, { preset: made }));
}));
app.patch('/api/templates/:kind/:id', asyncRoute(async (req, res) => {
  const kind = templateKind(req);
  let p = null;
  const db = await store.update((d) => { p = presets.update(d, kind, req.params.id, req.body || {}); });
  res.json(templatesReply(db, { preset: p }));
}));
app.post('/api/templates/:kind/:id/default', asyncRoute(async (req, res) => {
  const kind = templateKind(req);
  let p = null;
  const db = await store.update((d) => { p = presets.setDefault(d, kind, req.params.id); });
  res.json(templatesReply(db, { preset: p }));
}));
app.delete('/api/templates/:kind/:id', asyncRoute(async (req, res) => {
  const kind = templateKind(req);
  const db = await store.update((d) => { presets.remove(d, kind, req.params.id); });
  res.json(templatesReply(db));
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
// Capitals never make a different mailbox in practice, and the page's own
// repeat check ignores them, so Jane@X.com in a file is the jane@x.com
// already on the list — not a second person to email.
const emailKey = (e) => (address.normalize(e) || String(e || '').trim()).toLowerCase();
// One inbox, however it is spelled: Gmail ignores dots and anything after a
// "+", so jane.doe+jobs@gmail.com is janedoe@gmail.com. Every other provider
// is taken at its word.
function mailboxKey(e) {
  const k = emailKey(e);
  const at = k.lastIndexOf('@');
  if (at < 1) return k;
  const domain = k.slice(at + 1);
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') return k;
  return `${k.slice(0, at).split('+')[0].replace(/\./g, '')}@gmail.com`;
}
// The same person by name, loosely: the surnames agree (one may be cut short
// or carry an accent), or, with no surname to go on, the first names do.
const nameKey = (v) => String(v || '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
function surnameOf(p) {
  if (p.lastName) return nameKey(p.lastName);
  const parts = String(p.name || '').trim().split(/\s+/);
  return parts.length > 1 ? nameKey(parts[parts.length - 1]) : '';
}
function givenOf(p) { return nameKey(p.firstName || String(p.name || '').trim().split(/\s+/)[0]); }
function namesAgree(a, b) {
  const la = surnameOf(a); const lb = surnameOf(b);
  if (la && lb) return la === lb || la.startsWith(lb) || lb.startsWith(la);
  const fa = givenOf(a); const fb = givenOf(b);
  return Boolean(fa && fb) && (fa === fb || fa.startsWith(fb) || fb.startsWith(fa));
}
// "a@x.com; b@y.com" in an Other Emails column.
const listEmails = (v) => String(v || '').split(/[;,\s]+/).map((e) => address.normalize(e)).filter(Boolean);

function analyzeImport(candidates, rows, mapping, { lines = null, headerless = false } = {}) {
  const m = mapping || {};
  const col = (row, key) => (m[key] != null && m[key] >= 0 ? csv.cleanCell(row[m[key]]) : '');
  // Every address a person is known by (the one on file plus any they booked
  // with), by mailbox, so a Gmail address spelled with or without its dots is
  // the person already on the list rather than a second one.
  const byEmail = new Map();
  for (const c of candidates) {
    for (const e of [c.email, ...(c.altEmails || [])]) {
      for (const k of [emailKey(e), mailboxKey(e)]) if (k && !byEmail.has(k)) byEmail.set(k, c);
    }
  }
  // And by phone: somebody who signed up again with a different address is
  // still the person whose number this is — when the names agree. An office
  // line shared by a whole sales floor never makes two coworkers one person.
  const byPhone = new Map();
  for (const c of candidates) {
    const p = phone.normalize(c.phone);
    if (!p) continue;
    if (!byPhone.has(p)) byPhone.set(p, []);
    byPhone.get(p).push(c);
  }
  const phoneMatch = (list, fields) => {
    const same = (list || []).filter((c) => namesAgree(c, fields));
    return same.length === 1 ? same[0] : null;
  };
  // A shifted row may carry its address in another column — but only when the
  // file has just one column of addresses, so a "Referred by" column can never
  // be mistaken for the candidate's own.
  const emailColumns = rows.length
    ? rows[0].map((_, i) => i).filter((i) => i !== m.email && csv.scoreColumn(rows.map((r) => r[i])).email >= 0.3)
    : [];
  const allowShift = emailColumns.length === 0;
  const rowNumber = (idx) => (lines && lines[idx] ? lines[idx] : idx + (headerless ? 1 : 2));
  const seen = new Set();
  const seenPhones = new Map();   // number -> the people earlier in this file with it
  const out = [];
  rows.forEach((row, idx) => {
    if (!Array.isArray(row)) return;
    let email = address.normalize(col(row, 'email'));
    let shifted = false;
    const others = listEmails(col(row, 'altEmails'));
    if (!email && allowShift) {
      const found = row.map((v) => address.normalize(v)).filter(Boolean);
      if (found.length === 1) { email = found[0]; shifted = true; }
    }
    // Only other addresses: the first is the one to write to.
    if (!email && others.length) email = others.shift();
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
    // Every address on the row, one per mailbox, the one to write to first.
    const boxes = new Set();
    const emails = [email, ...others].filter((e) => { const k = mailboxKey(e); if (boxes.has(k)) return false; boxes.add(k); return true; });
    const keys = emails.flatMap((e) => [emailKey(e), mailboxKey(e)]);
    const tel = phone.normalize(fields.phone);
    // The same person earlier in this file: by address, or by number and name.
    if (keys.some((k) => seen.has(k)) || (tel && phoneMatch(seenPhones.get(tel), fields))) {
      out.push({ idx, row: rowNo, kind: 'duplicate', email, fields });
      return;
    }
    keys.forEach((k) => seen.add(k));
    if (tel) { if (!seenPhones.has(tel)) seenPhones.set(tel, []); seenPhones.get(tel).push(fields); }
    let existing = keys.map((k) => byEmail.get(k)).find(Boolean) || null;
    let matchedBy = existing ? 'email' : '';
    if (!existing && tel) { existing = phoneMatch(byPhone.get(tel), fields); if (existing) matchedBy = 'phone'; }
    if (existing) {
      const fill = {};
      for (const k of IMPORT_FIELDS) if (fields[k] && !String(existing[k] || '').trim()) fill[k] = fields[k];
      // An address of theirs the list did not know yet is kept as one of
      // theirs, so it is recognised next time (and a reply from it is theirs).
      const known = new Set([existing.email, ...(existing.altEmails || [])].map(mailboxKey));
      const more = emails.filter((e) => !known.has(mailboxKey(e)));
      if (more.length) fill.altEmails = [...(existing.altEmails || []), ...more];
      out.push({ idx, row: rowNo, kind: 'existing', email, fields, existing, fill, shifted, matchedBy });
      return;
    }
    out.push({ idx, row: rowNo, kind: 'new', email, fields, shifted, altEmails: emails.slice(1) });
  });
  return out;
}

function summarize(analysis) {
  const count = (k) => analysis.filter((a) => a.kind === k).length;
  return {
    total: analysis.length,
    newCount: count('new'),
    existing: count('existing'),
    // Already on the list under another address, found by their phone number.
    existingByPhone: analysis.filter((a) => a.kind === 'existing' && a.matchedBy === 'phone').length,
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
          ...(a.altEmails && a.altEmails.length ? { altEmails: a.altEmails } : {}),
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
  try {
    const found = await apollo.search(db.settings, req.body || {}, { page: req.body && req.body.page });
    res.json({ ok: true, ...found, maxPerPull: apollo.MAX_PER_PULL, perRequest: APOLLO_IDS_PER_REQUEST });
  } catch (err) {
    if (!err.planUpgrade) throw err;
    res.status(400).json({ error: err.message, planUpgrade: true });
  }
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
  const b = req.body;
  const email = address.normalize(b.email);
  if (!email) throw new Error('A valid email address is required.');
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
  await store.update((db) => {
    if (db.candidates.some((x) => x.email.toLowerCase() === email.toLowerCase())) {
      throw new Error('A candidate with that email already exists.');
    }
    db.candidates.push(c);
  });
  res.json({ ok: true, candidate: c });
}));

app.patch('/api/candidates/:id', asyncRoute(async (req, res) => {
  const email = 'email' in req.body ? address.normalize(req.body.email) : null;
  if ('email' in req.body && !email) throw new Error('That is not a valid email address.');
  let c = null;
  let wasDeclined = false;
  await store.update((db) => {
    c = db.candidates.find((x) => x.id === req.params.id);
    if (!c) throw new Error('Candidate not found.');
    wasDeclined = c.status === 'declined';
    const fields = ['name', 'firstName', 'lastName', 'role', 'company', 'phone', 'location', 'notes', 'status'];
    for (const f of fields) if (f in req.body) c[f] = String(req.body[f] ?? '').trim();
    if (email) c.email = email;
  });
  // Marking somebody "Not interested" has to stop a text that is already
  // waiting to go out. The ranking reads the status, but the queue does not —
  // it only consults its own opt-out list — so a text queued before the change
  // was still handed to the Mac and sent to somebody who had said no. This is
  // the one mistake the daily cap exists to avoid.
  if (!wasDeclined && c.status === 'declined' && phone.normalize(c.phone)) {
    await textQueue.updateQ((q) => { if (!textQueue.addOptOut(q, c.phone)) return false; });
  }
  res.json({ ok: true, candidate: c });
}));

// ---------- Keeping the list safe ----------
// The whole list as a spreadsheet, for a copy of your own.
const EXPORT_COLUMNS = [
  ['First Name', 'firstName'], ['Last Name', 'lastName'], ['Email', 'email'], ['Phone', 'phone'],
  ['Location', 'location'], ['Role', 'role'], ['Company', 'company'], ['Status', 'status'],
  ['Notes', 'notes'], ['Source', 'source'], ['Added', 'addedAt'], ['Last emailed', 'lastEmailedAt'],
  ['Last texted', 'lastTextedAt'], ['Last reply', 'lastReplyAt'], ['Booked', 'bookedAt'],
];
function csvCell(v) {
  // Typed by strangers on a job board: a cell starting = + - @ is a formula to
  // Excel, so it gets a leading space, which the importer trims again.
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = ` ${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
app.get('/api/candidates/export', asyncRoute(async (req, res) => {
  const db = await store.load();
  const lines = [EXPORT_COLUMNS.map(([h]) => h).join(',')];
  for (const c of db.candidates) {
    const first = c.firstName || (c.name || '').split(' ')[0] || '';
    const last = c.lastName || (c.firstName ? '' : (c.name || '').split(' ').slice(1).join(' '));
    lines.push(EXPORT_COLUMNS.map(([, k]) => csvCell(k === 'firstName' ? first : k === 'lastName' ? last : c[k])).join(','));
  }
  const team = (req.team && req.team.name ? req.team.name : 'candidates').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'candidates';
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${team}-candidates-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.set('Cache-Control', 'no-store');
  // A byte-order mark so Excel reads accents correctly; CRLF because Excel expects it.
  res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
}));

app.get('/api/backups', asyncRoute(async (_req, res) => {
  res.json({ ok: true, backups: await backups.list() });
}));
app.post('/api/backups', asyncRoute(async (_req, res) => {
  const b = await backups.snapshot('manual');
  res.json({ ok: true, backup: b, backups: await backups.list() });
}));
// Add back anybody who is in a backup and not on the list now. Never removes
// or changes anyone already on it. dryRun says how many that would be.
app.post('/api/backups/restore', asyncRoute(async (req, res) => {
  const r = await backups.restoreMissing(String((req.body && req.body.key) || ''), { dryRun: Boolean(req.body && req.body.dryRun) });
  res.json({ ok: true, ...r });
}));

app.delete('/api/candidates/:id', asyncRoute(async (req, res) => {
  await store.update((db) => {
    if (!store.removeCandidate(db, req.params.id)) throw new Error('Candidate not found.');
  });
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
    await store.update((d) => { if (!d.settings.trackingSecret) d.settings.trackingSecret = tracking.newSecret(); });
    db.settings.trackingSecret = (await store.load()).settings.trackingSecret;
  }
  const signature = await google.getSignature(db.settings, { refresh: true });
  const files = await attachments.loadAll(db);
  const recent = queue.recentlySentIds(q);
  const sentPatches = [];
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
      const trackingUrl = `${google.baseUrl()}${tracking.pixelPath(db.settings, c.id)}`;
      const msg = renderEmail(template, c, db.settings, { signature, trackingUrl });
      const thread = followUp && c.messageId ? { threadId: c.gmailThreadId || undefined, inReplyTo: c.messageId, references: c.messageId } : {};
      const sent = await queue.sendWithDeadline(db.settings, { to: c.email, ...msg, ...thread, attachments: followUp ? [] : files }, Math.min(queue.SEND_TIMEOUT_MS, left - 300), { via: st.via });
      // What the send changes on the candidate goes in the same write as the
      // send, so a request cut off before the end still gets it recorded.
      const ts = new Date().toISOString();
      const patch = { id: c.id, lastEmailedAt: ts, gmailThreadId: sent.threadId || '', messageId: sent.messageId || '', lastSubject: msg.subject, followUp };
      await queue.updateQ((f) => queue.recordSent(f, c.id, c.email, ts, patch));
      paceLeft -= 1;
      sentPatches.push(patch);
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
        await queue.updateQ((f) => queue.deferUnverified(f, c.id, c.email, attemptAt, template, { followUp }));
        results.push({ id, ok: false, queued: true, email: c.email, error: 'Timed out — Gmail will be checked and the send finished in the background.' });
        continue;
      }
      if (err.name === 'AbortError') { results.push({ id, ok: false, email: c.email, error: queue.TIMEOUT_UNKNOWN, kind }); continue; }
      results.push({ id, ok: false, email: c.email, error: err.message, kind });
    }
    await sleep(400);
  }
  // The emails have gone and are recorded: a failure here must not report
  // them as failed. The scheduled worker writes anything left within a minute.
  try { await queue.settlePending(sentPatches); }
  catch (err) { console.warn('[send] sends not written to candidates yet, the worker will:', err.message); }
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
// ---------- Texting: iMessage through the Mac Studio relay ----------
// The dashboard cannot send an iMessage — only a Mac can. So a small daemon on
// the Mac Studio (see relay/) polls these routes, claims one message at a time,
// sends it through BlueBubbles and reports what happened. Netlify never calls
// the Mac: the Mac always calls us, which is why none of this needs the Mac to
// be reachable from the internet.
//
// /api/relay/* is authenticated by the relay's bearer token, not by the
// dashboard password — see lib/auth.js.

// The relay's own record: last check-in, what it reported about itself.
const relayState = () => storage.getJson('relay').catch(() => null);

// Text funnel order, so a later signal never moves a candidate backwards
// (a delivery receipt arriving after a reply must not undo the reply).
const TEXT_RANK = { '': 0, failed: 0, 'not-imessage': 1, sent: 2, delivered: 3, read: 4, replied: 5 };
const advanceText = (c, next) => { if ((TEXT_RANK[next] || 0) >= (TEXT_RANK[c.textStatus || ''] || 0)) c.textStatus = next; };

// Candidates indexed by their number in E.164, so an inbound message can be
// matched back to a person. Numbers that do not belong to anyone in the list
// are ignored — this is what keeps the owner's personal iMessages out of the CRM.
function byPhone(db) {
  const m = new Map();
  for (const c of db.candidates) {
    const p = phone.normalize(c.phone);
    if (p && !m.has(p)) m.set(p, c);
  }
  return m;
}

app.post('/api/relay/hello', asyncRoute(async (req, res) => {
  const b = req.body || {};
  await storage.updateJson('relay', (cur) => ({
    ...(cur || {}),
    lastSeenAt: new Date().toISOString(),
    host: String(b.host || '').slice(0, 80),
    version: String(b.version || '').slice(0, 24),
    bluebubbles: Boolean(b.bluebubbles),
    backend: String(b.backend || 'applescript').slice(0, 20),
    error: String(b.error || '').slice(0, 300),
  }));
  const db = await store.load();
  const l = textQueue.limits(db.settings);
  res.json({ ok: true, pollMs: 5000, helloMs: 30000, limits: { startHour: l.startHour, endHour: l.endHour, dailyLimit: l.dailyLimit } });
}));

// The numbers this system has texted, so a relay knows which conversations on
// its Mac belong to the CRM. Without it, moving between two Macs silently loses
// replies: iMessage syncs the conversation to both, but a relay that did not
// send the original has no record of the number and ignores everything from it.
//
// Deliberately only ever numbers already texted — never the candidate list.
app.post('/api/relay/handles', asyncRoute(async (_req, res) => {
  const q = await textQueue.loadQ();
  const db = await store.load();
  const handles = new Set();
  for (const e of q.sentLog || []) if (e && e.phone) handles.add(e.phone);
  for (const c of db.candidates) {
    if (!c.lastTextedAt) continue;
    const p = phone.normalize(c.phone);
    if (p) handles.add(p);
  }
  res.json({ handles: [...handles] });
}));

// What the relay reported goes into the text queue first and onto the
// candidate second. Should a request end between the two, the outcome waits in
// the queue's pending list and the next report or claim writes it — safe to
// repeat: the thread never gets the same message twice.
function applyTextOutcome(c, o) {
  if (o.status === 'sent') {
    if (!(Date.parse(c.lastTextedAt) >= Date.parse(o.ts))) c.lastTextedAt = o.ts;
    advanceText(c, 'sent');
    // Our half of the conversation. Until now it lived only in the queue's
    // lease and went in the bin on delivery.
    if (o.body) store.addToThread(c, 'out', o.body, o.ts);
  } else if (Date.parse(c.lastTextedAt) > Date.parse(o.ts)) {
    // A later text went through; an older failure says nothing about now.
  } else if (o.status === 'not-imessage') c.textStatus = 'not-imessage';
  else c.textStatus = 'failed';
}

async function settleTextOutcomes(list) {
  if (!list || !list.length) return;
  await store.update((db) => {
    const byId = new Map(db.candidates.map((c) => [c.id, c]));
    let changed = false;
    for (const o of list) {
      const c = byId.get(o.id);
      if (!c) continue;
      const before = JSON.stringify(c);
      applyTextOutcome(c, o);
      if (JSON.stringify(c) !== before) changed = true;
    }
    if (!changed) return false;
  });
  await textQueue.updateQ((q) => textQueue.dropPending(q, list));
}

app.post('/api/relay/claim', asyncRoute(async (req, res) => {
  const db = await store.load();
  let out = { job: null, reason: 'empty' };
  const q = await textQueue.updateQ((f) => {
    out = textQueue.claim(f, db, { render: (tpl, c) => renderText(tpl || db.textTemplate, c, db.settings) });
    // A poll that found nothing to do writes nothing: the relay polls every few
    // seconds, and rewriting the record each time would be pure churn.
    if (!out.changed) return false;
  });
  if (q.pendingPatches.length) {
    try { await settleTextOutcomes(q.pendingPatches); }
    catch (err) { console.warn('[relay] earlier outcomes not written to candidates yet:', err.message); }
  }
  res.json({ job: out.job || null, reason: out.reason, until: out.until || null });
}));

app.post('/api/relay/report', asyncRoute(async (req, res) => {
  const { jobId, status, error } = req.body || {};
  let out = { ok: false, reason: 'unknown-or-expired-job' };
  const q = await textQueue.updateQ((f) => {
    out = textQueue.report(f, { jobId: String(jobId || ''), status: String(status || ''), error: String(error || '').slice(0, 300) });
    if (!out.ok) return false;
  });
  if (!out.ok) return res.status(409).json(out);
  // The outcome is stored; a failure writing it onto the candidate must not
  // send the relay back to report a job that is already closed.
  try { await settleTextOutcomes(q.pendingPatches); }
  catch (err) { console.warn('[relay] outcome not written to the candidate yet, the next poll will:', err.message); }
  res.json(out);
}));

// Delivery receipts, read receipts and inbound replies, read off the Mac's own
// Messages database. Only events for numbers already in the candidate list are
// acted on; anything else is silently dropped.
app.post('/api/relay/events', asyncRoute(async (req, res) => {
  const raw = Array.isArray(req.body && req.body.events) ? req.body.events.slice(0, 200) : [];
  // The relay skips this call when it has nothing, but a retry or a future
  // version might not: an empty batch should never read the whole record.
  if (!raw.length) return res.json({ applied: 0, unknown: 0, optOut: 0, tooOld: 0, neverTexted: 0 });
  const db = await store.load();
  const index = byPhone(db);
  const seen = { applied: 0, unknown: 0, optOut: 0, tooOld: 0, neverTexted: 0, replies: [] };
  const optOuts = [];
  const touched = new Map();   // candidate id -> mutation to apply

  for (const e of raw) {
    const p = phone.normalize(e && e.phone);
    const c = p ? index.get(p) : null;
    if (!c) { seen.unknown += 1; continue; }
    const kind = String((e && e.kind) || '');
    const ts = e && e.ts && !Number.isNaN(new Date(e.ts).getTime()) ? new Date(e.ts).toISOString() : new Date().toISOString();
    const text = String((e && e.text) || '').slice(0, 2000);
    const patch = touched.get(c.id) || { id: c.id, replies: [] };
    if (kind === 'delivered') patch.delivered = ts;
    else if (kind === 'read') patch.read = ts;
    else if (kind === 'undelivered') patch.undelivered = ts;
    else if (kind === 'reply') {
      // A reply cannot predate the text it answers. Anything older belongs to a
      // conversation that already existed on that Mac — the owner's own thread
      // with that person — and must never be filed as outreach, however
      // confidently a relay reports it. The relay checks this too; this is the
      // half that cannot be undone by a stale state file on a laptop.
      const textedAt = c.lastTextedAt ? new Date(c.lastTextedAt).getTime() : null;
      if (textedAt && new Date(ts).getTime() < textedAt - 5 * 60 * 1000) { seen.tooOld += 1; continue; }
      if (!textedAt) { seen.neverTexted += 1; continue; }
      // A tapback or a Driving Focus auto-reply goes in the conversation, but
      // nobody answered: it is not a reply and must not ring like one.
      const machine = phone.classifyText(text);
      if (machine) { (patch.machine = patch.machine || []).push({ ts, text, kind: machine }); }
      else {
        patch.replied = ts;
        patch.replies.push({ ts, text });
        if (phone.optedOut(text)) optOuts.push(p);
      }
    } else continue;
    touched.set(c.id, patch);
    seen.applied += 1;
  }

  if (touched.size) {
    await store.update((fresh) => {
      for (const patch of touched.values()) {
        // The mutator can run again after a write conflict: start clean.
        patch.fresh = [];
        patch.firstRead = false;
        const c = fresh.candidates.find((x) => x.id === patch.id);
        if (!c) continue;
        // Messages accepts a send and only then marks it failed, so this can
        // arrive after we already recorded "sent" — it has to be able to undo
        // that, which the usual forward-only rule would not allow. A receipt
        // that already proved delivery still wins.
        if (patch.undelivered && (TEXT_RANK[c.textStatus || ''] || 0) <= TEXT_RANK.sent) c.textStatus = 'not-imessage';
        if (patch.delivered) { c.textDeliveredAt = c.textDeliveredAt || patch.delivered; advanceText(c, 'delivered'); }
        if (patch.read) { patch.firstRead = !c.textReadAt; c.textReadAt = c.textReadAt || patch.read; advanceText(c, 'read'); }
        for (const m of patch.machine || []) store.addToThread(c, 'in', m.text, m.ts, { kind: m.kind });
        // Only a message this thread has never held is news. A relay reports
        // the same line again (a restart, a second Mac, a re-read window), and
        // each repeat used to mark the conversation unread again, add another
        // feed line and send another notification to the phone.
        for (const r of patch.replies) if (store.addToThread(c, 'in', r.text, r.ts)) patch.fresh.push(r);
        if (patch.fresh.length) {
          const latest = patch.fresh[patch.fresh.length - 1].ts;
          c.textRepliedAt = c.textRepliedAt || latest;
          advanceText(c, 'replied');
          // Cleared when the thread is opened, so the bell survives a reload
          // and agrees with itself across devices.
          c.textUnread = true;
          // A text reply is the same pipeline signal as an email reply.
          if (c.status === 'new' || c.status === 'emailed' || c.status === 'bounced') c.status = 'replied';
          c.repliedAt = c.repliedAt || latest;
          // STOP only counts when it is a new message: a repeat of an old one
          // must not undo someone putting them back on the list by hand.
          if (patch.fresh.some((r) => phone.optedOut(r.text))) c.status = 'declined';
        }
      }
    });
  }

  // Anyone who asked us to stop is blocked at the queue, not just on their record.
  if (optOuts.length) {
    await textQueue.updateQ((q) => { let any = false; for (const p of optOuts) any = textQueue.addOptOut(q, p) || any; if (!any) return false; });
    seen.optOut = optOuts.length;
  }

  // The feed and the phone push: once per new message, never per report.
  for (const patch of touched.values()) {
    const c = db.candidates.find((x) => x.id === patch.id);
    if (!c) continue;
    const who = c.name || phone.display(phone.normalize(c.phone));
    const fresh = patch.fresh || [];
    // The first read only; a receipt reported again says nothing new.
    if (patch.read && patch.firstRead && !fresh.length) {
      await store.addEvent('text-read', `${who} read your text.`, c.id, patch.read).catch(() => {});
    }
    for (const r of fresh) {
      // STOP is the one reply that changes what you may legally do next, and
      // as a plain "replied" line it read exactly like someone saying yes.
      if (phone.optedOut(r.text)) {
        await store.addEvent('text-optout', `${who} replied STOP — blocked from texting.`, c.id, r.ts).catch(() => {});
      } else {
        await store.addEvent('text-replied', `${who} replied to your text: “${r.text.slice(0, 140)}”`, c.id, r.ts).catch(() => {});
      }
    }
    if (!fresh.length) continue;
    // One notification per person per batch: "Hi" / "yes" / "call me at 3"
    // arriving together is one thing to read, not three buzzes.
    const stop = fresh.find((r) => phone.optedOut(r.text));
    const last = fresh[fresh.length - 1];
    const more = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : '';
    try {
      await notify.pushToPhone(db.settings, {
        title: stop ? `🛑 ${who} replied STOP` : `💬 ${who} replied`,
        message: stop ? `Blocked from texting. Their message: ${stop.text.slice(0, 260)}` : `${last.text.slice(0, 280)}${more}`,
        priority: 'high',
        tags: stop ? 'no_entry' : 'speech_balloon',
      });
    } catch {}
  }
  res.json({ ok: true, ...seen });
}));

// ---------- Texting: the dashboard's own routes ----------
// The default text, like /api/template for email.
app.post('/api/texts/template', asyncRoute(async (req, res) => {
  const db = await store.update((d) => {
    d.textTemplate = { body: String((req.body && req.body.body) || '').slice(0, 2000) };
    touchDefault(d, 'text');
    presets.normalize(d);   // the named default follows, in this reply too
  });
  res.json({ ok: true, textTemplate: db.textTemplate, templates: presets.publicView(db) });
}));

app.post('/api/texts/template/reset', asyncRoute(async (_req, res) => {
  const db = await store.update((d) => {
    // Only Team Maverick's starter text introduces Blake; any other team gets
    // the one that claims to be nobody.
    d.textTemplate = structuredClone(tenant.isLegacy() ? store.DEFAULT_TEXT_TEMPLATE : store.NEW_TEAM_TEXT_TEMPLATE);
    touchDefault(d, 'text');
    presets.normalize(d);   // the named default follows, in this reply too
  });
  res.json({ ok: true, textTemplate: db.textTemplate, templates: presets.publicView(db) });
}));

app.post('/api/texts/preview', asyncRoute(async (req, res) => {
  const db = await store.load();
  const c = db.candidates.find((x) => x.id === (req.body && req.body.id))
    || db.candidates.find((x) => phone.normalize(x.phone))
    || { name: 'Sam Rivera', role: 'Account Executive', company: 'Acme Payments', phone: '+15551234567' };
  const body = renderText(db.textTemplate, c, db.settings);
  res.json({ body, chars: body.length, to: phone.display(phone.normalize(c.phone)) || '', name: c.name || '' });
}));

app.post('/api/texts/queue', asyncRoute(async (req, res) => {
  const db = await store.load();
  const q0 = await textQueue.loadQ();
  const ranked = priority.rank(db.candidates, { maxFollowUps: followUpSettings(db.settings).max, optOut: q0.optOut });
  const order = new Map(ranked.map((r, i) => [r.id, i]));
  // Best first, always. Only 60-100 texts a day exist, so the order the queue
  // drains in IS the strategy: whoever is at the front is who the cap gets
  // spent on. A selection is ranked too — ticking thirty boxes should still
  // reach the best of them first.
  const asked = Array.isArray(req.body && req.body.ids) && req.body.ids.length ? req.body.ids : null;
  const ids = (asked ? asked.filter((id) => order.has(id)) : ranked.map((r) => r.id))
    .sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
  // Ranking drops people the queue would have rejected anyway, so their reason
  // has to be collected here or it is lost — picking someone and being told
  // "nothing to send" with no reason is worse than not offering it at all.
  const reasons = {};
  if (asked) {
    const blockedSet = new Set(q0.optOut);
    for (const id of asked) {
      if (order.has(id)) continue;
      const c = db.candidates.find((x) => x.id === id);
      const why = c ? priority.blockedReason(c, { optOut: blockedSet }) : 'no longer in the list';
      if (why) reasons[why] = (reasons[why] || 0) + 1;
    }
  }
  // A one-off message for this send only, exactly as the email side allows —
  // texting one person usually means saying something other than the template.
  const custom = req.body && req.body.template && String(req.body.template.body || '').trim();
  const template = custom ? { body: String(req.body.template.body) } : db.textTemplate;
  // Explicit, per send, and never sticky: a test message can go out at any
  // hour without touching the quiet hours that protect the real list.
  const ignoreQuietHours = Boolean(req.body && req.body.ignoreQuietHours);
  let result = { added: 0, promoted: 0, skipped: {} };
  await textQueue.updateQ((q) => {
    result = textQueue.enqueue(q, db, ids, template, { ignoreQuietHours });
    // Promoting someone already waiting is a change worth writing, even though
    // it adds nobody new.
    if (!result.added && !result.promoted) return false;
  });
  const q = await textQueue.loadQ();
  res.json({ ...result, reasons, queue: textQueue.status(q, db.settings, await relayState()) });
}));

app.delete('/api/texts/queue', asyncRoute(async (_req, res) => {
  const db = await store.load();
  const q = await textQueue.updateQ((f) => { textQueue.clearQueue(f); });
  res.json({ ok: true, queue: textQueue.status(q, db.settings, await relayState()) });
}));

app.post('/api/texts/queue/retry-failed', asyncRoute(async (_req, res) => {
  const db = await store.load();
  let n = 0;
  const q = await textQueue.updateQ((f) => { n = textQueue.retryFailed(f, db); if (!n) return false; });
  res.json({ ok: true, requeued: n, queue: textQueue.status(q, db.settings, await relayState()) });
}));

// One email conversation, read live from Gmail.
app.get('/api/emails/thread', asyncRoute(async (req, res) => {
  const db = await store.load();
  const c = db.candidates.find((x) => x.id === String((req.query && req.query.id) || ''));
  if (!c) return res.status(404).json({ error: 'No such candidate.' });
  const base = {
    ok: true,
    id: c.id,
    name: c.name || '',
    email: c.email || '',
    role: c.role || '',
    company: c.company || '',
    status: c.status || 'new',
    subject: c.lastSubject || '',
    gmailUrl: c.gmailThreadId ? `https://mail.google.com/mail/u/0/#all/${c.gmailThreadId}` : '',
  };
  const g = await google.status(db.settings);
  if (!g.connected) {
    return res.json({ ...base, messages: [], unavailable: 'Connect Google in Settings to read and reply to email conversations here.' });
  }
  if (!c.gmailThreadId) {
    return res.json({ ...base, messages: [], unavailable: 'Nothing has been emailed to this person yet.' });
  }
  try {
    const t = await google.threadMessages(db.settings, c.gmailThreadId, g.email);
    res.json({ ...base, ...t, canReply: true });
  } catch (err) {
    if (err.gone) return res.json({ ...base, messages: [], unavailable: 'That conversation is no longer in Gmail.' });
    res.json({
      ...base,
      messages: [],
      unavailable: err.scope
        ? 'Reading email needs the extra Gmail permission — Settings → Google → Reconnect and tick every box.'
        : err.message,
    });
  }
}));

// Answer an email in its own thread. Gmail's threadId keeps it together on
// our side; In-Reply-To/References are what keep it together in theirs.
app.post('/api/emails/reply', asyncRoute(async (req, res) => {
  const id = String((req.body && req.body.id) || '');
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'Type a message first.' });
  const db = await store.load();
  const c = db.candidates.find((x) => x.id === id);
  if (!c) return res.status(404).json({ error: 'No such candidate.' });
  if (!c.email) return res.status(409).json({ error: 'No email address on this candidate.' });
  const g = await google.status(db.settings);
  if (!g.connected) return res.status(409).json({ error: 'Connect Google in Settings to reply from here.' });
  if (!c.gmailThreadId) return res.status(409).json({ error: 'Nothing has been emailed to this person yet.' });

  let inReplyTo = c.messageId || '';
  let subject = c.lastSubject || '';
  try {
    const t = await google.threadMessages(db.settings, c.gmailThreadId, g.email);
    if (t.lastMessageId) inReplyTo = t.lastMessageId;
    if (t.lastSubject) subject = t.lastSubject;
  } catch { /* fall back to what was stored when we last sent */ }
  const re = /^re:/i.test(subject) ? subject : `Re: ${subject || 'Following up'}`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#141b4d;white-space:pre-wrap">${escapeHtml(body)}</div>`;

  try {
    const sent = await mailer.sendEmail(db.settings, {
      to: c.email,
      subject: re,
      text: body,
      html,
      threadId: c.gmailThreadId,
      inReplyTo: inReplyTo || undefined,
      references: inReplyTo || undefined,
    });
    await store.update((fresh) => {
      const f = fresh.candidates.find((x) => x.id === id);
      if (!f) return false;
      // A reply is a contact, so the follow-up clock restarts from here — an
      // automated nudge on top of a conversation already in progress reads as
      // nobody being home.
      f.lastEmailedAt = new Date().toISOString();
      f.lastSubject = re;
      if (sent.messageId) f.messageId = sent.messageId;
      if (sent.threadId) f.gmailThreadId = sent.threadId;
      f.emailUnread = false;
    });
    res.json({ ok: true, sent: true });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Gmail refused the message.' });
  }
}));

// Which unread flags a "seen" call may clear. `items` names each conversation
// with the time of the newest reply the screen actually showed; a flag is only
// cleared when nothing newer has arrived since, so a reply that lands while
// the call is on its way is still news. `id` (with an optional `ts`) is one
// conversation; `all` is every one, and kept for older clients.
function seenMatcher(body, ch) {
  const b = body || {};
  if (b.all) return () => true;
  const want = new Map();
  if (Array.isArray(b.items)) for (const it of b.items.slice(0, 2000)) if (it && it.id) want.set(String(it.id), it.ts || null);
  if (b.id) want.set(String(b.id), b.ts || null);
  return (c) => {
    if (!want.has(c.id)) return false;
    const shown = want.get(c.id);
    if (!shown) return true;
    const latest = lastInboundTs(c, ch);
    return !latest || new Date(latest).getTime() <= new Date(shown).getTime() + 1000;
  };
}
// The newest message they sent on a channel: a real email reply, or an
// inbound text that a person typed (not a tapback or an auto-reply).
function lastInboundTs(c, ch) {
  if (ch === 'email') {
    const real = (c.replies || []).filter((r) => !r.kind);
    const last = real[real.length - 1];
    return (last && last.date) || c.lastReplyAt || '';
  }
  const t = (c.textThread || []).filter((m) => m.dir === 'in' && !m.kind);
  return t.length ? t[t.length - 1].ts : '';
}

app.post('/api/emails/seen', asyncRoute(async (req, res) => {
  const match = seenMatcher(req.body, 'email');
  let n = 0;
  await store.update((db) => {
    n = 0;   // re-run on a conflict: count afresh
    for (const c of db.candidates) {
      if (!c.emailUnread || !match(c)) continue;
      c.emailUnread = false; n += 1;
    }
    if (!n) return false;
  });
  res.json({ ok: true, cleared: n });
}));

// One conversation, both halves, oldest first.
app.get('/api/texts/thread', asyncRoute(async (req, res) => {
  const db = await store.load();
  const c = db.candidates.find((x) => x.id === String((req.query && req.query.id) || ''));
  if (!c) return res.status(404).json({ error: 'No such candidate.' });
  const q = await textQueue.loadQ();
  const p = phone.normalize(c.phone);
  res.json({
    ok: true,
    id: c.id,
    name: c.name || '',
    phone: p ? phone.display(p) : '',
    role: c.role || '',
    company: c.company || '',
    status: c.status || 'new',
    textStatus: c.textStatus || '',
    optedOut: Boolean(p && q.optOut.includes(p)),
    // What is still on its way to the Mac, so a just-sent reply does not
    // vanish from the thread until the relay gets round to it.
    pending: [...q.items, ...Object.values(q.leases)]
      .filter((i) => i.id === c.id)
      .map((i) => ({ text: (q.templates[i.t] && q.templates[i.t].body) || '' }))
      .filter((i) => i.text),
    thread: c.textThread || [],
  });
}));

// Answer someone in the thread. This is a reply into a live conversation, not
// outreach, so it goes to the front and ignores the quiet hours — they texted
// us. The opt-out list still binds.
app.post('/api/texts/reply', asyncRoute(async (req, res) => {
  const id = String((req.body && req.body.id) || '');
  const body = String((req.body && req.body.body) || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Type a message first.' });
  const db = await store.load();
  const c = db.candidates.find((x) => x.id === id);
  if (!c) return res.status(404).json({ error: 'No such candidate.' });
  const relay = await relayState();
  // relayState() is the raw blob the Mac last wrote; "online" is a judgement
  // about how long ago that was, made the same way the queue makes it.
  const seen = relay && relay.lastSeenAt ? new Date(relay.lastSeenAt).getTime() : 0;
  const relayOnline = seen > 0 && Date.now() - seen < textQueue.RELAY_STALE_MS;
  let out = { ok: false, reason: 'no-phone' };
  await textQueue.updateQ((q) => { out = textQueue.enqueueReply(q, c, body); if (!out.ok) return false; });
  if (!out.ok) {
    const why = out.reason === 'opted-out'
      ? 'They replied STOP, so nothing more can be sent to that number.'
      : out.reason === 'no-phone' ? 'No mobile number on this candidate.' : 'Type a message first.';
    return res.status(409).json({ error: why });
  }
  // Reading a thread is answering it, so the badge should not still be lit.
  await store.update((fresh) => {
    const f = fresh.candidates.find((x) => x.id === id);
    if (f) f.textUnread = false;
  });
  res.json({ ok: true, queued: true, relayOnline });
}));

// Opening a conversation is reading it.
app.post('/api/texts/seen', asyncRoute(async (req, res) => {
  const match = seenMatcher(req.body, 'text');
  let n = 0;
  await store.update((db) => {
    n = 0;   // re-run on a conflict: count afresh
    for (const c of db.candidates) {
      if (!c.textUnread || !match(c)) continue;
      c.textUnread = false; n += 1;
    }
    if (!n) return false;
  });
  res.json({ ok: true, cleared: n });
}));

// The shared secret for the Mac. Generated here rather than typed, shown in
// full only to a signed-in dashboard so it can be copied into the relay's
// config once, and never sent anywhere else.
app.get('/api/texts/relay-token', asyncRoute(async (_req, res) => {
  const db = await store.load();
  res.json({
    token: db.settings.relayToken || '',
    envOverride: Boolean(tenant.isLegacy() && (process.env.RELAY_TOKEN || '').trim()),
    baseUrl: google.baseUrl(),
  });
}));

app.post('/api/texts/relay-token', asyncRoute(async (req, res) => {
  const token = crypto.randomBytes(32).toString('base64url');
  await store.update((db) => { db.settings.relayToken = token; });
  // The registry keeps a fingerprint of it, so a relay presenting the token
  // can be traced to its team in one read instead of by opening every team's
  // settings in turn.
  await teams.setRelayToken(tenant.currentOrThrow('a relay token'), token);
  auth.forgetRelaySecret();
  res.json({ ok: true, token, baseUrl: google.baseUrl(), envOverride: Boolean(tenant.isLegacy() && (process.env.RELAY_TOKEN || '').trim()) });
}));

// This runs in the recipient's mail client, once per open, so it is the most
// frequently hit route in the app. A first open used to read the whole record
// three times and write it twice — once to look the token up, again to set the
// timestamp, and a third time to add the feed line. The timestamp and the feed
// line are now one write, and a repeat open still costs a single read.
// Mark the open, if that token really is one of this team's. Returns nothing:
// the pixel is served either way, because whether we recognised it is not the
// mail client's business.
async function recordOpen(token) {
  const db = await store.load();
  const id = tracking.verify(db.settings, token);
  if (!id) return false;
  const c = db.candidates.find((x) => x.id === id);
  if (!c) return false;
  if (!c.openedAt) {
    await store.update((fresh) => {
      const fc = fresh.candidates.find((x) => x.id === id);
      // Re-checked against the fresh copy: two opens can land together.
      if (!fc || fc.openedAt) return false;
      fc.openedAt = new Date().toISOString();
      store.pushEvent(fresh, 'opened', `${fc.name || fc.email} opened your email.`, fc.id);
    });
  }
  return true;
}

function servePixel(res) {
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(tracking.GIF);
}

app.get('/webhooks/open/:team/:token', asyncRoute(async (req, res) => {
  const team = await teams.byId(req.params.team);
  if (team) await tenant.run(team.id, () => recordOpen(req.params.token)).catch(() => {});
  servePixel(res);
}));

// Every email sent before teams existed carries a pixel at this older path,
// and those emails are out in the world for good. The token is signed, so the
// team that can verify it is the team it belongs to: try each in turn and stop
// at the first that recognises it.
//
// That search is the whole cost of this route, and it is a public path that
// crawlers find, so it is guarded twice: anything that is not shaped like one
// of our tokens is answered without touching storage at all, and a token that
// has been placed once is remembered, so the second open of the same email is
// one read rather than one per team.
const pixelOwner = new Map();          // token -> team id
const PIXEL_OWNER_MAX = 500;

function rememberPixelOwner(token, teamId) {
  if (pixelOwner.size >= PIXEL_OWNER_MAX) pixelOwner.delete(pixelOwner.keys().next().value);
  pixelOwner.set(token, teamId);
}

app.get('/webhooks/open/:token', asyncRoute(async (req, res) => {
  const token = req.params.token;
  if (!tracking.looksLikeToken(token)) return servePixel(res);
  const known = pixelOwner.get(token);
  if (known) {
    await tenant.run(known, () => recordOpen(token)).catch(() => {});
    return servePixel(res);
  }
  for (const t of await teams.all().catch(() => [])) {
    const hit = await tenant.run(t.id, () => recordOpen(token)).catch(() => false);
    if (hit) { rememberPixelOwner(token, t.id); break; }
  }
  servePixel(res);
}));

// ---------- Reply detection (Gmail thread headers, a few at a time) ----------
// The checking itself lives in lib/replies.js, shared with the scheduled
// worker so replies are noticed with the app closed too.
app.post('/api/replies/check', asyncRoute(async (_req, res) => {
  res.json(await replies.checkReplies());
}));

// ---------- Google OAuth ----------
// Used by the dashboard button: returns the consent URL (and sets the state
// cookie) so the browser only navigates once everything server-side worked.
app.get('/api/google/auth-url', asyncRoute(async (req, res) => {
  const db = await store.load();
  const st = await google.status(db.settings);
  if (!st.configured) throw new Error('Enter your Google OAuth Client ID and Secret first, then save.');
  const state = auth.issueOauthState(req, res, req.team.id);
  res.json({ url: google.authUrl(db.settings, state) });
}));

app.get('/auth/google', asyncRoute(async (req, res) => {
  const db = await store.load();
  const st = await google.status(db.settings);
  if (!st.configured) return res.redirect('/#settings?error=google-not-configured');
  const state = auth.issueOauthState(req, res, req.team.id);
  res.redirect(google.authUrl(db.settings, state));
}));

app.get('/auth/google/callback', asyncRoute(async (req, res) => {
  const db = await store.load();
  if (req.query.error) return res.redirect('/#settings?error=' + encodeURIComponent(req.query.error));
  // The state round-trip stops a forged callback from binding someone else's
  // Google account to this dashboard — and, because it carries the team that
  // started it, stops a team switch made while the consent screen was open
  // from filing one team's Gmail connection under another's.
  if (!auth.consumeOauthState(req, res, req.query.state, req.team.id)) {
    return res.redirect('/#settings?error=' + encodeURIComponent('That Google sign-in did not match this team — please click Connect Google again.'));
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
// The one warning that has to be retractable: it tells the user to go and fix
// something, so once they have, it must stop shouting at them.
const CALENDLY_SIGNATURE_WARNING = 'Rejected a Calendly webhook call with an invalid signature. If bookings stop showing up, click "Enable booking alerts" in Settings to re-register.';
const isCalendlySignatureWarning = (e) => e && e.type === 'error' && /Calendly webhook call with an invalid signature/.test(e.message || '');

app.post('/api/calendly/register-webhook', asyncRoute(async (req, res) => {
  const db = await store.load();
  const provided = String(req.body.token || '').trim();
  const token = provided && provided !== '••••••••' ? provided : (db.settings.calendlyToken || '');
  const publicUrl = String(req.body.publicUrl || google.baseUrl()).trim();
  if (!token) throw new Error('Paste your Calendly Personal Access Token first.');
  if (!publicUrl || publicUrl.includes('localhost')) {
    throw new Error('Calendly needs a public URL to reach this app. Deploy it (or tunnel with ngrok) and enter that URL.');
  }
  // The team's own callback path first, then the path everything used before
  // teams existed — so re-registering also clears away the old subscription
  // this deploy used to answer on, instead of leaving it firing forever.
  const result = await calendly.registerWebhook(token, publicUrl, [
    `/webhooks/calendly/${tenant.currentOrThrow('a Calendly registration')}`,
    '/webhooks/calendly',
  ]);
  if (result.signingKey) store.addCalendlyKey(db.settings, result.signingKey);
  db.settings.calendlyToken = token;
  if (!db.settings.calendlyUrl && result.schedulingUrl) db.settings.calendlyUrl = result.schedulingUrl;
  await store.save(db);
  // Re-registering IS the fix the warning asked for, so retire it here rather
  // than leaving it on screen for a day after the problem is gone.
  lastSignatureWarning.delete(tenant.currentOrThrow('a Calendly registration'));
  const cleared = await store.clearEvents(isCalendlySignatureWarning).catch(() => 0);
  res.json({ ok: true, ...result, signingKey: undefined, clearedWarnings: cleared });
}));

// Interview times are shown in the user's own time zone (auto-saved from the
// browser), both in the activity feed and on the phone.
function formatWhen(iso, timeZone) {
  if (!iso) return 'time TBD';
  const opts = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  try { return new Date(iso).toLocaleString('en-US', { ...opts, timeZone: timeZone || 'UTC' }); }
  catch { return new Date(iso).toLocaleString('en-US', { ...opts, timeZone: 'UTC' }); }
}

// Per team: when we last complained about a bad Calendly signature. One team's
// broken registration must not silence the warning for another's.
const lastSignatureWarning = new Map();

// Who booked? Email first — including addresses learned from earlier
// bookings — then a unique full-name match, because people often book with
// a different address (work vs personal) than the one on the sheet.
const normEmail = (e) => String(e || '').trim().toLowerCase();
// One booking: an event and the person booked into it.
const bookingKey = (uri, email) => `${uri || ''}|${normEmail(email)}`;
// Where a booking may move someone from on its own. Anything else — booked
// already, declined, or a status set by hand — is left alone.
const EARLY_STATUSES = new Set(['new', 'emailed', 'replied', 'bounced']);
// What this team has been told about each booking, kept apart from the
// interviews list (which every sync rebuilds from Calendly's listing): the
// Candidate-updates line, written by whichever of the sync and the webhook
// sees a booking first, and the phone push, which only the webhook sends —
// the sync reads a window of past and future bookings, and the first one
// after connecting Calendly would otherwise push every one of them. Keyed
// by booking; a cancellation's keys start with "x|". Long enough to outlast
// the sync's window, then let go.
const ANNOUNCED_KEEP_MS = 150 * 24 * 3600 * 1000;
function calendlyMemo(fresh, which) {
  const now = Date.now();
  const memo = fresh[which] && typeof fresh[which] === 'object' ? fresh[which] : {};
  for (const [k, ts] of Object.entries(memo)) if (!(now - Date.parse(ts) < ANNOUNCED_KEEP_MS)) delete memo[k];
  fresh[which] = memo;
  return memo;
}
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

// Every key this team has ever issued, newest first, plus the environment
// override. A subscription that outlived a cleanup still verifies.
function calendlyKeys(db) {
  return [
    ...(db.settings.calendlySigningKeys || []),
    db.settings.calendlySigningKey,
    // Set process-wide, so it belongs to the team that predates teams —
    // otherwise any team could verify, and claim, another team's bookings.
    tenant.isLegacy() ? process.env.CALENDLY_SIGNING_KEY : '',
  ].filter(Boolean);
}

// A booking, for the team already in context, already proven to be theirs.
async function applyCalendlyEvent(req, db) {
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
    // Calendly retries a delivery it is not sure arrived, and the sync may
    // already have listed this booking. The line in Candidate updates is
    // written once, by whichever got here first; the push is sent once, and
    // only from here.
    const key = bookingKey(ev.uri, inviteeEmail);
    let already = false;     // listed already: by the sync, or an earlier delivery
    let listed = false;      // its Candidate-updates line is written
    let pushed = false;      // its push is sent
    const booked = await store.update((fresh) => {
      already = Boolean(ev.uri) && (fresh.interviews || []).some((i) => i && i.status === 'active' && bookingKey(i.uri, i.inviteeEmail) === key);
      const announced = calendlyMemo(fresh, 'calendlyAnnounced');
      const pushes = calendlyMemo(fresh, 'calendlyPushed');
      listed = !ev.uri || Boolean(announced[key]);
      pushed = !ev.uri || Boolean(pushes[key]);
      const now = new Date().toISOString();
      if (ev.uri) { announced[key] = announced[key] || now; pushes[key] = pushes[key] || now; }
      const fc = c && fresh.candidates.find((x) => x.id === c.id);
      if (fc) {
        learnEmail(fc, inviteeEmail);
        if (EARLY_STATUSES.has(fc.status || 'new') || (!already && fc.status !== 'declined')) fc.status = 'booked';
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
          inviteePhone: calendly.phoneFrom(p), bookedAt: p.created_at || null,
          // When this row was written, so a sync whose listing was taken
          // before it does not drop it as gone.
          hookAt: new Date().toISOString(),
        });
        fresh.interviews.sort((x, y) => String(x.start).localeCompare(String(y.start)));
      }
    });
    await feedSalesiq(booked);
    // A reschedule arrives as a new booking that names the one it replaces.
    const moved = Boolean(p.old_invitee);
    if (!listed && !already) await store.addEvent('booked', `${inviteeName} ${moved ? 'rescheduled' : 'booked'} "${eventName}" — ${when}.`, c ? c.id : null, p.created_at || null);
    if (pushed) return;
    try {
      await notify.pushToPhone(db.settings, {
        title: moved ? `📅 ${inviteeName} rescheduled` : `📅 ${inviteeName} booked an interview`,
        message: `${eventName} — ${when}${c && c.role ? `\n${c.role}${c.company ? ' @ ' + c.company : ''}` : ''}`,
        tags: 'tada,calendar',
      });
    } catch (err) {
      await store.addErrorOnce(`Phone notification failed: ${err.message}`);
    }
  } else if (event === 'invitee.canceled') {
    const evUri = (p.scheduled_event && p.scheduled_event.uri) || '';
    // The old half of a reschedule: the new booking carries the news, so this
    // one neither un-books them nor says "canceled".
    const rescheduled = p.rescheduled === true;
    const key = `x|${bookingKey(evUri, inviteeEmail)}`;
    let listed = false;
    let pushed = false;
    const canceled = await store.update((fresh) => {
      const announced = calendlyMemo(fresh, 'calendlyAnnounced');
      const pushes = calendlyMemo(fresh, 'calendlyPushed');
      listed = !evUri || Boolean(announced[key]);
      pushed = !evUri || Boolean(pushes[key]);
      if (evUri && !rescheduled) {
        const now = new Date().toISOString();
        announced[key] = announced[key] || now;
        pushes[key] = pushes[key] || now;
      }
      const fc = c && fresh.candidates.find((x) => x.id === c.id);
      // Only the interview their card is showing: canceling an old one must
      // not un-book someone who has another on the books.
      if (fc && fc.status === 'booked' && fc.calendlyEventUri === evUri && !rescheduled) {
        fc.status = (fc.replies || []).some((r) => !r.kind) ? 'replied' : 'emailed';
        fc.bookedAt = null; fc.bookedEvent = ''; fc.calendlyEventUri = ''; fc.bookedJoinUrl = '';
      }
      for (const i of fresh.interviews || []) {
        if (i.uri === evUri && String(i.inviteeEmail || '').toLowerCase() === inviteeEmail) i.status = 'canceled';
      }
    });
    await feedSalesiq(canceled);
    // Announced once, whether the sync saw it first or Calendly delivers it
    // twice; the old half of a reschedule not at all.
    if (rescheduled) return;
    if (!listed) await store.addEvent('canceled', `${inviteeName} canceled "${eventName}".`, c ? c.id : null);
    if (pushed) return;
    try {
      await notify.pushToPhone(db.settings, {
        title: `❌ ${inviteeName} canceled`,
        message: `${eventName} was canceled.`,
        priority: 'default',
        tags: 'x',
      });
    } catch {}
  }
}

// Handle a call we have decided belongs to `team`: verify it against that
// team's keys and apply it. Nothing is applied on a signature we cannot check.
function calendlyWebhook(req, res, team) {
  return tenant.run(team.id, async () => {
    const db = await store.load();
    const keys = calendlyKeys(db);
    const header = req.get('Calendly-Webhook-Signature');
    if (!keys.length) {
      return res.status(401).json({ error: 'Calendly webhook is not registered (no signing key). Use "Enable booking alerts" in Settings.' });
    }
    if (!calendly.verifySignature(keys, header, req.rawBody)) {
      // This path is public and unauthenticated, so crawlers find it. Only a
      // call that actually carries a Calendly signature can be a key problem;
      // anything else is noise and must not be reported as a broken booking
      // setup, which is what made this warning keep coming back.
      const last = lastSignatureWarning.get(team.id) || 0;
      if (calendly.parseSignature(header) && Date.now() - last > 10 * 60 * 1000) {
        lastSignatureWarning.set(team.id, Date.now());
        await store.addErrorOnce(CALENDLY_SIGNATURE_WARNING);
      }
      return res.status(401).json({ error: 'Invalid Calendly signature' });
    }
    // A call that verifies proves the key is right, so the old warning goes.
    lastSignatureWarning.delete(team.id);
    await store.clearEvents(isCalendlySignatureWarning).catch(() => {});
    await applyCalendlyEvent(req, db);
    res.json({ ok: true });
  });
}

// What Calendly is told to call from now on: the team is in the path, because
// a webhook arrives with no session and nothing else to say whose booking it is.
app.post('/webhooks/calendly/:team', asyncRoute(async (req, res) => {
  const team = await teams.byId(req.params.team);
  if (!team) return res.status(404).json({ error: 'Unknown team.' });
  await calendlyWebhook(req, res, team);
}));

// Subscriptions registered before teams existed still call this path. The
// signature is the proof of ownership: whichever team can verify the call is
// the team that registered it. Re-registering from Settings moves them onto
// the path above.
app.post('/webhooks/calendly', asyncRoute(async (req, res) => {
  const header = req.get('Calendly-Webhook-Signature');
  // Not even shaped like a signed call: this is a crawler, and it gets nothing
  // and costs nothing.
  if (!calendly.parseSignature(header)) return res.status(401).json({ error: 'Invalid Calendly signature' });
  for (const t of await teams.all()) {
    const mine = await tenant.run(t.id, async () => {
      const db = await store.load();
      const keys = calendlyKeys(db);
      return keys.length > 0 && calendly.verifySignature(keys, header, req.rawBody);
    }).catch(() => false);
    if (mine) return calendlyWebhook(req, res, t);
  }
  // Nobody's key verifies it. This path belongs to the team that predates
  // teams — every other team registers under its own id — so that is the team
  // whose registration might genuinely be broken, and the one worth telling.
  // It is deliberately not "whoever happens to be first in the list": a "your
  // Calendly key is wrong" warning shown to a team that never registered here
  // is worse than silence, because the fix it asks for does nothing.
  const owner = await teams.byId(teams.LEGACY_ID);
  if (!owner) return res.status(401).json({ error: 'Invalid Calendly signature' });
  await calendlyWebhook(req, res, owner);
}));

// ---------- Calendly sync: pull scheduled interviews, match to candidates ----------
const DAY_MS = 24 * 3600 * 1000;
// Shared by the dashboard's sync button and by Sales IQ, which asks for one
// so that a booking reaches it while nobody has this dashboard open. Returns
// the body the dashboard's route has always answered with.
async function syncCalendly() {
  const db = await store.load();
  const token = db.settings.calendlyToken;
  if (!token) return { ok: true, unavailable: 'Add your Calendly token in Settings to sync interviews.' };
  const minStart = new Date(Date.now() - 14 * DAY_MS);
  const maxStart = new Date(Date.now() + 120 * DAY_MS);
  let result;
  // Rows the webhook writes after this moment are newer than the listing.
  const listedAt = Date.now();
  try {
    result = await calendly.listInterviews(token, { minStart, maxStart });
  } catch (err) {
    await store.update((d) => { d.calendlySyncError = err.message; d.calendlyLastSyncAt = new Date().toISOString(); });
    return { ok: false, error: err.message };
  }
  const announce = [];
  const synced = await store.update((fresh) => {
    announce.length = 0;   // the mutator re-runs on a conflict: collect afresh
    // Every booking this team has already been told about — what the last
    // sync listed and what the webhook has added since. A booking is
    // announced the first time its (event, invitee) pair shows up, and never
    // again. Deciding "new" from the one event a candidate's card shows made
    // anyone with two bookings (a first and a second interview, both inside
    // the window) flip between them and be announced twice on every sync.
    const known = new Set((fresh.interviews || []).filter((i) => i && i.status === 'active').map((i) => bookingKey(i.uri, i.inviteeEmail)));
    // And what it was told about before, even if the list has since lost it.
    const announced = calendlyMemo(fresh, 'calendlyAnnounced');
    const stamp = new Date().toISOString();
    for (const k of Object.keys(announced)) if (!k.startsWith('x|')) known.add(k);
    const list = [];
    const activeFor = new Map();     // candidate -> [{ ev, inv }], in listing order
    const canceledFor = new Map();
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
          inviteePhone: inv.phone || '', bookedAt: inv.createdAt || null,
        });
        if (!c) continue;
        const into = active ? activeFor : canceledFor;
        if (!into.has(c)) into.set(c, []);
        into.get(c).push({ ev, inv });
      }
    }
    for (const [c, pairs] of activeFor) {
      // The card shows one interview: the first the listing gives (it lists
      // upcoming ones soonest first, then past ones latest first), so the
      // next one coming up, or else the most recent.
      const { ev } = pairs[0];
      const isNewAny = pairs.some(({ ev: e, inv }) => !known.has(bookingKey(e.uri, inv.email)));
      c.bookedAt = ev.start;
      c.bookedEvent = ev.name;
      c.calendlyEventUri = ev.uri;
      c.bookedJoinUrl = ev.joinUrl || '';
      // Only moved forward from earlier in the funnel, or on a booking nobody
      // has seen yet; a status set by hand is not undone every five minutes.
      if (EARLY_STATUSES.has(c.status || 'new') || (isNewAny && c.status !== 'declined')) c.status = 'booked';
      for (const { ev: e, inv } of pairs) {
        const key = bookingKey(e.uri, inv.email);
        const seen = known.has(key);
        // Remembered either way, so a list that later loses the row (a
        // listing cut short) never makes it news again.
        announced[key] = announced[key] || stamp;
        if (seen) continue;
        known.add(key);
        announce.push({ c, ev: e, at: inv.createdAt || null });
      }
    }
    for (const [c, pairs] of canceledFor) {
      if (activeFor.has(c)) continue;          // still has an interview on the books
      for (const { ev, inv } of pairs) {
        if (c.calendlyEventUri !== ev.uri || c.status !== 'booked') continue;
        c.status = (c.replies && c.replies.length) ? 'replied' : 'emailed';
        c.bookedAt = null; c.bookedEvent = ''; c.calendlyEventUri = ''; c.bookedJoinUrl = '';
        const key = `x|${bookingKey(ev.uri, inv.email)}`;
        if (announced[key]) continue;          // the webhook said so already
        announced[key] = stamp;
        announce.push({ c, ev, canceled: true });
      }
    }
    // What this sync did not read is kept as it was, rather than replaced by
    // nothing: an event it listed but had no allowance left for (only a
    // cancellation is carried over), and, when the listing stopped short of
    // the window's end, anything it never reached. A booking the webhook has
    // just brought in is one of those, and Sales IQ, which asks for a sync
    // every time it looks, would otherwise see it vanish. Only what a full
    // listing no longer has, or what has left the window, is let go.
    const read = new Set(result.interviews.map((ev) => ev.uri));
    const skipped = new Map((result.skipped || []).map((ev) => [ev.uri, ev]));
    for (const i of fresh.interviews || []) {
      if (!i || read.has(i.uri)) continue;
      const at = new Date(i.start).getTime();
      if (!(at >= minStart.getTime() && at <= maxStart.getTime())) continue;
      const ev = skipped.get(i.uri);
      // Gone from a full listing: let go — unless the webhook wrote it after
      // the listing was taken, when the listing simply had not seen it yet.
      if (!ev && result.complete && !(i.hookAt && Date.parse(i.hookAt) >= listedAt)) continue;
      list.push(ev && ev.status !== 'active' ? { ...i, status: 'canceled' } : i);
    }
    fresh.interviews = list.sort((a, b) => String(a.start).localeCompare(String(b.start)));
    fresh.calendlyLastSyncAt = new Date().toISOString();
    fresh.calendlySyncError = '';
  });
  await feedSalesiq(synced);
  for (const a of announce) {
    const who = a.c.name || a.c.email;
    await store.addEvent(
      a.canceled ? 'canceled' : 'booked',
      a.canceled ? `${who} canceled "${a.ev.name}".` : `${who} booked "${a.ev.name}" — ${formatWhen(a.ev.start, db.settings.timeZone)}.`,
      a.c.id,
      a.at || null
    );
  }
  return { ok: true, interviews: result.interviews.length, newBookings: announce.filter((a) => !a.canceled).length };
}

app.post('/api/calendly/sync', asyncRoute(async (_req, res) => {
  res.json(await syncCalendly());
}));

// ---------- Sales IQ: booked interviewees, and nothing else ----------
// The Sales IQ hiring dashboard lists everyone who has booked an interview on
// this team's Calendly so the manager can send them a questionnaire. That list
// is ALL it gets from here: no candidate ids, notes, replies, statuses, or
// anything else from outreach. /api/salesiq/* answers only to the connection
// code's token (see lib/auth.js); /api/salesiq-connection, which hands that
// code out, answers only to a signed-in dashboard, and deliberately sits
// outside that prefix.
const SALESIQ_CODE_PREFIX = 'WPSIQ1.';
const SALESIQ_SYNC_EVERY_MS = 90 * 1000;

// Everything Sales IQ needs to find this deploy and prove which team it is
// reading for, in one string that survives being pasted into a text box.
function salesiqCode(team, token) {
  const body = { u: google.baseUrl(), k: token, t: team.name, i: team.id };
  return SALESIQ_CODE_PREFIX + Buffer.from(JSON.stringify(body)).toString('base64url');
}

// Connected means the code shown would actually be let in: a token in the
// team's settings AND its fingerprint in the registry, which is what the
// bearer check reads. A write that failed half way leaves the two apart, and a
// code that is shown but refused is worse than an honest "Not connected" with
// a button that fixes it.
function salesiqConnection(team, token) {
  const live = Boolean(token) && Boolean(team && team.salesiqTokenHash) && team.salesiqTokenHash === teams.fingerprint(token);
  return {
    connected: live,
    code: live ? salesiqCode(team, token) : '',
    team: teamName(team),
    baseUrl: google.baseUrl(),
  };
}

app.get('/api/salesiq-connection', asyncRoute(async (req, res) => {
  const db = await store.load();
  res.set('Cache-Control', 'no-store');
  res.json(salesiqConnection(req.team, db.settings.salesiqToken || ''));
}));

// A change answers with what is stored once its writes are done, read back,
// not with the token it just made. Two Generates at once can end with one's
// fingerprint in the registry and the other's token in settings, and the
// request that lost must say "Not connected" rather than show a code the
// bearer check refuses.
async function storedSalesiqConnection(id) {
  const [team, db] = await Promise.all([teams.byId(id), store.load()]);
  return salesiqConnection(team, db.settings.salesiqToken || '');
}

// Always a new token: whoever holds the old code loses access the moment this
// returns. The registry is written first because it is what the bearer check
// reads — so if the second write fails, the old code has still stopped
// working, rather than the dashboard offering a new code that is refused while
// the old one carries on.
app.post('/api/salesiq-connection', asyncRoute(async (req, res) => {
  const id = tenant.currentOrThrow('a Sales IQ connection');
  const token = crypto.randomBytes(32).toString('base64url');
  await teams.setSalesiqToken(id, token);
  auth.forgetSalesiqSecret();
  await store.update((db) => { db.settings.salesiqToken = token; });
  res.set('Cache-Control', 'no-store');
  res.json(await storedSalesiqConnection(id));
}));

// Disconnecting revokes in the same order: the fingerprint goes first, so the
// code stops working even if clearing the stored copy then fails.
app.delete('/api/salesiq-connection', asyncRoute(async (req, res) => {
  const id = tenant.currentOrThrow('a Sales IQ connection');
  await teams.setSalesiqToken(id, '');
  auth.forgetSalesiqSecret();
  await store.update((db) => {
    if (!db.settings.salesiqToken) return false;
    db.settings.salesiqToken = '';
  });
  res.set('Cache-Control', 'no-store');
  res.json(await storedSalesiqConnection(id));
}));

// Everyone who booked, from lib/salesiq.js — the same list, and the same
// booking keys, as the built-in Sales IQ page folds into its candidates. The
// pipeline candidate each booking was matched to stays behind: this feed has
// never carried anybody's candidate id.
app.get('/api/salesiq/bookings', asyncRoute(async (req, res) => {
  const db = await store.load();
  const bookings = salesiq.bookingsFrom(db).map(({ crmId, ...b }) => b);
  res.json({
    ok: true,
    team: teamName(req.team),
    syncedAt: db.calendlyLastSyncAt || null,
    calendly: {
      sync: Boolean(db.settings.calendlyToken),
      webhook: Boolean((db.settings.calendlySigningKeys || []).length || db.settings.calendlySigningKey),
    },
    bookings,
  });
}));

// Sales IQ asks for this whenever it looks, and it may be open in several tabs
// on several machines; Calendly's API is shared by all of them. So a sync runs
// only when the last one — from anywhere, the dashboard included — is more
// than a minute and a half old. A failed sync stamps the time too, so a broken
// Calendly token is not retried on every look either. A stamp in the future
// is not believed.
//
// The slot is claimed before Calendly is called, in a conditional write, and
// not merely checked: a sync takes dozens of calls, and everyone who asked
// while it ran used to see the old stamp and start one of their own. Within
// one instance, whoever asks while that team's sync is running waits for it
// and shares its answer.
const salesiqSyncing = new Map();   // team id -> the sync under way
const recentStamp = (iso) => {
  const age = Date.now() - new Date(iso || 0).getTime();
  return Boolean(iso) && Number.isFinite(age) && age >= 0 && age < SALESIQ_SYNC_EVERY_MS;
};

async function salesiqSync() {
  let claimed = false;
  const db = await store.update((d) => {
    claimed = false;   // the mutator re-runs on a conflict
    if (!d.settings.calendlyToken) return false;
    if (recentStamp(d.calendlyLastSyncAt) || recentStamp(d.salesiqSyncClaimedAt)) return false;
    d.salesiqSyncClaimedAt = new Date().toISOString();
    claimed = true;
  });
  if (!claimed) return { ok: true, ran: false, syncedAt: db.calendlyLastSyncAt || null };
  const result = await syncCalendly();
  const syncedAt = (await store.load()).calendlyLastSyncAt || null;
  return { ok: true, ran: true, syncedAt, ...result };
}

// One sync per team at a time, shared by everyone who asks while it runs —
// the external Sales IQ app and the built-in Sales IQ page alike.
function sharedSalesiqSync(id) {
  let running = salesiqSyncing.get(id);
  if (!running) {
    running = salesiqSync().finally(() => salesiqSyncing.delete(id));
    salesiqSyncing.set(id, running);
  }
  return running;
}

app.post('/api/salesiq/sync', asyncRoute(async (req, res) => {
  res.json(await sharedSalesiqSync(req.team.id));
}));

// ---------- Sales IQ, built in ----------
// The questionnaire and its hiring dashboard, as part of this app. The
// dashboard's routes sit under /api/iq/ behind the team sign-in like every
// other page; the candidate's two routes sit under /api/assessment/, which is
// open (see lib/auth.js) because the person answering is not signed in to
// anything — each call proves which team and which candidate it is for with
// the signed token in their link, and is refused without one.

// New Calendly bookings into the team's Sales IQ list. Never allowed to fail
// the thing that called it: a booking is recorded whether or not this works,
// and the next look at the Sales IQ page folds it in anyway.
async function feedSalesiq(db) {
  try { return await salesiq.syncBookings(db); }
  catch (err) { console.error('[salesiq] folding in bookings failed:', err && err.message); return []; }
}

const IQ_SEND_PER_REQUEST = 5;
const IQ_OWN_COMPANY = 'That is a Wholesale Payments address — Sales IQ is for candidates, not the team.';
const REPORT_ID_RE = /^r[0-9a-f]{18}$/;

async function iqState(req) {
  const db = await store.load();
  await feedSalesiq(db);
  const [doc, secret] = await Promise.all([salesiq.load(), salesiq.ensureSecret()]);
  const sending = await mailer.sendStatus(db.settings);
  const base = google.baseUrl();
  return {
    ok: true,
    company: salesiq.COMPANY,
    teams: salesiq.TEAMS,
    tiers: salesiq.tiers(),
    hostTeam: teamName(req.team),
    settings: doc.settings,
    candidates: doc.candidates.map((c) => salesiq.publicCandidate(c, secret, base, req.team.id)),
    reports: doc.reports.map(salesiq.publicReport),
    calendly: {
      syncEnabled: Boolean(db.settings.calendlyToken),
      webhook: Boolean((db.settings.calendlySigningKeys || []).length || db.settings.calendlySigningKey),
      lastSyncAt: db.calendlyLastSyncAt || null,
      error: db.calendlySyncError || '',
    },
    mail: { ready: Boolean(sending.ready), from: sending.from || '', reason: sending.reason || '' },
    previewUrl: '/assessment/?preview=1',
  };
}

// Tagged like /api/state, so the page's 30-second look costs a 304 when
// nothing has moved.
app.get('/api/iq/state', asyncRoute(async (req, res) => {
  const payload = await iqState(req);
  const body = JSON.stringify(payload);
  const etag = `W/"${crypto.createHash('sha1').update(`${tenant.current() || '-'}:iq:${body}`).digest('base64url')}"`;
  res.set('ETag', etag);
  res.set('Cache-Control', 'no-cache, private');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  return res.type('application/json').send(body);
}));

function iqCandidateInput(body, { partial = false } = {}) {
  const out = {};
  for (const [k, max] of [['name', 120], ['email', 254], ['phone', 40]]) {
    if (body[k] === undefined) { if (!partial) out[k] = ''; continue; }
    out[k] = salesiq.str(body[k], max);
  }
  if (out.name !== undefined && out.name.length < 2) throw new Error('Please enter a name.');
  if (out.email !== undefined && !salesiq.EMAIL_RE.test(out.email)) throw new Error('Please enter a valid email address.');
  if (out.email && salesiq.isOwnCompanyEmail(out.email)) throw new Error(IQ_OWN_COMPANY);
  return out;
}

app.post('/api/iq/candidates', asyncRoute(async (req, res) => {
  const input = iqCandidateInput(req.body || {});
  const source = ['resume', 'manual'].includes(req.body && req.body.source) ? req.body.source : 'manual';
  const cand = { id: salesiq.newCandidateId(), ...input, status: 'added', added: new Date().toISOString(), source };
  await salesiq.update((doc) => { doc.candidates = [cand, ...doc.candidates.filter((c) => c.id !== cand.id)]; });
  res.json({ ok: true, id: cand.id });
}));

// Only what the manager changed: a sync while the sheet was open (a booking
// filling in the phone) must not be undone by the values it was opened with.
app.patch('/api/iq/candidates/:id', asyncRoute(async (req, res) => {
  const edits = iqCandidateInput(req.body || {}, { partial: true });
  let found = false;
  await salesiq.update((doc) => {
    const c = doc.candidates.find((x) => x.id === req.params.id);
    found = Boolean(c);
    if (!c) return false;
    Object.assign(c, edits);
  });
  if (!found) return res.status(404).json({ error: 'That candidate is no longer on the list.' });
  res.json({ ok: true });
}));

// Off the list. Who they were is kept aside, so a link already in their inbox
// still files their answers under their name rather than "unknown".
app.delete('/api/iq/candidates/:id', asyncRoute(async (req, res) => {
  await salesiq.update((doc) => {
    const c = doc.candidates.find((x) => x.id === req.params.id);
    if (!c) return false;
    doc.candidates = doc.candidates.filter((x) => x.id !== c.id);
    doc.removed = [{ id: c.id, name: c.name || '', email: c.email || '', phone: c.phone || '', crmId: c.crmId || null, at: new Date().toISOString() },
      ...(doc.removed || []).filter((x) => x.id !== c.id)].slice(0, 2000);
  });
  res.json({ ok: true });
}));

app.put('/api/iq/settings', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const managerEmail = salesiq.str(b.managerEmail, 254);
  if (managerEmail && !salesiq.EMAIL_RE.test(managerEmail)) throw new Error('Please enter a valid results email.');
  const team = salesiq.TEAMS.some((t) => t.name === b.team) ? b.team : '';
  const doc = await salesiq.update((d) => {
    if (d.settings.team === team && d.settings.managerEmail === managerEmail) return false;
    d.settings = { team, managerEmail };
  });
  res.json({ ok: true, settings: doc.settings });
}));

app.delete('/api/iq/reports/:id', asyncRoute(async (req, res) => {
  await salesiq.update((doc) => {
    const before = doc.reports.length;
    doc.reports = doc.reports.filter((r) => r.id !== req.params.id);
    if (doc.reports.length === before) return false;
  });
  res.json({ ok: true });
}));

// Invites, each its own email with its own link, from the team's own mailbox.
// A few per request so a long list cannot outrun the function's time limit;
// the page asks again for the rest. Each person is claimed before their email
// goes and marked as sent the moment it has, so neither a request cut off part
// way nor two devices pressing Send at once can email anyone twice.
// `onlyNew` is the send-to-everyone button: it sends to people still marked
// Not sent and skips anyone another device has sent to since.
const IQ_CLAIM_MS = 2 * 60 * 1000;
async function sendIqInvites(ids, { onlyNew = false } = {}) {
  const db = await store.load();
  const [doc, secret] = await Promise.all([salesiq.load(), salesiq.ensureSecret()]);
  if (!doc.settings.managerEmail) {
    const e = new Error('Choose your team under Results delivery first — completed questionnaires are sent there.');
    e.needsResults = true;
    throw e;
  }
  const status = await mailer.sendStatus(db.settings);
  if (!status.ready) return { ok: false, needsMail: true, reason: status.reason || '' };
  const want = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  const batch = want.slice(0, IQ_SEND_PER_REQUEST);
  const rest = want.slice(IQ_SEND_PER_REQUEST);
  const failed = [];
  const skipped = [];
  const claimAt = new Date().toISOString();
  let claimed = [];
  await salesiq.update((d) => {
    claimed = [];
    for (const id of batch) {
      const c = d.candidates.find((x) => x.id === id);
      if (!c || c.status === 'completed') continue;
      if (onlyNew && (c.status || 'added') !== 'added') continue;
      if (c.sendingAt && Date.now() - Date.parse(c.sendingAt) < IQ_CLAIM_MS) continue;
      c.sendingAt = claimAt;
      claimed.push(id);
    }
    if (!claimed.length) return false;
  });
  for (const id of batch) {
    if (claimed.includes(id)) continue;
    const c = doc.candidates.find((x) => x.id === id);
    if (!c) failed.push({ id, error: 'No longer on the list.' });
    else if (c.status === 'completed') failed.push({ id, error: 'Already completed the questionnaire.' });
    else skipped.push(id);
  }
  const sent = [];
  const base = google.baseUrl();
  const teamId = tenant.currentOrThrow('a questionnaire link');
  for (const id of claimed) {
    const c = doc.candidates.find((x) => x.id === id);
    const link = salesiq.linkFor(base, salesiq.tokenFor(secret, teamId, id));
    const text = salesiq.inviteText(c, link);
    let error = '';
    try {
      await mailer.sendEmail(db.settings, { to: c.email, subject: salesiq.inviteSubject(), text, html: salesiq.textToHtml(text) });
    } catch (err) {
      error = err.message || String(err);
    }
    const at = new Date().toISOString();
    await salesiq.update((d) => {
      const x = d.candidates.find((y) => y.id === id);
      if (!x) return false;
      delete x.sendingAt;
      if (error) return;
      if (x.status !== 'completed') x.status = 'invited';
      x.invitedAt = at;
      x.invitedVia = 'email';
    });
    if (error) failed.push({ id, error }); else sent.push(id);
  }
  return { ok: true, sent, failed, skipped, remaining: rest, from: status.from || '' };
}

app.post('/api/iq/invite', asyncRoute(async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await sendIqInvites(b.ids, { onlyNew: b.onlyNew === true }));
  } catch (err) {
    if (err.needsResults) return res.status(400).json({ error: err.message, needsResults: true });
    throw err;
  }
}));

// With no mailbox connected the page opens a ready-to-send draft on the
// device instead, one person at a time, and marks them here as it does.
app.post('/api/iq/mark-invited', asyncRoute(async (req, res) => {
  const ids = new Set((Array.isArray((req.body || {}).ids) ? req.body.ids : []).map(String));
  const at = new Date().toISOString();
  await salesiq.update((doc) => {
    let changed = false;
    for (const c of doc.candidates) {
      if (!ids.has(c.id) || c.status === 'completed') continue;
      c.status = 'invited';
      c.invitedAt = at;
      c.invitedVia = 'draft';
      changed = true;
    }
    if (!changed) return false;
  });
  res.json({ ok: true });
}));

// The same shared, throttled Calendly sync the external app uses, then the
// bookings into the list.
app.post('/api/iq/sync', asyncRoute(async (req, res) => {
  const r = await sharedSalesiqSync(req.team.id);
  const added = await feedSalesiq(await store.load());
  res.json({ ...r, added: added.length });
}));

// A report link from the standalone Sales IQ app's results email.
app.post('/api/iq/import-report', asyncRoute(async (req, res) => {
  const p = salesiq.unseal((req.body || {}).code);
  const scored = salesiq.score(p.answers);
  const entry = {
    id: p.id, name: p.name, email: p.email, phone: p.phone,
    score: scored.score, tier: scored.tier.label, tierKey: scored.tier.key, categories: scored.categories,
    durationSec: p.durationSec, completedAt: p.completedAt, answers: p.answers, source: 'link',
  };
  let official = null;
  let filed = null;
  await salesiq.update((doc) => {
    const reports = doc.reports.map((r) => ({ ...r }));
    official = salesiq.fileReport(reports, { ...entry });
    doc.reports = reports.slice(0, 1000);
    filed = doc.reports.find((r) => r.id === entry.id) || null;
    const cand = p.email && doc.candidates.find((c) => salesiq.sameEmail(c.email, p.email));
    if (cand) {
      cand.status = 'completed';
      cand.score = official.score;
      cand.durationSec = official.durationSec;
      cand.completedAt = cand.completedAt || official.completedAt;
    }
  });
  res.json({ ok: true, report: filed ? salesiq.publicReport(filed) : null, official: official ? official.score : null, retake: Boolean(filed && filed.retake), name: p.name || p.email || 'Unidentified candidate', tier: scored.tier.label, score: scored.score });
}));

// "Send questionnaire" from a pipeline candidate: onto the Sales IQ list (or
// matched to who is already there, by address) and sent.
// A Candidates-page person on the Sales IQ list: found by their id there or
// their email, or added. Never anyone twice.
function upsertIqFromPipeline(doc, pc) {
  let c = doc.candidates.find((x) => x.crmId === pc.id) || doc.candidates.find((x) => salesiq.sameEmail(x.email, pc.email));
  let added = false;
  if (!c) {
    c = {
      id: salesiq.newCandidateId(),
      name: salesiq.str(pc.name || `${pc.firstName || ''} ${pc.lastName || ''}`, 120) || salesiq.str(pc.email, 254),
      email: salesiq.str(pc.email, 254),
      phone: salesiq.str(pc.phone, 40),
      status: 'added',
      added: new Date().toISOString(),
      source: 'pipeline',
      crmId: pc.id,
    };
    doc.candidates.unshift(c);
    added = true;
  } else {
    if (!c.crmId) c.crmId = pc.id;
    if (!c.phone && pc.phone) c.phone = salesiq.str(pc.phone, 40);
  }
  return { c, added };
}

// Onto the Sales IQ list from the Candidates page — one person or a selection
// — without sending anything yet: the questionnaire goes out from the Sales IQ
// page (or Send Sales IQ on the row) when you are ready.
app.post('/api/iq/add-from-pipeline', asyncRoute(async (req, res) => {
  const ids = [...new Set((Array.isArray((req.body || {}).ids) ? req.body.ids : []).map(String))].slice(0, 500);
  if (!ids.length) throw new Error('Choose who to add to Sales IQ.');
  const db = await store.load();
  const byId = new Map(db.candidates.map((c) => [c.id, c]));
  const out = { added: [], already: [], refused: [] };
  await salesiq.update((doc) => {
    // Re-run from the top if another write landed first.
    out.added = []; out.already = []; out.refused = [];
    for (const id of ids) {
      const pc = byId.get(id);
      if (!pc) { out.refused.push({ id, error: 'No longer on the list.' }); continue; }
      if (!salesiq.EMAIL_RE.test(String(pc.email || ''))) { out.refused.push({ id, error: 'No email address.' }); continue; }
      if (salesiq.isOwnCompanyEmail(pc.email)) { out.refused.push({ id, error: IQ_OWN_COMPANY }); continue; }
      (upsertIqFromPipeline(doc, pc).added ? out.added : out.already).push(id);
    }
    if (!out.added.length) return false;
  });
  res.json({ ok: true, ...out });
}));

app.post('/api/iq/from-pipeline', asyncRoute(async (req, res) => {
  const id = String((req.body || {}).candidateId || '');
  const db = await store.load();
  const pc = db.candidates.find((c) => c.id === id);
  if (!pc) return res.status(404).json({ error: 'That candidate is no longer in your pipeline.' });
  if (!salesiq.EMAIL_RE.test(String(pc.email || ''))) throw new Error(`${pc.name || 'This candidate'} has no email address to send the questionnaire to.`);
  if (salesiq.isOwnCompanyEmail(pc.email)) throw new Error(IQ_OWN_COMPANY);
  let rosterId = '';
  let status = 'added';
  await salesiq.update((doc) => {
    const { c } = upsertIqFromPipeline(doc, pc);
    rosterId = c.id;
    status = c.status || 'added';
  });
  if (status === 'completed') {
    return res.json({ ok: true, id: rosterId, status, already: true });
  }
  try {
    const r = await sendIqInvites([rosterId]);
    if (r.needsMail) {
      const [doc, secret] = await Promise.all([salesiq.load(), salesiq.ensureSecret()]);
      const c = doc.candidates.find((x) => x.id === rosterId);
      const link = salesiq.linkFor(google.baseUrl(), salesiq.tokenFor(secret, req.team.id, rosterId));
      return res.json({ ok: true, id: rosterId, needsMail: true, draft: { to: c.email, subject: salesiq.inviteSubject(), body: salesiq.inviteText(c, link) } });
    }
    if (r.failed.length) throw new Error(r.failed[0].error);
    if (!r.sent.length) throw new Error('Their invitation is being sent from another device right now.');
    res.json({ ok: true, id: rosterId, status: 'invited', sent: true });
  } catch (err) {
    if (err.needsResults) return res.status(400).json({ error: err.message, needsResults: true, id: rosterId });
    throw err;
  }
}));

// ---- the candidate's side: open, but only to a signed link ----
// Which team and which candidate a link is for, proven by its signature.
// Crawlers find open routes, so nothing is read for something that is not even
// shaped like a token, and an unknown team costs one registry read.
async function assessmentContext(tok) {
  const parsed = salesiq.parseToken(tok);
  if (!parsed) return null;
  const team = await teams.byId(parsed.teamId);
  if (!team) return null;
  return tenant.run(team.id, async () => {
    if (!salesiq.verifyToken(await salesiq.readSecret(), parsed)) return null;
    const doc = await salesiq.load();
    const cand = doc.candidates.find((c) => c.id === parsed.candId)
      || (doc.removed || []).find((c) => c.id === parsed.candId)
      || null;
    return { team, doc, cand, candId: parsed.candId };
  });
}

const LINK_REFUSED = 'This questionnaire link isn’t valid — it may have been copied incompletely. Please contact your recruiter for a new link.';

app.get('/api/assessment/session', asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const base = { ok: true, company: salesiq.COMPANY, questions: salesiq.publicQuestions(), version: salesiq.QUESTIONS_VERSION };
  if (req.query.preview === '1') return res.json({ ...base, preview: true, candidate: null, done: null });
  const ctx = await assessmentContext(req.query.t);
  if (!ctx || !ctx.cand) return res.status(404).json({ error: LINK_REFUSED, invalid: true });
  const mine = ctx.doc.reports
    .filter((r) => r.candidateId === ctx.candId)
    .sort((a, b) => String(a.completedAt || '').localeCompare(String(b.completedAt || '')));
  res.json({
    ...base,
    preview: false,
    candidate: { name: ctx.cand.name || '', email: ctx.cand.email || '' },
    done: mine.length ? { id: mine[0].id, completedAt: mine[0].completedAt } : null,
  });
}));

// Scored here, filed, and passed on: onto the dashboard, into the candidate
// updates, to the team's phone, and emailed to the results address. The
// candidate is told only that it arrived.
app.post('/api/assessment/submit', asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const b = req.body || {};
  const ctx = await assessmentContext(b.t);
  if (!ctx || !ctx.cand) return res.status(404).json({ error: LINK_REFUSED, invalid: true });
  if (!salesiq.validAnswers(b.answers)) return res.status(400).json({ error: 'Some answers are missing — please go back and answer every question.' });
  const reportId = REPORT_ID_RE.test(String(b.id || '')) ? String(b.id) : salesiq.newReportId();
  const dur = Number(b.durationSec);
  const durationSec = Number.isFinite(dur) && dur >= 1 && dur <= 7 * 24 * 3600 ? Math.round(dur) : null;
  const scored = salesiq.score(b.answers);
  const who = ctx.cand;

  await tenant.run(ctx.team.id, async () => {
    await salesiq.update((doc) => {
      if (doc.reports.some((r) => r.id === reportId)) return false;   // already filed: a retry
      const theirs = doc.reports.filter((r) => r.candidateId === ctx.candId || salesiq.sameEmail(r.email, who.email));
      if (theirs.length >= salesiq.MAX_REPORTS_PER_PERSON) return false;
      const entry = {
        id: reportId,
        candidateId: ctx.candId,
        name: who.name || '',
        email: who.email || '',
        phone: who.phone || '',
        score: scored.score,
        tier: scored.tier.label,
        tierKey: scored.tier.key,
        categories: scored.categories,
        durationSec,
        completedAt: new Date().toISOString(),
        answers: b.answers.slice(),
      };
      const reports = doc.reports.map((r) => ({ ...r }));
      const official = salesiq.fileReport(reports, entry);
      doc.reports = reports.slice(0, 1000);
      const cand = doc.candidates.find((c) => c.id === ctx.candId);
      if (cand) {
        cand.status = 'completed';
        cand.score = official.score;
        cand.durationSec = official.durationSec;
        cand.completedAt = official.completedAt;
      }
    });
    await notifyIqCompletion(reportId, ctx);
  });
  res.json({ ok: true });
}));

// Everyone told about a finished questionnaire: the candidate updates feed,
// the team's phone, and the results address. Claimed first, and marked done
// after, so a retry of the same submission — the page retries until it hears
// back — finishes whatever the first attempt did not get to, and two at once
// never tell anyone twice.
const IQ_NOTIFY_CLAIM_MS = 2 * 60 * 1000;
async function notifyIqCompletion(reportId, ctx) {
  let filed = null;
  let official = null;
  let crmId = ctx.cand.crmId || null;
  let managerEmail = '';
  await salesiq.update((doc) => {
    filed = null;
    const r = doc.reports.find((x) => x.id === reportId);
    if (!r || r.notifiedAt) return false;
    if (r.notifyClaimAt && Date.now() - Date.parse(r.notifyClaimAt) < IQ_NOTIFY_CLAIM_MS) return false;
    r.notifyClaimAt = new Date().toISOString();
    filed = { ...r };
    official = doc.reports
      .filter((x) => salesiq.sameEmail(x.email, r.email) || x.id === r.id)
      .sort((a, b) => String(a.completedAt || '').localeCompare(String(b.completedAt || '')))[0] || r;
    const cand = doc.candidates.find((c) => c.id === r.candidateId);
    if (cand && cand.crmId) crmId = cand.crmId;
    managerEmail = doc.settings.managerEmail;
  });
  if (!filed) return;

  const db = await store.load();
  const name = filed.name || filed.email || 'A candidate';
  const pipeline = crmId && db.candidates.some((c) => c.id === crmId)
    ? crmId
    : ((db.candidates.find((c) => salesiq.sameEmail(c.email, filed.email) || (c.altEmails || []).some((e) => salesiq.sameEmail(e, filed.email))) || {}).id || null);
  const message = filed.retake
    ? `${name} took the Sales IQ questionnaire again — ${filed.score}/100. Their first score (${official.score}/100) stands.`
    : `${name} completed the Sales IQ questionnaire — ${filed.score}/100, ${filed.tier}.`;
  await store.addEvent('assessed', message, pipeline, filed.completedAt).catch((err) => console.error('[salesiq] feed:', err.message));
  try {
    await notify.pushToPhone(db.settings, {
      title: `📋 ${name} completed the questionnaire`,
      message: filed.retake ? `Retake: ${filed.score}/100 — their first score (${official.score}/100) stands.` : `${filed.score}/100 · ${filed.tier}`,
      priority: 'default',
      tags: 'clipboard',
    });
  } catch (err) {
    await store.addErrorOnce(`Phone notification failed: ${err.message}`).catch(() => {});
  }
  // Emailed to the results address from the team's own mailbox. The report
  // is on the dashboard whether or not this goes; what happened is noted on
  // it either way.
  let emailedTo = '';
  let emailError = '';
  if (managerEmail) {
    try {
      const text = salesiq.resultsText(filed, { timeZone: db.settings.timeZone, reportLink: salesiq.reportLinkFor(google.baseUrl(), filed.id) });
      await mailer.sendEmail(db.settings, { to: managerEmail, subject: salesiq.resultsSubject(filed), text, html: salesiq.textToHtml(text) });
      emailedTo = managerEmail;
    } catch (err) {
      emailError = err.message || String(err);
    }
  } else {
    emailError = 'No results email is set on the Sales IQ page.';
  }
  await salesiq.update((doc) => {
    const r = doc.reports.find((x) => x.id === filed.id);
    if (!r) return false;
    r.notifiedAt = new Date().toISOString();
    delete r.notifyClaimAt;
    r.emailedTo = emailedTo;
    r.emailError = emailError;
  }).catch(() => {});
}

// ---------- Onboarding docs, built in ----------
// WPI Hire — the onboarding pipeline, hiring into BambooHR, and the new-hire
// paperwork portal with its e-signatures — as a page of this app. Its routes
// are in lib/onboarding-routes.js: /api/onboarding/* behind the team sign-in,
// and the hire's two, /api/paperwork/*, open to a signed link only.
app.use(onboardingRoutes.router);

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
