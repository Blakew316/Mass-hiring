// Sending iMessage by driving Messages.app, with no third-party software.
//
// This is the default backend. It needs nothing installed: macOS already has
// Messages and osascript. What it does need, once, is permission —
// System Settings → Privacy & Security → Automation → your terminal (or node)
// → Messages. Until that is granted every send fails with error -1743.
//
// The number and the message are passed to the script as ARGUMENTS, never
// pasted into it, so no apostrophe or quotation mark in a message can change
// what AppleScript executes.
const { execFile } = require('child_process');
const path = require('path');

const OSASCRIPT = process.env.WP_RELAY_OSASCRIPT || '/usr/bin/osascript';
const SEND_SCRIPT = path.join(__dirname, '..', 'send.applescript');

// Messages is slow to wake, and a send that has not returned in half a minute
// is not going to.
const SEND_TIMEOUT_MS = 30000;
const CHECK_TIMEOUT_MS = 15000;

const CHECK = `
tell application "Messages"
  set svc to missing value
  try
    set svc to 1st service whose service type = iMessage
  end try
  if svc is missing value then
    try
      set svc to 1st account whose service type = iMessage
    end try
  end if
  if svc is missing value then error "No iMessage account is signed in on this Mac."
  return "ok"
end tell`;

function run(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(OSASCRIPT, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const detail = String(stderr || '').trim();
      if (err) {
        // The two failures worth naming, because both are a setting rather
        // than a bug and neither is obvious from Apple's wording.
        if (/-1743|Not authorized|not allowed assistive/i.test(detail)) {
          return reject(new Error('macOS has not granted permission to control Messages. System Settings → Privacy & Security → Automation → enable Messages for whatever runs the relay, then restart it.'));
        }
        if (/-1728|can.t get|Invalid handle/i.test(detail)) {
          return reject(new Error(`Messages could not reach that number on iMessage${detail ? ` (${detail.slice(0, 160)})` : ''}`));
        }
        return reject(new Error(detail || err.message));
      }
      resolve(String(stdout || '').trim());
    });
  });
}

class AppleScript {
  constructor({ log = () => {} } = {}) { this.log = log; }

  // Is Messages there, awake, and signed in?
  async ping() {
    await run(['-e', CHECK], CHECK_TIMEOUT_MS);
    return true;
  }

  // AppleScript cannot reliably answer this before sending — Messages will
  // happily hand back a participant for a number that has no iMessage account.
  // Null means "no idea, send it and watch what happens"; a failed send is
  // caught afterwards from the Messages database instead (see receipts.js).
  async isOnIMessage() { return null; }

  async send(e164, message) {
    await run([SEND_SCRIPT, e164, message], SEND_TIMEOUT_MS);
    // AppleScript gives back no message id; the guid is picked up from the
    // Messages database on the next receipts pass.
    return { guid: '' };
  }

  // Replies come from the Messages database with this backend, so there is
  // nothing to poll here.
  async recentMessages() { return []; }
}

module.exports = { AppleScript, SEND_SCRIPT, OSASCRIPT };
