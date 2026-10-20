// Tolerant CSV/TSV reading and column guessing for imports.
//
// Files come from wherever people keep lists — Excel on Windows, Numbers,
// Google Sheets, HubSpot, Salesforce, Outlook, Google Contacts, LinkedIn, a
// copy-paste — so nothing here assumes a tidy RFC 4180 file: the delimiter
// is sniffed, a byte-order mark and any line-ending style are accepted, an
// unclosed quote is treated as an ordinary character, ragged rows are
// padded, invisible characters are stripped, title rows above the header
// are skipped, and when the header row is missing or unhelpful the columns
// are recognised from what they contain (an email column looks like emails,
// whatever it is called).
const address = require('./email-address');

const DELIMITERS = ['\t', ',', ';', '|'];
const MAX_COLUMNS = 200;
const ZWNJ = String.fromCharCode(0x200c);
const ZWJ = String.fromCharCode(0x200d);

// HTML character references, as spreadsheets exported from web tools leave
// them ("So&#64257;a", "513&#8208;675&#8208;1234", "Smith &amp; Co").
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
const fromCode = (n) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '');
function decodeEntities(t) {
  if (!t.includes('&')) return t;
  return t.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi, (m, dec, hex, name) => {
    if (dec) return fromCode(Number(dec)) || m;
    if (hex) return fromCode(parseInt(hex, 16)) || m;
    const v = ENTITIES[name.toLowerCase()];
    return v === undefined ? m : v;
  });
}
// Typographic ligatures ("ﬁ" in "Soﬁa") and the hyphen look-alikes that
// copy-paste from PDFs and web pages leaves in names and numbers.
const LOOKALIKES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st', '‐': '-', '‑': '-', '−': '-' };
const LOOKALIKE = /[ﬀﬁﬂﬃﬄﬅﬆ‐‑−]/g;

function cleanCell(s) {
  return decodeEntities(String(s == null ? '' : s))
    .replace(LOOKALIKE, (c) => LOOKALIKES[c])
    .normalize('NFC')
    .replace(/\p{Zs}/gu, ' ')                                             // every kind of space, incl. non-breaking
    .replace(/\p{Cf}/gu, (ch) => (ch === ZWNJ || ch === ZWJ ? ch : ''))   // format chars (zero-width, bidi, soft hyphen…); joiners are letters in some scripts
    .replace(/[^\P{Cc}\n\r\t]/gu, '')                                     // control characters, keeping line breaks and tabs
    .trim();
}

// A quote opens a quoted region only at the start of a field — the same rule
// the parser uses, so the sniffer and the parser agree about stray quotes.
function countOutsideQuotes(line, d) {
  let n = 0, q = false, atStart = true;
  for (const c of line) {
    if (q) { if (c === '"') q = false; continue; }
    if (c === '"' && atStart) { q = true; atStart = false; continue; }
    if (c === d) { n++; atStart = true; continue; }
    if (c === ' ' && atStart) continue;
    atStart = false;
  }
  return n;
}

// Pick the delimiter that gives the most consistent column count across the
// first lines. A delimiter that most lines do not contain cannot win, and a
// tab wins ties because tabs never occur inside ordinary cell text.
function sniffDelimiter(text) {
  const lines = String(text || '').split(/\r\n|\r|\n/).filter((l) => l.trim()).slice(0, 25);
  if (!lines.length) return ',';
  let best = { d: ',', score: -1 };
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const mode = counts.slice().sort((a, b) => a - b)[Math.floor(counts.length / 2)];
    if (mode === 0) continue;
    const consistent = counts.filter((c) => c === mode).length / counts.length;
    const nonZero = counts.filter((c) => c > 0).length / counts.length;
    const score = consistent * 10 + nonZero * 5 + Math.min(mode, 20) / 20 + (d === '\t' ? 0.01 : 0);
    if (score > best.score) best = { d, score };
  }
  return best.d;
}

