// Shared set-up for the Candidates-page tests (candidates-*.test.js).
//
// A crafted team of 150 made-up people (example.com addresses, 555 numbers)
// laid out so every filter on the page has something to find: every stage,
// a spread of industries and roles, numbers that can be texted, numbers that
// cannot (the fictional 555-01xx block) and no number at all, people texted
// today / this week / earlier, Sales IQ at every step and tier, Onboarding
// docs at every stage. Everything is deterministic and relative to "now", so
// the counts below hold on any day.
//
// Nothing here may reach the outside world: every module that would (Gmail,
// the mailer, ntfy, Calendly, Apollo, the reply checker) is answered locally,
// and the test process's own fetch refuses any host but localhost — the
// attempt is recorded, and each test file checks that none was made.
const { R, startApp, ago } = require('./helpers');

const FIRST = ['Avery', 'Blair', 'Cameron', 'Dana', 'Emerson', 'Finley', 'Greer', 'Harper', 'Indigo', 'Jules', 'Kendall', 'Logan', 'Morgan', 'Noel', 'Oakley'];
const LAST = ['Quill', 'Rowan', 'Sable', 'Thorne', 'Underhill', 'Vance', 'Whitlock', 'Yarrow', 'Zephyr', 'Ashdown'];

// role, company, pastRoles — and the industry the server files them under.
const ROLES = [
  ['Merchant Services Consultant', 'Harborline Payments', ''],     // payments
  ['Account Executive', 'Northwind Logistics', ''],                // b2b
  ['Solar Consultant', 'Brightfield Solar', ''],                   // solar
  ['Inside Sales Associate', 'Maple Office Supply', ''],           // weak
  ['Alarm Systems Rep', 'Keystone Alarm Co', ''],                  // security
  ['Insurance Agent', 'Cedar Mutual', ''],                         // insurance
  ['Car Sales Consultant', 'Riverbend Motors', ''],                // auto
  ['account executive', 'Bluepeak Software', ''],                  // b2b — same role as #1, written differently
  ['Server', 'Corner Diner', ''],                                  // other, and no sales background
  ['Timeshare Sales Agent', 'Seaside Resorts', ''],                // timeshare
  ['', '', ''],                                                    // nothing on file
  ['Roofing Sales Rep', 'Summit Roofing', ''],                     // home
  ['Pest Control Sales', 'Greenleaf Pest Control', ''],            // pest
  ['Fiber Sales Rep', 'Lightwave Fiber', ''],                      // telecom
  ['Small Business Consultant', 'Mainstreet Advisors', ''],        // smb
  ['Office Manager', 'Dental Partners', 'Solar Consultant | Door to door sales'],   // solar, from their history
];
const LOCATIONS = ['Springfield, IL', 'Boston, MA', 'Austin, TX'];
const SUBJECT = 'Open to a new sales role?';

const pad = (n, w) => String(n).padStart(w, '0');

// Group order: [status, how many, id prefix, phone kind for the j-th of them].
const GROUPS = [
  ['new', 40, 'n', (j) => (j % 4 === 0 ? 'none' : j % 4 === 1 ? 'bad' : 'ok')],
  ['emailed', 60, 'e', (j) => (j % 6 === 0 ? 'none' : j % 6 === 1 ? 'bad' : 'ok')],
  ['replied', 15, 'r', (j) => (j % 5 === 0 ? 'bad' : j === 1 || j === 6 ? 'none' : 'ok')],
  ['booked', 10, 'b', (j) => (j % 5 === 0 ? 'none' : 'ok')],
  ['declined', 10, 'd', (j) => (j % 5 <= 1 ? 'none' : 'ok')],
  ['bounced', 15, 'x', (j) => (j % 5 === 0 ? 'none' : 'ok')],
];

// The same number written four ways, as a spreadsheet would hand them over.
function okPhone(g) {
  const line = `2${pad(g, 3)}`;
  switch (g % 4) {
    case 0: return `(617) 555-${line}`;
    case 1: return `617.555.${line}`;
    case 2: return `+1 617 555 ${line}`;
    default: return `617555${line}`;
  }
}

// Minutes ago someone was added: ten today, twenty more this week, forty more
// this month, forty more within 90 days, and forty older than that. Each is
// distinct, so "Newest first" has exactly one right answer.
function addedMinutesAgo(g) {
  const p = (g * 53) % 150;
  const day = 1440;
  if (p < 10) return 30 + p * 60;
  if (p < 30) return Math.round((1.5 + (p - 10) * 0.25) * day);
  if (p < 70) return Math.round((8 + (p - 30) * 0.5) * day);
  if (p < 110) return Math.round((32 + (p - 70) * 1.4) * day);
  return Math.round((95 + (p - 110) * 5) * day);
}

