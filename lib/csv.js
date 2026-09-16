// Tolerant CSV/TSV reading and column guessing for imports.
//
// Files come from wherever people keep lists — Excel on Windows, Numbers,
// Google Sheets, CRM exports, a copy-paste — so nothing here assumes a
// tidy RFC 4180 file: the delimiter is sniffed, a byte-order mark and any
// line-ending style are accepted, stray quotes inside a field are literal,
// ragged rows are padded, invisible characters are stripped, and when the
// header row is missing or unhelpful the columns are recognised from what
// they contain (an email column looks like emails, whatever it is called).
const address = require('./email-address');

const DELIMITERS = [',', ';', '\t', '|'];

function cleanCell(s) {
  return String(s == null ? '' : s)
    .replace(/[\u00a0\u2007\u202f]/g, ' ')                 // non-breaking spaces
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')           // zero-width characters
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
}

// Count delimiter occurrences per line, ignoring anything inside quotes.
function countOutsideQuotes(line, d) {
  let n = 0, q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (!q && c === d) n++;
  }
  return n;
}

// Pick the delimiter that gives the most consistent column count across the
// first lines; ties go to the more frequent one, then to the conventional order.
function sniffDelimiter(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim()).slice(0, 25);
  if (!lines.length) return ',';
  let best = { d: ',', score: -1 };
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const nonZero = counts.filter((c) => c > 0).length;
    if (!nonZero) continue;
    const mode = counts.slice().sort((a, b) => a - b)[Math.floor(counts.length / 2)];
    const consistent = counts.filter((c) => c === mode).length / counts.length;
    const score = consistent * 10 + Math.min(mode, 20) / 20 + nonZero / lines.length;
    if (score > best.score) best = { d, score };
  }
  return best.d;
}

// Parse text into rows of trimmed cells. Quotes only open a field at its
// start; anywhere else they are ordinary characters (5'10" stays intact).
function parseCsv(text, { delimiter } = {}) {
  let src = String(text == null ? '' : text);
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const d = delimiter || sniffDelimiter(src);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let atFieldStart = true;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && atFieldStart) { inQuotes = true; atFieldStart = false; continue; }
    if (c === d) { row.push(field); field = ''; atFieldStart = true; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row);
      row = []; field = ''; atFieldStart = true;
      continue;
    }
    if (atFieldStart && (c === ' ' || c === '\t') && d !== '\t') { field += c; continue; }   // keep, trimmed later
    field += c;
    atFieldStart = false;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const cleaned = rows.map((r) => r.map(cleanCell)).filter((r) => r.some((cell) => cell !== ''));
  const width = cleaned.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of cleaned) while (r.length < width) r.push('');
  return cleaned;
}