// Parse text into rows of trimmed cells. Quotes only open a field at its
// start; anywhere else they are ordinary characters (5'10" stays intact). A
// quote that never closes is re-read as an ordinary character too. Each row
// remembers the physical line it started on (rows.lines, 1-based) so the
// dashboard can point at the right row of the file.
function parseCsv(text, { delimiter } = {}) {
  let src = String(text == null ? '' : text);
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const d = delimiter || sniffDelimiter(src);
  const literalQuotes = new Set();   // positions of quotes that turned out not to open a field
  for (let attempt = 0; attempt < 50; attempt++) {
    const rows = [];
    const lines = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let quoteAt = -1;
    let atFieldStart = true;
    let line = 1;
    let rowLine = 1;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\n' || (c === '\r' && src[i + 1] !== '\n')) line++;
      if (inQuotes) {
        if (c === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
        continue;
      }
      if (c === '"' && atFieldStart && !literalQuotes.has(i)) { inQuotes = true; quoteAt = i; atFieldStart = false; continue; }
      if (c === d) { row.push(field); field = ''; atFieldStart = true; continue; }
      if (c === '\n' || c === '\r') {
        if (c === '\r' && src[i + 1] === '\n') i++;
        row.push(field); rows.push(row); lines.push(rowLine);
        row = []; field = ''; atFieldStart = true; rowLine = line;
        continue;
      }
      if (atFieldStart && c === ' ') { field += c; continue; }   // kept, trimmed later
      field += c;
      atFieldStart = false;
    }
    if (inQuotes) { literalQuotes.add(quoteAt); continue; }       // unclosed: that quote was just a character
    if (field.length || row.length) { row.push(field); rows.push(row); lines.push(rowLine); }
    const cleaned = [];
    const keptLines = [];
    rows.forEach((r, i) => {
      const cells = r.map(cleanCell);
      if (cells.some((cell) => cell !== '')) { cleaned.push(cells.slice(0, MAX_COLUMNS)); keptLines.push(lines[i]); }
    });
    Object.defineProperty(cleaned, 'lines', { value: keptLines, enumerable: false });
    return cleaned;
  }
  return [];
}

// A cell that only says nothing is known: "?", "N/A", "none", "-".
const PLACEHOLDER = /^(\?+|-+|\.+|n\/?a|none|null|nil|unknown|tbd|x|no|not available|not provided|no email|no phone|#n\/a|#value!|#ref!|undefined)$/i;
const isPlaceholder = (v) => PLACEHOLDER.test(String(v || '').trim());

// ---------- what does a column contain? ----------
const PHONE = /^\+?[\d\s().-]{7,}$/;
const DATE = /^(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}|\d{4}-\d{2}-\d{2}T)/;
const URL = /^(https?:\/\/|www\.)/i;
const WORD = "[\\p{L}\\p{M}'’.-]+";
const NAME = new RegExp(`^${WORD}(\\s+${WORD}){1,4}$`, 'u');
const LAST_FIRST = new RegExp(`^(${WORD}(?:\\s${WORD})?),\\s*(${WORD}(?:\\s${WORD})?)$`, 'u');
const REGION = /^([A-Z]{2,3}|[\p{L}\p{M}. ]{2,30})$/u;
const CITY_STATE = new RegExp(`^[\\p{L}\\p{M} .'-]{2,40},\\s*([A-Z]{2}|[\\p{L}\\p{M}. ]{2,30})$`, 'u');
const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const REGION_WORDS = /^(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|ontario|quebec|british columbia|alberta|england|scotland|wales|ireland|usa|us|uk|canada|australia|germany|france|spain|italy|mexico|india|netherlands|texas|fl|ca|ny|tx|ga|nc|nj|az|oh|pa|il|mi|va|wa|ma|co|md|tn|mo|in|wi|mn|sc|al|la|ky|or|ok|ct|ut|ia|nv|ar|ms|ks|nm|ne|wv|id|hi|nh|me|ri|mt|de|sd|nd|ak|vt|wy|dc)\.?$/i;

