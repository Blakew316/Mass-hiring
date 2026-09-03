// Google integration over plain REST (no heavyweight SDK):
//  - OAuth2 (offline access) for Sheets read + Gmail send
//  - Sheets values fetch for private sheets
//  - Public-link CSV export fallback so Sheets import works with zero setup
//  - Gmail API "send" from the connected work account
const storage = require('./storage');

const BASE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
];
// Read-only use here (fetching the account's signature), but Google classes
// it as a *restricted* scope, so it is requested only when the user keeps
// the signature option on (Settings → Google).
const SIGNATURE_SCOPE = 'https://www.googleapis.com/auth/gmail.settings.basic';

function signatureEnabled(settings) {
  return settings.gmailSignature !== false;
}

function scopes(settings) {
  return (signatureEnabled(settings) ? [...BASE_SCOPES, SIGNATURE_SCOPE] : BASE_SCOPES).join(' ');
}

function creds(settings) {
  return {
    clientId: settings.googleClientId || process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: settings.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || '',
  };
}

// BASE_URL wins; Netlify exposes the site address as URL; else local dev.
function baseUrl() {
  return (process.env.BASE_URL || process.env.URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
}

function redirectUri() {
  return `${baseUrl()}/auth/google/callback`;
}

const loadTokens = () => storage.getJson('tokens');
const saveTokens = (t) => storage.setJson('tokens', t);
const clearTokens = () => storage.del('tokens');

function authUrl(settings, state) {
  const { clientId } = creds(settings);
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: scopes(settings),
    access_type: 'offline',
    prompt: 'consent',
    ...(state ? { state } : {}),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

// Every call to Google is bounded so a stall surfaces as a clear error
// instead of tripping the platform's 10s function limit.
const NET_TIMEOUT_MS = 8000;
function bounded(init = {}) {
  return { ...init, signal: AbortSignal.timeout(NET_TIMEOUT_MS) };
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', bounded({
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  }));
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
  const previous = (await loadTokens()) || {};
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || previous.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
  // Look up which account was connected so the UI can show it.
  try {
    const uRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', bounded({
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    }));
    const u = await uRes.json();
    tokens.email = u.email || '';
  } catch {}
  // Cache the account's Gmail signature so outreach carries it.
  tokens.signature = '';
  tokens.signatureError = '';
  if (signatureEnabled(settings)) {
    try {
      tokens.signature = await fetchSignature(tokens.access_token, tokens.email);
    } catch (err) {
      tokens.signatureError = err.message || String(err);
    }
  }
  await saveTokens(tokens);
  return tokens;
}

// The signature configured in Gmail for the connected address (HTML).
async function fetchSignature(token, email) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', bounded({
    headers: { Authorization: `Bearer ${token}` },
  }));
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || 'Could not read Gmail signature');
  // Messages go out From the connected (primary) address, so use that alias's
  // signature rather than whichever alias Gmail marks as the compose default.
  const list = data.sendAs || [];
  const mine =
    list.find((s) => email && String(s.sendAsEmail).toLowerCase() === email.toLowerCase()) ||
    list.find((s) => s.isPrimary) ||
    list.find((s) => s.isDefault) ||
    list[0];
  return (mine && mine.signature) || '';
}

// Cached signature from connect time; with refresh=true re-read it from Gmail
// (used at send time so edits made in Gmail are picked up).
async function getSignature(settings, { refresh = false } = {}) {
  if (!signatureEnabled(settings)) return '';
  const t = await loadTokens();
  if (!t) return '';
  if (!refresh) return t.signature || '';
  try {
    const token = await accessToken(settings);
    const sig = await fetchSignature(token, t.email);
    if (sig !== t.signature) {
      const latest = (await loadTokens()) || t;
      latest.signature = sig;
      await saveTokens(latest);
    }
    return sig;
  } catch {
    return t.signature || '';
  }
}

async function accessToken(settings) {
  const t = await loadTokens();
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
  await saveTokens(t);
  return t.access_token;
}

// "connected" means the stored credentials still work: an expired or revoked
// refresh token (e.g. Google's 7-day limit for External apps in Testing) is
// reported as expired so the UI can prompt a reconnect instead of failing
// silently at send time.
async function status(settings) {
  const t = await loadTokens();
  const c = creds(settings);
  const hasTokens = Boolean(t && (t.refresh_token || t.access_token));
  let expired = false;
  let error = '';
  if (hasTokens) {
    try { await accessToken(settings); }
    catch (err) { expired = true; error = err.message || String(err); }
  }
  return {
    configured: Boolean(c.clientId && c.clientSecret),
    connected: hasTokens && !expired,
    expired,
    error,
    email: (t && t.email) || '',
    signature: signatureEnabled(settings) ? (t && t.signature) || '' : '',
    signatureEnabled: signatureEnabled(settings),
    signatureError: (t && t.signatureError) || '',
    redirectUri: redirectUri(),
  };
}

function sheetIdFrom(input) {
  const m = String(input || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(String(input || '').trim())) return input.trim();
  return null;
}

// A link copied while viewing a specific tab carries "#gid=<id>"; honour it
// so lists on a second tab import correctly.
function gidFrom(input) {
  const m = String(input || '').match(/[#&?]gid=(\d+)/);
  return m ? m[1] : null;
}

// Fetch sheet rows. Tries the Sheets API when connected; otherwise falls back
// to the public CSV export (works when the sheet is shared "anyone with link").
async function fetchSheetRows(input, settings) {
  const id = sheetIdFrom(input);
  if (!id) throw new Error('That does not look like a Google Sheets link or ID.');
  const gid = gidFrom(input);

  const token = await accessToken(settings).catch(() => null);
  if (token) {
    const h = { headers: { Authorization: `Bearer ${token}` } };
    let range = 'A1:Z10000';
    if (gid) {
      const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties(sheetId,title)`, h);
      const md = await meta.json();
      const tab = meta.ok && (md.sheets || []).map((s) => s.properties).find((p) => String(p.sheetId) === gid);
      if (tab) range = `'${tab.title.replace(/'/g, "''")}'!A1:Z10000`;
    }
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?majorDimension=ROWS`, h
    );
    const data = await res.json();
    if (res.ok) return { rows: data.values || [], via: 'google-api' };
    // Fall through to the public export if the API rejected us (e.g. no access).
  }

  const res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}`, {
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
  const t = (await loadTokens()) || {};
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

module.exports = { authUrl, exchangeCode, status, clearTokens, fetchSheetRows, gmailSend, getSignature, baseUrl };
