// Apollo.io: find sales people who match a hiring profile and reveal their
// work email, so candidates can be added to the list without a spreadsheet.
//
// Two very different costs, kept apart on purpose:
//   search  — free. Says how many people match and shows a sample.
//   enrich  — one Apollo credit per revealed email, and the credit is spent
//             whether or not the person ever replies.
// The dashboard therefore always searches first, shows the number, and only
// enriches the batch the user explicitly asks for.
const address = require('./email-address');

const BASE = 'https://api.apollo.io/api/v1';
const ENRICH_BATCH = 10;        // Apollo's own limit for people/bulk_match
const MAX_PER_PULL = 200;       // one click can never spend more than this many credits
const PER_PAGE = 100;
const TIMEOUT_MS = 8000;

const clean = (v) => String(v == null ? '' : v).trim();
const list = (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(','))
  .map((x) => clean(x))
  .filter(Boolean)
  .slice(0, 25);

function apiKey(settings) {
  const key = clean(settings && settings.apolloApiKey);
  if (!key) {
    const e = new Error('Add your Apollo API key in Settings first (Apollo → Settings → Integrations → API keys).');
    e.status = 400;
    throw e;
  }
  return key;
}

async function call(path, key, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'cache-control': 'no-cache',
        'x-api-key': key,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Apollo did not answer in time — try again in a moment.');
    throw new Error(`Could not reach Apollo: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const detail = (data && (data.error || data.error_message || data.message)) || text.slice(0, 200);
    // Apollo answers 403 both for a wrong key and for a good key on a plan
    // that does not sell API access. Those need very different fixes, so say
    // which one it is instead of sending someone to check a key that is fine.
    if (res.status === 403 && /not included in your|not accessible|upgrade your plan|upgrade to/i.test(detail)) {
      const e = new Error(`Your Apollo key is fine, but your Apollo plan does not include this part of their API. ${detail} `
        + 'Until the plan is upgraded, add candidates by importing a CSV exported from Apollo instead.');
      e.planUpgrade = true;
      e.status = 400;
      throw e;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Apollo refused the API key (${res.status}). Copy it again from Apollo → Settings → Integrations → API. ${detail || ''}`.trim());
    }
    if (res.status === 429) throw new Error('Apollo is rate limiting this key — wait a minute and try again.');
    if (res.status === 422) throw new Error(`Apollo rejected the search: ${detail || 'check the titles and locations.'}`);
    throw new Error(`Apollo returned ${res.status}: ${detail || 'unknown error'}`);
  }
  return data || {};
}

// What the dashboard asks for, in the shape Apollo expects.
function criteria(input = {}) {
  const months = (v, dflt) => {
    const n = Number(clean(v));
    return Number.isFinite(n) && n >= 0 && n <= 240 ? Math.round(n) : dflt;
  };
  const minMonths = months(input.minMonthsInRole, 12);
  const maxMonths = Math.max(minMonths, months(input.maxMonthsInRole, 30));
  return {
    titles: list(input.titles),
    locations: list(input.locations),
    keywords: list(input.keywords),
    minMonths,
    maxMonths,
  };
}

function searchBody(c, page) {
  const body = {
    page: Math.max(1, Number(page) || 1),
    per_page: PER_PAGE,
    contact_email_status: ['verified'],
  };
  if (c.titles.length) body.person_titles = c.titles;
  if (c.locations.length) body.person_locations = c.locations;
  if (c.keywords.length) body.q_organization_keyword_tags = c.keywords;
  if (c.minMonths || c.maxMonths) {
    body.person_days_in_current_title_range = { min: Math.round(c.minMonths * 30), max: Math.round(c.maxMonths * 30) };
  }
  return body;
}

// Free: how many people match, plus ids and a sample to show before spending.
async function search(settings, input, { page = 1 } = {}) {
  const key = apiKey(settings);
  const c = criteria(input);
  if (!c.titles.length && !c.keywords.length) throw new Error('Give at least one job title or industry keyword to search for.');
  const data = await call('/mixed_people/search', key, searchBody(c, page));
  const people = Array.isArray(data.people) ? data.people : [];
  const pag = data.pagination || {};
  return {
    total: Number(pag.total_entries != null ? pag.total_entries : data.total_entries) || people.length,
    page: Number(pag.page || page),
    pages: Number(pag.total_pages || 1),
    ids: people.map((p) => clean(p.id)).filter(Boolean),
    sample: people.slice(0, 8).map((p) => ({
      title: clean(p.title),
      company: clean((p.organization && p.organization.name) || p.organization_name),
    })),
  };
}

// Costs one credit per revealed email. Callers pass at most MAX_PER_PULL ids
// and are told exactly how many credits Apollo reported spending.
async function enrich(settings, ids) {
  const key = apiKey(settings);
  const wanted = (Array.isArray(ids) ? ids : []).map(clean).filter((id) => /^[a-f0-9]{24}$/.test(id));
  if (!wanted.length) throw new Error('No Apollo records were selected.');
  if (wanted.length > MAX_PER_PULL) throw new Error(`Enrich at most ${MAX_PER_PULL} people at a time.`);
  const matches = [];
  let credits = 0;
  for (let i = 0; i < wanted.length; i += ENRICH_BATCH) {
    const data = await call('/people/bulk_match', key, { details: wanted.slice(i, i + ENRICH_BATCH).map((id) => ({ id })) });
    for (const m of (Array.isArray(data.matches) ? data.matches : [])) if (m) matches.push(m);
    credits += Number(data.credits_consumed) || 0;
  }
  return { matches, credits };
}

// One Apollo record as the import pipeline expects a row's fields.
function toRow(match) {
  const org = (match && match.organization) || {};
  const past = [];
  for (const job of (match && match.employment_history) || []) {
    if (!job || job.current) continue;
    const title = clean(job.title);
    if (!title) continue;
    const where = clean(job.organization_name);
    const label = where ? `${title} at ${where}` : title;
    if (!past.includes(label)) past.push(label);
  }
  const firstName = clean(match && match.first_name);
  const lastName = clean(match && match.last_name);
  return {
    email: address.normalize(match && match.email),
    name: clean(match && match.name) || [firstName, lastName].filter(Boolean).join(' '),
    firstName,
    lastName,
    role: clean(match && match.title),
    company: clean(org.name),
    phone: '',
    location: [clean(match && match.city), clean(match && match.state)].filter(Boolean).join(', '),
    pastRoles: past.slice(0, 6).join(' | '),
    notes: '',
  };
}

// Rows worth importing: a real address, and never a colleague at our own
// company (their address is on the same domain we send from).
function toRows(matches, { ownDomain = '', ownCompany = '' } = {}) {
  const domain = clean(ownDomain).toLowerCase();
  const company = clean(ownCompany).toLowerCase();
  const rows = [];
  const skipped = { noEmail: 0, ownCompany: 0 };
  for (const m of matches || []) {
    const row = toRow(m);
    if (!row.email) { skipped.noEmail += 1; continue; }
    const sameDomain = domain && row.email.toLowerCase().endsWith(`@${domain}`);
    const sameCompany = company && row.company.toLowerCase() === company;
    if (sameDomain || sameCompany) { skipped.ownCompany += 1; continue; }
    rows.push(row);
  }
  return { rows, skipped };
}

module.exports = { search, enrich, toRow, toRows, criteria, MAX_PER_PULL, ENRICH_BATCH, PER_PAGE };