// Is the text after a comma a place (state/country) rather than a first name?
function looksLikePlace(s) {
  const t = String(s || '').trim();
  return US_STATES.has(t.toUpperCase()) || REGION_WORDS.test(t);
}
// "Doe, Jane" → { firstName: 'Jane', lastName: 'Doe' }; null when it is not
// that shape ("Austin, TX" is a place, "Acme, Inc." is a company).
const COMPANY_SUFFIX = /^(inc|llc|ltd|corp|co|gmbh|plc|lp|llp|pllc|pc|sa|ag|nv|bv|dba|group|holdings|company|corporation|limited)\.?$/i;
// "Robert Safford, Jr." is a name with its suffix, not "Jr." first.
const NAME_SUFFIX = /^(jr|sr|ii|iii|iv|v|phd|md|dds|do|rn|cpa|mba|esq|cpm|arm|rpm|pe|pmp)\.?$/i;
function splitLastFirst(name) {
  const m = LAST_FIRST.exec(String(name || '').trim());
  if (!m || /\d/.test(name) || looksLikePlace(m[2]) || COMPANY_SUFFIX.test(m[2].trim()) || NAME_SUFFIX.test(m[2].trim())) return null;
  return { lastName: m[1].trim(), firstName: m[2].trim() };
}

function scoreColumn(cells) {
  const vals = cells.map(cleanCell).filter((v) => v && !isPlaceholder(v));
  const n = vals.length || 1;
  const frac = (fn) => vals.filter(fn).length / n;
  const emails = vals.filter((v) => v.length <= 254 && Boolean(address.normalize(v))).length;
  const short = (v, max) => v.length <= max;
  const isPhone = (v) => short(v, 30) && PHONE.test(v) && (v.match(/\d/g) || []).length >= 7 && !address.normalize(v);
  const isDate = (v) => short(v, 40) && DATE.test(v);
  const isUrl = (v) => short(v, 500) && URL.test(v);
  const isLastFirst = (v) => short(v, 80) && Boolean(splitLastFirst(v));
  const isName = (v) => short(v, 60) && !/\d/.test(v) && (NAME.test(v) || isLastFirst(v));
  const isPlace = (v) => short(v, 60) && CITY_STATE.test(v) && !isLastFirst(v) && (looksLikePlace(v.split(',').pop()) || !/^[\p{L}\p{M}'’.-]+,\s*[\p{L}\p{M}'’.-]+$/u.test(v));
  const distinct = new Set(vals.map((v) => v.toLowerCase())).size;
  return {
    filled: vals.length,
    distinct,
    emailCount: emails,
    email: emails / n,
    phone: frac(isPhone),
    date: frac(isDate),
    url: frac(isUrl),
    name: frac(isName),
    location: frac(isPlace),
    text: frac((v) => /\p{L}/u.test(v) && !address.normalize(v) && !isPhone(v) && !isDate(v) && !isUrl(v)),
    // A "label" column (Mobile/Work/Home) repeats a handful of short words.
    label: vals.length >= 4 && distinct < vals.length && distinct <= Math.max(2, Math.ceil(vals.length * 0.15)) && vals.every((v) => v.length <= 12) ? 1 : 0,
    zip: frac((v) => /^\d{5}(-\d{4})?$|^[A-Z]\d[A-Z] ?\d[A-Z]\d$/i.test(v)),
  };
}

const dataLooking = (c) => Boolean(address.normalize(c)) || (PHONE.test(c) && (c.match(/\d/g) || []).length >= 7);

// A header row has no data-looking cells and short labels.
function looksLikeHeader(row) {
  const cells = row.map(cleanCell).filter(Boolean);
  if (!cells.length) return false;
  if (cells.some(dataLooking)) return false;
  return cells.every((c) => c.length <= 40) || cells.some((c) => synonymHits(c) > 0);
}

