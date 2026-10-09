const crypto = require('crypto');
const { assertSendable } = require('./email-address');
// Google integration over plain REST (no heavyweight SDK):
//  - OAuth2 (offline access) for Sheets read + Gmail send
//  - Sheets values fetch for private sheets
//  - Public-link CSV export fallback so Sheets import works with zero setup
//  - Gmail API "send" from the connected work account
const storage = require('./storage');
const tenant = require('./tenant');

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

// `refused` on the error: Google itself said no to these credentials (the
// connection was revoked, expired or never valid), which only connecting
// again can cure — as opposed to a timeout or a passing fault at Google,
// which the next try usually gets past.
const REFUSED = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_request']);
async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', bounded({
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error_description || data.error || `Google token request failed (${res.status})`);
    e.refused = REFUSED.has(data.error) || res.status === 401;
    throw e;
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A refusal from Gmail, said for what it is. Gmail answers 403 for two very
// different things: a permission this connection was not given (only
// reconnecting cures that), and its own per-user rate limit, shared by
// everything the account does at once — a send run, the reply check, a
// conversation opened — and met for a second or two at a time (as is 429,
// too many at once). Every 403 used to be taken for the first, so opening a
// couple of conversations while Gmail was busy said "Reconnect" — which
// changed nothing.
function isRateLimited(res, data) {
  const err = (data && data.error) || {};
  const reasons = (Array.isArray(err.errors) ? err.errors : []).map((x) => (x && x.reason) || '').join(' ');
  return res.status === 429 || (res.status === 403 && /rate ?limit|quota|limitexceeded|too many/i.test(`${reasons} ${err.message || ''} ${err.status || ''}`));
}
// When Gmail has said to wait ("User-rate limit exceeded. Retry after
// <time>"), until when, per team: asking again before then only keeps the
// account locked out longer, so nothing more is asked of Gmail until it.
const quietUntil = new Map();         // team -> ms
const teamNow = () => tenant.current() || '-';
function busyNow() {
  const until = quietUntil.get(teamNow()) || 0;
  if (until <= Date.now()) return null;
  const e = new Error(BUSY_MESSAGE);
  e.rateLimited = true;
  e.retryAt = new Date(until).toISOString();
  return e;
}
const BUSY_MESSAGE = 'Gmail is busy for a moment (its limit on how fast one account is read) — try again in a few seconds.';
function gmailFailure(res, data, fallback) {
  const err = (data && data.error) || {};
  const msg = err.message || fallback;
  const e = new Error(msg);
  e.status = res.status;
  e.rateLimited = isRateLimited(res, data);
  if (e.rateLimited) {
    const after = Date.parse((String(msg).match(/retry after\s+(\S+)/i) || [])[1] || '');
    if (Number.isFinite(after) && after > Date.now()) {
      const until = Math.min(after, Date.now() + 30 * 60 * 1000);
      quietUntil.set(teamNow(), until);
      e.retryAt = new Date(until).toISOString();
    }
    e.message = BUSY_MESSAGE;
  }
  const reasons = (Array.isArray(err.errors) ? err.errors : []).map((x) => (x && x.reason) || '').join(' ');
  e.scope = !e.rateLimited && res.status === 403 && /insufficient|scope/i.test(`${reasons} ${msg} ${JSON.stringify(err.details || '')}`);
  if (res.status === 404) e.gone = true;
  return e;
}
// A Gmail read, asked once more when Gmail is only busy for a moment (its
// rate limit, or a passing fault on its side) — once: asking again and again
// is itself what keeps an account over the limit. Not at all while Gmail
// has said to wait (busyNow).
const RETRY_WAIT_MS = 1000;
async function gmailGet(url, token) {
  const quiet = busyNow();
  if (quiet) throw quiet;
  for (let i = 0; ; i++) {
    const res = await fetch(url, bounded({ headers: { Authorization: `Bearer ${token}` } }));
    const data = await res.json().catch(() => ({}));
    if (res.ok || i >= 1 || !(isRateLimited(res, data) || res.status >= 500)) return { res, data };
    if (isRateLimited(res, data) && /retry after/i.test((data.error && data.error.message) || '')) return { res, data };
    const named = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
    if (Number.isFinite(named) && named > 2) return { res, data };
    await sleep(Number.isFinite(named) && named > 0 ? named * 1000 : RETRY_WAIT_MS);
  }
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

// `known` lets a caller that has already read the token record pass it in.
// status() is on the /api/state path, which the browser asks for every 30
// seconds; reading the same blob twice per call is a round-trip for nothing.
async function accessToken(settings, known) {
  const t = known !== undefined ? known : await loadTokens();
  if (!t) return null;
  if (t.expires_at && t.expires_at - 60_000 > Date.now()) return t.access_token;
  if (!t.refresh_token) return t.access_token || null;
  const { clientId, clientSecret } = creds(settings);
  const ask = () => tokenRequest({
    refresh_token: t.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });
  // A refusal is final; a timeout or a fault at Google is asked once more.
  const data = await ask().catch(async (err) => {
    if (err.refused) throw err;
    await sleep(500);
    return ask();
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
//
// `tokens` lets a caller that started reading the token record already (the
// state poll starts it alongside everything else it reads) hand it over, the
// record or the read under way.
async function status(settings, tokens) {
  const t = tokens !== undefined ? await tokens : await loadTokens();
  const c = creds(settings);
  const hasTokens = Boolean(t && (t.refresh_token || t.access_token));
  let expired = false;
  let error = '';
  // Expired only when Google refused the credentials: a token refresh that
  // timed out, or met a passing fault at Google, is not a reason to tell
  // anyone to reconnect — the next request simply tries again.
  if (hasTokens) {
    try { await accessToken(settings, t); }
    catch (err) { expired = Boolean(err.refused); error = err.message || String(err); }
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
// RFC 822 message: multipart/alternative (text + html), wrapped in
// multipart/mixed when there are attachments. Base64 bodies are wrapped at
// 76 columns as the standard requires.
function b64lines(buf) {
  return Buffer.from(buf).toString('base64').replace(/(.{76})/g, '$1\r\n');
}
function encodeWord(s) {
  const str = String(s || '');
  return /^[\x20-\x7e]*$/.test(str) ? str : `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}
// A header *parameter* whose value is not plain ASCII -- an attachment's
// filename, in practice. We used to write an RFC 2047 encoded-word here
// (=?UTF-8?B?...?=), which RFC 2047 s5 forbids inside a parameter value: a
// client that follows the standard shows the candidate that gibberish instead
// of the name of the file. RFC 2231 is the parameter form. An ASCII fallback
// goes first for clients that ignore the extended form; the value is split
// across continuations, and the header folded, so no line runs long.
function extParam(name, value) {
  const v = String(value || '').replace(/[\r\n]/g, '');
  // Inside a quoted-string a backslash escapes the next character, so a
  // Windows path arrived as C:Usersmeflyer.png -- the reader ate the
  // separators. Both it and a quote have to be escaped, not dropped.
  if (/^[\x20-\x7e]*$/.test(v)) return `${name}="${v.replace(/([\\"])/g, '\\$1')}"`;
  const enc = [...Buffer.from(v, 'utf8')]
    .map((b) => {
      const ch = String.fromCharCode(b);
      return /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
  // Chunk on whole tokens: a continuation must never split a %XX escape.
  const chunks = [];
  let cur = '';
  for (const tok of enc.match(/%[0-9A-F]{2}|[\s\S]/g) || []) {
    if (cur.length + tok.length > 60) { chunks.push(cur); cur = ''; }
    cur += tok;
  }
  if (cur) chunks.push(cur);
  // The extended form only: RFC 2231 s4 makes the two forms of one parameter
  // mutually exclusive, and a reader offered both keeps the plain one, which
  // is exactly the mangled name we are trying not to send.
  const out = [];
  if (chunks.length <= 1) out.push(`${name}*=UTF-8''${chunks[0] || ''}`);
  else chunks.forEach((c, i) => out.push(`${name}*${i}*=${i === 0 ? "UTF-8''" : ''}${c}`));
  return out.join(';\r\n ');
}

// A Message-ID we choose ourselves, so a later follow-up can reference it.
function newMessageId(fromAddress) {
  const domain = String(fromAddress || '').split('@')[1] || 'outreach.local';
  return `<${crypto.randomUUID()}@${domain.replace(/[^A-Za-z0-9.-]/g, '')}>`;
}
const cleanHeaderId = (v) => String(v || '').replace(/[\r\n"]/g, '').trim();

// Copy addresses: one, several, or a comma-separated list, each held to the
// same rule as a recipient. Duplicates of each other are dropped.
function ccList(cc) {
  const raw = Array.isArray(cc) ? cc : String(cc || '').split(',');
  const out = [];
  for (const c of raw) {
    const a = String(c || '').trim();
    if (!a) continue;
    assertSendable(a, 'copy');
    if (!out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(a);
  }
  return out;
}

function buildMime({ from, to, cc, subject, text, html, attachments = [], messageId, inReplyTo, references }) {
  // The recipient comes from an imported sheet, so it is checked here rather
  // than trusted: no second address, no display name, nothing that could end
  // the header and start another one.
  const recipient = assertSendable(to);
  const alt = 'alt_' + crypto.randomBytes(8).toString('hex');
  const headers = [`From: ${from}`, `To: ${recipient}`, `Subject: ${encodeWord(subject)}`, 'MIME-Version: 1.0'];
  // A copy, checked exactly like the recipient. Only the onboarding packet and
  // its signed return use one; every other send leaves it out.
  const copies = ccList(cc);
  if (copies.length) headers.splice(2, 0, `Cc: ${copies.join(', ')}`);
  if (messageId) headers.push(`Message-ID: ${cleanHeaderId(messageId)}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${cleanHeaderId(inReplyTo)}`);
  if (references) headers.push(`References: ${cleanHeaderId(references)}`);
  const body = [
    `--${alt}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64lines(Buffer.from(text || '', 'utf8')),
    `--${alt}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64lines(Buffer.from(html || '', 'utf8')),
    `--${alt}--`,
  ];
  // An attachment with a cid is an image the HTML shows in place (a logo),
  // carried beside the text in multipart/related rather than as a file.
  const inline = attachments.filter((a) => a && a.cid);
  const files = attachments.filter((a) => !(a && a.cid));
  let content = [`Content-Type: multipart/alternative; boundary="${alt}"`, '', ...body];
  if (inline.length) {
    const rel = 'rel_' + crypto.randomBytes(8).toString('hex');
    content = [`Content-Type: multipart/related; type="multipart/alternative"; boundary="${rel}"`, '', `--${rel}`, ...content];
    for (const a of inline) {
      const fname = String(a.filename || 'image');
      content.push(
        `--${rel}`,
        `Content-Type: ${a.contentType || 'application/octet-stream'}; ${extParam('name', fname)}`,
        `Content-ID: <${String(a.cid).replace(/[^A-Za-z0-9._@-]/g, '')}>`,
        `Content-Disposition: inline; ${extParam('filename', fname)}`,
        'Content-Transfer-Encoding: base64',
        '',
        b64lines(a.content)
      );
    }
    content.push(`--${rel}--`);
  }
  if (!files.length) {
    return [...headers, ...content].join('\r\n');
  }
  const mixed = 'mix_' + crypto.randomBytes(8).toString('hex');
  const lines = [...headers, `Content-Type: multipart/mixed; boundary="${mixed}"`, '', `--${mixed}`, ...content];
  for (const a of files) {
    const fname = String(a.filename || 'attachment');
    lines.push(
      `--${mixed}`,
      `Content-Type: ${a.contentType || 'application/octet-stream'}; ${extParam('name', fname)}`,
      `Content-Disposition: attachment; ${extParam('filename', fname)}`,
      'Content-Transfer-Encoding: base64',
      '',
      b64lines(a.content)
    );
  }
  lines.push(`--${mixed}--`);
  return lines.join('\r\n');
}

// Sent through the media-upload endpoint as a raw RFC 822 message, which
// carries attachments (up to 35 MB) — the JSON `raw` variant is for small
// messages only.
// A follow-up (threadId + In-Reply-To/References) goes through the
// multipart upload so Gmail files it in the existing conversation; anything
// else uses the plain media upload.
async function gmailSend(settings, { to, cc, subject, html, text, attachments = [], threadId, inReplyTo, references, messageId }, { signal } = {}) {
  const token = await accessToken(settings);
  if (!token) throw new Error('Google is not connected.');
  const t = (await loadTokens()) || {};
  const mid = messageId || newMessageId(t.email || '');
  const raw = buildMime({ from: fromHeader(settings.fromName, t.email || 'me'), to, cc, subject, text, html, attachments, messageId: mid, inReplyTo, references });
  let url = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media';
  let body = raw;
  let contentType = 'message/rfc822';
  if (threadId) {
    const b = 'rel_' + crypto.randomBytes(8).toString('hex');
    url = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart';
    contentType = `multipart/related; boundary="${b}"`;
    body = [`--${b}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify({ threadId: String(threadId) }), `--${b}`, 'Content-Type: message/rfc822', '', raw, `--${b}--`, ''].join('\r\n');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body,
    signal: signal || AbortSignal.timeout(NET_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error((data.error && data.error.message) || `Gmail send failed (${res.status})`);
    e.status = res.status;
    e.reason = data.error && data.error.errors && data.error.errors[0] && data.error.errors[0].reason;
    throw e;
  }
  return { id: data.id, threadId: data.threadId, messageId: mid };
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

// Bounces and machine-generated replies are not people responding.
//   'bounce' – delivery failure (address not found, undeliverable, …)
//   'auto'   – out-of-office / automatic reply / notification
//   ''       – a real reply
function classifyReply({ from = '', subject = '', text = '', snippet = '', headers = {} }) {
  const f = String(from).toLowerCase();
  const s = String(subject).toLowerCase();
  const body = `${text || ''}\n${snippet || ''}`.toLowerCase();
  const h = (n) => String(headers[n.toLowerCase()] || '').toLowerCase();
  if (/mailer-daemon|postmaster@|mail delivery (subsystem|system)/.test(f)) return 'bounce';
  if (h('x-failed-recipients') || h('return-path') === '<>') return 'bounce';
  if (/^(delivery status notification|undeliverable|undelivered mail|mail delivery failed|returned mail|failure notice|delivery failure|address not found)/.test(s)) return 'bounce';
  if (/^(address not found|your message wasn't delivered|delivery to the following recipient failed|the email account that you tried to reach|this message was created automatically by mail delivery)/.test(body.trim())) return 'bounce';
  const auto = h('auto-submitted');
  if (auto && auto !== 'no') return 'auto';
  if (/^(bulk|auto_reply|auto-reply|junk|list)$/.test(h('precedence'))) return 'auto';
  if (h('x-autoreply') || h('x-autorespond') || h('x-auto-response-suppress')) return 'auto';
  if (/^(automatic reply|auto(matic)?[- ]?reply|auto(matic)?[- ]?response|out of (the )?office|ooo\b|i am out of|i'm out of|away from (the )?office)/.test(s)) return 'auto';
  if (/no-?reply@|donotreply@|do-not-reply@|notifications?@|noreply/.test(f)) return 'auto';
  if (/^(i am currently out of the office|i'm currently out of the office|thank you for your (e-?mail|message)\.? i am (currently )?(out|away))/.test(body.trim())) return 'auto';
  return '';
}

const REPLY_HEADERS = ['From', 'Date', 'Subject', 'Auto-Submitted', 'Precedence', 'X-Autoreply', 'X-Autorespond', 'X-Auto-Response-Suppress', 'X-Failed-Recipients', 'Return-Path'];

async function threadReplies(settings, threadId, myEmail) {
  const token = await accessToken(settings);
  if (!token) throw new Error('Google is not connected.');
  const get = (format) => gmailGet(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=${format}` +
      (format === 'metadata' ? REPLY_HEADERS.map((h) => `&metadataHeaders=${h}`).join('') : ''),
    token
  );
  let limited = false;
  let { res, data } = await get('full');
  if (res.status === 403 && /metadata scope|format/i.test((data.error && data.error.message) || '')) {
    limited = true;
    ({ res, data } = await get('metadata'));
  }
  if (!res.ok) throw gmailFailure(res, data, `Gmail thread lookup failed (${res.status})`);
  const me = String(myEmail || '').toLowerCase();
  const replies = [];
  for (const m of data.messages || []) {
    const headers = {};
    for (const h of (m.payload && m.payload.headers) || []) headers[String(h.name).toLowerCase()] = h.value;
    const from = headers.from || '';
    if (!from || (me && from.toLowerCase().includes(me))) continue;
    const snippet = decodeEntities(m.snippet || '');
    const text = limited ? '' : messageText(m.payload);
    replies.push({
      id: m.id,
      from,
      date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : (headers.date || ''),
      subject: headers.subject || '',
      snippet,
      text,
      kind: classifyReply({ from, subject: headers.subject, text, snippet, headers }),
    });
  }
  return { replies, limited };
}

// Both halves of an email conversation, oldest first.
//
// threadReplies() above exists to answer "did they write back", so it drops
// our own messages on the floor. A conversation needs them, and it needs the
// Message-ID of the newest message: Gmail's threadId keeps a reply in the
// right thread on OUR side, but only In-Reply-To/References put it there in
// the recipient's client.
//
// Gmail is the store for email, so this reads it live rather than mirroring
// it. A reply sent from a phone or from Gmail itself then shows up here too,
// which a mirror would quietly miss.
const THREAD_HEADERS = ['From', 'To', 'Date', 'Subject', 'Message-ID'];
async function threadMessages(settings, threadId, myEmail) {
  const token = await accessToken(settings);
  if (!token) throw new Error('Google is not connected.');
  const get = (format) => gmailGet(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=${format}` +
      (format === 'metadata' ? THREAD_HEADERS.map((h) => `&metadataHeaders=${h}`).join('') : ''),
    token
  );
  let limited = false;
  let { res, data } = await get('full');
  // The narrow metadata scope cannot read bodies. Fall back to headers and
  // snippets rather than showing nothing at all.
  if (res.status === 403 && /metadata scope|format/i.test((data.error && data.error.message) || '')) {
    limited = true;
    ({ res, data } = await get('metadata'));
  }
  if (!res.ok) throw gmailFailure(res, data, `Gmail thread lookup failed (${res.status})`);
  const me = String(myEmail || '').toLowerCase();
  const messages = [];
  for (const m of data.messages || []) {
    const headers = {};
    for (const h of (m.payload && m.payload.headers) || []) headers[String(h.name).toLowerCase()] = h.value;
    const from = headers.from || '';
    const mine = Boolean(me && from.toLowerCase().includes(me));
    const snippet = decodeEntities(m.snippet || '');
    const text = limited ? '' : messageText(m.payload);
    messages.push({
      id: m.id,
      dir: mine ? 'out' : 'in',
      from,
      date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : (headers.date || ''),
      subject: headers.subject || '',
      messageId: headers['message-id'] || '',
      snippet,
      text,
      // Ours is never a bounce; theirs might be, and a bounce is not a person
      // talking, so the view can mark it rather than pass it off as a reply.
      kind: mine ? '' : classifyReply({ from, subject: headers.subject, text, snippet, headers }),
    });
  }
  messages.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const last = messages[messages.length - 1] || null;
  return {
    messages,
    limited,
    lastMessageId: last ? last.messageId : '',
    lastSubject: last ? last.subject : '',
  };
}

// Did a message to `email` leave this account since `sinceMs`? Used after a
// send timed out (outcome unknown) so it is never blindly sent twice.
// Costs 5 quota units; needs the Gmail read permission (gmail.readonly).
async function findSentTo(settings, email, sinceMs) {
  const token = await accessToken(settings);
  if (!token) throw new Error('Google is not connected.');
  const after = Math.max(0, Math.floor(sinceMs / 1000) - 120);
  const q = `in:sent to:${email} after:${after}`;
  const { res, data } = await gmailGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&q=${encodeURIComponent(q)}`, token);
  if (!res.ok) throw gmailFailure(res, data, `Gmail search failed (${res.status})`);
  const m = (data.messages || [])[0];
  return m ? { id: m.id, threadId: m.threadId } : null;
}

// Which conversations have had a message from someone else since `sinceMs`:
// one search instead of reading every thread in turn, so a new reply is found
// within the minute rather than whenever a slow rotation reaches its thread.
// Every page of the search, up to `pages` of 500: the answer's `complete`
// says whether it reached the end, since a window that was cut short must not
// be treated as looked at.
async function recentInboundThreads(settings, sinceMs, { pages = 4 } = {}) {
  const token = await accessToken(settings);
  if (!token) throw new Error('Google is not connected.');
  const after = Math.max(0, Math.floor(sinceMs / 1000) - 120);
  const q = `-in:sent -in:drafts -in:chats after:${after}`;
  const threads = new Set();
  let pageToken = '';
  for (let i = 0; i < pages; i++) {
    const { res, data } = await gmailGet(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=500&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      token
    );
    if (!res.ok) throw gmailFailure(res, data, `Gmail search failed (${res.status})`);
    for (const m of data.messages || []) if (m.threadId) threads.add(m.threadId);
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  threads.complete = !pageToken;
  return threads;
}

module.exports = { ccList, authUrl, exchangeCode, status, loadTokens, clearTokens, fetchSheetRows, gmailSend, buildMime, newMessageId, getSignature, threadReplies, threadMessages, cleanReply, classifyReply, findSentTo, recentInboundThreads, baseUrl, accessToken };
