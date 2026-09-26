// The team gate.
//
// Signing in means choosing a team and entering its PIN; from then on every
// request carries that team, and lib/storage.js will not touch a stored
// document without one. APP_PASSWORD is no longer the way in — it is the
// ADMIN password, the thing you have to know to create or delete a team. The
// first team, Team Maverick, has no PIN of its own and so still signs in with
// APP_PASSWORD, exactly as the dashboard always did.
//
// A public (Netlify) deploy without APP_PASSWORD refuses to operate, because
// the app can send email from the owner's account.
//
// Session design (no server-side session table needed):
//   key    = the team's sessionSalt: 32 random bytes, kept in the registry and
//            never sent anywhere. Rotating it signs that team out everywhere,
//            and nobody else.
//   cookie = <teamId>.<expiry>.<HMAC(key, "session:<teamId>:<expiry>")>
// The cookie is derived from a random secret rather than from the PIN, so a
// stolen cookie is not an offline oracle for the PIN — there is nothing in it
// to attack — and verifying one is an HMAC rather than a key-stretching hash.
const crypto = require('crypto');
const storage = require('./storage');
const tenant = require('./tenant');
const teams = require('./teams');

const COOKIE = 'crm_auth';
const STATE_COOKIE = 'crm_oauth_state';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILS = 5;                 // wrong PINs from one IP before it is locked out
const LOCK_MS = 15 * 60 * 1000;
const FAIL_DELAY_MS = 600;
const MAX_FAIL_DELAY_MS = 5000;      // the longest we will ever sit on an answer
const FAIL_FORGET_MS = 15 * 60 * 1000;
// A bucket name no team id could ever collide with: tenant.validId allows only
// [a-z0-9-], so a colon cannot appear in one. Without this, someone creating a
// team called "Admin" would share a throttle with the admin-password gate and
// could lock every other team out of being created or deleted.
const ADMIN_BUCKET = 'admin:gate';
// Where the per-address lockout is written down. A Map in one instance's
// memory is nearly meaningless on a platform that runs several of them and
// throws each away when it goes cold: whoever is guessing simply gets a fresh
// allowance every few minutes. With a four-digit PIN that is the difference
// between "not worth trying" and "a few days", so the count goes to storage.
const GUARD_KEY = 'login-guard';
const GUARD_MAX = 300;

function adminPassword() {
  return process.env.APP_PASSWORD || '';
}

function required() {
  return Boolean(adminPassword());
}

function setupRequired() {
  return storage.onNetlify && !required();
}

// Without a password there is no sign-in and no way to make a second team, so
// a one-team install is simply that team. This is what keeps a local checkout,
// and every test, working unchanged.
//
// More than one team with no password is a different situation entirely: it
// means a password was set once and has since gone missing, and handing an
// anonymous visitor one of those teams would be a door left standing open. So
// that case resolves to nobody, and the middleware says why.
async function soloTeam() {
  const list = await teams.all();
  return list.length === 1 ? list[0] : null;
}

// ---------- signing ----------
function sign(team, payload) {
  if (!team || !team.sessionSalt) {
    throw new Error('That team has no session secret stored, so it cannot be signed in. Reload and try again.');
  }
  return crypto.createHmac('sha256', Buffer.from(team.sessionSalt, 'hex')).update(payload).digest('hex');
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
// The team this request is signed into, or null. A team id can only ever be
// [a-z0-9-], so splitting on dots is unambiguous.
async function sessionTeam(req) {
  if (setupRequired()) return null;
  if (!required()) return soloTeam();
  const raw = parseCookies(req.headers.cookie)[COOKIE] || '';
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [teamId, expStr, sig] = parts;
  if (!tenant.validId(teamId) || !/^\d+$/.test(expStr) || !sig) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const team = await teams.byId(teamId);
  if (!team || !team.sessionSalt) return null;
  return safeEqual(sig, sign(team, `session:${teamId}:${expStr}`)) ? team : null;
}

async function isAuthed(req) {
  return Boolean(await sessionTeam(req));
}

function setSessionCookie(req, res, team) {
  const exp = String(Date.now() + SESSION_MS);
  const value = `${team.id}.${exp}.${sign(team, `session:${team.id}:${exp}`)}`;
  res.setHeader('Set-Cookie', cookieString(req, COOKIE, value, SESSION_MS / 1000));
}

// Sign out of this browser only. Other devices on the same team keep working —
// on a shared team PIN, one person leaving must not throw everyone else out.
function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', cookieString(req, COOKIE, '', 0));
}

