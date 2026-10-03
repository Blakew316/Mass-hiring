// Sales IQ — the sales talent questionnaire and its hiring dashboard, built
// into this app rather than living on a site of its own.
//
// Everything the standalone Sales IQ app kept in one browser's localStorage —
// the candidate list, the reports, the results email, which bookings it had
// already acted on — is kept here instead, per team, next to the rest of the
// team's data. So it is the same on every device the team signs in from, and a
// candidate who finishes on their own phone lands on the dashboard directly
// rather than by way of an email and a pasted link.
//
// What stays exactly as it was:
//   - the ten questions, their scoring and the four tiers (lib/salesiq-questions.js)
//   - a candidate never sees a score: their page is sent the question text and
//     nothing else, and scoring happens here when the answers arrive
//   - a candidate's first report is the one that counts; any later one is
//     filed as a retake and never replaces it
//   - bookings are folded in once per booking: someone removed stays removed
//     (a reschedule does not bring them back), a booking canceled before
//     anything was sent is flagged, and nothing is ever sent automatically.
const crypto = require('crypto');
const storage = require('./storage');
const { CATEGORIES, QUESTIONS, MAX_POINTS_PER_QUESTION, TIERS, tierForScore } = require('./salesiq-questions');

const KEY = 'salesiq';
const COMPANY = 'Wholesale Payments';
const MAX_CANDIDATES = 3000;
const MAX_REPORTS = 1000;
// One person can finish more than once (a second link after being removed and
// added again), and each finish is kept as a retake. Past this many it is not
// a candidate any more, it is something hammering the link.
const MAX_REPORTS_PER_PERSON = 6;
const DAY_MS = 24 * 3600 * 1000;
const SEEN_KEEP_MS = 200 * DAY_MS;

// The teams the dashboard's picker offers — choosing one fills the results
// email with that team lead's address. Copied from the Sales IQ app's config.
const TEAMS = [
  { name: 'Team Indigo', email: 'erik.demster@wholesalepayments.com' },
  { name: 'Team Mahogany', email: 'walker.hall@wholesalepayments.com' },
  { name: 'Team Chrome', email: 'donovan.staggs@wholesalepayments.com' },
  { name: 'Team Shadow', email: 'bobby.ingram@wholesalepayments.com' },
  { name: 'Team Maverick', email: 'justin.woodruff@wholesalepayments.com' },
  { name: 'Team Mercury', email: 'michael.reed@wholesalepayments.com' },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Nobody at Wholesale Payments is a candidate: the questionnaire is never
// sent to one of the team, and their bookings are never folded in as one.
const OWN_COMPANY_RE = /@(?:[a-z0-9-]+\.)*wholesalepayments\.com$/i;
const isOwnCompanyEmail = (e) => OWN_COMPANY_RE.test(String(e || '').trim());
const lower = (s) => String(s || '').trim().toLowerCase();
const sameEmail = (a, b) => lower(a) === lower(b) && lower(a) !== '';
const iso = (ms) => new Date(ms).toISOString();
const str = (v, max = 300) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function newCandidateId() {
  return 'c' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}
function newReportId() {
  return 'r' + crypto.randomBytes(9).toString('hex');
}

// ---------------- the stored document ----------------

function blank() {
  return { v: 1, candidates: [], reports: [], settings: { team: '', managerEmail: '' }, seen: {}, removed: [] };
}

// Whatever was stored, in the shape everything below expects. Unknown or
// broken entries are dropped rather than trusted.
function normalize(raw) {
  const doc = blank();
  if (!raw || typeof raw !== 'object') return doc;
  doc.candidates = (Array.isArray(raw.candidates) ? raw.candidates : [])
    .filter((c) => c && typeof c === 'object' && typeof c.id === 'string' && c.id)
    .slice(0, MAX_CANDIDATES);
  doc.reports = (Array.isArray(raw.reports) ? raw.reports : [])
    .filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id)
    .slice(0, MAX_REPORTS);
  const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  doc.settings = { team: str(s.team, 80), managerEmail: str(s.managerEmail, 254) };
  doc.seen = raw.seen && typeof raw.seen === 'object' && !Array.isArray(raw.seen) ? raw.seen : {};
  // Who was taken off the list, kept so a link already in their inbox still
  // files their answers under their name.
  doc.removed = (Array.isArray(raw.removed) ? raw.removed : [])
    .filter((c) => c && typeof c === 'object' && typeof c.id === 'string')
    .slice(0, 2000);
  return doc;
}

async function load() {
  return normalize(await storage.getJson(KEY));
}

