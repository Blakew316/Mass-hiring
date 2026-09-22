// Getting the text out of a message that has no text.
//
// On recent macOS the `text` column of chat.db is NULL for many messages and
// the body lives in `attributedBody` instead — an NSAttributedString written in
// Apple's old "typedstream" archive format. There is no supported way to read
// it and no Node library ships with one, so this walks the few bytes that
// matter.
//
// The body sits just after the class name NSString: a length, then the UTF-8
// bytes. The length is one byte, unless it is 0x81 (a 16-bit length follows)
// or 0x82 (32-bit). How many bytes sit between "NSString" and that length
// varies between macOS versions, so rather than trust one offset this tries
// each one in a short window, keeps only candidates that decode to clean UTF-8,
// and takes the longest — a stray byte can look like a one-character string,
// but it cannot look like a sentence.
//
// Anything it is not sure about returns '' rather than a guess. A missing reply
// is obvious and harmless; a mangled one would be filed as what the candidate
// actually said.
const MARKER = 0x2b;                 // '+' introduces an inline string
const LEN_16 = 0x81;
const LEN_32 = 0x82;
const MAX_BODY = 64 * 1024;
const WINDOW = 16;                   // how far past "NSString" the length may sit
// Archive bookkeeping that must never be mistaken for a message.
const CLASS_NAMES = ['NSString', 'NSObject', 'NSDictionary', 'NSNumber', 'NSValue', 'NSMutable', 'NSAttributedString', 'NSArray', '__kIM', 'streamtyped'];

function plausible(text) {
  if (!text || text.length > MAX_BODY) return false;
  if (text.includes('�') || text.includes('\u0000')) return false;   // sliced mid-character, or not text at all
  if (CLASS_NAMES.some((n) => text.startsWith(n))) return false;
  return true;
}

// Something a person plausibly typed, as opposed to a byte that happens to be
// printable: at least two characters, carrying a letter, a digit, or anything
// outside ASCII (which covers accents and emoji).
const looksTyped = (text) => text.length >= 2 && (/[\p{L}\p{N}]/u.test(text) || /[^\x00-\x7F]/.test(text));

// Read a length-prefixed string starting at `i`, or '' if that is not one.
function readString(buf, i) {
  if (i < 0 || i >= buf.length) return '';
  let len = buf[i];
  let at = i + 1;
  if (len === LEN_16) {
    if (at + 2 > buf.length) return '';
    len = buf.readUInt16LE(at); at += 2;
  } else if (len === LEN_32) {
    if (at + 4 > buf.length) return '';
    len = buf.readUInt32LE(at); at += 4;
  } else if (len > 0x7f) {
    return '';
  }
  if (len < 1 || len > MAX_BODY || at + len > buf.length) return '';
  const text = buf.toString('utf8', at, at + len);
  return plausible(text) ? text : '';
}

function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return '';
  const start = buf.indexOf('NSString', 0, 'latin1');
  if (start < 0) return '';
  const from = start + 'NSString'.length;

  // The documented layout: a '+' marker immediately before the length.
  const marker = buf.indexOf(MARKER, from);
  if (marker >= 0 && marker < from + WINDOW) {
    const exact = readString(buf, marker + 1);
    if (exact) return exact;
  }

  // Otherwise take the longest thing in the window that reads as real text.
  // The bar is higher here than on the marker path, because without the marker
  // we are guessing where the string starts: a stray byte can easily produce a
  // one-character "message" like "+" out of the archive's own punctuation, so a
  // guessed body has to be at least two characters and contain something a
  // person would actually type.
  let best = '';
  for (let i = from; i < Math.min(from + WINDOW, buf.length); i++) {
    const got = readString(buf, i);
    if (got.length > best.length && looksTyped(got)) best = got;
  }
  return best;
}

const fromHex = (hex) => {
  const s = String(hex || '').trim();
  if (!s || s.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(s)) return '';
  return decode(Buffer.from(s, 'hex'));
};

module.exports = { decode, fromHex };
