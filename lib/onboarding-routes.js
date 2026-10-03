// Onboarding docs — WPI Hire's API, built into this app.
//
// Every route WPI Hire had is here, under /api/onboarding/ instead of /api/
// (this app already has its own /api/candidates, /api/status and so on), and
// behind the team sign-in like every other page. The two the new hire uses —
// loading their paperwork and submitting it — are the exception: they sit
// under /api/paperwork/, open (see lib/auth.js), because the hire is not
// signed in to anything. Each call proves which team and which hire it is for
// with the signed token in their link, and is refused without one.
//
// What changed from WPI Hire, and why:
//   - no BambooHR: candidates come from this app's Candidates page, and the
//     company's details are fixed (lib/onboarding.js) rather than read from
//     environment variables; signed paperwork comes back to the team's own
//     sending mailbox
//   - mail goes out through this app's mailer — the team's own Google account
//     or App Password — so a packet is sent from the same mailbox as the
//     outreach that found the hire
//   - a finished packet also lands in Candidate updates and on the team's
//     phone, like a booking or a finished questionnaire
//   - the signing record is fuller: where the signer was (by their network
//     address), and a SHA-256 fingerprint of every signed file; the signed
//     files themselves are kept, encrypted, to download again later
const express = require('express');
const crypto = require('crypto');
const storage = require('./storage');
const tenant = require('./tenant');
const teams = require('./teams');
const store = require('./store');
const mailer = require('./mailer');
const google = require('./google');
const notify = require('./notify');
const address = require('./email-address');
const onboarding = require('./onboarding');
const paperwork = require('./paperwork');
const { COMPANY_DOCUMENTS, readDocument, publicPath } = require('./onboarding-docs');
const templates = require('./onboarding-templates');
const mail = require('./onboarding-mail');

// Exact-case, like the app it is mounted on (see app.js).
const router = express.Router({ caseSensitive: true });

// Every answer says whose it is. One browser can have the page open in two
// tabs, and signing in to another team in one replaces the other's session:
// the page drops an answer that is not for the team it is showing, rather
// than draw it (and keep a copy of it) under that team's name.
// And a request says whose it is meant to be: a change typed into a page that
// still shows the last team must not be saved over the one signed in now.
router.use('/api/onboarding', (req, res, next) => {
  if (req.team && req.team.id) res.set('X-Team', encodeURIComponent(req.team.id));
  const meant = req.get('X-Team-Expected');
  let meantId = '';
  try { meantId = meant ? decodeURIComponent(meant) : ''; } catch { meantId = meant; }
  if (meantId && req.team && req.team.id && meantId !== req.team.id) {
    return res.status(409).json({ error: 'This browser is now signed in to another team — nothing was changed.', otherTeam: true });
  }
  next();
});

// WPI Hire's error handling, in this app's terms: a storage failure is "try
// again", a refusal is the caller's to fix, and anything else is reported as
// it was thrown.
const route = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error('[onboarding]', req.method, req.path, err && err.message);
  const status = err.status === 409 ? 409
    : err.storage ? 503
      : err.invalidAddress || err.userError ? 400 : 500;
  res.status(status).json({ error: err.message || 'Unexpected server error', retry: status === 409 || status === 503 });
});

const userError = (message) => Object.assign(new Error(message), { userError: true });

// ---------------- the team's configuration ----------------

// The company is fixed (lib/onboarding.js); where signed paperwork goes, and
// who a letter says to contact, is the mailbox the team sends from. A route
// that only looks (`readOnly`) shares the read-only copy of the team's
// document (store.read()); one that sends keeps loading its own.
async function context({ readOnly = false } = {}) {
  const [doc, db] = await Promise.all([onboarding.load(), readOnly ? store.read() : store.load()]);
  return { doc, db, cfg: onboarding.config(), company: onboarding.COMPANY };
}

// ---------------- own company ----------------
// Nobody at Wholesale Payments is ever added or emailed as a hire: the packet
// goes to the new person's own address, before they have a company inbox.
const OWN_DOMAINS = ['wholesalepayments.com'];
const PUBLIC_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com']);

function ownDomains(sendingFrom) {
  const out = new Set(OWN_DOMAINS);
  const d = String(sendingFrom || '').split('@')[1];
  if (d && !PUBLIC_MAIL.has(d.toLowerCase())) out.add(d.toLowerCase());
  return out;
}