function buildPeople() {
  const out = [];
  let g = 0;
  let bad = 0;
  for (const [status, n, prefix, phoneKind] of GROUPS) {
    for (let j = 0; j < n; j++, g++) {
      const id = `${prefix}${pad(j + 1, 2)}`;
      const first = FIRST[g % 15];
      const last = LAST[Math.floor(g / 15)];
      const [role, company, pastRoles] = ROLES[g % 16];
      const kind = phoneKind(j);
      const c = {
        id,
        name: `${first} ${last}`, firstName: first, lastName: last,
        email: `${first}.${last}.${id}@example.com`.toLowerCase(),
        phone: kind === 'ok' ? okPhone(g) : kind === 'bad' ? `(617) 555-01${pad(bad++, 2)}` : '',
        role, company, pastRoles,
        location: LOCATIONS[g % 3],
        notes: g % 10 === 0 ? 'Met at the spring job fair' : '',
        source: g % 25 === 0 ? 'manual' : 'csv',
        status,
        addedAt: ago(addedMinutesAgo(g)),
        lastEmailedAt: null,
        bookedAt: null,
      };
      if (status !== 'new') {
        c.lastEmailedAt = ago(180 + g * 7);
        c.lastSubject = SUBJECT;
        c.gmailThreadId = `thread-${id}`;
      }
      if (status === 'emailed') {
        if (j % 3 === 0) c.followUpCount = 2;
        if (j % 4 === 1) c.openedAt = ago(5 * 1440);
      }
      if (status === 'replied') {
        c.lastReplyAt = ago(120 + j);
        c.replies = [{ id: `reply-${id}`, from: c.email, date: c.lastReplyAt, text: 'Sounds interesting, tell me more.' }];
        c.emailUnread = j % 2 === 0;
      }
      if (status === 'bounced') {
        c.replies = [{ id: `bounce-${id}`, from: 'mailer-daemon@example.com', date: ago(100), text: 'Address not found', kind: 'bounce' }];
      }
      if (status === 'booked') {
        c.bookedAt = ago(-2 * 1440 - j * 60);
        c.bookedEvent = 'Intro call';
        c.bookedJoinUrl = `https://example.com/join/${id}`;
      }
      out.push(c);
    }
  }
  const byId = Object.fromEntries(out.map((c) => [c.id, c]));
  // Texted: three today, three this week, two earlier (one has no iMessage).
  const texted = [['e03', 60, 'delivered'], ['e04', 90, 'read'], ['e05', 120, 'sent'],
    ['e06', 3 * 1440, 'delivered'], ['e09', 3 * 1440 + 10, 'delivered'], ['e10', 3 * 1440 + 20, 'delivered'],
    ['e11', 20 * 1440, 'delivered'], ['e12', 20 * 1440 + 5, 'not-imessage']];
  for (const [id, mins, st] of texted) {
    const c = byId[id];
    c.lastTextedAt = ago(mins);
    c.textStatus = st;
    c.textThread = [{ dir: 'out', ts: c.lastTextedAt, text: 'Hi, are you open to a new sales role?' }];
    if (st === 'delivered' || st === 'read') c.textDeliveredAt = ago(mins - 1);
    if (st === 'read') c.textReadAt = ago(mins - 2);
  }
  for (const id of ['r03', 'r04']) {
    const c = byId[id];
    c.lastTextedAt = ago(300);
    c.textStatus = 'replied';
    c.textRepliedAt = ago(240);
    c.textUnread = id === 'r03';
    c.textThread = [{ dir: 'out', ts: c.lastTextedAt, text: 'Hi, are you open to a new sales role?' }, { dir: 'in', ts: c.textRepliedAt, text: 'Yes, call me tomorrow' }];
  }
  // Said no in their own words, without the word STOP.
  byId.e15.notes = 'Please remove me from your list';
  // Somebody with an email and nothing else.
  Object.assign(byId.n40, { name: '', firstName: '', lastName: '', email: 'no.name.n40@example.com' });
  // One of the team's own people, who never goes to Sales IQ or Onboarding docs.
  byId.e40.email = 'e40.teammate@wholesalepayments.com';

  // Storage order is neither the group order nor any sort the page offers.
  const stored = new Array(out.length);
  out.forEach((c, i) => { stored[(i * 37) % out.length] = c; });
  return stored;
}