// Sign out everywhere: rotating the team's session secret invalidates every
// cookie ever issued for it, and only for it.
async function revokeTeamSessions(req, res, teamId) {
  await teams.edit(teamId, (t) => { t.sessionSalt = teams.randHex(32); });
  clearSessionCookie(req, res);
}

const checkAdminPassword = (candidate) => required() && safeEqual(candidate || '', adminPassword());

// ---------- login throttling ----------
const attempts = new Map();
function clientIp(req) {
  const h = req.headers['x-nf-client-connection-ip'] || req.headers['x-forwarded-for'] || req.ip || '';
  return String(h).split(',')[0].trim() || 'unknown';
}

// The stored record is keyed by a hash of the address, not the address: it is
// enough to recognise a repeat visitor and count their attempts, and there is
// no reason for this app to keep a list of who has typed a wrong PIN.
function ipHash(req) {
  return crypto.createHash('sha256').update(clientIp(req)).digest('hex').slice(0, 16);
}

// Reads never fail loudly: a storage blip must not lock everybody out, and it
// must not hand out a free pass either — the in-memory count still applies.
async function readGuard() {
  try {
    const g = await storage.getJson(GUARD_KEY);
    return g && typeof g === 'object' && g.ips ? g : { v: 1, ips: {} };
  } catch { return null; }
}

function pruneGuard(g, now) {
  for (const [k, e] of Object.entries(g.ips)) {
    if (now - (e.at || 0) > FAIL_FORGET_MS && (e.until || 0) <= now) delete g.ips[k];
  }
  const keys = Object.keys(g.ips);
  if (keys.length > GUARD_MAX) {
    keys.sort((a, b) => (g.ips[a].at || 0) - (g.ips[b].at || 0))
      .slice(0, keys.length - GUARD_MAX)
      .forEach((k) => delete g.ips[k]);
  }
}
// Two counters, because team names are not secrets and the sign-in screen
// lists them. They do different jobs on purpose.
//
// The per-IP one is a hard lock: one machine working through a team's PINs is
// stopped. The per-team one is NOT a lock — it only lengthens the pause before
// the answer comes back. A team-wide lock would mean anyone who can load the
// sign-in page could read a team's id off it, spend twenty wrong PINs, and
// keep that team out of its own dashboard all day for nothing.
function keysFor(req, teamId) {
  return { ip: `ip:${clientIp(req)}|${teamId || '-'}`, team: `team:${teamId || '-'}` };
}

// Counting resumes from zero once the guessing stops for a while, so a bad
// afternoon does not slow somebody down for the rest of the week.
function bucket(key) {
  const a = attempts.get(key);
  if (!a) return { count: 0, lockedUntil: 0, at: 0 };
  if (Date.now() - a.at > FAIL_FORGET_MS && a.lockedUntil <= Date.now()) return { count: 0, lockedUntil: 0, at: 0 };
  return a;
}

// Seconds this address must wait, from whichever of the two records says
// longer: the one in this instance's memory, and the one written down. The
// stored one counts every team, so five wrong PINs is five wrong PINs however
// they are spread across the sign-in screen.
async function loginLockedFor(req, teamId) {
  const now = Date.now();
  let until = bucket(keysFor(req, teamId).ip).lockedUntil;
  const g = await readGuard();
  if (g) {
    const e = g.ips[ipHash(req)];
    if (e && (e.until || 0) > until) until = e.until;
  }
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}

