// Talking to the BlueBubbles server running on this Mac.
//
// BlueBubbles has changed the shape of its send endpoint between versions, so
// send() tries the current form and falls back to the older one rather than
// failing on a version mismatch. Everything optional (availability checks,
// read receipts from the message list) is best-effort: if an endpoint is not
// there, the relay logs it once and carries on, because sending and receiving
// replies are the only things it genuinely cannot work without.
const crypto = require('crypto');

class BlueBubbles {
  constructor({ url, password, timeoutMs = 15000, log = () => {} }) {
    this.base = String(url || 'http://localhost:1234').replace(/\/+$/, '');
    this.password = String(password || '');
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.warned = new Set();
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(`note: ${message}`);
  }

  async call(method, endpoint, { body, query } = {}) {
    const qs = new URLSearchParams({ password: this.password, ...(query || {}) });
    const url = `${this.base}/api/v1${endpoint}?${qs}`;
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!res.ok) {
      const err = new Error((json && (json.error && json.error.message || json.message)) || `BlueBubbles ${method} ${endpoint} failed (${res.status})`);
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return json;
  }

  async ping() {
    await this.call('GET', '/ping');
    return true;
  }

  // Best-effort: does this number have an iMessage account? Unknown (null) is
  // not a reason to skip someone — we simply send and let the result tell us.
  async isOnIMessage(e164) {
    try {
      const r = await this.call('GET', '/handle/availability/imessage', { query: { address: e164 } });
      const d = r && (r.data !== undefined ? r.data : r);
      if (typeof d === 'boolean') return d;
      if (d && typeof d.available === 'boolean') return d.available;
      return null;
    } catch (err) {
      this.warnOnce('availability', `this BlueBubbles build has no iMessage availability check (${err.message}) — sending without it`);
      return null;
    }
  }

  async send(e164, message) {
    const tempGuid = `wp-${crypto.randomUUID()}`;
    // Current shape.
    try {
      const r = await this.call('POST', '/message/text', {
        body: { chatGuid: `any;-;${e164}`, tempGuid, message, method: 'apple-script' },
      });
      return { guid: (r && r.data && r.data.guid) || tempGuid, raw: r };
    } catch (err) {
      if (err.status && err.status !== 400 && err.status !== 422) throw err;
      // Older/newer builds accept an address instead of a chatGuid.
      this.warnOnce('send-shape', 'falling back to the address form of /message/text for this BlueBubbles version');
      const r = await this.call('POST', '/message/text', {
        body: { address: e164, tempGuid, message, method: 'apple-script' },
      });
      return { guid: (r && r.data && r.data.guid) || tempGuid, raw: r };
    }
  }

  // The most recent messages across every chat. Used only to pick up INBOUND
  // replies, and filtered against the relay's own handle list before anything
  // leaves this machine.
  async recentMessages(limit = 50) {
    const r = await this.call('GET', '/message', { query: { limit: String(limit), sort: 'DESC', with: 'handle,chat' } });
    const rows = (r && (r.data || r.messages)) || [];
    return Array.isArray(rows) ? rows : [];
  }
}

// BlueBubbles reports times in milliseconds; Apple's own database uses
// nanoseconds since 2001. Accept either and return a JS Date, or null.
function toDate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e17) return new Date(n / 1e6 + 978307200000);   // Apple epoch, nanoseconds
  if (n > 1e14) return new Date(n / 1e3 + 978307200000);   // Apple epoch, microseconds
  if (n > 1e11) return new Date(n);                        // unix milliseconds
  return new Date(n * 1000);                               // unix seconds
}

// Pull the counterparty's address out of whichever field this version uses.
function addressOf(m) {
  if (!m) return '';
  if (m.handle && m.handle.address) return String(m.handle.address);
  if (m.handle && m.handle.id) return String(m.handle.id);
  if (Array.isArray(m.chats) && m.chats[0] && m.chats[0].chatIdentifier) return String(m.chats[0].chatIdentifier);
  return '';
}

const textOf = (m) => String((m && (m.text || m.body)) || '').trim();
const isFromMe = (m) => Boolean(m && (m.isFromMe ?? m.is_from_me));

module.exports = { BlueBubbles, toDate, addressOf, textOf, isFromMe };