// Sales IQ, stored the way the app stores it (lib/salesiq.js records).
function iqRecords(people) {
  const by = Object.fromEntries(people.map((c) => [c.id, c]));
  const rec = (n, id, status, extra = {}) => ({ id: `siq${pad(n, 3)}`, name: by[id] ? by[id].name : 'Someone Else', email: by[id] ? by[id].email : '', phone: '', status, added: ago(500), source: 'pipeline', crmId: id, ...extra });
  return [
    rec(1, 'e20', 'completed', { score: 92 }),
    rec(2, 'e21', 'completed', { score: 78 }),
    rec(3, 'r05', 'completed', { score: 61 }),
    rec(4, 'b03', 'completed', { score: 40 }),
    rec(5, 'b04', 'completed', { score: 88 }),
    rec(6, 'e22', 'invited'),
    rec(7, 'e23', 'invited'),
    rec(8, 'n05', 'invited'),
    rec(9, 'n06', 'added'),
    rec(10, 'n07', 'added'),
    rec(11, 'd03', 'added'),
    // Known to Sales IQ under another address, matched by their id here.
    rec(12, 'e24', 'invited', { email: 'other.address.e24@example.com' }),
    // Listed twice: the furthest they got is what counts.
    rec(13, 'e25', 'added'),
    rec(14, 'e25', 'completed', { score: 72, crmId: undefined }),
    // Not on the Candidates list at all.
    { id: 'siq015', name: 'Nobody Here', email: 'nobody.here@example.com', phone: '', status: 'added', added: ago(500), source: 'manual' },
  ];
}

// Onboarding docs, stored the way the app stores it (lib/onboarding.js).
function onbRecords(people) {
  const by = Object.fromEntries(people.map((c) => [c.id, c]));
  const cand = (id) => ({
    id: `hire-${id}`, local: true, appliedDate: '2026-09-01', startDate: '',
    applicant: { firstName: by[id].firstName, lastName: by[id].lastName, email: by[id].email, phoneNumber: by[id].phone },
    job: { title: { label: 'Account Executive' } }, status: { id: 'local', label: 'Added' }, crmId: id, savedAt: ago(400),
  });
  const send = (id, simulated = false) => ({ id: by[id].email, email: by[id].email, firstName: by[id].firstName, lastName: by[id].lastName, jobTitle: 'Account Executive', documents: ['Offer letter'], sentAt: ago(300), simulated });
  const hire = (id) => ({ id: `ref-${id}`, reference: `ref-${id}`, firstName: by[id].firstName, lastName: by[id].lastName, email: by[id].email, signedAt: ago(200), documents: ['Offer letter'] });
  return {
    candidates: ['n10', 'e30', 'e31', 'e32', 'e33', 'e34', 'b05', 'b06'].map(cand),
    // e34's "send" went nowhere (email was not set up): still just on the pipeline.
    sends: [send('e32'), send('e33'), send('e34', true), send('b05'), send('b06')],
    // b07 signed without ever being on the pipeline list.
    hires: [hire('b05'), hire('b06'), hire('b07')],
  };
}

// Who is on Sales IQ and Onboarding docs, by their id here.
const IQ_IDS = ['e20', 'e21', 'r05', 'b03', 'b04', 'e22', 'e23', 'n05', 'n06', 'n07', 'd03', 'e24', 'e25'];
const ONB_IDS = ['n10', 'e30', 'e31', 'e32', 'e33', 'e34', 'b05', 'b06', 'b07'];
// Whether a number can be texted, by how the fixture made it.
const phoneKind = (c) => (!c.phone ? 'none' : /555-01\d\d$/.test(c.phone) ? 'bad' : 'ok');

// What the fixture adds up to — the numbers the page must show. Worked out
// by hand from the layout above, not by asking the app.
const EXPECT = {
  total: 150,
  stage: { new: 40, emailed: 60, replied: 15, booked: 10, declined: 10, bounced: 15 },
  needsNumber: 54,
  textedToday: 5, textedWeek: 8, textedAny: 10, neverTexted: 140,
  added: { 1: 10, 7: 30, 30: 70, 90: 110, old: 40 },
  iq: { any: 13, none: 137, added: 3, invited: 4, completed: 6, elite: 2, strong: 2, develop: 1, notready: 1 },
  onb: { any: 9, none: 141, pipeline: 4, sent: 2, signed: 3 },
};

