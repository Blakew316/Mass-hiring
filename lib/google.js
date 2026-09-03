// Google integration over plain REST (no heavyweight SDK):
//  - OAuth2 (offline access) for Sheets read + Gmail send
//  - Sheets values fetch for private sheets
//  - Public-link CSV export fallback so Sheets import works with zero setup
//  - Gmail API "send" from the connected work account
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, '..', 'data', 'tokens.json');
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

function creds(settings) {
  return {
    clientId: settings.googleClientId || process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: settings.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || '',
  };
}

function baseUrl() {
  return (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
}

function redirectUri() {
  return `${baseUrl()}/auth/google/callback`;
}

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}

function saveTokens(t) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2));
}

function clearTokens() {
  try { fs.unlinkSync(TOKEN_FILE); } catch {}
}

function authUrl(settings) {
  const { clientId } = creds(settings);
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Google token request failed');
  return data;
}

async function exchangeCode(code, settings) {
  const { clientId, clientSecret } = creds(settings);
  const data = await tokenRequest({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || (loadTokens() || {}).refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
  // Look up which account was connected so the UI can show it.
  try {
    const uRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const u = await uRes.json();
    tokens.email = u.email || '';
  } catch {}
  saveTokens(tokens);
  return tokens;
}

async function accessToken(settings) {
  const t = loadTokens();
  if (!t) return null;
  if (t.expires_at && t.expires_at - 60_000 > Date.now()) return t.access_token;
  if (!t.refresh_token) return t.access_token || null;
  const { clientId, clientSecret } = creds(settings);
  const data = await tokenRequest({
    refresh_token: t.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });
  t.access_token = data.access_token;
  t.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
  saveTokens(t);
  return t.access_token;
}

function status(settings) {
  const t = loadTokens();
  const c = creds(settings);
  return {
    configured: Boolean(c.clientId && c.clientSecret),
    connected: Boolean(t && (t.refresh_token || t.access_token)),
    email: (t && t.email) || '',
    redirectUri: redirectUri(),
  };
}

function sheetIdFrom(input) {
  const m = String(input || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(String(input || '').trim())) return input.trim();
  return null;
}

// Fetch sheet rows. Tries the Sheets API when connected; otherwise falls back
// to the public CSV export (works when the sheet is shared "anyone with link").
async function fetchSheetRows(input, settings) {
  const id = sheetIdFrom(input);
  if (!id) throw new Error('That does not look like a Google Sheets link or ID.');

  const token = await accessToken(settings).catch(() => null);
  if (token) {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/A1:Z10000?majorDimension=ROWS`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    if (res.ok) return { rows: data.values || [], via: 'google-api' };
    // Fall through to the public export if the API rejected us (e.g. no access).
  }

  const res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv`, {
    redirect: 'follow',
  });
  const text = await res.text();
  if (!res.ok || /<html/i.test(text.slice(0, 500))) {
    throw new Error(
      token
        ? 'Google could not open that sheet with the connected account, and it is not shared publicly.'
        : 'The sheet is not public. Either share it as "Anyone with the link → Viewer", or connect Google in Settings to import private sheets.'
    );
  }
  const { parseCsv } = require('./csv');
  return { rows: parseCsv(text), via: 'public-csv' };
}

// Send one email through the Gmail API from the connected account.
async function gmailSend(settings, { to, subject, html, text }) {
  const token = await accessToken(settings);
  if (!token) throw new Error('Google is not connected.');
  const t = loadTokens();
  const boundary = 'b_' + Math.random().toString(36).slice(2);
  const subjectB64 = Buffer.from(subject, 'utf8').toString('base64');
  const lines = [
    `From: ${t.email || 'me'}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${subjectB64}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text, 'utf8').toString('base64'),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64'),
    `--${boundary}--`,
  ];
  const raw = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || 'Gmail send failed');
  return data;
}

module.exports = { authUrl, exchangeCode, status, clearTokens, fetchSheetRows, gmailSend, loadTokens };