function isOwnCompany(email, domains) {
  const d = onboarding.lower(email).split('@')[1] || '';
  return Boolean(d) && [...domains].some((own) => d === own || d.endsWith(`.${own}`));
}

const OWN_COMPANY_MESSAGE = 'That is a Wholesale Payments address. Onboarding packets go to the new hire’s own email — use their personal address.';

async function assertNotOwnCompany(db, email) {
  if (!email) return;
  const sending = await mailer.sendStatus(db.settings).catch(() => ({}));
  if (isOwnCompany(email, ownDomains(sending.from))) throw userError(OWN_COMPANY_MESSAGE);
}

// ---------------- status / config ----------------

async function describeStore() {
  const b = await storage.backend();
  return {
    backend: b.kind === 'netlify-blobs' ? 'blobs' : b.kind === 'file' ? 'file' : 'memory',
    persistent: b.persistent,
    // Only Blobs is shared across devices and survives a redeploy.
    sharedAcrossDevices: b.kind === 'netlify-blobs',
  };
}

router.get('/api/onboarding/status', route(async (req, res) => {
  const { db, company } = await context({ readOnly: true });
  const sending = await mailer.sendStatus(db.settings);
  res.json({
    emailConfigured: Boolean(sending.ready),
    email: { ready: Boolean(sending.ready), via: sending.via || null, from: sending.from || '', reason: sending.reason || '' },
    storage: await describeStore(),
    company,
    team: req.team ? { id: req.team.id, name: req.team.name } : null,
  });
}));

// ---------------- saved records ----------------
// Candidates added from the Candidates page, packets sent and completed
// hires all live server-side so they persist across
// devices and sessions.

function publicHire(h) {
  const out = { ...h };
  // Nothing about the stored files but what the page needs to offer them.
  out.files = (Array.isArray(h.files) ? h.files : []).map((f) => ({ key: f.key, title: f.title, filename: f.filename, sha256: f.sha256, size: f.size, stored: f.stored !== false }));
  return out;
}

router.get('/api/onboarding/saved', route(async (_req, res) => {
  const doc = await onboarding.load();
  res.json({
    candidates: doc.candidates,
    overrides: doc.overrides,
    sends: doc.sends,
    hires: doc.hires.map(publicHire),
    storage: await describeStore(),
  });
}));

// A record the page made: kept as it was sent, within bounds. It is the page's
// own data, read back only by the page.
function cleanCandidate(c) {
  const json = JSON.stringify(c);
  if (json.length > 20000) throw userError('That candidate record is too large to save.');
  return JSON.parse(json);
}

router.post('/api/onboarding/saved/candidates', route(async (req, res) => {
  const c = req.body && req.body.candidate;
  if (!c || !c.id) return res.status(400).json({ error: 'candidate.id is required' });
  const email = c.applicant && c.applicant.email;
  if (email) await assertNotOwnCompany(await store.read(), email);
  await onboarding.upsertRecord('candidates', { ...cleanCandidate(c), id: String(c.id), savedAt: new Date().toISOString() });
  res.json({ ok: true });
}));

router.delete('/api/onboarding/saved/candidates/:id', route(async (req, res) => {
  await onboarding.update((doc) => {
    const id = String(req.params.id);
    doc.candidates = doc.candidates.filter((r) => String(r.id) !== id);
    doc.overrides = doc.overrides.filter((r) => String(r.id) !== id);
  });
  res.json({ ok: true });
}));

router.get('/api/onboarding/hires', route(async (_req, res) => {
  const doc = await onboarding.load();
  res.json({ hires: doc.hires.map(publicHire) });
}));

// A signed copy, decrypted for the signed-in team that owns it.
router.get('/api/onboarding/hires/:reference/files/:key', route(async (req, res) => {
  const doc = await onboarding.load();
  const hire = doc.hires.find((h) => h.reference === req.params.reference);
  const file = hire && (hire.files || []).find((f) => f.key === req.params.key);
  if (!file) return res.status(404).json({ error: 'That signed document is not on file.' });
  const bytes = await onboarding.readSignedCopy(hire.reference, file.key);
  if (!bytes) return res.status(404).json({ error: 'That signed document is not on file.' });
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (file.sha256 && sha256 !== file.sha256) {
    return res.status(409).json({ error: 'This stored copy does not match the fingerprint recorded when it was signed, so it has not been opened.' });
  }
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${String(file.filename).replace(/[^\w.-]/g, '_')}"`);
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-SHA256', sha256);
  res.send(bytes);
}));