// Anything that would leave the machine is answered here instead, and the
// process's own fetch refuses any host but this one.
const outside = [];
function guardOutside() {
  const realFetch = global.fetch;
  if (!realFetch.__guarded) {
    const guarded = (url, opts) => {
      const u = new URL(typeof url === 'string' ? url : (url && url.url) || String(url));
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return realFetch(url, opts);
      outside.push(String(u));
      return Promise.reject(new Error(`test: refused a call to ${u.host}`));
    };
    guarded.__guarded = true;
    global.fetch = guarded;
  }
  const mailer = require(R('lib/mailer.js'));
  mailer.sendEmail = async (...a) => { outside.push(`mailer.sendEmail ${JSON.stringify(a[0] && a[0].to)}`); throw new Error('test: no email is sent'); };
  const google = require(R('lib/google.js'));
  google.gmailSend = async () => { outside.push('google.gmailSend'); throw new Error('test: no email is sent'); };
  google.getSignature = async () => '';
  require(R('lib/notify.js')).pushToPhone = async () => { outside.push('notify.pushToPhone'); return false; };
  const calendly = require(R('lib/calendly.js'));
  calendly.listInterviews = async () => { outside.push('calendly.listInterviews'); throw new Error('test: no Calendly'); };
  calendly.registerWebhook = async () => { outside.push('calendly.registerWebhook'); throw new Error('test: no Calendly'); };
  const apollo = require(R('lib/apollo.js'));
  apollo.search = async () => { outside.push('apollo.search'); throw new Error('test: no Apollo'); };
  apollo.enrich = async () => { outside.push('apollo.enrich'); throw new Error('test: no Apollo'); };
  require(R('lib/replies.js')).checkReplies = async () => ({ ok: true, checked: 0, replies: 0 });
}

// The app, signed in, holding the crafted team.
async function startCandidates(offset) {
  const s = await startApp({ offset });
  guardOutside();
  const people = buildPeople();
  await s.store.update((d) => { d.candidates = people.map((c) => ({ ...c })); });
  await require(R('lib/salesiq.js')).update((doc) => { doc.candidates = iqRecords(people); });
  const onb = onbRecords(people);
  await require(R('lib/onboarding.js')).update((doc) => { Object.assign(doc, onb); });
  return { ...s, people, byId: Object.fromEntries(people.map((c) => [c.id, c])) };
}

// ---- reading the page the way a person does ----

// The names on the rows on screen, top to bottom.
const rowNames = (page) => page.$$eval('#candidateRows tr', (trs) => trs.map((tr) => tr.querySelector('.cand-name').textContent.trim()));
const rowIds = (page) => page.$$eval('#candidateRows tr', (trs) => trs.map((tr) => tr.dataset.id));
// Each pill's label, number and whether it is lit.
const pills = (page) => page.$$eval('#candViews .view-pill', (bs) => bs.map((b) => ({
  label: b.firstChild.textContent.trim(), n: b.querySelector('.view-n').textContent.trim(), on: b.classList.contains('on'),
})));
const options = (page, sel) => page.$$eval(`${sel} option`, (os) => os.map((o) => o.textContent.trim()));
const text = (page, sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim());
const visible = (page, sel) => page.$eval(sel, (el) => Boolean(el.offsetParent || el.getClientRects().length) && getComputedStyle(el).display !== 'none' && !el.hidden).catch(() => false);
const toasts = (page) => page.$$eval('#toasts .toast', (ts) => ts.map((t) => ({ text: t.textContent, err: t.classList.contains('err') })));

// Wait until fn(page) passes (or time out and return the last value).
async function until(page, fn, { timeout = 8000, every = 50 } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn(page);
    if (last) return last;
    if (Date.now() > end) return last;
    await page.waitForTimeout(every);
  }
}

// Wait until fn(page) reads as `want` (compared as JSON), and return what it
// last read — so a check never depends on how soon the page redraws.
async function settle(page, fn, want, opts) {
  const w = JSON.stringify(want);
  let last;
  const got = await until(page, async () => { last = await fn(page); return JSON.stringify(last) === w; }, opts);
  if (!got) console.log(`(waited for ${w.slice(0, 120)}, page still says ${JSON.stringify(last).slice(0, 200)})`);
  return last;
}

// The Candidates page, drawn.
async function openCandidates(page) {
  await page.evaluate(() => { const el = document.querySelector('.nav-item[data-view="candidates"]'); if (el) el.click(); });
  await page.waitForFunction(() => document.querySelector('#view-candidates.active') && /\d/.test(document.querySelector('#candCount').textContent));
}

// The add/edit window puts the cursor in its first field (or the number) a
// moment after it opens; type only once it has, as a person would. On a
// laptop the first field is focused twice — as the window opens, and again
// (selecting what is in it) 40 ms later — so seeing the cursor there is not
// enough: a field filled in between had its text land in the first field
// instead. Timers run in the order they fall due, so one set in the page now,
// for later than that, runs after the window's own; wait it out, then check.
async function focused(page, id) {
  const there = (x) => document.activeElement && document.activeElement.id === x;
  await page.waitForFunction(there, id);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 250)));
  await page.waitForFunction(there, id);
}

// A count shown as "n of total" or "N candidates".
const countText = (page) => text(page, '#candCount');

module.exports = {
  buildPeople, iqRecords, onbRecords, EXPECT, IQ_IDS, ONB_IDS, phoneKind, ROLES, SUBJECT, outside, guardOutside, startCandidates,
  rowNames, rowIds, pills, options, text, visible, toasts, until, settle, openCandidates, countText, focused,
};