// Header words in the vocabularies of Excel, CRMs and a few languages.
const SYNONYMS = {
  email: ['email', 'emailaddress', 'mail', 'workemail', 'personalemail', 'contactemail', 'primaryemail', 'emailvalue', 'courriel', 'correo', 'correoelectronico', 'epost'],
  name: ['fullname', 'name', 'candidate', 'contact', 'lead', 'person', 'applicant', 'candidatename', 'contactname', 'leadname', 'displayname', 'nombre', 'nombrecompleto', 'nome', 'nomcomplet', 'naam'],
  firstName: ['firstname', 'first', 'givenname', 'fname', 'forename', 'vorname', 'prenom', 'nombre', 'primeironome', 'voornaam'],
  lastName: ['lastname', 'last', 'surname', 'familyname', 'lname', 'nachname', 'familienname', 'nom', 'apellido', 'apellidos', 'sobrenome', 'cognome', 'achternaam'],
  role: ['role', 'title', 'jobtitle', 'position', 'job', 'headline', 'occupation', 'currenttitle', 'poste', 'cargo', 'puesto', 'funktion', 'beruf', 'functie'],
  company: ['company', 'employer', 'organization', 'organisation', 'org', 'business', 'firm', 'currentcompany', 'account', 'accountname', 'companyname', 'currentemployer', 'processor', 'organizationname', 'firma', 'unternehmen', 'societe', 'entreprise', 'empresa', 'azienda', 'bedrijf', 'arbeitgeber'],
  phone: ['phone', 'mobile', 'cell', 'telephone', 'tel', 'phonenumber', 'number', 'contactnumber', 'phonevalue', 'telefon', 'telefono', 'telefone', 'telefoon', 'handy', 'movil', 'portable'],
  location: ['location', 'address', 'region', 'area', 'market', 'metro', 'territory', 'citystate', 'cityandstate', 'citystatezip', 'fulladdress', 'mailingaddress', 'homeaddress'],
  // A place in parts, each its own column (City, State, Zip): put back
  // together as "Fort Worth, TX 76107" (app.js analyzeImport).
  city: ['city', 'town', 'mailingcity', 'billingcity', 'homecity', 'workcity', 'cityname', 'addresscity', 'ort', 'stadt', 'ville', 'ciudad', 'cidade', 'citta', 'plaats'],
  state: ['state', 'st', 'province', 'statename', 'stateprovince', 'stateregion', 'mailingstate', 'billingstate', 'homestate', 'addressregion', 'addressstate', 'bundesland', 'provincia', 'estado'],
  zip: ['zip', 'zipcode', 'postalcode', 'postcode', 'postal', 'mailingzip', 'mailingpostalcode', 'billingzip', 'homezip', 'addresszip', 'plz', 'codigopostal', 'cep'],
  notes: ['notes', 'note', 'comment', 'comments', 'remarks', 'source', 'notizen', 'bemerkung', 'commentaire', 'comentarios', 'opmerkingen'],
  // A second column of notes (a recruiter's initials beside the comments).
  notes2: [],
  pastRoles: ['pastroles', 'pastrole', 'pasttitles', 'previousroles', 'previousrole', 'previoustitles', 'priorroles', 'formerroles', 'formertitles', 'workhistory', 'employmenthistory', 'jobhistory', 'experience', 'pastpositions', 'previouspositions'],
  // More addresses for the same person ("Other Emails": a; b). Never the
  // address to write to — only how to recognise them when they turn up again.
  altEmails: ['otheremails', 'otheremail', 'alternateemails', 'alternateemail', 'altemails', 'altemail', 'additionalemails', 'additionalemail', 'secondaryemails', 'secondaryemail', 'moreemails'],
};
// Header words that disqualify a column for a field.
const EXCLUDE = {
  name: ['firstname', 'lastname', 'first', 'last', 'company', 'username', 'filename', 'surname', 'owner', 'id', 'status', 'donot', 'type', 'label', 'score', 'accuracy', 'yomi', 'nickname', 'domain', 'website', 'url', 'link'],
  role: ['entitled', 'type', 'label', 'honorific', 'prefix', 'suffix', 'yomi'],
  phone: ['phonetic', 'type', 'label', 'ext', 'extension', 'yomi'],
  company: ['phone', 'email', 'type', 'label', 'size', 'id', 'url', 'domain', 'website', 'yomi', 'industry', 'revenue', 'employees', 'linkedin', 'owner'],
  location: ['type', 'label', 'email', 'phone', 'ip', 'url', 'website'],
  city: ['type', 'label', 'email', 'phone'],
  state: ['type', 'label', 'email', 'phone', 'status', 'statement'],
  zip: ['type', 'label', 'email', 'phone'],
  notes2: [],
  notes: ['type', 'label'],
  pastRoles: ['type', 'label', 'count', 'years'],
  email: ['type', 'label', 'status', 'valid', 'verified', 'confidence', 'domain', 'bounce', 'optout', 'unsubscribe', 'opt', 'consent', 'other', 'alternate', 'additional', 'secondary'],
  altEmails: ['type', 'label', 'status', 'refer', 'manager', 'owner', 'recruiter', 'assistant', 'spouse', 'mother', 'father', 'brother', 'sister', 'parent', 'emergency'],
  firstName: ['yomi', 'phonetic'],
  lastName: ['yomi', 'phonetic'],
};
const norm = (h) => String(h || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z]/g, '');
// Short and generic synonyms only count as the whole header ("org", "contact");
// longer ones may appear inside it ("workphone" → phone).
const EXACT_ONLY = new Set(['otheremail', 'otheremails', 'lname', 'fname', 'number', 'source', 'note', 'name', 'last', 'first', 'mail', 'org', 'tel', 'cell', 'city', 'area', 'lead', 'firm', 'job', 'state', 'contact', 'person', 'candidate', 'applicant', 'account', 'address', 'business', 'nom', 'nome', 'nombre', 'naam', 'ort', 'stadt', 'ville', 'poste', 'cargo', 'puesto', 'handy', 'movil', 'portable', 'plaats', 'citta', 'cidade', 'ciudad', 'town', 'st', 'zip', 'postal', 'plz', 'cep', 'estado']);
// "Partner Name", "Client Name", "Customer Name": a person's name, whoever
// the file calls them (but never a username, a file's or a company's name).
const PERSON_NAME = /^(partner|client|customer|prospect|recruit|agent|rep|member|employee|student|patient|owner|primary|primarycontact|partnerprimary|contactperson|full|display)?name$/;
const headerMatches = (h, s) => h === s || (s.length >= 5 && !EXACT_ONLY.has(s) && h.includes(s));
function synonymHits(header) {
  const h = norm(header);
  if (!h) return 0;
  return Object.values(SYNONYMS).filter((list) => list.some((s) => headerMatches(h, s))).length + (PERSON_NAME.test(h) ? 1 : 0);
}