// Takes a completed hire off the list, with their stored copies. Their
// emailed copies are not touched.
router.delete('/api/onboarding/hires/:reference', route(async (req, res) => {
  let removed = null;
  await onboarding.update((doc) => {
    removed = doc.hires.find((h) => h.reference === req.params.reference) || null;
    if (!removed) return false;
    doc.hires = doc.hires.filter((h) => h.reference !== req.params.reference);
  });
  if (removed) await onboarding.deleteSignedCopies(removed);
  res.json({ ok: true, removed: Boolean(removed) });
}));

// ---------------- hiring pipeline (ATS) ----------------

router.post('/api/onboarding/email/test', route(async (_req, res) => {
  const db = await store.read();
  const result = await mailer.verify(db.settings);
  res.json({ ok: result.ok, host: result.host || '(not set)', user: result.user, error: result.error });
}));

// ---------------- the packet ----------------

router.get('/api/onboarding/packet/documents', (_req, res) => {
  res.json({
    documents: COMPANY_DOCUMENTS.map(({ key, title, summary }) => ({
      key,
      title,
      summary,
      default: true,
      company: true,
      // Where the PDF itself is published, so Preview can simply open it.
      href: publicPath(key),
    })),
  });
});

// Preview a document: the company PDFs as they are, and the generated
// templates rendered with the current hire's details.
router.post('/api/onboarding/packet/preview', route(async (req, res) => {
  const { hire = {}, docKey } = req.body || {};

  if (COMPANY_DOCUMENTS.some((d) => d.key === docKey)) {
    const buffer = await readDocument(docKey);
    if (!buffer) return res.status(404).json({ error: `Document unavailable: ${docKey}` });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${docKey}.pdf"`);
    return res.send(buffer);
  }

  if (!templates.PACKET_DOCUMENTS.some((d) => d.key === docKey)) {
    return res.status(400).json({ error: `Unknown document: ${docKey}` });
  }
  const { company, db } = await context({ readOnly: true });
  // The letters' HR contact ("Questions? Contact … at …") is the mailbox the
  // team sends from — the one signed paperwork comes back to.
  const hrEmail = (await mailer.sendStatus(db.settings).catch(() => ({}))).from || '';
  const letterCompany = { ...company, hrEmail };
  const buffer = await templates.renderTemplateToPdf(docKey, templates.buildTokens(hire, letterCompany), letterCompany);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${docKey}.pdf"`);
  res.send(buffer);
}));

// Where a copy of the packet invitation goes when "CC HR" is ticked.