// Read, change, write — conditional on nobody else having written in between,
// and re-run on top of their version if they did. The mutator may therefore
// run more than once: keep it free of side effects, and collect anything it
// reports afresh on each run. Returning false writes nothing.
async function update(mutator) {
  const { value } = await storage.updateJson(KEY, (current) => {
    const doc = normalize(current);
    return mutator(doc) === false ? false : doc;
  });
  return normalize(value);
}

// The key invite links are signed with, kept under a small entry of its own:
// the candidate's routes are open to anyone, so a link is checked against it
// before the (much larger) list is read at all. Made the first time one is
// needed, only if none exists, and never changed after — every link already
// sent was signed with it.
const SECRET_KEY = 'salesiq-secret';

async function readSecret() {
  const v = await storage.getJson(SECRET_KEY);
  return v && typeof v.secret === 'string' ? v.secret : '';
}

async function ensureSecret() {
  const have = await readSecret();
  if (have) return have;
  await storage.setJsonIfMatch(SECRET_KEY, { secret: crypto.randomBytes(32).toString('hex') }, null);
  // Whoever got there first, theirs is the one kept.
  return readSecret();
}

// ---------------- invite links ----------------
// team.candidate.signature — the team because the link is opened with no
// session, by someone who is not signed in to anything; the signature because
// the candidate id alone would let anyone who guessed one file answers under
// that person's name.
const TOKEN_RE = /^([a-z0-9][a-z0-9-]{0,39})\.(c[a-z0-9]{4,40})\.([A-Za-z0-9_-]{22})$/;

function sign(secret, teamId, candId) {
  return crypto.createHmac('sha256', secret).update(`salesiq:${teamId}:${candId}`).digest('base64url').slice(0, 22);
}

function tokenFor(secret, teamId, candId) {
  if (!secret) throw new Error('Sales IQ has no signing key yet.');
  return `${teamId}.${candId}.${sign(secret, teamId, candId)}`;
}

// { teamId, candId, sig } for something shaped like a token, else null. Worth
// asking before any storage is read: the route is public and crawlers find it.
function parseToken(tok) {
  const m = String(tok || '').trim().match(TOKEN_RE);
  return m ? { teamId: m[1], candId: m[2], sig: m[3] } : null;
}

function verifyToken(secret, parsed) {
  if (!secret || !parsed) return false;
  const want = sign(secret, parsed.teamId, parsed.candId);
  return want.length === parsed.sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(parsed.sig));
}

const linkFor = (base, token) => `${String(base).replace(/\/$/, '')}/assessment/?t=${encodeURIComponent(token)}`;
const reportLinkFor = (base, reportId) => `${String(base).replace(/\/$/, '')}/#salesiq?report=${encodeURIComponent(reportId)}`;

// ---------------- scoring ----------------

function validAnswers(answers) {
  return Array.isArray(answers) && answers.length === QUESTIONS.length
    && answers.every((a, i) => Number.isInteger(a) && a >= 0 && a < QUESTIONS[i].options.length);
}

// Scores a full answer sheet (option index per question).
function score(answers) {
  const perCat = {};
  Object.keys(CATEGORIES).forEach((k) => { perCat[k] = { score: 0, max: 0 }; });
  QUESTIONS.forEach((q, i) => {
    const ans = answers[i];
    const opt = Number.isInteger(ans) ? q.options[ans] : null;
    perCat[q.category].score += opt ? opt.points : 0;
    perCat[q.category].max += MAX_POINTS_PER_QUESTION;
  });
  const total = Object.values(perCat).reduce((s, c) => s + c.score, 0);
  const max = Object.values(perCat).reduce((s, c) => s + c.max, 0);
  const value = Math.round((total / max) * 100);
  return {
    score: value,
    tier: tierForScore(value),
    categories: Object.entries(perCat).map(([key, v]) => ({
      key,
      name: CATEGORIES[key].name,
      blurb: CATEGORIES[key].blurb,
      score: v.score,
      max: v.max,
      pct: Math.round((v.score / v.max) * 100),
    })),
  };
}

// What a candidate's page is sent: the words, never the points.
function publicQuestions() {
  return QUESTIONS.map((q) => ({ text: q.text, options: q.options.map((o) => o.text) }));
}

// A fingerprint of the question text. The candidate's page keeps it with any
// answers it saves part way, and starts afresh rather than carry answers over
// to a different set of questions.
const QUESTIONS_VERSION = crypto.createHash('sha1')
  .update(JSON.stringify(publicQuestions())).digest('hex').slice(0, 12);

