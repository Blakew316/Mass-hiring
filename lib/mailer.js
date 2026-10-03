// Outbound email with two transports:
//  1) Gmail API via Google OAuth (preferred when connected)
//  2) Gmail SMTP with an App Password (zero-Cloud-Console fallback)
// Loaded the first time the SMTP fallback is actually used. Parsing it is a
// third of this function's cold start (46 ms of 136) and the Gmail API path,
// which is the one that runs, never touches it.
let nodemailer = null;
const tenant = require('./tenant');
const google = require('./google');
const { assertSendable } = require('./email-address');

function smtpCreds(settings) {
  return {
    // The env vars are the original owner's mailbox login. Any other team
    // falling back to them would be sending mail from an account that is not
    // theirs, out of a dashboard that never told them whose it was.
    user: settings.smtpUser || (tenant.isLegacy() ? process.env.SMTP_USER : '') || '',
    pass: settings.smtpPass || (tenant.isLegacy() ? process.env.SMTP_PASS : '') || '',
  };
}

// `known` lets a caller that already has google.status() hand it over. Both
// are on the /api/state path, and google.status() is a blob read.
async function sendStatus(settings, known) {
  const g = known || await google.status(settings);
  const s = smtpCreds(settings);
  if (g.connected) return { ready: true, via: 'gmail-api', from: g.email || 'connected Google account' };
  if (s.user && s.pass) return { ready: true, via: 'smtp', from: s.user };
  return {
    ready: false,
    via: null,
    from: null,
    reason: g.expired
      ? 'Google connection expired — click Reconnect in Settings.'
      : 'Connect Google or add a Gmail App Password in Settings.',
  };
}

async function sendEmail(settings, message, { signal } = {}) {
  const st = await sendStatus(settings);
  if (!st.ready) {
    throw new Error('No email account is set up. Connect Google, or add a Gmail App Password in Settings.');
  }
  // Checked for both transports, before either one builds a header.
  assertSendable(message.to);
  const cc = google.ccList(message.cc);
  if (st.via === 'gmail-api') {
    const sent = await google.gmailSend(settings, message, { signal });
    return { via: 'gmail-api', from: st.from, threadId: sent.threadId, gmailId: sent.id, messageId: sent.messageId };
  }
  const { user, pass } = smtpCreds(settings);
  if (!nodemailer) nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
    // Bounded so one stalled connection cannot exceed the serverless time limit.
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 8000,
  });
  const messageId = message.messageId || google.newMessageId(user);
  await transport.sendMail({
    from: settings.fromName ? { name: String(settings.fromName).trim(), address: user } : user,
    to: message.to,
    cc: cc.length ? cc : undefined,
    subject: message.subject,
    text: message.text,
    html: message.html,
    messageId,
    // A follow-up is a reply in the original conversation.
    inReplyTo: message.inReplyTo || undefined,
    references: message.references || undefined,
    attachments: (message.attachments || []).map((a) => (a.cid
      ? { filename: a.filename, content: a.content, contentType: a.contentType, cid: a.cid, contentDisposition: 'inline' }
      : { filename: a.filename, content: a.content, contentType: a.contentType })),
  });
  return { via: 'smtp', from: user, messageId };
}

// Checks the account mail goes out through without sending anything, and
// says which one it is — the onboarding page's "Test email settings". For
// Google that is a fresh access token; for an App Password, the SMTP login.
function masked(address) {
  const u = String(address || '').trim();
  const [local, domain] = u.split('@');
  if (!domain) return u ? `${u.slice(0, 2)}•••` : '(not set)';
  return `${local.slice(0, 2)}•••@${domain}`;
}

async function verify(settings) {
  const st = await sendStatus(settings);
  if (!st.ready) return { ok: false, via: null, host: '(not set)', user: '(not set)', error: st.reason };
  if (st.via === 'gmail-api') {
    try {
      const token = await google.accessToken(settings);
      if (!token) throw new Error('Google is not connected.');
      return { ok: true, via: 'gmail-api', host: 'Gmail', user: masked(st.from) };
    } catch (err) {
      return { ok: false, via: 'gmail-api', host: 'Gmail', user: masked(st.from), error: err.message || String(err) };
    }
  }
  const { user, pass } = smtpCreds(settings);
  if (!nodemailer) nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass },
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 8000,
  });
  try {
    await transport.verify();
    return { ok: true, via: 'smtp', host: 'smtp.gmail.com', user: masked(user) };
  } catch (err) {
    return { ok: false, via: 'smtp', host: 'smtp.gmail.com', user: masked(user), error: err.message || String(err) };
  }
}

module.exports = { sendEmail, sendStatus, verify };
