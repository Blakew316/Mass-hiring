// Open tracking: a 1x1 GIF whose URL carries a signed candidate id. When the
// recipient's mail client loads images, the app marks the email as opened.
const tenant = require('./tenant');
const crypto = require('crypto');

function secret(settings) {
  // Every team created since teams existed is given a secret of its own, so
  // this fallback is only ever reached by the team that predates them — whose
  // pixels, already out in the world, were signed with APP_PASSWORD.
  return settings.trackingSecret || (tenant.isLegacy() ? process.env.APP_PASSWORD : '') || 'crm-open-tracking';
}

function sign(settings, id) {
  return crypto.createHmac('sha256', secret(settings)).update(String(id)).digest('hex').slice(0, 24);
}

function token(settings, candidateId) {
  return `${candidateId}.${sign(settings, candidateId)}`;
}

// Returns the candidate id for a valid token, else null.
function verify(settings, tok) {
  const m = String(tok || '').replace(/\.gif$/i, '').match(/^([A-Za-z0-9]+)\.([0-9a-f]{24})$/);
  if (!m) return null;
  const expected = sign(settings, m[1]);
  return expected.length === m[2].length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[2])) ? m[1] : null;
}

// Does this even look like one of our tokens? Worth asking before any storage
// is read: the pixel path is public and crawlers find it, and answering a
// crawler must not cost a database read per team.
function looksLikeToken(tok) {
  return /^[A-Za-z0-9]+\.[0-9a-f]{24}$/.test(String(tok || '').replace(/\.gif$/i, ''));
}

// Where this team's tracking pixel lives. The team is in the path because the
// URL is read months later, by a mail client, with no session and no cookie:
// whatever identifies the team has to travel inside the pixel itself. Both
// senders — the immediate one and the background drain — go through here, so
// they cannot drift apart.
function pixelPath(settings, candidateId) {
  return `/webhooks/open/${tenant.currentOrThrow('a tracking pixel')}/${token(settings, candidateId)}.gif`;
}

// The value to store the first time a team needs a secret. For the team that
// predates teams that is APP_PASSWORD itself, because every pixel already
// delivered was signed with it — minting a random one instead would silently
// stop opens registering on months of mail already in people's inboxes.
function newSecret() {
  const inherited = tenant.isLegacy() ? process.env.APP_PASSWORD : '';
  return inherited || crypto.randomBytes(32).toString('hex');
}

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

module.exports = { token, verify, looksLikeToken, pixelPath, newSecret, GIF };
