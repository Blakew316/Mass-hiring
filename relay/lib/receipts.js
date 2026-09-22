// Delivery receipts, read receipts and replies, straight from the Messages
// database at ~/Library/Messages/chat.db.
//
// macOS protects that file behind Full Disk Access, and how you read it
// decides whether that permission actually applies. Shelling out to
// /usr/bin/sqlite3 does NOT work: it is an Apple-signed system binary, so
// macOS gives it its own permission identity instead of letting it inherit
// the relay's, and the read is refused however carefully Full Disk Access was
// granted to node. Reading the file from inside this process has no such
// problem — node holds the permission and node opens the file.
//
// So node:sqlite is used when it exists (Node 22.5+), and the CLI is kept only
// as a fallback for older Node, where the permission caveat above applies.
//
// Read-only, and only ever for numbers this relay has itself texted.
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const attributedBody = require('./attributedbody');

let nodeSqlite = null;
try { nodeSqlite = require('node:sqlite'); } catch { nodeSqlite = null; }

const SQLITE = process.env.WP_RELAY_SQLITE || '/usr/bin/sqlite3';
const CHAT_DB = process.env.WP_RELAY_CHATDB || path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
// A test can force the fallback path to keep it covered.
const forceCli = process.env.WP_RELAY_FORCE_SQLITE_CLI === '1';
const inProcess = () => Boolean(nodeSqlite) && !forceCli;

const DENIED = /authorization denied|unable to open database|operation not permitted|EPERM|EACCES/i;
function permissionError(detail) {
  const e = new Error(
    'macOS is blocking access to the Messages database, so receipts and replies are off. '
    + 'Grant Full Disk Access to the node binary that runs the relay '
    + '(System Settings → Privacy & Security → Full Disk Access → + → your node), then restart the relay: '
    + 'launchctl kickstart -k gui/$UID/com.wholesalepayments.wprelay'
    + (detail ? `  [${detail}]` : ''),
  );
  e.permission = true;
  return e;
}

// Apple stores times as nanoseconds since 2001-01-01 (seconds on much older
// systems). 0 means "never happened".
function appleDate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const seconds = n > 1e11 ? n / 1e9 : n;
  return new Date((seconds + 978307200) * 1000);
}

function available() {
  try {
    if (!fs.existsSync(CHAT_DB)) return false;
    return inProcess() ? true : fs.existsSync(SQLITE);
  } catch { return false; }
}

const cli = (args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(SQLITE, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      // execFile puts the whole command — the entire SQL statement — into
      // err.message. Logged repeatedly that buries everything else, so only
      // sqlite's own complaint is kept.
      const detail = String(stderr || '').replace(/^Error:\s*/i, '').trim();
      return reject(DENIED.test(detail) ? permissionError(detail.slice(0, 120)) : new Error(detail || String(err.message).split('\n')[0]));
    }
    resolve(String(stdout || ''));
  });
});

function query(sql, timeoutMs) {
  if (!inProcess()) {
    return cli(['-readonly', '-json', CHAT_DB, sql], timeoutMs).then((out) => {
      if (!out.trim()) return [];
      try { return JSON.parse(out); } catch { return []; }
    });
  }
  let db = null;
  try {
    db = new nodeSqlite.DatabaseSync(CHAT_DB, { readOnly: true });
    const stmt = db.prepare(sql);
    // Apple's nanosecond timestamps do not fit in a JS number, so they come
    // back as BigInt; everything downstream goes through Number().
    if (typeof stmt.setReadBigInts === 'function') stmt.setReadBigInts(true);
    return Promise.resolve(stmt.all());
  } catch (err) {
    const msg = String((err && err.message) || err);
    return Promise.reject(DENIED.test(msg) ? permissionError(msg.slice(0, 120)) : new Error(msg));
  } finally {
    try { if (db) db.close(); } catch {}
  }
}

// Everything newer than `sinceRowId`, oldest first.
//
// `text` is NULL on recent macOS for messages whose body was written into
// `attributedBody` instead, so that column is fetched as hex and decoded — but
// only for inbound messages that need it, since it is a blob and this runs
// every twenty seconds.
//
// `error` is what catches a number with no iMessage account: the send appears
// to succeed and then Messages marks the row failed a moment later.
async function since(sinceRowId = 0, limit = 500, timeoutMs = 10000) {
  const sql = `SELECT m.ROWID AS rowid, m.guid AS guid, h.id AS handle,
       m.is_from_me AS fromMe, m.is_delivered AS delivered, m.error AS error, m.service AS service,
       m.date AS dateSent, m.date_delivered AS dateDelivered, m.date_read AS dateRead,
       m.text AS text,
       CASE WHEN m.is_from_me = 0 AND (m.text IS NULL OR m.text = '')
            THEN hex(m.attributedBody) ELSE NULL END AS bodyHex
  FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID
  WHERE m.ROWID > ${Number(sinceRowId) || 0}
  ORDER BY m.ROWID ASC LIMIT ${Number(limit) || 500};`;
  const rows = await query(sql, timeoutMs);
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    rowid: Number(r.rowid) || 0,
    guid: String(r.guid || ''),
    handle: String(r.handle || ''),
    fromMe: Number(r.fromMe) === 1,
    delivered: Number(r.delivered) === 1,
    failed: r.error != null && Number(r.error) !== 0,
    service: String(r.service || ''),
    sentAt: appleDate(r.dateSent),
    deliveredAt: appleDate(r.dateDelivered),
    readAt: appleDate(r.dateRead),
    text: r.text != null && String(r.text).trim() ? String(r.text) : attributedBody.fromHex(r.bodyHex),
  }));
}

// Which way it is reading, for the startup log.
const mode = () => (inProcess() ? 'in-process (node:sqlite)' : `${SQLITE} (child process — Full Disk Access may not apply)`);

module.exports = { available, since, appleDate, mode, CHAT_DB, SQLITE };