// THE button: works out the signing packet, emails the hire their link into
// the portal, and records the send.
router.post('/api/onboarding/send', route(async (req, res) => {
  const { hire: rawHire = {}, documents, options = {} } = req.body || {};
  const steps = [];
  const hire = {};
  for (const k of ['firstName', 'lastName', 'email', 'phone', 'jobTitle', 'department', 'startDate', 'manager', 'salary', 'employmentType', 'workLocation']) {
    if (rawHire[k] !== undefined && rawHire[k] !== null) hire[k] = onboarding.str(rawHire[k], 254);
  }

  if (!hire.firstName || !hire.email) {
    return res.status(400).json({ error: 'Hire first name and email are required' });
  }
  if (!address.isSendable(hire.email)) {
    return res.status(400).json({ error: `“${hire.email}” is not a valid email address.` });
  }
  const { db, company } = await context();
  await assertNotOwnCompany(db, hire.email);
  // Every packet defaults to the standard role unless one was provided.
  if (!hire.jobTitle) hire.jobTitle = 'Account Executive';
  const requested =
    Array.isArray(documents) && documents.length
      ? documents
      : COMPANY_DOCUMENTS.map((d) => d.key);

  // 1. Work out the signing packet. Nothing is attached to this email — the
  // hire reads and signs in the portal, and receives signed copies after.
  const packet = COMPANY_DOCUMENTS.filter((d) => requested.includes(d.key)).map(
    ({ key, title }) => ({ key, title, signable: true })
  );
  if (!packet.length) {
    return res.status(400).json({ error: 'Select at least one document for the packet' });
  }
  steps.push({
    step: 'Prepare packet',
    status: 'done',
    detail: `${packet.length} documents to sign: ${packet.map((p) => p.title).join(', ')}`,
  });

  // The hire completes and signs the company documents through this link.
  const keys = await onboarding.ensureSecret();
  const portalLink = paperwork.paperworkUrl(hire, keys.secret, req.team.id, google.baseUrl());

  // 2. Email the packet
  let sent = null;
  if (options.sendEmail !== false) {
    const subject = `Welcome to ${company.name}, ${hire.firstName} — complete your paperwork`;
    const sending = await mailer.sendStatus(db.settings);
    if (!sending.ready) {
      steps.push({
        step: 'Email packet',
        status: 'simulated',
        detail: `Email is not set up (${sending.reason || 'connect Google or add an App Password in Settings'}) — would send the signing invitation to ${hire.email} with subject “${subject}”`,
      });
    } else {
      // A failed send fails the request, as it did in WPI Hire: the page then
      // says why, and records nothing as sent.
      const result = await mailer.sendEmail(db.settings, {
        to: hire.email,
        subject,
        html: mail.packetEmailHtml(hire, company, packet, portalLink),
        text: mail.packetEmailText(hire, company, packet, portalLink),
        attachments: mail.logoAttachment(),
      });
      sent = result;
      steps.push({
        step: 'Email packet',
        status: 'done',
        detail: `Sent to ${hire.email} from ${result.from || sending.from} — message id ${result.messageId || result.gmailId || ''}`.trim(),
      });
    }
  } else {
    steps.push({ step: 'Email packet', status: 'skipped', detail: 'Email disabled for this send' });
  }

  // 3. Record the send so every device sees who has been invited, and the
  //    pipeline counters stay right. A storage
  //    failure must not fail a packet that already went out.
  if (options.sendEmail !== false) {
    try {
      await onboarding.upsertRecord('sends', {
        id: hire.email.trim().toLowerCase(),
        email: hire.email.trim(),
        firstName: hire.firstName || '',
        lastName: hire.lastName || '',
        jobTitle: hire.jobTitle,
        documents: packet.map((p) => p.title),
        sentAt: new Date().toISOString(),
        simulated: !sent,
      });
    } catch (err) {
      console.error(`Could not record the packet send to ${hire.email}:`, err.message);
    }
  }

  // 4. Signed copies are produced when the hire submits, so nothing is
  //    filed yet — say so rather than leaving a silent gap.
  steps.push({
    step: 'Awaiting signatures',
    status: 'skipped',
    detail: `Signed PDFs will be emailed to you as soon as ${hire.firstName} completes the paperwork.`,
  });

  const failed = steps.some((s) => s.status === 'error');
  res.json({
    ok: !failed,
    steps,
    portalLink,
    documents: packet.map(({ key, title }) => ({ key, title })),
  });
}));

// ---------------- the new hire's side: open, but only to a signed link ----

const LINK_REFUSED = 'This paperwork link is invalid or has been changed.';

// Which team and which hire a link is for, proven by its signature. Crawlers
// find open routes, so nothing is read for something not even shaped like a
// token, and an unknown team costs one registry read.
async function paperworkContext(token) {
  const parsed = paperwork.parseToken(token);
  if (!parsed) return null;
  const team = await teams.byId(parsed.teamId);
  if (!team) return null;
  return tenant.run(team.id, async () => {
    const keys = await onboarding.readSecret();
    const hire = keys ? paperwork.verifyPaperworkToken(parsed, keys.secret) : null;
    return hire ? { team, hire, linkId: linkIdOf(parsed) } : null;
  });
}

// Which link a completed packet came in through. Like an envelope, a link is
// signed once: opened again it says so, and a retry of a submission that did
// arrive is answered with what arrived rather than filed a second time.
function linkIdOf(parsed) {
  return crypto.createHash('sha256').update(`${parsed.teamId}.${parsed.body}.${parsed.sig}`).digest('hex').slice(0, 24);
}

function completedFor(doc, linkId) {
  return doc.hires.find((h) => h.linkId === linkId) || null;
}

// A link that was signed, whose record has since been deleted or aged out of
// the list: still used.
function usedLink(doc, linkId) {
  const l = onboarding.linkState(doc, linkId);
  return l && l.state === 'done' ? { reference: l.reference, signedAt: l.at, delivered: false, email: '', documents: COMPANY_DOCUMENTS.map((d) => d.title) } : null;
}

function alreadyAnswer(h) {
  const v = completedView(h);
  return { ok: true, already: true, emailed: v.emailed, reference: v.reference, steps: [], documents: v.documents };
}

