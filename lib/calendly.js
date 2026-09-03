// Calendly webhook helpers: signature verification of incoming events and
// one-click registration of a webhook subscription via a Personal Access Token.
const crypto = require('crypto');

// Verify the "Calendly-Webhook-Signature: t=...,v1=..." header (HMAC-SHA256 of
// "<t>.<rawBody>" with the subscription's signing key). Returns true when no
// key is configured (verification opt-in).
function verifySignature(signingKey, header, rawBody) {
  if (!signingKey) return true;
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.trim().split('=').map((s) => s.trim()))
  );
  if (!parts.t || !parts.v1) return false;
  const expected = crypto
    .createHmac('sha256', signingKey)
    .update(`${parts.t}.${rawBody}`)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  } catch {
    return false;
  }
}

async function calendlyApi(token, path, options = {}) {
  const res = await fetch(`https://api.calendly.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.title || `Calendly API error (${res.status})`);
  }
  return data;
}

// Register {publicUrl}/webhooks/calendly for invitee.created / invitee.canceled
// on the token owner's account. Returns the signing key Calendly issues.
async function registerWebhook(token, publicUrl) {
  const me = await calendlyApi(token, '/users/me');
  const user = me.resource.uri;
  const organization = me.resource.current_organization;
  const url = `${publicUrl.replace(/\/$/, '')}/webhooks/calendly`;
  const created = await calendlyApi(token, '/webhook_subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      url,
      events: ['invitee.created', 'invitee.canceled'],
      organization,
      user,
      scope: 'user',
    }),
  });
  return {
    url,
    subscription: created.resource && created.resource.uri,
    signingKey: (created.resource && created.resource.signing_key) || '',
    schedulingUrl: me.resource.scheduling_url || '',
  };
}

module.exports = { verifySignature, registerWebhook };
