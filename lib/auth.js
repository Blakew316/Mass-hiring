// Password gate for the dashboard.
//
// Set APP_PASSWORD (env var — on Netlify: Site configuration → Environment
// variables) and every API and OAuth route requires a session cookie; the
// Calendly webhook and static files stay open. A public (Netlify) deploy
// without APP_PASSWORD refuses to operate until one is set, because the app
// can send email from the owner's account.
//
// Session design (no server-side session table needed):
//   key    = scrypt(APP_PASSWORD, salt)   salt lives in storage; rotating it
//                                         on sign-out invalidates every session
//   cookie = <expiry>.<HMAC(key, expiry)> expiry enforced server-side
// scrypt keeps a stolen cookie from being a cheap offline oracle for the
// password; the derived key is memoized per warm instance.
const crypto = require('crypto');
const storage = require('./storage');

const COOKIE = 'crm_auth';
const STATE_COOKIE = 'crm_oauth_state';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const FAIL_DELAY_MS = 600;

function password() {
  return process.env.APP_PASSWORD || '';
}

function required() {
  return Boolean(password());
}

function setupRequired() {
  return storage.onNetlify && !required();
}

// ---------- key derivation ----------
const keyCache = new Map();
function derivedKey(salt) {
  const pw = password();
  const cacheKey = `${salt}:${crypto.createHash('sha256').update(pw).digest('hex')}`;
  let k = keyCache.get(cacheKey);
  if (!k) {
    k = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
    keyCache.clear();
    keyCache.set(cacheKey, k);
  }
  return k;
}

async function sessionSalt({ rotate = false } = {}) {
  let s = rotate ? null : await storage.getJson('session');
  if (!s || typeof s.salt !== 'string' || !s.salt) {
    s = { salt: crypto.randomBytes(16).toString('hex') };
    await storage.setJson('session', s);
  }
  return s.salt;
}

function sign(key, payload) {
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// ---------- cookies ----------
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i <= 0) return;
    const name = part.slice(0, i).trim();
    const raw = part.slice(i + 1).trim();
    try { out[name] = decodeURIComponent(raw); } catch { out[name] = raw; }
  });
  return out;
}

function isHttps(req) {
  return Boolean(req.secure) || String(req.headers['x-forwarded-proto'] || '').includes('https');
}

function cookieString(req, name, value, maxAgeSeconds) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

// ---------- sessions ----------
async function isAuthed(req) {
  if (setupRequired()) return false;
  if (!required()) return true;
  const raw = parseCookies(req.headers.cookie)[COOKIE] || '';
  const dot = raw.indexOf('.');
  if (dot <= 0) return false;
  const expStr = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const exp = Number(expStr);
  if (!/^\d+$/.test(expStr) || !Number.isFinite(exp) || exp < Date.now() || !sig) return false;
  const salt = await sessionSalt();
  return safeEqual(sig, sign(derivedKey(salt), `session:${expStr}`));
}

async function setSessionCookie(req, res) {
  const salt = await sessionSalt();
  const exp = String(Date.now() + SESSION_MS);
  const value = `${exp}.${sign(derivedKey(salt), `session:${exp}`)}`;
  res.setHeader('Set-Cookie', cookieString(req, COOKIE, value, SESSION_MS / 1000));
}

// Sign-out rotates the salt, which signs out every device at once.
async function revokeAllSessions(req, res) {
  await sessionSalt({ rotate: true });
  res.setHeader('Set-Cookie', cookieString(req, COOKIE, '', 0));
}

function checkPassword(candidate) {
  return required() && safeEqual(candidate || '', password());
}

// ---------- login throttling (per warm instance; best effort) ----------
const attempts = new Map();
function clientIp(req) {
  const h = req.headers['x-nf-client-connection-ip'] || req.headers['x-forwarded-for'] || req.ip || '';
  return String(h).split(',')[0].trim() || 'unknown';
}
function loginLockedFor(req) {
  const a = attempts.get(clientIp(req));
  if (a && a.lockedUntil > Date.now()) return Math.ceil((a.lockedUntil - Date.now()) / 1000);
  return 0;
}
function recordLoginFailure(req) {
  const ip = clientIp(req);
  const a = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  a.count += 1;
  if (a.count >= MAX_FAILS) { a.lockedUntil = Date.now() + LOCK_MS; a.count = 0; }
  attempts.set(ip, a);
}
function clearLoginFailures(req) {
  attempts.delete(clientIp(req));
}
const failDelay = () => new Promise((r) => setTimeout(r, FAIL_DELAY_MS));

// ---------- OAuth CSRF state ----------
function issueOauthState(req, res) {
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', cookieString(req, STATE_COOKIE, state, 600));
  return state;
}
function consumeOauthState(req, res, given) {
  const expected = parseCookies(req.headers.cookie)[STATE_COOKIE] || '';
  res.setHeader('Set-Cookie', cookieString(req, STATE_COOKIE, '', 0));
  return Boolean(expected) && safeEqual(given || '', expected);
}

// ---------- middleware ----------
// Guards /api/* and /auth/* except the login endpoints. Express matches routes
// case-insensitively and tolerates repeated slashes, so the guard normalizes
// the same way before deciding.
const OPEN = new Set(['/api/auth/status', '/api/login']);
function middleware(req, res, next) {
  const p = req.path.replace(/\/{2,}/g, '/').replace(/\/$/, '').toLowerCase() || '/';
  const guarded = p.startsWith('/api/') || p.startsWith('/auth/');
  if (!guarded || OPEN.has(p)) return next();
  if (setupRequired()) {
    return res.status(403).json({
      error: 'This dashboard is deployed publicly without a password. Set the APP_PASSWORD environment variable in Netlify (Project configuration → Environment variables) and redeploy.',
      setupRequired: true,
    });
  }
  isAuthed(req).then((ok) => {
    if (ok) return next();
    if (p.startsWith('/auth/')) return res.redirect('/#login');
    res.status(401).json({ error: 'Please sign in to the dashboard.', auth: true });
  }).catch(next);
}

module.exports = {
  required, setupRequired, isAuthed, checkPassword, setSessionCookie, revokeAllSessions,
  loginLockedFor, recordLoginFailure, clearLoginFailures, failDelay,
  issueOauthState, consumeOauthState, middleware,
};