async function recordLoginFailure(req, teamId) {
  const now = Date.now();
  const k = keysFor(req, teamId);
  const ip = bucket(k.ip);
  ip.count += 1;
  ip.at = now;
  // The count is NOT reset when the lock goes on: someone who comes back after
  // fifteen minutes and keeps guessing is locked out again immediately.
  if (ip.count >= MAX_FAILS) ip.lockedUntil = now + LOCK_MS;
  attempts.set(k.ip, ip);
  const team = bucket(k.team);
  team.count += 1;
  team.at = now;
  attempts.set(k.team, team);
  try {
    await storage.updateJson(GUARD_KEY, (raw) => {
      const g = raw && typeof raw === 'object' && raw.ips ? raw : { v: 1, ips: {} };
      pruneGuard(g, now);
      const key = ipHash(req);
      const e = g.ips[key] || { n: 0, until: 0, at: 0 };
      e.n += 1;
      e.at = now;
      if (e.n >= MAX_FAILS) e.until = now + LOCK_MS;
      g.ips[key] = e;
      return g;
    });
  } catch { /* the in-memory count still stands */ }
}

async function clearLoginFailures(req, teamId) {
  const k = keysFor(req, teamId);
  attempts.delete(k.ip);
  attempts.delete(k.team);
  // Getting in proves this address is not the one guessing, so its record goes.
  try {
    await storage.updateJson(GUARD_KEY, (raw) => {
      const g = raw && typeof raw === 'object' && raw.ips ? raw : null;
      if (!g || !g.ips[ipHash(req)]) return false;
      delete g.ips[ipHash(req)];
      pruneGuard(g, Date.now());
      return g;
    });
  } catch { /* nothing worth failing a successful sign-in over */ }
}

