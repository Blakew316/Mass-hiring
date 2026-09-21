#!/usr/bin/env node
// The Wholesale Payments text relay.
//
// Runs on the Mac Studio and is the only part of the system that can actually
// send an iMessage. It works by POLLING the CRM, never the other way round:
// the Mac reaches out, so it needs no open ports, no tunnel, no static IP and
// no firewall changes, and it keeps working on any network it is moved to.
//
//   every 5s   ask the CRM for one message to send; send it; report back
//   every 20s  look for delivery receipts, read receipts and replies; report them
//   every 30s  say hello, so the dashboard can show the Mac as online
//
// Three rules it never breaks:
//   1. It only ever reads or reports messages for numbers IT HAS TEXTED.
//      Personal conversations on this Mac are never touched.
//   2. It records a send locally BEFORE telling the CRM, so a crash in between
//      cannot turn into the same person being texted twice.
//   3. It sends one message at a time, at whatever moment the CRM says. All
//      the pacing, the daily cap and the recipient's local hours are decided
//      server-side; this daemon deliberately has no opinion about them.
const fs = require('fs');
const path = require('path');
const os = require('os');

const state = require('./lib/state');
const receipts = require('./lib/receipts');
const { BlueBubbles, toDate, addressOf, textOf, isFromMe } = require('./lib/bluebubbles');

const VERSION = '1.0.0';
const CONFIG_PATH = process.env.WP_RELAY_CONFIG || path.join(state.DIR, 'config.json');

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  process.stdout.write(`${line}\n`);
}

function loadConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (err) {
    console.error(`Could not read ${CONFIG_PATH}: ${err.message}`);
    console.error('Copy config.example.json there and fill it in — see relay/README.md.');
    process.exit(1);
  }
  const cfg = {
    crmUrl: String(raw.crmUrl || '').replace(/\/+$/, ''),
    relayToken: String(raw.relayToken || ''),
    bluebubblesUrl: String(raw.bluebubblesUrl || 'http://localhost:1234'),
    bluebubblesPassword: String(raw.bluebubblesPassword || ''),
    pollMs: Number(raw.pollMs) || 5000,
    receiptsMs: Number(raw.receiptsMs) || 20000,
    helloMs: Number(raw.helloMs) || 30000,
    dryRun: Boolean(raw.dryRun),
  };
  const missing = ['crmUrl', 'relayToken', 'bluebubblesPassword'].filter((k) => !cfg[k]);
  if (missing.length) {
    console.error(`${CONFIG_PATH} is missing: ${missing.join(', ')}`);
    process.exit(1);
  }
  return cfg;
}

// ---- the CRM ----
class Crm {
  constructor(cfg) { this.cfg = cfg; }
  async call(endpoint, body) {
    const res = await fetch(`${this.cfg.crmUrl}/api/relay${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.relayToken}` },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (res.status === 401) throw Object.assign(new Error('The CRM rejected the relay token. Generate a new one on the Texting page and update config.json.'), { fatal: true });
    if (!res.ok) throw new Error((json && json.error) || `CRM ${endpoint} failed (${res.status})`);
    return json || {};
  }
  hello(payload) { return this.call('/hello', payload); }
  claim() { return this.call('/claim', {}); }
  report(payload) { return this.call('/report', payload); }
  events(events) { return this.call('/events', { events }); }
}