/**
 * Adds a report to a newest-first list (once per id) and returns the one that
 * counts for that candidate: their earliest. Every later report of theirs is
 * marked `retake` and never replaces the first score.
 */
function fileReport(reports, entry) {
  if (!reports.some((r) => r.id === entry.id)) reports.unshift(entry);
  const email = lower(entry.email);
  if (!email) return reports.find((r) => r.id === entry.id);
  const theirs = reports
    .filter((r) => lower(r.email) === email)
    .sort((a, b) => String(a.completedAt || '').localeCompare(String(b.completedAt || '')));
  theirs.forEach((r, i) => { r.retake = i > 0; });
  return theirs[0];
}

// ---------------- report links from the standalone app ----------------
// Results emailed by the standalone Sales IQ app carry the answers sealed into
// a "WPR1." link. Opening one here files it, scored here, exactly as the old
// dashboard did — so nothing already in someone's inbox is lost.
const SEAL_PREFIX = 'WPR1.';
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
function unseal(code) {
  const raw = String(code || '').trim().replace(/^.*?(WPR1\.)/, '$1');
  if (!raw.startsWith(SEAL_PREFIX)) throw new Error("That isn't a Sales IQ report link.");
  const dot = raw.lastIndexOf('.');
  const damaged = 'This report link looks damaged — it may have been cut off by the email app.';
  if (dot <= SEAL_PREFIX.length) throw new Error(damaged);
  let body;
  try { body = Buffer.from(raw.slice(SEAL_PREFIX.length, dot), 'base64url').toString('utf8'); } catch { throw new Error(damaged); }
  if (fnv(body) !== raw.slice(dot + 1)) throw new Error(damaged);
  let d;
  try { d = JSON.parse(body); } catch { throw new Error(damaged); }
  if (!d || d.v !== 1 || typeof d.id !== 'string' || !validAnswers(d.a)) {
    throw new Error('This report link is for a different version of the questionnaire.');
  }
  return {
    id: str(d.id, 60),
    name: str(d.n, 120),
    email: str(d.e, 254),
    phone: str(d.p, 40),
    answers: d.a,
    durationSec: Number.isFinite(d.d) ? Math.max(0, Math.round(d.d)) : null,
    completedAt: Number.isFinite(Date.parse(d.t)) ? new Date(d.t).toISOString() : new Date().toISOString(),
  };
}

// ---------------- Calendly bookings ----------------

// A stable id for one person's booking of one event: the same booking is the
// same row however often it is fetched or re-synced, and the id gives away
// nothing about the record behind it. The external Sales IQ feed has always
// used this exact key, so the two can never disagree.
const bookingKey = (i) => crypto.createHash('sha256')
  .update(`${String(i.uri || '')}|${lower(i.inviteeEmail)}`)
  .digest('hex')
  .slice(0, 24);

const MAX_BOOKINGS = 300;

// Everyone who booked, newest interview first, once per booking. `crmId` is
// the pipeline candidate the booking was matched to — used here to link the
// two, and stripped before anything leaves for the external app.
function bookingsFrom(db) {
  const byId = new Map((db.candidates || []).map((c) => [c.id, c]));
  const seen = new Set();
  const out = [];
  const list = (db.interviews || [])
    .filter((i) => i && lower(i.inviteeEmail))
    .sort((a, b) => String(b.start || '').localeCompare(String(a.start || '')));
  for (const i of list) {
    if (out.length >= MAX_BOOKINGS) break;
    const key = bookingKey(i);
    if (seen.has(key)) continue;
    seen.add(key);
    const c = i.candidateId ? byId.get(i.candidateId) : null;
    const email = String(i.inviteeEmail).trim();
    out.push({
      key,
      name: String(i.inviteeName || (c && c.name) || email),
      email,
      phone: String(i.inviteePhone || (c && c.phone) || ''),
      interviewAt: i.start || null,
      eventName: String(i.name || ''),
      bookedAt: i.bookedAt || null,
      status: i.status === 'active' ? 'active' : 'canceled',
      crmId: c ? c.id : null,
    });
  }
  return out;
}

/**
 * Folds bookings into the candidate list. Each booking is acted on once
 * (tracked by its key), so a person the manager removed is not brought back
 * by the next sync — only a new booking of theirs would (a reschedule doesn't).
 * Never sends anything. Returns whether anything changed and the people to
 * announce: new bookers, and anyone already listed who booked and hasn't been
 * sent the questionnaire.
 */