router.post('/api/paperwork/session', route(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ctx = await paperworkContext(req.body && req.body.token);
  if (!ctx) return res.status(401).json({ ok: false, error: LINK_REFUSED });
  const doc = await tenant.run(ctx.team.id, () => onboarding.load());
  const company = onboarding.COMPANY;
  const done = completedFor(doc, ctx.linkId) || usedLink(doc, ctx.linkId);
  res.json({
    ok: true,
    hire: ctx.hire,
    company: { name: company.name, address: company.address, hrName: company.hrName },
    documents: COMPANY_DOCUMENTS.map(({ key, title, summary }) => ({ key, title, summary })),
    // Already signed through this link: the portal says so instead.
    completed: done ? completedView(done) : null,
  });
}));

// Where the signer was, as Netlify's edge placed their connection — set by
// the function wrapper (netlify/src/api.mjs), which discards any value the
// browser tried to send. Not available running locally.
function edgeLocation(req) {
  if (!storage.onNetlify) return '';
  try {
    const g = JSON.parse(req.get('x-wpo-geo') || 'null');
    if (!g) return '';
    const parts = [g.city, g.subdivision && g.subdivision.name, g.country && g.country.name].filter(Boolean);
    return parts.join(', ');
  } catch {
    return '';
  }
}

function completedView(h) {
  return {
    reference: h.reference,
    signedAt: h.signedAt,
    signedDate: h.signedDate,
    emailed: Boolean(h.delivered),
    email: h.email,
    documents: (h.files && h.files.length ? h.files : (h.documents || []).map((title) => ({ title }))).map((f) => ({ key: f.key || '', title: f.title, filename: f.filename || '' })),
  };
}

router.post('/api/paperwork/submit', route(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ctx = await paperworkContext(req.body && req.body.token);
  if (!ctx) return res.status(401).json({ ok: false, error: LINK_REFUSED });
  const { hire, team } = ctx;
  const seen = await tenant.run(team.id, () => onboarding.load());
  const already = completedFor(seen, ctx.linkId) || usedLink(seen, ctx.linkId);
  if (already) return res.json(alreadyAnswer(already));
  const submission = (req.body && req.body.submission) || {};
  if (!submission.esignConsent) {
    return res.status(400).json({ ok: false, error: 'Electronic signature consent is required.' });
  }
  if (!submission.legalFirstName || !submission.legalLastName) {
    return res.status(400).json({ ok: false, error: 'Your legal name is required.' });
  }
  const missing = paperwork.missingSignatures(submission.signatures);
  if (missing.length) {
    return res.status(400).json({
      ok: false,
      error: `We couldn't read ${missing.length === 1 ? 'one of your signatures' : 'some of your signatures'}: ${missing.join(', ')}. Please go back and sign again.`,
    });
  }
  // What the portal's review step asks for, asked for here too.
  const incomplete = paperwork.missingDetails(submission);
  if (incomplete.length) {
    return res.status(400).json({ ok: false, error: `Still needed before you can submit: ${incomplete.join(', ')}. Please go back and complete ${incomplete.length === 1 ? 'it' : 'them'}.` });
  }

  await tenant.run(team.id, async () => {
    // The link is claimed before anything is built, sent or filed (see
    // onboarding.claimLink), and given back if the submission fails.
    const claim = await onboarding.claimLink(ctx.linkId);
    if (claim.state === 'done') {
      const doc = await onboarding.load();
      res.json(alreadyAnswer(completedFor(doc, ctx.linkId) || usedLink(doc, ctx.linkId)));
      return;
    }
    if (claim.state === 'pending') {
      res.status(409).json({ ok: false, error: 'Your paperwork is already being submitted from another window. Give it a minute, then reload this page — it will show that it went through.' });
      return;
    }
    let settled = false;
    try {
      settled = await submitPaperwork(req, res, ctx, submission);
    } finally {
      if (settled) await onboarding.finishLink(ctx.linkId, settled).catch((err) => console.error('[onboarding] could not close the link:', err.message));
      else await onboarding.releaseLink(ctx.linkId).catch(() => {});
    }
  });
}));

