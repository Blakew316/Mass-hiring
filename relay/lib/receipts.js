// Delivery and read receipts, straight from the Messages database.
//
// BlueBubbles is the right tool for SENDING, but the per-message
// date_delivered / date_read timestamps are not exposed consistently across
// its versions, and those two columns are the whole reason texting can be
// tracked better than email. They live in ~/Library/Messages/chat.db, which
// macOS ships a sqlite3 binary to read — so no npm dependency and no database
// driver, just one query.
//
// Read-only, and only ever for numbers this relay has itself texted.
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const SQLITE = '/usr/bin/sqlite3';
const CHAT_DB = process.env.WP_RELAY_CHATDB || path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

const run = (args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(SQLITE, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) { err.message = `${err.message}${stderr ? ` — ${String(stderr).trim()}` : ''}`; return reject(err); }
    resolve(String(stdout || ''));
  });
});

// Apple stores times as nanoseconds since 2001-01-01 (seconds on much older
// systems). 0 means "never happened".
function appleDate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const seconds = n > 1e11 ? n / 1e9 : n;
  return new Date((seconds + 978307200) * 1000);
}

function available() {
  try { return fs.existsSync(SQLITE) && fs.existsSync(CHAT_DB); } catch { return false; }
}

// Everything newer than `sinceRowId`, oldest first. `text` is read too, but it
// is NULL on recent macOS for messages whose body lives in attributedBody —
// reply text comes from BlueBubbles for that reason; this is only a fallback.
async function since(sinceRowId = 0, limit = 500, timeoutMs = 10000) {
  const sql = `SELECT m.ROWID AS rowid, m.guid AS guid, h.id AS handle,
       m.is_from_me AS fromMe, m.is_delivered AS delivered,
       m.date AS dateSent, m.date_delivered AS dateDelivered, m.date_read AS dateRead,
       m.text AS text
  FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID
  WHERE m.ROWID > ${Number(sinceRowId) || 0}
  ORDER BY m.ROWID ASC LIMIT ${Number(limit) || 500};`;
  const out = await run(['-readonly', '-json', CHAT_DB, sql], timeoutMs);
  if (!out.trim()) return [];
  let rows;
  try { rows = JSON.parse(out); } catch { return []; }
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    rowid: Number(r.rowid) || 0,
    guid: String(r.guid || ''),
    handle: String(r.handle || ''),
    fromMe: Number(r.fromMe) === 1,
    delivered: Number(r.delivered) === 1,
    sentAt: appleDate(r.dateSent),
    deliveredAt: appleDate(r.dateDelivered),
    readAt: appleDate(r.dateRead),
    text: r.text == null ? '' : String(r.text),
  }));
}

module.exports = { available, since, appleDate, CHAT_DB, SQLITE };
