// The teams. One global document lists them; everything else in storage
// belongs to exactly one of them.
//
// What lives here is only what has to be readable BEFORE we know which team
// the request is for: the name to show on the sign-in screen, the PIN to check
// against, the secret that signs that team's session cookies, and a fingerprint
// of the relay token so a bearer token can be traced back to its team. A team's
// actual work -- candidates, templates, settings, queues, Gmail tokens -- lives
// under its own storage keys and is unreachable without being signed into it.
//
// The first team is not created here in any ordinary sense: it already exists.
// Everything this app has stored so far is one person's, and on first run it is
// adopted as "Team Maverick" without moving a single byte (see lib/storage.js
// on the legacy key names).
const crypto = require('crypto');
const storage = require('./storage');
const tenant = require('./tenant');

const KEY = 'teams';

// The team that owns the data this app had before teams existed.
const LEGACY_ID = tenant.LEGACY_ID;
const LEGACY_NAME = 'Team Maverick';

// A team PIN is four digits: short enough to hand to a team and to tap on a
// phone, which is the point of it. Four digits is ten thousand possibilities,
// so what keeps it safe is not its length but the lockout in lib/auth.js —
// which is why that lockout is written down rather than kept in the memory of
// one serverless instance.
const PIN_LENGTH = 4;
const PIN_RE = /^\d{4}$/;
const MAX_NAME = 40;
const MAX_TEAMS = 50;