function applyBookings(doc, bookings, now = Date.now()) {
  const seen = doc.seen;
  const added = [];
  let changed = false;
  // A reschedule in Calendly cancels the old booking and makes a new one: a
  // new booking from someone whose already-seen booking is now canceled is
  // that same person moving their time, not a new booker.
  const rescheduled = new Set(
    bookings.filter((b) => b.status === 'canceled' && b.key && seen[b.key]).map((b) => lower(b.email))
  );

  // A canceled booking flags a not-yet-sent candidate it created; an active
  // one (processed after, so a rebooking wins) clears the flag.
  for (const b of bookings) {
    if (b.status !== 'canceled') continue;
    const c = doc.candidates.find((x) => x.bookingKey === b.key);
    if (c && !c.interviewCanceled && (c.status || 'added') === 'added') {
      c.interviewCanceled = true;
      changed = true;
    }
  }

  for (const b of bookings) {
    if (b.status !== 'active' || !b.email || !b.key) continue;
    const when = Date.parse(b.interviewAt);
    if (seen[b.key]) continue;
    seen[b.key] = { at: iso(now) };
    changed = true;
    if (Number.isFinite(when) && when < now - DAY_MS) continue;

    const existing = doc.candidates.find((c) => sameEmail(c.email, b.email));
    if (existing) {
      if (!existing.phone && b.phone) existing.phone = str(b.phone, 40);
      existing.interviewAt = b.interviewAt;
      existing.interviewEvent = str(b.eventName, 160);
      existing.bookingKey = b.key;
      existing.interviewCanceled = false;
      if (b.crmId && !existing.crmId) existing.crmId = b.crmId;
      if ((existing.status || 'added') === 'added') added.push(existing);
      continue;
    }
    if (rescheduled.has(lower(b.email))) continue;
    const cand = {
      id: newCandidateId(),
      name: str(b.name, 120) || str(b.email, 254),
      email: str(b.email, 254),
      phone: str(b.phone, 40),
      status: 'added',
      added: iso(now),
      source: 'calendly',
      interviewAt: b.interviewAt,
      interviewEvent: str(b.eventName, 160),
      bookingKey: b.key,
      bookedAt: b.bookedAt || null,
    };
    if (b.crmId) cand.crmId = b.crmId;
    doc.candidates.unshift(cand);
    added.push(cand);
  }

  // Keep the seen list from growing forever.
  for (const k of Object.keys(seen)) {
    const at = Date.parse(seen[k] && seen[k].at);
    if (!Number.isFinite(at) || now - at > SEEN_KEEP_MS) { delete seen[k]; changed = true; }
  }
  if (doc.candidates.length > MAX_CANDIDATES) doc.candidates.length = MAX_CANDIDATES;
  return { changed, added };
}

// The team's latest bookings, into its Sales IQ list. Writes only when
// something changed; returns the people who were added or newly booked.
async function syncBookings(db) {
  const bookings = bookingsFrom(db).filter((b) => !isOwnCompanyEmail(b.email));
  let added = [];
  await update((doc) => {
    const r = applyBookings(doc, bookings);
    added = r.added;
    return r.changed ? undefined : false;
  });
  return added;
}

// ---------------- the words that go out ----------------

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function inviteSubject() {
  return `${COMPANY} — Sales Talent Questionnaire (next step)`;
}

// The Sales IQ app's invitation, word for word.
function inviteText(cand, link) {
  const first = firstName(cand && cand.name);
  return [
    first ? `Hi ${first},` : 'Hi,',
    '',
    `Thanks for your interest in joining the ${COMPANY} sales team!`,
    '',
    'As the next step in our hiring process, please complete our short',
    'Sales Talent Questionnaire — 10 quick questions, about 5 minutes:',
    '',
    link,
    '',
    'Answer honestly and go with your instincts. Your responses are sent',
    "directly to our hiring team, and we'll reach out about next steps.",
    '',
    'Best regards,',
    `${COMPANY} Hiring Team`,
  ].join('\n');
}

