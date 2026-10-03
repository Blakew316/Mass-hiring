// A short fingerprint of the code answering requests.
//
// A tag the browser holds (the state's ETag) says "you already have this".
// Once the tag is keyed on the stored document's version rather than on a
// hash of the whole answer, it no longer notices the server's own code
// changing what that version looks like — a field added to the candidate
// list, a ranking rule changed — and a page left open across a deploy would
// be told "304, nothing new" while holding an answer the new code would never
// give. So every version-keyed tag carries this too.
//
// Locally, and wherever the sources are on disk, it is a hash of app.js,
// lib/ and public/wire.js (the compact list's format, which the server writes
// with). Deployed, the function is one bundle and those files are not there:
// netlify/src/api.mjs names its own bundle file (useFile), which holds all of
// the same code. Should neither be readable, the value is this process's own,
// so its tags can only ever cost another instance a full answer, never give
// one the wrong 304.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let version = null;
let bundle = null;

function useFile(file) {
  bundle = file;
  version = null;
}

function fromSources() {
  const root = path.join(__dirname, '..');
  const h = crypto.createHash('sha1');
  h.update(fs.readFileSync(path.join(root, 'app.js')));
  h.update('\0wire.js\0').update(fs.readFileSync(path.join(root, 'public', 'wire.js')));
  for (const name of fs.readdirSync(path.join(root, 'lib')).filter((n) => n.endsWith('.js')).sort()) {
    h.update(`\0${name}\0`).update(fs.readFileSync(path.join(root, 'lib', name)));
  }
  return h.digest('hex').slice(0, 16);
}

function fromBundle() {
  if (!bundle) throw new Error('no bundle named');
  return crypto.createHash('sha1').update(fs.readFileSync(bundle)).digest('hex').slice(0, 16);
}

function codeVersion() {
  if (version) return version;
  try { version = fromSources(); } catch {
    try { version = fromBundle(); } catch (err) {
      console.warn(`[code-version] nothing to fingerprint (${err.message}); tags from this instance are its own`);
      version = `p${crypto.randomBytes(8).toString('hex')}`;
    }
  }
  return version;
}

module.exports = { codeVersion, useFile };
