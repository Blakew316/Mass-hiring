// The relay's own memory, kept next to its config at ~/.wp-relay/state.json.
//
// Two jobs, both about not doing something twice:
//   * `pending` survives a crash between "sent" and "reported", so a message
//     that went out is never sent a second time after a restart
//   * `handles` is the list of numbers this relay has actually texted, and
//     NOTHING outside that list is ever read or reported. That is what keeps
//     the owner's personal iMessages out of the CRM.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = process.env.WP_RELAY_HOME || path.join(os.homedir(), '.wp-relay');
const FILE = path.join(DIR, 'state.json');

const EMPTY = {
  pending: [],        // [{ jobId, phone, body, sentAt }] sent, not yet acknowledged by the CRM
  handles: {},        // "+1617..." -> { firstTextedAt, lastTextedAt }
  lastRowId: 0,       // highest chat.db message ROWID already examined
  seenEvents: {},     // "kind:guid" -> ts, so one receipt is reported once
};

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ...structuredClone(EMPTY), ...raw };
  } catch { return structuredClone(EMPTY); }
}

function save(state) {
  fs.mkdirSync(DIR, { recursive: true });
  // Prune the reported-events memory to a day so the file cannot grow forever.
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [k, ts] of Object.entries(state.seenEvents || {})) if (ts < cutoff) delete state.seenEvents[k];
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);   // atomic: a crash mid-write cannot corrupt it
}

const known = (state, phone) => Object.prototype.hasOwnProperty.call(state.handles || {}, phone);

function remember(state, phone, at = new Date().toISOString()) {
  const h = state.handles[phone] || { firstTextedAt: at };
  h.lastTextedAt = at;
  state.handles[phone] = h;
}

// When this relay first texted a number. Anything that arrived from them BEFORE
// that is part of a conversation that already existed — old messages in a thread
// the owner had with that person long before any outreach — and is nobody's
// reply to anything.
function firstTextedAt(state, phone) {
  const h = (state.handles || {})[phone];
  const t = h && h.firstTextedAt ? new Date(h.firstTextedAt).getTime() : NaN;
  return Number.isNaN(t) ? null : t;
}

// Have we already sent this exact message to this number a moment ago? Guards
// the window between sending and the CRM recording it.
function alreadySent(state, phone, body, withinMs = 10 * 60 * 1000) {
  const cutoff = Date.now() - withinMs;
  return (state.pending || []).find((p) => p.phone === phone && p.body === body && new Date(p.sentAt).getTime() >= cutoff) || null;
}

module.exports = { load, save, known, remember, firstTextedAt, alreadySent, DIR, FILE };