// Which row is the header? Title lines, notes and merged group rows often
// sit above it (LinkedIn's export starts with three lines of prose). Score
// the first rows by how many recognisable header words they hold.
// A header row may carry one stray value (a phone number typed into the
// header of an empty column): with at least two recognisable header words
// and only that one value, it is still the header, the value just not a
// column's name.
function findHeader(rows, maxScan = 20) {
  let best = -1, bestHits = 0;
  for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
    const cells = rows[i].map(cleanCell).filter(Boolean);
    if (!cells.length) continue;
    const stray = cells.filter(dataLooking).length;
    const hits = cells.reduce((n, c) => n + (!dataLooking(c) && synonymHits(c) > 0 ? 1 : 0), 0);
    if (stray && !(stray === 1 && hits >= 2 && hits > stray)) continue;
    if (hits > bestHits) { best = i; bestHits = hits; }
  }
  if (best >= 0) return { index: best, headerless: false };
  return looksLikeHeader(rows[0] || []) ? { index: 0, headerless: false } : { index: -1, headerless: true };
}

// A header split over two rows ("Partner Name" under a blank, beside
// "Phone" above): the row under the header holds labels, not data, and only
// where the header row has none. Returns the merged header, or null.
function headerContinuation(header, next) {
  if (!Array.isArray(next)) return null;
  const cells = next.map(cleanCell);
  const filled = cells.map((c, i) => [c, i]).filter(([c]) => c);
  if (!filled.length || filled.some(([c]) => dataLooking(c) || c.length > 40 || /\d/.test(c))) return null;
  if (filled.some(([, i]) => cleanCell(header[i]))) return null;
  if (!filled.some(([c]) => synonymHits(c) > 0)) return null;
  const width = Math.max(header.length, cells.length);
  return Array.from({ length: width }, (_, i) => cleanCell(header[i]) || cells[i] || '');
}

// How well a column's content fits a field, 0..1. Used to rank several
// header matches (Outlook's "Business Phone" must not become the company)
// and to reject a header match the data contradicts.
function fit(field, s) {
  const textish = Math.max(0, s.text - s.phone - s.date - s.url - s.email) * (1 - s.label * 0.8);
  switch (field) {
    case 'email': return s.email;
    case 'phone': return s.phone * (1 - s.label);
    case 'name': return s.name;
    case 'firstName': case 'lastName': return (s.text * 0.5 + (s.name < 0.5 ? 0.5 : 0.2)) * (1 - s.label * 0.6);
    case 'location': return Math.max(s.location, textish * 0.5);
    case 'city': case 'state': return textish;
    case 'zip': return s.zip;
    case 'company': case 'role': case 'notes': return textish;
    default: return s.text;
  }
}

