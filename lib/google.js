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
// Read-only use here (the account's signature, and thread headers to detect
// replies), but Google classes both as *restricted* scopes, so they are
// requested only when the user keeps the option on (Settings → Google).
const EXTRA_SCOPES = [
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.readonly',
];

function signatureEnabled(settings) {
  return settings.gmailSignature !== false;
}

function scopes(settings) {
  return (signatureEnabled(settings) ? [...BASE_SCOPES, ...EXTRA_SCOPES] : BASE_SCOPES).join(' ');
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
  if (t.signatureCheckedAt && Date.now() - new Date(t.signatureCheckedAt).getTime() < 3600 * 1000) return t.signature || '';
  try {
    const token = await accessToken(settings);
    const sig = await fetchSignature(token, t.email);
    const latest = (await loadTokens()) || t;
    latest.signature = sig;
    latest.signatureCheckedAt = new Date().toISOString();
    await saveTokens(latest);
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

// "Blake Woodruff" <addr> — the display name recipients see instead of the
// bare address. Non-ASCII names are RFC 2047 encoded.
function fromHeader(name, address) {
  const n = String(name || '').trim().replace(/["\r\n]/g, '');
  if (!n) return address;
  const display = /^[\x20-\x7e]+$/.test(n) ? `"${n}"` : `=?UTF-8?B?${Buffer.from(n, 'utf8').toString('base64')}?=`;
  return `${display} <${address}>`;
}

// Send one email through the Gmail API from the connected account.
async function gmailSend(settings, { to, subject, html, text }, { signal } = {}) {
  const token = await accessToken(settings);
  if (!token) throw new Error('Google is not connected.');
  const t = (await loadTokens()) || {};
  const boundary = 'b_' + Math.random().toString(36).slice(2);
  const subjectB64 = Buffer.from(subject, 'utf8').toString('base64');
  const lines = [
    `From: ${fromHeader(settings.fromName, t.email || 'me')}`,
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
    signal: signal || AbortSignal.timeout(NET_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error((data.error && data.error.message) || `Gmail send failed (${res.status})`);
    e.status = res.status;
    e.reason = data.error && data.error.errors && data.error.errors[0] && data.error.errors[0].reason;
    throw e;
  }
  return { id: data.id, threadId: data.threadId };
}

// Replies in a Gmail thread: every message not from the sender, with its text.
// Falls back to headers-only when the connected account granted only the
// metadata permission (limited=true → no text).
function decodeEntities(s) {
  return String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function b64url(data) {
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function partText(part, want) {
  if (!part) return '';
  if (part.mimeType === want && part.body && part.body.data) return b64url(part.body.data);
  for (const sub of part.parts || []) { const t = partText(sub, want); if (t) return t; }
  return '';
}
// Just the new words: drop quoted history and signatures-of-quotes.
function cleanReply(text) {
  let t = String(text || '').replace(/\r/g, '');
  const cut = t.search(/^(On .{5,200} wrote:|-{2,}\s*Original Message\s*-{2,}|From: .+\nSent: .+|_{10,})/m);
  if (cut > 0) t = t.slice(0, cut);
  t = t.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
  return t.replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);
}
function messageText(payload) {
  const plain = partText(payload, 'text/plain');
  if (plain) return cleanReply(plain);
  const html = partText(payload, 'text/html');
  if (html) return cleanReply(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' '));
  return '';
}

async function threadReplies(settings, threadId, myEmail) {
  const token = await accessToken(settings);
  if (!token) throw new Error('Google is not connected.');
  const get = (format) => fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=${format}` +
      (format === 'metadata' ? '&metadataHeaders=From&metadataHeaders=Date' : ''),
    bounded({ headers: { Authorization: `Bearer ${token}` } })
  );
  let limited = false;
  let res = await get('full');
  let data = await res.json().catch(() => ({}));
  if (res.status === 403 && /metadata scope|format/i.test((data.error && data.error.message) || '')) {
    limited = true;
    res = await get('metadata');
    data = await res.json().catch(() => ({}));
  }
  if (!res.ok) {
    const msg = (data.error && data.error.message) || `Gmail thread lookup failed (${res.status})`;
    const e = new Error(msg);
    if (res.status === 403 || /insufficient|scope/i.test(msg)) e.scope = true;
    if (res.status === 404) e.gone = true;
    throw e;
  }
  const me = String(myEmail || '').toLowerCase();
  const replies = [];
  for (const m of data.messages || []) {
    const header = (n) => (((m.payload && m.payload.headers) || []).find((h) => h.name.toLowerCase() === n) || {}).value || '';
    const from = header('from');
    if (!from || (me && from.toLowerCase().includes(me))) continue;
    replies.push({
      id: m.id,
      from,
      date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : header('date'),
      snippet: decodeEntities(m.snippet || ''),
      text: limited ? '' : messageText(m.payload),
    });
  }
  return { replies, limited };
}

module.exports = { authUrl, exchangeCode, status, clearTokens, fetchSheetRows, gmailSend, getSignature, threadReplies, cleanReply, baseUrl };