// The submission itself, as the team, once its link is claimed. Answers the
// hire, and returns the reference when the packet is safely somewhere (kept
// here, or delivered), or false when it is not and the link is given back.
async function submitPaperwork(req, res, ctx, submission) {
  const { hire } = ctx;
  {
    const { db, cfg, company } = await context();
    const now = new Date();
    // One timezone for the signing date and the certificate time, so a late
    // evening submission can't stamp two different days on the same document.
    const zone = cfg.timezone;
    const inZone = (opts) => now.toLocaleString('en-US', { timeZone: zone, ...opts });
    // x-nf-client-connection-ip is set by Netlify's edge — and only there: run
    // anywhere else, anyone can send it, so it is not believed. The
    // forwarded-for fallback is client-supplied, so it is labelled as
    // reported rather than presented as verified.
    const edgeIp = storage.onNetlify ? (req.get('x-nf-client-connection-ip') || '').trim() : '';
    const reportedIp = (req.get('x-forwarded-for') || '').split(',')[0].trim() || req.ip || '';
    const audit = {
      ip: edgeIp || (reportedIp ? `${reportedIp} (reported)` : ''),
      location: edgeLocation(req),
      userAgent: req.get('user-agent') || '',
      time: `${inZone({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })} ${zone}`,
      reference: `WP-${now.getTime().toString(36).toUpperCase()}`,
      // The certificate says the signer opened a unique link sent to the
      // address it shows: that is this one, from the signed link. The
      // contact email the hire gives in the form is theirs to state, and is
      // the one on the agreement itself, as in WPI Hire.
      sentTo: hire.email || '',
    };
    const enriched = {
      ...submission,
      // Trusted values come from the signed link, not the browser.
      jobTitle: hire.jobTitle || 'Account Executive',
      startDate: hire.startDate || '',
      signedDate: inZone({ month: '2-digit', day: '2-digit', year: 'numeric' }),
    };

    const completed = await paperwork.buildCompletedDocuments(enriched, company, audit);
    // Every document must build — a partial packet must never be reported as
    // complete, since the hire would believe they had signed everything.
    if (completed.length !== COMPANY_DOCUMENTS.length) {
      const built = new Set(completed.map((d) => d.key));
      const failedDocs = COMPANY_DOCUMENTS.filter((d) => !built.has(d.key)).map((d) => d.title);
      console.error('Paperwork generation incomplete; missing:', failedDocs.join(', '));
      const contact = (await mailer.sendStatus(db.settings).catch(() => ({}))).from || 'your hiring contact';
      res.status(500).json({
        ok: false,
        error: `We couldn't finish preparing ${failedDocs.join(' and ')}. Nothing has been submitted — please contact ${contact} so we can sort this out.`,
      });
      return false;
    }

    const steps = [];
    steps.push({
      step: 'Complete documents',
      status: 'done',
      detail: `${completed.length} signed PDFs generated: ${completed.map((d) => d.title).join(', ')}`,
    });

    // Kept here, encrypted, beside the record — alongside the email rather
    // than instead of it, and at the same time, so neither waits on the other.
    const keep = Promise.all(completed.map((d) => onboarding.storeSignedCopy(audit.reference, d.key, d.buffer)))
      .then(() => true)
      .catch((err) => { console.error('Could not keep the signed copies:', err.message); return false; });

    // Deliver to the company inbox, copying the new hire.
    let emailed = false;
    let deliveredTo = '';
    const sending = await mailer.sendStatus(db.settings);
    // Back to the mailbox the team sends from.
    const inbox = sending.ready ? sending.from : '';
    const name = `${enriched.legalFirstName || hire.firstName || ''} ${enriched.legalLastName || hire.lastName || ''}`.trim();
    const deliver = (async () => {
      if (!sending.ready) {
        steps.push({
          step: 'Deliver paperwork',
          status: 'simulated',
          detail: `Email is not set up — would send ${completed.length} completed PDFs to ${inbox || 'the paperwork inbox'}`,
        });
        return;
      }
      if (!inbox || !address.isSendable(inbox)) {
        steps.push({ step: 'Deliver paperwork', status: 'error', detail: 'The sending mailbox has no address to send signed paperwork back to.' });
        return;
      }
      try {
        const result = await mailer.sendEmail(db.settings, {
          to: inbox,
          // Always the address from the signed link — never a client-supplied
          // one, which would turn this into an open mail relay.
          cc: hire.email && hire.email.toLowerCase() !== inbox.toLowerCase() && address.isSendable(hire.email) ? hire.email : undefined,
          subject: `Signed paperwork — ${name} (${audit.reference})`,
          html: mail.completedEmailHtml({ ...hire, ...enriched }, company, completed, audit, name),
          text: mail.completedEmailText({ ...hire, ...enriched }, company, completed, audit, name),
          attachments: [
            ...completed.map((d) => ({ filename: d.filename, content: d.buffer, contentType: 'application/pdf' })),
            ...mail.logoAttachment(),
          ],
        });
        emailed = true;
        deliveredTo = inbox;
        steps.push({
          step: 'Deliver paperwork',
          status: 'done',
          detail: `Sent to ${inbox}${hire.email ? ` (cc ${hire.email})` : ''} — message id ${result.messageId || result.gmailId || ''}`.trim(),
        });
      } catch (err) {
        console.error('Paperwork delivery failed:', err.message);
        steps.push({ step: 'Deliver paperwork', status: 'error', detail: err.message });
      }
    })();
    const [kept] = await Promise.all([keep, deliver]);
    if (!kept) steps.push({ step: 'Keep signed copies', status: 'error', detail: 'The signed copies could not be saved here.' });

    // Keep a durable record of the completed paperwork so there is a lasting
    // history of every hire, independent of anyone's inbox.
    let recorded = false;
    try {
      await onboarding.upsertRecord('hires', {
        id: audit.reference,
        reference: audit.reference,
        linkId: ctx.linkId,
        firstName: enriched.legalFirstName || hire.firstName,
        lastName: enriched.legalLastName || hire.lastName,
        email: hire.email,
        phone: enriched.phone || hire.phone,
        jobTitle: enriched.jobTitle,
        startDate: hire.startDate || '',
        signedDate: enriched.signedDate,
        signedAt: now.toISOString(),
        documents: completed.map((d) => d.title),
        healthElection: submission.healthElection || '',
        delivered: emailed,
        deliveredTo,
        // The signing record, as the certificate on every document states it.
        audit: { ip: audit.ip, location: audit.location, userAgent: audit.userAgent.slice(0, 300), time: audit.time, consent: true },
        files: completed.map((d) => ({ key: d.key, title: d.title, filename: d.filename, sha256: d.sha256, size: d.buffer.length, stored: kept })),
      });
      recorded = true;
    } catch (err) {
      console.error('Could not save the hire record:', err.message);
    }

    // The hire's part is done once their signed packet is safely somewhere —
    // kept here with its record, or delivered to the team's inbox — whatever
    // became of the rest: telling them it failed would only have them sign it
    // all again. Nowhere at all, it did fail, and they are told so.
    const failed = !((kept && recorded) || emailed);
    if (failed) {
      // Nothing is left to say it went through: the link opens again for them
      // to resubmit, and a half-kept attempt would otherwise answer "already
      // signed" to it.
      if (recorded) await onboarding.deleteRecord('hires', audit.reference).catch(() => {});
      await onboarding.deleteSignedCopies({ reference: audit.reference, files: completed }).catch(() => {});
    } else {
      await announceSigned({ name, email: hire.email, reference: audit.reference, at: now.toISOString(), db });
    }
    // A step that failed on our side is the team's to know about, not the
    // hire's to redo: the dashboard says what went wrong.
    for (const st of steps.filter((x) => x.status === 'error')) {
      await store.addEvent('error', `Signed paperwork from ${name || hire.email} (${audit.reference}): ${st.step.toLowerCase()} failed — ${st.detail}${failed ? ' Nothing was kept, and they were asked to submit again.' : kept && recorded ? ' The signed copies are saved under Onboarding docs → Signed paperwork.' : ''}`).catch(() => {});
    }

    res.json({
      ok: !failed,
      emailed,
      reference: audit.reference,
      steps,
      documents: completed.map(({ key, title, filename }) => ({ key, title, filename })),
    });
    return failed ? false : audit.reference;
  }
}

