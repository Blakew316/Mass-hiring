// Open tracking: a 1x1 GIF whose URL carries a signed candidate id. When the
// recipient's mail client loads images, the app marks the email as opened.
const crypto = require('crypto');

function secret(settings) {
  return settings.trackingSecret || process.env.APP_PASSWORD || 'crm-open-tracking';
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

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

module.exports = { token, verify, GIF };