// ---------- names and ids ----------
// The id is what ends up in storage keys and in the session cookie, so it is
// derived once, at creation, and never changes -- renaming a team must not
// strand its data. tenant.validId is the authority on what is allowed.
function slugify(name) {
  const s = String(name || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return tenant.validId(s) ? s : '';
}

// Ids nobody may be given. LEGACY_ID is the dangerous one: its storage keys
// are the bare ones, so a team handed that id would be pointed straight at
// data that is not theirs. The rest are words other parts of the app already
// mean something by — a path segment, a throttling bucket — and a team that
// took one of them would collide with it.
const RESERVED_IDS = new Set([LEGACY_ID, 'admin', 'api', 'auth', 'webhooks', 'teams', 't', 'new']);

function uniqueId(base, taken) {
  const blocked = new Set([...taken, ...RESERVED_IDS]);
  const root = base || 'team';
  if (!blocked.has(root)) return root;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${root.slice(0, 36)}-${n}`;
    if (tenant.validId(candidate) && !blocked.has(candidate)) return candidate;
  }
  return `team-${crypto.randomBytes(4).toString('hex')}`;
}

function cleanName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return n;
}

// ---------- PINs ----------
const randHex = (n) => crypto.randomBytes(n).toString('hex');

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
}

function pinRecord(pin) {
  const salt = randHex(16);
  return { salt, hash: hashPin(pin, salt) };
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// The handful of four-digit PINs that are barely PINs at all: four of the
// same digit, or a run in either direction. Twenty-odd combinations out of ten
// thousand, and they are the ones anybody guessing would try first.
function tooObvious(pin) {
  if (/^(\d)\1{3}$/.test(pin)) return true;
  const d = [...pin].map(Number);
  const runs = (step) => d.every((n, i) => i === 0 || n === (d[i - 1] + step + 10) % 10);
  return runs(1) || runs(-1);
}

function checkPin(pin) {
  const p = String(pin == null ? '' : pin).trim();
  if (!PIN_RE.test(p)) throw new Error(`A team PIN is exactly ${PIN_LENGTH} digits.`);
  if (tooObvious(p)) throw new Error('That PIN is one of the first anybody would try — avoid four of the same digit, or a run like 1234.');
  return p;
}

// Team Maverick starts with no PIN of its own, which means "sign in with the
// APP_PASSWORD environment variable" -- exactly what the single-password
// dashboard did, so nothing changes for the person already using it. It also
// means rotating APP_PASSWORD still locks everyone out, which freezing a copy
// of it here would quietly have stopped doing. Setting a PIN in Settings ends
// the arrangement for good.
function appPassword() {
  return process.env.APP_PASSWORD || '';
}

function verifyPin(team, pin) {
  if (!team) return false;
  const given = String(pin == null ? '' : pin);
  if (!team.pin) {
    const pw = appPassword();
    return Boolean(pw) && safeEqual(given, pw);
  }
  // Trimmed, because a phone keyboard and a password manager both like to
  // leave a space on the end and four digits are four digits either way. The
  // environment-variable branch above is left exactly as typed: that is a
  // password, and a space in it is part of it.
  return safeEqual(hashPin(given.trim(), team.pin.salt), team.pin.hash);
}

// Does this team sign in with the environment variable rather than its own PIN?
const usesAppPassword = (team) => Boolean(team) && !team.pin;

// True once every team has a PIN of its own — which is to say, once every way
// into this dashboard is four digits. The sign-in screen asks so it knows
// whether to put up a number pad, and it is a fact about the whole list rather
// than about any one team, so it gives away nothing about which team holds
// what.
const allPinsNumeric = (list) => list.length > 0 && list.every((t) => !usesAppPassword(t));

// ---------- the document ----------
function normalizeTeam(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  if (!tenant.validId(id)) return null;
  const pin = raw.pin && typeof raw.pin === 'object' && raw.pin.salt && raw.pin.hash
    ? { salt: String(raw.pin.salt), hash: String(raw.pin.hash) }
    : null;
  return {
    id,
    name: cleanName(raw.name) || id,
    createdAt: raw.createdAt || null,
    pin,
    // The HMAC key for this team's session cookies. Rotating it signs every
    // one of that team's devices out, and nobody else's.
    //
    // Empty when it is missing, never invented here: normalize() runs on every
    // read, and a fresh random key per read would sign a cookie that the very
    // next request could not verify — a sign-in that succeeds and then does
    // nothing, forever. It is minted once, by all(), which writes it down.
    sessionSalt: typeof raw.sessionSalt === 'string' && raw.sessionSalt.length >= 32 ? raw.sessionSalt : '',
    // SHA-256 of the Mac relay's bearer token, so a token presented by the
    // relay can be traced to its team without reading every team's settings.
    relayTokenHash: typeof raw.relayTokenHash === 'string' ? raw.relayTokenHash : '',
  };
}

function normalize(raw) {
  const list = Array.isArray(raw && raw.teams) ? raw.teams : [];
  const seen = new Set();
  const teams = [];
  for (const t of list) {
    const n = normalizeTeam(t);
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    teams.push(n);
  }
  return { version: 1, teams };
}

function legacyTeam() {
  return normalizeTeam({
    id: LEGACY_ID,
    name: LEGACY_NAME,
    createdAt: null,      // it predates the registry; no honest date to give
    pin: null,            // signs in with APP_PASSWORD until a PIN is set
  });
}

async function read() {
  return normalize(await storage.getJson(KEY));
}

// The registry, creating it on first run and repairing anything incomplete.
// Every request needs it, so this is one read in the common case and a write
// only when there is genuinely something to write.
async function all() {
  const reg = await read();
  if (reg.teams.length && reg.teams.every((t) => t.sessionSalt)) return reg.teams;
  const { value } = await storage.updateJson(KEY, (raw) => {
    const cur = normalize(raw);
    let changed = false;
    if (!cur.teams.length) { cur.teams = [legacyTeam()]; changed = true; }
    // A team with no session secret cannot be signed in at all, so one is
    // minted and STORED here — the one place that writes it — rather than
    // conjured on each read.
    for (const t of cur.teams) if (!t.sessionSalt) { t.sessionSalt = randHex(32); changed = true; }
    return changed ? cur : false;
  });
  return normalize(value).teams;
}

async function byId(id) {
  if (!tenant.validId(id)) return null;
  return (await all()).find((t) => t.id === id) || null;
}

// What the sign-in screen may know: a name and the id to send back. Never a
// salt, a hash or a token fingerprint.
async function publicList() {
  return (await all()).map((t) => ({ id: t.id, name: t.name }));
}

// Change one team in place, atomically. `mutate(team, reg)` returns false to
// change nothing. Throws if the team is gone.
async function edit(id, mutate) {
  if (!tenant.validId(id)) throw new Error('Unknown team.');
  let out = null;
  await storage.updateJson(KEY, (raw) => {
    const reg = normalize(raw);
    const team = reg.teams.find((t) => t.id === id);
    if (!team) throw new Error('That team no longer exists.');
    if (mutate(team, reg) === false) return false;
    out = team;
    return reg;
  });
  return out || byId(id);
}

// ---------- creating a team ----------
// Two steps, in this order: reserve the id, then write the team's own empty
// document. If the second step fails the reservation is given back, because a
// team in the list with nothing behind it would silently inherit the built-in
// defaults -- another team's sender name and flyer -- which is the one thing a
// new team must not do.
async function create({ name, pin }, seed) {
  const clean = cleanName(name);
  if (!clean) throw new Error('Give the team a name.');
  checkPin(pin);
  // Make sure the registry exists and holds the team that predates it BEFORE
  // an id is allocated. Allocating from an empty registry would let the first
  // team anyone creates take the legacy id — whose storage keys are the bare
  // ones — and point a brand-new team at somebody else's candidates.
  await all();
  // Ids that still hold data are taken too, registered or not: a team deleted
  // while a backup was being written can leave entries behind, and a new team
  // of the same name must not inherit them.
  const leftovers = await storage.teamIdsWithData().catch(() => new Set());
  let created = null;
  await storage.updateJson(KEY, (raw) => {
    const reg = normalize(raw);
    if (reg.teams.length >= MAX_TEAMS) throw new Error(`That is the ${MAX_TEAMS}-team limit.`);
    if (reg.teams.some((t) => t.name.toLowerCase() === clean.toLowerCase())) {
      throw new Error(`There is already a team called “${clean}”.`);
    }
    const id = uniqueId(slugify(clean), new Set([...reg.teams.map((t) => t.id), ...leftovers]));
    // The session secret is minted HERE, on the write path, and travels back
    // in the object the caller signs the first cookie with. normalizeTeam does
    // not invent one on reads, so this is the only place it can come from.
    created = normalizeTeam({
      id, name: clean, createdAt: new Date().toISOString(),
      pin: pinRecord(pin), sessionSalt: randHex(32),
    });
    reg.teams.push(created);
    return reg;
  });
  if (!created) throw new Error('Could not create the team — please try again.');
  try {
    if (seed) await tenant.run(created.id, () => seed(created));
  } catch (err) {
    // Hand the id back, and NOTHING else. Not remove(), which erases the
    // documents under that id: we are here precisely because the seed did not
    // write any, and a delete aimed at an id we may have got wrong is how a
    // failed creation turns into somebody else's data disappearing.
    await dropEntry(created.id).catch(() => {});
    throw err;
  }
  return created;
}

// Take a team out of the registry without touching a byte of stored data.
async function dropEntry(id) {
  await storage.updateJson(KEY, (raw) => {
    const reg = normalize(raw);
    const before = reg.teams.length;
    reg.teams = reg.teams.filter((t) => t.id !== id);
    return reg.teams.length === before ? false : reg;
  });
}

// ---------- removing a team ----------
// The registry entry goes first: the moment it is gone nobody can sign in or
// reach the data, so a failure while deleting the documents leaves unreachable
// bytes rather than a half-working team.
async function remove(id) {
  const team = await byId(id);
  if (!team) return { removed: false };
  await dropEntry(id);
  await tenant.run(id, () => storage.purgeTeam()).catch(() => {});
  return { removed: true, team };
}

// ---------- the relay token ----------
const fingerprint = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');

async function setRelayToken(id, token) {
  return edit(id, (t) => { t.relayTokenHash = token ? fingerprint(token) : ''; });
}

// Which team does this bearer token belong to? Compared by fingerprint so the
// token itself is never stored in the one document every request reads.
async function teamForRelayToken(token) {
  const fp = fingerprint(token);
  for (const t of await all()) {
    if (t.relayTokenHash && safeEqual(t.relayTokenHash, fp)) return t;
  }
  return null;
}

module.exports = {
  KEY, LEGACY_ID, LEGACY_NAME, PIN_LENGTH, MAX_NAME, MAX_TEAMS,
  all, byId, publicList, edit, create, remove,
  verifyPin, usesAppPassword, allPinsNumeric, pinRecord, checkPin, tooObvious, cleanName, slugify,
  setRelayToken, teamForRelayToken, fingerprint, randHex,
};