// How long to sit on a wrong answer: longer the more guessing has been going
// on against this team lately, but always an answer in the end.
function failDelay(req, teamId) {
  const over = Math.max(0, bucket(keysFor(req, teamId).team).count - MAX_FAILS);
  const ms = Math.min(FAIL_DELAY_MS * 2 ** over, MAX_FAIL_DELAY_MS);
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- OAuth CSRF state ----------
// The state carries the team that began the consent, because the team at the
// other end comes from the session cookie — and in the minute the Google
// consent screen is open, somebody can sign out and into a different team in
// the same browser. Without this, the first team's Gmail refresh token would
// be written into the second team's storage.
function issueOauthState(req, res, teamId) {
  const state = `${teamId}.${crypto.randomBytes(16).toString('hex')}`;
  res.setHeader('Set-Cookie', cookieString(req, STATE_COOKIE, state, 600));
  return state;
}
function consumeOauthState(req, res, given, teamId) {
  const expected = parseCookies(req.headers.cookie)[STATE_COOKIE] || '';
  res.setHeader('Set-Cookie', cookieString(req, STATE_COOKIE, '', 0));
  if (!expected || !safeEqual(given || '', expected)) return false;
  return expected.split('.')[0] === String(teamId);
}

// ---------- the Mac relay ----------
// The relay daemon on the Mac Studio is a machine, not a browser: it has no
// way to complete a sign-in or hold a session cookie. So /api/relay/* is
// authenticated by a bearer token instead — a long random secret shared only
// with that one machine — and the token is also what says which team's texting
// it is allowed to do.
//
// It is deliberately a SEPARATE secret from APP_PASSWORD: the token lives in a
// config file on the Mac, and a copy of it must never be a way into anything
// else. It grants nothing but that one team's relay routes.
const RELAY_PREFIX = '/api/relay/';
const MIN_RELAY_TOKEN = 24;
let relayCache = new Map();          // token fingerprint -> { teamId, at }
const RELAY_CACHE_MS = 30 * 1000;

function bearer(req) {
  const h = String((req.headers && req.headers.authorization) || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// Forget the memoized lookup immediately — called when a token is generated or
// cleared, so revoking one takes effect at once rather than in 30 seconds.
function forgetRelaySecret() { relayCache = new Map(); }

// A token generated before the registry recorded fingerprints is still valid:
// look through the teams' own settings for it once, then record the
// fingerprint so the next call is a single read.
async function teamByStoredRelayToken(presented) {
  for (const t of await teams.all()) {
    const stored = await tenant.run(t.id, async () => {
      try {
        const db = await storage.getJson('db');
        return String((db && db.settings && db.settings.relayToken) || '').trim();
      } catch { return ''; }
    });
    if (stored && stored.length >= MIN_RELAY_TOKEN && safeEqual(stored, presented)) {
      await teams.setRelayToken(t.id, stored).catch(() => {});
      return t;
    }
  }
  return null;
}

// Which team is this relay working for? null when the token is unknown.
async function relayTeam(req) {
  const presented = bearer(req);
  if (!presented || presented.length < MIN_RELAY_TOKEN) return null;
  // An environment override has no team of its own; it belongs to the team
  // whose data predates teams, which is the only one a single-token
  // deployment could ever have meant.
  const fromEnv = (process.env.RELAY_TOKEN || '').trim();
  if (fromEnv && fromEnv.length >= MIN_RELAY_TOKEN && safeEqual(fromEnv, presented)) {
    return teams.byId(teams.LEGACY_ID);
  }
  const fp = teams.fingerprint(presented);
  const hit = relayCache.get(fp);
  if (hit && Date.now() - hit.at < RELAY_CACHE_MS) return hit.teamId ? teams.byId(hit.teamId) : null;
  let team = await teams.teamForRelayToken(presented);
  if (!team) team = await teamByStoredRelayToken(presented);
  relayCache.set(fp, { teamId: team ? team.id : '', at: Date.now() });
  if (relayCache.size > 64) relayCache = new Map([[fp, { teamId: team ? team.id : '', at: Date.now() }]]);
  return team;
}

// ---------- Sales IQ ----------
// The Sales IQ hiring dashboard is a static site on another origin. It reads
// one thing from here — who has booked an interview, with their email, phone
// and time — and it proves which team it is reading for with a bearer token
// carried inside the connection code the manager pasted into it. No cookie is
// involved, which is also what makes the wildcard CORS origin below safe: a
// page on another site cannot borrow a signed-in browser's session here,
// because nothing on these routes looks at one.
//
// It is a third secret, apart from APP_PASSWORD and the relay's token, with its
// own fingerprints and its own cache. A shared cache keyed by fingerprint would
// be enough to let a relay token that had just been looked up open these
// routes, or the other way round.
const SALESIQ_PREFIX = '/api/salesiq/';
const MIN_SALESIQ_TOKEN = 24;
let salesiqCache = new Map();        // token fingerprint -> { teamId, at }
const SALESIQ_CACHE_MS = 30 * 1000;

const SALESIQ_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '600',
  'Cache-Control': 'no-store',
};

function forgetSalesiqSecret() { salesiqCache = new Map(); }

// Which team is Sales IQ reading for? null when the token is unknown.
//
// A remembered hit is re-checked against the team's current fingerprint. That
// read happens anyway, to fetch the team, and without the check a code that was
// regenerated or disconnected would keep working for half a minute on every
// instance except the one that changed it. What the cache is really for is the
// misses: a stream of wrong keys costs no reads at all.
async function salesiqTeam(req) {
  const presented = bearer(req);
  if (!presented || presented.length < MIN_SALESIQ_TOKEN) return null;
  const fp = teams.fingerprint(presented);
  const hit = salesiqCache.get(fp);
  if (hit && Date.now() - hit.at < SALESIQ_CACHE_MS) {
    if (!hit.teamId) return null;
    const cached = await teams.byId(hit.teamId);
    if (cached && cached.salesiqTokenHash && safeEqual(cached.salesiqTokenHash, fp)) return cached;
    salesiqCache.delete(fp);
  }
  const team = await teams.teamForSalesiqToken(presented);
  salesiqCache.set(fp, { teamId: team ? team.id : '', at: Date.now() });
  if (salesiqCache.size > 64) salesiqCache = new Map([[fp, { teamId: team ? team.id : '', at: Date.now() }]]);
  return team;
}

// ---------- middleware ----------
// Guards /api/* and /auth/* except the endpoints you must be able to reach
// before you are in a team, and puts the team into context for everything that
// gets through. Express matches routes case-insensitively and tolerates
// repeated slashes, so the guard normalizes the same way before deciding.
//
// /webhooks/* is deliberately NOT here: those are called by Calendly and by
// mail clients loading a tracking pixel, and each one works out its own team
// from what it was given.
const OPEN = new Set(['/api/auth/status', '/api/login', '/api/teams', '/api/teams/create']);
function middleware(req, res, next) {
  const p = req.path.replace(/\/{2,}/g, '/').replace(/\/$/, '').toLowerCase() || '/';
  const guarded = p.startsWith('/api/') || p.startsWith('/auth/');
  if (!guarded || OPEN.has(p)) return next();
  // Before any decision about who is asking, so that a refusal is still
  // readable from the other origin: without these headers the browser hides
  // the 401 and Sales IQ can only report a network failure. A preflight never
  // carries the Authorization header, so it is answered without one.
  // /api/salesiq-connection is not under this prefix and stays behind the
  // dashboard session like everything else.
  const salesiq = p.startsWith(SALESIQ_PREFIX);
  if (salesiq) {
    res.set(SALESIQ_CORS);
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
  if (setupRequired()) {
    return res.status(403).json({
      error: 'This dashboard is deployed publicly without a password. Set the APP_PASSWORD environment variable in Netlify (Project configuration → Environment variables) and redeploy.',
      setupRequired: true,
    });
  }
  // The relay authenticates with its own bearer token; a dashboard session
  // cookie is neither required nor accepted on these routes, and the token is
  // accepted nowhere else.
  if (p.startsWith(RELAY_PREFIX)) {
    return relayTeam(req).then((team) => {
      if (!team) return res.status(401).json({ error: 'Relay token missing or invalid.', relay: true });
      req.team = team;
      tenant.run(team.id, next);
    }).catch(next);
  }
  // Likewise Sales IQ: its own token, checked only against Sales IQ
  // fingerprints, and never a session — not even on a deploy with no password.
  if (salesiq) {
    return salesiqTeam(req).then((team) => {
      if (!team) return res.status(401).json({ error: 'Sales IQ connection key missing or invalid.', salesiq: true });
      req.team = team;
      tenant.run(team.id, next);
    }).catch(next);
  }
  if (!required()) {
    return teams.all().then((list) => {
      if (list.length !== 1) {
        return res.status(403).json({
          error: 'There is more than one team here but no APP_PASSWORD is set, so there is no way to tell which of them you are. Set APP_PASSWORD and restart.',
          setupRequired: true,
        });
      }
      req.team = list[0];
      tenant.run(list[0].id, next);
    }).catch(next);
  }
  sessionTeam(req).then((team) => {
    if (!team) {
      if (p.startsWith('/auth/')) return res.redirect('/#login');
      return res.status(401).json({ error: 'Please sign in to the dashboard.', auth: true });
    }
    req.team = team;
    tenant.run(team.id, next);
  }).catch(next);
}

module.exports = {
  required, setupRequired, soloTeam, isAuthed, sessionTeam, ADMIN_BUCKET,
  checkAdminPassword, setSessionCookie, clearSessionCookie, revokeTeamSessions,
  loginLockedFor, recordLoginFailure, clearLoginFailures, failDelay,
  issueOauthState, consumeOauthState, middleware,
  relayTeam, forgetRelaySecret, MIN_RELAY_TOKEN, SESSION_MS,
  salesiqTeam, forgetSalesiqSecret, MIN_SALESIQ_TOKEN,
};
