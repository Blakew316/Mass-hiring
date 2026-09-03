// Outbound email with two transports:
//  1) Gmail API via Google OAuth (preferred when connected)
//  2) Gmail SMTP with an App Password (zero-Cloud-Console fallback)
const nodemailer = require('nodemailer');
const google = require('./google');

function smtpCreds(settings) {
  return {
    user: settings.smtpUser || process.env.SMTP_USER || '',
    pass: settings.smtpPass || process.env.SMTP_PASS || '',
  };
}

async function sendStatus(settings) {
  const g = await google.status(settings);
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

async function sendEmail(settings, message) {
  const st = await sendStatus(settings);
  if (!st.ready) {
    throw new Error('No email account is set up. Connect Google, or add a Gmail App Password in Settings.');
  }
  if (st.via === 'gmail-api') {
    await google.gmailSend(settings, message);
    return { via: 'gmail-api', from: st.from };
  }
  const { user, pass } = smtpCreds(settings);
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });
  await transport.sendMail({
    from: user,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
  return { via: 'smtp', from: user };
}

module.exports = { sendEmail, sendStatus };