// Guess the mapping from headers first, then from the data itself for
// anything the headers did not settle. `confidence` says which.
function guessMapping(headers, rows = []) {
  const map = {};
  const confidence = {};
  const scores = headers.map((_, i) => scoreColumn(rows.map((r) => r[i])));
  const taken = new Set();
  const set = (field, i, how) => { map[field] = i; if (i >= 0) { taken.add(i); confidence[field] = how; } };

  const byHeader = (field) => {
    const hits = [];
    headers.forEach((raw, i) => {
      const h = norm(raw);
      if (!h || taken.has(i)) return;
      if (EXCLUDE[field].some((x) => h.includes(x))) return;
      const matches = SYNONYMS[field].filter((s) => headerMatches(h, s));
      if (field === 'name' && PERSON_NAME.test(h)) matches.push(h);
      if (!matches.length) return;
      const exact = matches.some((s) => s === h);
      const longest = Math.max(...matches.map((s) => s.length));
      const f = fit(field, scores[i]);
      // Exact header beats a substring; between equals, the data decides.
      const fullness = field === 'email' ? Math.min(scores[i].emailCount, 50) / 50 * 2 : Math.min(scores[i].filled, 50) / 100;
      const rank = (exact ? 4 : 0) + longest / 100 + f * 2 + fullness;
      hits.push({ i, rank, f });
    });
    if (!hits.length) return -1;
    hits.sort((a, b) => b.rank - a.rank);
    const top = hits[0];
    // A header match whose data is plainly something else is not a match
    // (a column of phone numbers is never the company, whatever it is called);
    // sparse or messy data under a right-looking header is still accepted.
    const sc = scores[top.i];
    if (sc.filled >= 3) {
      const other = (...keys) => keys.some((k) => sc[k] > 0.5);
      if (field === 'email' && other('phone', 'date', 'url')) return -1;
      if (field === 'phone' && (other('email', 'date', 'url') || sc.label)) return -1;
      if ((field === 'company' || field === 'role' || field === 'name' || field === 'location' || field === 'notes') && other('phone', 'email', 'url', 'date')) return -1;
      if (field === 'name' && sc.label) return -1;
    }
    return top.i;
  };
  // A column only counts by its content when there is enough of it: two
  // notes that happen to read like names ("Doesnt like vesting") are not the
  // name column beside four hundred names. Between columns that qualify, the
  // fuller one wins.
  const most = Math.max(1, ...scores.map((s) => s.filled));
  const byContent = (key, min) => {
    let best = -1, bestScore = 0;
    scores.forEach((s, i) => {
      if (taken.has(i) || s.filled < 1 || s[key] < min) return;
      if (most >= 10 && s.filled < most * 0.2) return;
      const score = s[key] * (0.5 + 0.5 * Math.min(1, s.filled / most));
      if (score > bestScore) { best = i; bestScore = score; }
    });
    return best;
  };

  // Email first: a column that is plainly addresses is the email column
  // whatever its header says ("Contact", "Account", "Username"); of several,
  // the one holding the most addresses.
  // Among several address columns an exact "Email"-type header wins, then
  // the fuller column ("Work Email" with 40 addresses over "Personal Email" with 3).
  // A column headed as someone's other address is never the one to write to.
  const OTHER_ADDRESS = /other|alternate|additional|secondary|tertiary|^e?mail[2-9]|e?mail[2-9]$|email[2-9]value/;
  const emailRank = (i) => {
    const h = norm(headers[i]);
    if (OTHER_ADDRESS.test(h) || SYNONYMS.altEmails.includes(h)) return -1000 + Math.min(scores[i].emailCount, 5000) / 5000;
    const exact = SYNONYMS.email.includes(h) ? 100 : (SYNONYMS.email.some((x) => headerMatches(h, x)) ? 10 : 0);
    return exact + Math.min(scores[i].emailCount, 5000) / 5000;
  };
  let emailByContent = -1;
  scores.forEach((sc, i) => {
    if (sc.email >= 0.8 && sc.emailCount >= 2 && (emailByContent < 0 || emailRank(i) > emailRank(emailByContent))) emailByContent = i;
  });
  if (emailByContent >= 0) {
    set('email', emailByContent, synonymHits(headers[emailByContent]) ? 'header' : 'content');
  } else {
    const i = byHeader('email');
    if (i >= 0) set('email', i, 'header'); else set('email', byContent('email', 0.5), 'content');
  }
  // The parts of a place before the place itself: "State/Region" is the
  // state, not a whole location that happens to say "region".
  for (const f of ['altEmails', 'firstName', 'lastName', 'name', 'phone', 'role', 'company', 'city', 'state', 'zip', 'location', 'notes', 'pastRoles']) {
    const i = byHeader(f);
    if (i >= 0) set(f, i, 'header'); else map[f] = -1;
  }
  // First/last name columns plus a "name" column that does not hold names
  // (HubSpot's "Contact owner"): the split columns win.
  // A second column of the person's own addresses ("E-mail 2 Address",
  // "Personal Email" beside "Work Email", "Tertiary Email"): their other
  // addresses — never a referrer's, a manager's or a relative's.
  if (map.altEmails < 0 && map.email >= 0) {
    let best = -1;
    scores.forEach((sc, i) => {
      const h = norm(headers[i]);
      if (taken.has(i) || sc.email < 0.8 || !/mail/.test(h) || EXCLUDE.altEmails.some((w) => h.includes(w))) return;
      if (best < 0 || sc.emailCount > scores[best].emailCount) best = i;
    });
    if (best >= 0) set('altEmails', best, 'content');
  }
  if (map.name >= 0 && (map.firstName >= 0 || map.lastName >= 0) && scores[map.name].filled >= 3 && scores[map.name].name < 0.5) {
    taken.delete(map.name); map.name = -1; delete confidence.name;
  }
  if (map.phone < 0) set('phone', byContent('phone', 0.6), 'content');
  if (map.name < 0 && map.firstName < 0 && map.lastName < 0) set('name', byContent('name', 0.6), 'content');
  // A place in one column ("Austin, TX") or in parts: a lone City or State
  // column (one that holds "City, ST" itself, say) is the location; with
  // both, they are put together.
  if (map.location < 0 && (map.city >= 0) !== (map.state >= 0) && map.zip < 0) {
    const only = map.city >= 0 ? 'city' : 'state';
    set('location', map[only], confidence[only]);
    delete confidence[only];
    map[only] = -1;
  }
  if (map.location < 0 && map.city < 0 && map.state < 0) set('location', byContent('location', 0.5), 'content');
  // Columns with no header, of free text nobody else claimed — "start here
  // 3/3", a recruiter's name beside "Doesnt like vesting" — are notes, the
  // fullest first.
  const unlabeled = (i) => !norm(headers[i]) || /^column\d+$/.test(norm(headers[i]));
  const noteish = scores.map((s, i) => ({ s, i }))
    .filter(({ s, i }) => !taken.has(i) && unlabeled(i) && s.filled >= 1 && s.filled < Math.max(2, rows.length * 0.3) && s.text >= 0.6 && s.email < 0.2 && s.phone < 0.2 && s.date < 0.5)
    .sort((a, b) => b.s.filled - a.s.filled);
  for (const f of ['notes', 'notes2']) {
    if (map[f] >= 0) continue;
    const next = noteish.find(({ i }) => !taken.has(i));
    if (next) set(f, next.i, 'guess'); else map[f] = -1;
  }
  // One leftover text column with no useful header is most often the company.
  if (map.company < 0) {
    const leftovers = scores
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => !taken.has(i) && s.filled >= Math.max(1, rows.length * 0.3) && s.text >= 0.7 && s.date < 0.3 && s.location < 0.5 && !s.label);
    const unnamed = leftovers.filter(({ i }) => !norm(headers[i]) || /^column\d+$/.test(norm(headers[i])) || /(company|employer|org)/.test(norm(headers[i])));
    if (unnamed.length === 1 && leftovers.length === 1) set('company', unnamed[0].i, 'guess');
  }
  return { mapping: map, confidence };
}

module.exports = { parseCsv, sniffDelimiter, guessMapping, findHeader, headerContinuation, looksLikeHeader, scoreColumn, cleanCell, splitLastFirst, synonymHits, isPlaceholder, dataLooking, NAME_SUFFIX, MAX_COLUMNS };