// A signed packet is news: into Candidate updates (against the person's
// record, when they are on the Candidates list) and to the team's phone.
async function announceSigned({ name, email, reference, at, db }) {
  const who = name || email || 'A new hire';
  const lowerEmail = onboarding.lower(email);
  const match = lowerEmail
    ? db.candidates.find((c) => onboarding.lower(c.email) === lowerEmail || (c.altEmails || []).some((e) => onboarding.lower(e) === lowerEmail))
    : null;
  await store.addEvent('signed', `${who} signed their onboarding paperwork (${reference}).`, match ? match.id : null, at)
    .catch((err) => console.error('[onboarding] feed:', err.message));
  try {
    await notify.pushToPhone(db.settings, {
      title: `✍️ ${who} signed their onboarding paperwork`,
      message: `All ${COMPANY_DOCUMENTS.length} documents are signed — reference ${reference}.`,
      priority: 'default',
      tags: 'writing_hand',
    });
  } catch (err) {
    await store.addErrorOnce(`Phone notification failed: ${err.message}`).catch(() => {});
  }
}

// ---------------- from the Candidates page ----------------
// Someone on the team's candidate list, onto the onboarding pipeline — once:
// if they are already there (by email), the existing card is the answer.
// The pipeline's record for someone on the Candidates page.
function recordFromCrm(cand, id) {
  const parts = String(cand.name || '').trim().split(/\s+/).filter(Boolean);
  return {
    id,
    local: true,
    appliedDate: new Date().toISOString().slice(0, 10),
    startDate: '',
    applicant: {
      firstName: cand.firstName || parts[0] || '',
      lastName: cand.lastName || parts.slice(1).join(' ') || '',
      email: String(cand.email || '').trim(),
      phoneNumber: cand.phone || '',
    },
    job: { title: { label: 'Account Executive' } },
    status: { id: 'local', label: 'Added' },
    crmId: cand.id,
    savedAt: new Date().toISOString(),
  };
}

