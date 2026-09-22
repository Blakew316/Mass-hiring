// Calendly webhook helpers: signature verification of incoming events and
// one-click registration of a webhook subscription via a Personal Access Token.
const crypto = require('crypto');

// Verify the "Calendly-Webhook-Signature: t=...,v1=..." header (HMAC-SHA256 of
// "<t>.<rawBody>" with the subscription's signing key). Without a key nothing
// can be verified, so the webhook is rejected rather than trusted.
function verifySignature(signingKey, header, rawBody) {
  if (!signingKey || !header) return false;
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
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.title || `Calendly API error (${res.status})`);
  }
  return data;
}

// Register {publicUrl}/webhooks/calendly for invitee.created / invitee.canceled
// on the token owner's account. With a personal access token the caller
// chooses the signing key (Calendly does not issue or echo one back), so a
// fresh random key is generated here and must be stored by the caller.
async function registerWebhook(token, publicUrl) {
  const me = await calendlyApi(token, '/users/me');
  const user = me.resource.uri;
  const organization = me.resource.current_organization;
  const url = `${publicUrl.replace(/\/$/, '')}/webhooks/calendly`;

  // Remove any earlier subscription pointing at this app before making a new
  // one, so "Enable booking alerts" is always safe to re-run.
  //
  // Matching on the exact URL is not enough. One deploy answers on several
  // hostnames — the custom domain, the branch subdomain, deploy previews — and
  // they all reach the same function and the same stored signing key. A
  // subscription left behind under an older hostname keeps firing, signed with
  // a key that no longer exists here, so every booking is rejected as a bad
  // signature and re-registering never clears it. So anything whose path is
  // this webhook goes, whatever host it was registered under.
  const isOurs = (callbackUrl) => {
    try { return new URL(callbackUrl).pathname.replace(/\/+$/, '') === '/webhooks/calendly'; }
    catch { return false; }
  };
  const q = new URLSearchParams({ organization, user, scope: 'user', count: '100' });
  const existing = await calendlyApi(token, `/webhook_subscriptions?${q}`);
  let replaced = 0;
  const replacedUrls = [];
  for (const sub of (existing.collection || [])) {
    if (sub.uri && isOurs(sub.callback_url)) {
      await calendlyApi(token, `/webhook_subscriptions/${sub.uri.split('/').pop()}`, { method: 'DELETE' });
      replaced++;
      if (sub.callback_url !== url) replacedUrls.push(sub.callback_url);
    }
  }

  const signingKey = crypto.randomBytes(32).toString('hex');
  const created = await calendlyApi(token, '/webhook_subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      url,
      events: ['invitee.created', 'invitee.canceled'],
      organization,
      user,
      scope: 'user',
      signing_key: signingKey,
    }),
  });
  return {
    url,
    subscription: created.resource && created.resource.uri,
    signingKey,
    replaced,
    replacedUrls,     // old hostnames cleaned up, worth telling the user about
    schedulingUrl: me.resource.scheduling_url || '',
  };
}

// Scheduled events (with invitees) in a window, nearest first.
async function listInterviews(token, { minStart, maxStart, maxEvents = 40 } = {}) {
  const me = await calendlyApi(token, '/users/me');
  const q = new URLSearchParams({
    user: me.resource.uri,
    organization: me.resource.current_organization,
    min_start_time: minStart.toISOString(),
    max_start_time: maxStart.toISOString(),
    sort: 'start_time:asc',
    count: '100',
  });
  const data = await calendlyApi(token, `/scheduled_events?${q}`);
  const events = (data.collection || []).slice(0, maxEvents);
  const interviews = [];
  for (const ev of events) {
    const uuid = String(ev.uri || '').split('/').pop();
    let invitees = [];
    try {
      const inv = await calendlyApi(token, `/scheduled_events/${uuid}/invitees?count=100`);
      invitees = inv.collection || [];
    } catch {}
    interviews.push({
      uri: ev.uri,
      name: ev.name,
      status: ev.status,
      start: ev.start_time,
      end: ev.end_time,
      joinUrl: (ev.location && (ev.location.join_url || null)) || null,
      locationType: (ev.location && ev.location.type) || '',
      invitees: invitees.map((i) => ({
        name: i.name, email: i.email, status: i.status, createdAt: i.created_at || null,
        rescheduleUrl: i.reschedule_url, cancelUrl: i.cancel_url,
      })),
    });
  }
  return { interviews, schedulingUrl: me.resource.scheduling_url || '' };
}

module.exports = { verifySignature, registerWebhook, listInterviews };