/** 254 → "4m 14s"; 3671 → "1h 01m". */
function formatDuration(sec) {
  if (!sec && sec !== 0) return '';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`;
}

function formatDate(isoText, timeZone) {
  const d = new Date(isoText);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) });
  } catch {
    return d.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
  }
}

const candidateLabel = (r) => r.name || r.email || 'Unidentified candidate';

// The scored summary the hiring manager is emailed — the Sales IQ app's
// results email, line for line. Only ever sent to the manager.
function resultsText(report, { timeZone, reportLink } = {}) {
  const tier = TIERS.find((t) => t.key === report.tierKey) || tierForScore(report.score);
  return [
    `${COMPANY} — Sales Talent Questionnaire`,
    '',
    `Candidate: ${candidateLabel(report)}`,
    report.email ? `Email: ${report.email}` : null,
    report.phone ? `Phone: ${report.phone}` : null,
    `Completed: ${formatDate(report.completedAt, timeZone)}`,
    report.durationSec ? `Time to complete: ${formatDuration(report.durationSec)}` : null,
    '',
    `OVERALL SCORE: ${report.score}/100 — ${tier.label}`,
    '',
    tier.blurb,
    '',
    'Competency breakdown:',
    (report.categories || []).map((c) => `  • ${c.name}: ${c.score}/${c.max}  (${c.pct}%)`).join('\n'),
    reportLink ? '' : null,
    reportLink ? `Open in your Hiring Dashboard: ${reportLink}` : null,
  ].filter((l) => l !== null).join('\n');
}

const resultsSubject = (report) => `Assessment completed — ${candidateLabel(report)} · ${report.score}/100 ${report.tier || ''}`.trim();

// Plain text as a simple HTML part: every message this app sends carries both,
// and an empty HTML part would show as a blank email.
function textToHtml(text) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const linked = esc(text).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`);
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;line-height:1.55;color:#1c2340;white-space:pre-wrap">${linked}</div>`;
}

// ---------------- what the dashboard is sent ----------------

function publicCandidate(c, secret, base, teamId) {
  const out = {
    id: c.id,
    name: c.name || '',
    email: c.email || '',
    phone: c.phone || '',
    status: ['added', 'invited', 'completed'].includes(c.status) ? c.status : 'added',
    added: c.added || null,
    source: c.source || '',
    interviewAt: c.interviewAt || null,
    interviewEvent: c.interviewEvent || '',
    interviewCanceled: Boolean(c.interviewCanceled),
    bookedAt: c.bookedAt || null,
    invitedAt: c.invitedAt || null,
    completedAt: c.completedAt || null,
    crmId: c.crmId || null,
  };
  if (typeof c.score === 'number') out.score = c.score;
  if (c.durationSec) out.durationSec = c.durationSec;
  if (secret && teamId) out.link = linkFor(base, tokenFor(secret, teamId, c.id));
  return out;
}

function publicReport(r) {
  return {
    id: r.id,
    candidateId: r.candidateId || null,
    name: r.name || '',
    email: r.email || '',
    score: r.score,
    tier: r.tier || '',
    tierKey: r.tierKey || '',
    categories: Array.isArray(r.categories) ? r.categories : [],
    durationSec: r.durationSec || null,
    completedAt: r.completedAt || null,
    retake: Boolean(r.retake),
    emailedTo: r.emailedTo || '',
    emailError: r.emailError || '',
  };
}

// Who has been sent or has finished the questionnaire, by address, for the
// rest of the app (a chip on a candidate, a line on an interview).
// Where each person is, by email (and by their Candidates-page id), for the
// Dashboard's tracker, the Candidates filters and badges. Someone listed
// twice counts at the furthest they have got.
const IQ_RANK = { added: 0, invited: 1, completed: 2 };
function summary(doc) {
  const byEmail = {};
  const byCrm = {};
  for (const c of doc.candidates) {
    const e = lower(c.email);
    if (!e) continue;
    const status = IQ_RANK[c.status] !== undefined ? c.status : 'added';
    if (c.crmId && !byCrm[c.crmId]) byCrm[c.crmId] = e;
    if (byEmail[e] && IQ_RANK[byEmail[e].status] >= IQ_RANK[status]) continue;
    const s = { id: c.id, status };
    if (s.status === 'completed' && typeof c.score === 'number') {
      s.score = c.score;
      const t = tierForScore(c.score);
      s.tier = t.label;
      s.tierKey = t.key;
    }
    byEmail[e] = s;
  }
  return { byEmail, byCrm, total: doc.candidates.length };
}

const tiers = () => TIERS.map((t) => ({ key: t.key, label: t.label, blurb: t.blurb }));

module.exports = {
  KEY, COMPANY, TEAMS, EMAIL_RE, MAX_REPORTS_PER_PERSON, isOwnCompanyEmail,
  load, update, readSecret, ensureSecret, SECRET_KEY, normalize, blank,
  newCandidateId, newReportId,
  tokenFor, parseToken, verifyToken, linkFor, reportLinkFor,
  validAnswers, score, publicQuestions, QUESTIONS_VERSION, fileReport, unseal, tiers,
  bookingKey, bookingsFrom, applyBookings, syncBookings,
  inviteSubject, inviteText, resultsText, resultsSubject, textToHtml, formatDuration, firstName,
  publicCandidate, publicReport, summary, sameEmail, lower, str,
};