// ---------- what does a column contain? ----------
const PHONE = /^\+?[\d\s().-]{7,}$/;
const DATE = /^(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}|\d{4}-\d{2}-\d{2}T)/;
const URL = /^(https?:\/\/|www\.)/i;
const NAME = /^[\p{L}'’.-]+(\s+[\p{L}'’.-]+){1,4}$/u;
const CITY_STATE = /^[\p{L} .'-]+,\s*[\p{L} .]+$/u;

function scoreColumn(cells) {
  const vals = cells.map(cleanCell).filter(Boolean);
  const n = vals.length || 1;
  const frac = (fn) => vals.filter(fn).length / n;
  const emails = vals.filter((v) => Boolean(address.normalize(v))).length;
  return {
    filled: vals.length,
    emailCount: emails,
    email: emails / n,
    phone: frac((v) => PHONE.test(v) && (v.match(/\d/g) || []).length >= 7 && !address.normalize(v)),
    date: frac((v) => DATE.test(v)),
    url: frac((v) => URL.test(v)),
    name: frac((v) => NAME.test(v) && !/\d/.test(v) && v.length <= 60),
    location: frac((v) => CITY_STATE.test(v) && v.length <= 60),
    text: frac((v) => /\p{L}/u.test(v) && !address.normalize(v) && !PHONE.test(v) && !DATE.test(v) && !URL.test(v)),
  };
}

// A header row has no data-looking cells and short labels.
function looksLikeHeader(row) {
  const cells = row.map(cleanCell).filter(Boolean);
  if (!cells.length) return false;
  if (cells.some((c) => address.normalize(c) || (PHONE.test(c) && (c.match(/\d/g) || []).length >= 7))) return false;
  return cells.every((c) => c.length <= 40);
}

const SYNONYMS = {
  email: ['email', 'emailaddress', 'mail', 'workemail', 'personalemail', 'contactemail', 'primaryemail'],
  name: ['fullname', 'name', 'candidate', 'contact', 'lead', 'person', 'applicant'],
  firstName: ['firstname', 'first', 'givenname', 'fname', 'forename'],
  lastName: ['lastname', 'last', 'surname', 'familyname', 'lname'],
  role: ['role', 'title', 'jobtitle', 'position', 'job', 'headline', 'occupation', 'currenttitle'],
  company: ['company', 'employer', 'organization', 'organisation', 'org', 'business', 'firm', 'currentcompany', 'account', 'companyname', 'currentemployer', 'processor'],
  phone: ['phone', 'mobile', 'cell', 'telephone', 'tel', 'phonenumber', 'number', 'contactnumber'],
  location: ['location', 'city', 'state', 'address', 'region', 'area', 'market', 'metro', 'territory', 'citystate'],
  notes: ['notes', 'note', 'comment', 'comments', 'remarks', 'source'],
};
// Header words that must never be taken for these fields.
const EXCLUDE = {
  name: ['firstname', 'lastname', 'first', 'last', 'company', 'companyname', 'username', 'filename', 'surname'],
  role: ['entitled'],
  phone: ['phonetic'],
  notes: [],
  email: [],
  firstName: [],
  lastName: [],
  company: [],
  location: [],
};

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z]/g, '');
// Short synonyms only count as the whole header ("org", "cell"); longer ones
// may appear inside it ("workphone" → phone). A few are always exact-only.
const EXACT_ONLY = new Set(['lname', 'fname', 'number', 'source', 'note', 'name', 'last', 'first', 'mail', 'org', 'tel', 'cell', 'city', 'area', 'lead', 'firm', 'job', 'state']);
const headerMatches = (h, s) => h === s || (s.length >= 5 && !EXACT_ONLY.has(s) && h.includes(s));

// Guess the mapping from headers first, then from the data itself for
// anything the headers did not settle. `confidence` says which.
function guessMapping(headers, rows = []) {
  const map = {};
  const confidence = {};
  const scores = headers.map((_, i) => scoreColumn(rows.map((r) => r[i])));
  const taken = new Set();
  const byHeader = (field) => {
    const hits = headers
      .map((h, i) => ({ i, h: norm(h) }))
      .filter(({ h, i }) => h && !taken.has(i) && SYNONYMS[field].some((s) => headerMatches(h, s)) && !EXCLUDE[field].some((x) => h.includes(x)));
    if (!hits.length) return -1;
    // Several matching columns (work/personal email…): take the fullest.
    const fullness = (i) => (field === 'email' ? scores[i].emailCount : scores[i].filled) || 0;
    hits.sort((a, b) => fullness(b.i) - fullness(a.i));
    return hits[0].i;
  };
  const byContent = (key, min) => {
    let best = -1, bestScore = 0;
    scores.forEach((s, i) => {
      if (taken.has(i) || s.filled < 1) return;
      if (s[key] >= min && s[key] > bestScore) { best = i; bestScore = s[key]; }
    });
    return best;
  };
  const set = (field, i, how) => { map[field] = i; if (i >= 0) { taken.add(i); confidence[field] = how; } };

  // Order matters: the most recognisable columns are claimed first.
  for (const f of ['email', 'firstName', 'lastName', 'name', 'phone', 'role', 'company', 'location', 'notes']) {
    const i = byHeader(f);
    if (i >= 0) set(f, i, 'header'); else map[f] = -1;
  }
  if (map.email < 0) set('email', byContent('email', 0.5), 'content');
  if (map.phone < 0) set('phone', byContent('phone', 0.6), 'content');
  if (map.name < 0 && map.firstName < 0 && map.lastName < 0) set('name', byContent('name', 0.6), 'content');
  if (map.location < 0) set('location', byContent('location', 0.5), 'content');
  // One leftover text column with no useful header is most often the company.
  if (map.company < 0) {
    const leftovers = scores
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => !taken.has(i) && s.filled >= Math.max(1, rows.length * 0.3) && s.text >= 0.7 && s.date < 0.3 && s.location < 0.5)
      .filter(({ i }) => !norm(headers[i]) || /^column\d+$/.test(norm(headers[i])) || /(company|employer|org)/.test(norm(headers[i])));
    if (leftovers.length === 1) set('company', leftovers[0].i, 'guess');
  }
  return { mapping: map, confidence };
}

module.exports = { parseCsv, sniffDelimiter, guessMapping, looksLikeHeader, scoreColumn, cleanCell };