// Everyone already on the pipeline, by email (with any correction applied).
function pipelineEmails(doc) {
  const over = new Map(doc.overrides.map((o) => [String(o.id), o]));
  const taken = new Map();
  for (const c of doc.candidates) {
    const e = onboarding.lower({ ...(c.applicant || {}), ...(over.get(String(c.id)) || {}) }.email);
    if (e && !taken.has(e)) taken.set(e, c.id);
  }
  return taken;
}

// From the Candidates page: one person ({id} — the row's button, which then
// opens their card), or a selection ({ids}), onto the pipeline — once each,
// by email. Nothing is sent: that is one tap on their card.
router.post('/api/onboarding/from-crm', route(async (req, res) => {
  const body = req.body || {};
  const db = await store.read();
  if (Array.isArray(body.ids)) {
    const ids = [...new Set(body.ids.map(String))].slice(0, 500);
    if (!ids.length) throw userError('Choose who to add to Onboarding docs.');
    const byId = new Map(db.candidates.map((c) => [c.id, c]));
    const domains = ownDomains(((await mailer.sendStatus(db.settings).catch(() => ({}))) || {}).from);
    const out = { added: [], already: [], refused: [] };
    await onboarding.update((doc) => {
      out.added = []; out.already = []; out.refused = [];
      const taken = pipelineEmails(doc);
      const fresh = [];
      ids.forEach((id, i) => {
        const cand = byId.get(id);
        const email = cand && String(cand.email || '').trim();
        if (!cand) return out.refused.push({ id, error: 'No longer on the list.' });
        if (!email) return out.refused.push({ id, error: 'No email address to send their packet to.' });
        if (isOwnCompany(email, domains)) return out.refused.push({ id, error: 'That is a Wholesale Payments address.' });
        const key = onboarding.lower(email);
        if (taken.has(key)) return out.already.push(id);
        if (doc.candidates.length + fresh.length >= 2000) return out.refused.push({ id, error: 'The onboarding pipeline is full (2,000).' });
        const record = recordFromCrm(cand, `hire-${Date.now()}-${i}`);
        taken.set(key, record.id);
        fresh.push(record);
        out.added.push({ id, recordId: record.id });
      });
      if (!fresh.length) return false;
      doc.candidates = [...fresh, ...doc.candidates];
    });
    return res.json({ ok: true, ...out });
  }
  const id = String(body.id || '');
  const cand = db.candidates.find((c) => c.id === id);
  if (!cand) return res.status(404).json({ error: 'That candidate is no longer on the list.' });
  const email = String(cand.email || '').trim();
  if (email) await assertNotOwnCompany(db, email);
  let result = null;
  await onboarding.update((doc) => {
    result = null;
    const key = onboarding.lower(email);
    const existing = key && pipelineEmails(doc).get(key);
    if (existing) { result = { id: existing, already: true }; return false; }
    const record = recordFromCrm(cand, `hire-${Date.now()}`);
    doc.candidates = [record, ...doc.candidates].slice(0, 2000);
    result = { id: record.id, already: false };
  });
  res.json({ ok: true, ...result });
}));

module.exports = { router, isOwnCompany, ownDomains, paperworkContext, announceSigned };