// ---- main ----
async function main() {
  const cfg = loadConfig();
  const bb = new BlueBubbles({ url: cfg.bluebubblesUrl, password: cfg.bluebubblesPassword, log });
  const crm = new Crm(cfg);
  let st = state.load();

  log(`wp-relay ${VERSION} starting`);
  log(`  CRM         ${cfg.crmUrl}`);
  log(`  BlueBubbles ${cfg.bluebubblesUrl}`);
  log(`  state       ${state.FILE}`);
  if (cfg.dryRun) log('  DRY RUN — messages will be logged, not sent');
  if (!receipts.available()) log('  note: chat.db is not readable, so delivery and read receipts are off (grant Full Disk Access to your terminal or to node — see README)');

  let lastError = '';
  let stopping = false;
  const stop = (sig) => { if (stopping) return; stopping = true; log(`${sig} — shutting down`); state.save(st); process.exit(0); };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // Anything sent but never acknowledged (a crash, a reboot mid-send) is
  // reported first, before a single new message goes out.
  async function flushPending() {
    if (!st.pending.length) return;
    log(`reporting ${st.pending.length} send(s) left over from the last run`);
    for (const p of [...st.pending]) {
      try {
        await crm.report({ jobId: p.jobId, status: 'sent' });
        st.pending = st.pending.filter((x) => x.jobId !== p.jobId);
        state.save(st);
      } catch (err) {
        // The CRM may have expired the lease and re-queued it; either way,
        // stop claiming it as ours after a day so the file does not grow.
        if (Date.now() - new Date(p.sentAt).getTime() > 24 * 3600 * 1000) {
          st.pending = st.pending.filter((x) => x.jobId !== p.jobId);
          state.save(st);
        }
        log(`could not report ${p.jobId}: ${err.message}`);
        if (err.fatal) throw err;
      }
    }
  }

  async function sendOnce() {
    const { job, reason } = await crm.claim();
    if (!job) return reason;

    // Did this already go out just before a crash? Then acknowledge, do not resend.
    const dupe = state.alreadySent(st, job.phone, job.body);
    if (dupe) {
      log(`already sent to ${job.phone} moments ago — acknowledging instead of sending again`);
      await crm.report({ jobId: job.jobId, status: 'sent' });
      st.pending = st.pending.filter((x) => x.jobId !== dupe.jobId && x.jobId !== job.jobId);
      state.save(st);
      return 'deduped';
    }

    if (cfg.dryRun) {
      log(`DRY RUN → ${job.phone}: ${job.body.replace(/\n/g, ' ⏎ ').slice(0, 120)}`);
      await crm.report({ jobId: job.jobId, status: 'sent' });
      return 'dry-run';
    }

    const on = await bb.isOnIMessage(job.phone);
    if (on === false) {
      log(`${job.phone} is not on iMessage — reporting, not sending`);
      await crm.report({ jobId: job.jobId, status: 'not-imessage' });
      return 'not-imessage';
    }

    // Recorded BEFORE the CRM is told, so the crash window cannot double-send.
    st.pending.push({ jobId: job.jobId, phone: job.phone, body: job.body, sentAt: new Date().toISOString() });
    state.remember(st, job.phone);
    state.save(st);

    try {
      await bb.send(job.phone, job.body);
      log(`sent to ${job.phone}${job.name ? ` (${job.name})` : ''}`);
    } catch (err) {
      st.pending = st.pending.filter((x) => x.jobId !== job.jobId);
      state.save(st);
      const notRegistered = /not (registered|available)|no.*imessage|invalid (address|handle)/i.test(err.message);
      await crm.report({ jobId: job.jobId, status: notRegistered ? 'not-imessage' : 'failed', error: err.message });
      log(`send to ${job.phone} failed: ${err.message}`);
      return 'failed';
    }

    await crm.report({ jobId: job.jobId, status: 'sent' });
    st.pending = st.pending.filter((x) => x.jobId !== job.jobId);
    state.save(st);
    return 'sent';
  }

  // Receipts and replies. Only for numbers this relay has texted — everything
  // else on this Mac is none of the CRM's business.
  async function scanReceipts() {
    const events = [];
    const mark = (kind, guid, ts) => {
      const key = `${kind}:${guid}`;
      if (st.seenEvents[key]) return false;
      st.seenEvents[key] = ts;
      return true;
    };

    if (receipts.available()) {
      let rows = [];
      try { rows = await receipts.since(st.lastRowId, 500); }
      catch (err) { log(`could not read chat.db (${err.message}) — receipts are off until that is fixed`); }
      for (const r of rows) {
        if (r.rowid > st.lastRowId) st.lastRowId = r.rowid;
        const handle = normalizePhone(r.handle);
        if (!handle || !state.known(st, handle)) continue;     // not one of ours
        if (r.fromMe) {
          if (r.deliveredAt && mark('delivered', r.guid, Date.now())) events.push({ kind: 'delivered', phone: handle, ts: r.deliveredAt.toISOString() });
          if (r.readAt && mark('read', r.guid, Date.now())) events.push({ kind: 'read', phone: handle, ts: r.readAt.toISOString() });
        } else if (r.text && mark('reply', r.guid, Date.now())) {
          events.push({ kind: 'reply', phone: handle, text: r.text, ts: (r.sentAt || new Date()).toISOString() });
        }
      }
    }

    // BlueBubbles decodes message bodies that chat.db stores in attributedBody,
    // so replies are picked up here too; the guid keeps them from doubling up.
    try {
      for (const m of await bb.recentMessages(50)) {
        if (isFromMe(m)) continue;
        const handle = normalizePhone(addressOf(m));
        const body = textOf(m);
        if (!handle || !body || !state.known(st, handle)) continue;
        const guid = String(m.guid || `${handle}:${m.dateCreated || ''}`);
        if (!mark('reply', guid, Date.now())) continue;
        events.push({ kind: 'reply', phone: handle, text: body, ts: (toDate(m.dateCreated) || new Date()).toISOString() });
      }
    } catch (err) {
      log(`could not read recent messages from BlueBubbles: ${err.message}`);
    }

    if (!events.length) { state.save(st); return 0; }
    await crm.events(events);
    state.save(st);
    log(`reported ${events.length} event(s): ${events.map((e) => e.kind).join(', ')}`);
    return events.length;
  }

  // ---- loops ----
  const every = (ms, name, fn) => {
    let running = false;
    const tick = async () => {
      if (running || stopping) return;
      running = true;
      try { await fn(); lastError = ''; }
      catch (err) {
        if (err && err.fatal) { log(`FATAL: ${err.message}`); process.exit(1); }
        if (err.message !== lastError) log(`${name}: ${err.message}`);
        lastError = err.message;
      }
      finally { running = false; }
    };
    tick();
    return setInterval(tick, ms);
  };

  let bbOk = false;
  try { await bb.ping(); bbOk = true; log('BlueBubbles answered — ready'); }
  catch (err) { log(`BlueBubbles is not answering: ${err.message}`); }

  await flushPending().catch((err) => { if (err.fatal) { log(`FATAL: ${err.message}`); process.exit(1); } });

  every(cfg.helloMs, 'hello', async () => {
    try { await bb.ping(); bbOk = true; } catch { bbOk = false; }
    await crm.hello({
      host: os.hostname(),
      version: VERSION,
      bluebubbles: bbOk,
      error: bbOk ? '' : 'BlueBubbles is not answering on this Mac.',
    });
  });

  every(cfg.pollMs, 'send', async () => {
    if (!bbOk && !cfg.dryRun) return;      // nothing to send through yet
    await flushPending();
    await sendOnce();
  });

  every(cfg.receiptsMs, 'receipts', scanReceipts);
}

// Same E.164 rule the CRM uses, kept deliberately simple here: handles from
// Messages are already either +1XXXXXXXXXX or an email address (which we skip).
function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (!s || s.includes('@')) return '';
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 ? `+${digits}` : '';
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return '';
}

main().catch((err) => { console.error(err); process.exit(1); });
