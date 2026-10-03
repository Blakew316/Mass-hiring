// A made-up team the size of the live one, for measuring speed: 32,667 people
// with the mix of activity a few weeks of outreach leaves behind (emails,
// opens, replies, bounces, text threads, bookings, feed lines, interviews).
// Nobody in it is real. Deterministic, so two runs build the same list.
//   ROOT=<repo> N=32667 node tests/perf/fixture.js <out-dir>
// writes <out-dir>/ as a copy of ROOT/data holding that team ("maverick").
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(process.env.ROOT || path.join(__dirname, '../..'));
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'fixture-data'));
const N = Number(process.env.N || 32667);
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'perf-pw';
require(path.join(ROOT, 'lib/tenant.js')).adopt('maverick');
fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
const store = require(path.join(ROOT, 'lib/store.js'));

let seed = 20261002;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const FIRST = 'James Mary Robert Patricia John Jennifer Michael Linda David Elizabeth William Barbara Richard Susan Joseph Jessica Thomas Sarah Christopher Karen Charles Lisa Daniel Nancy Matthew Betty Anthony Sandra Mark Margaret Donald Ashley Steven Kimberly Andrew Emily Paul Donna Joshua Michelle Kenneth Carol Kevin Amanda Brian Melissa George Deborah Timothy Stephanie Ronald Dorothy Jason Rebecca Edward Sharon Jeffrey Laura Ryan Cynthia Jacob Amy Gary Kathleen Nicholas Angela Eric Shirley Jonathan Brenda Stephen Emma Larry Anna Justin Pamela Scott Nicole Brandon Samantha Benjamin Katherine Samuel Christine Gregory Helen Alexander Debra Patrick Rachel Frank Carolyn Raymond Janet Jack Maria Dennis Catherine Jerry Heather Tyler Diane Aaron Olivia Jose Julie Adam Joyce Nathan Victoria Henry Ruth Zachary Virginia Douglas Lauren Peter Kelly Kyle Christina Noah Joan Ethan Evelyn Jeremy Judith Walter Andrea Christian Hannah Keith Megan Roger Cheryl Terry Jacqueline Austin Martha Sean Madison Gerald Teresa Carl Gloria Harold Sara Dylan Janice Arthur Ann Lawrence Kathryn Jordan Abigail Jesse Sophia Bryan Frances Billy Jean Bruce Alice Gabriel Judy Joe Isabella Logan Julia Alan Grace Juan Amber Albert Denise Willie Danielle Elijah Marilyn Wayne Beverly Randy Charlotte Vincent Natalie Mason Theresa Roy Diana Ralph Brittany Bobby Doris Russell Kayla Bradley Alexis Philip Lori Eugene Marie'.split(' ');
const LAST = 'Smith Johnson Williams Brown Jones Garcia Miller Davis Rodriguez Martinez Hernandez Lopez Gonzalez Wilson Anderson Thomas Taylor Moore Jackson Martin Lee Perez Thompson White Harris Sanchez Clark Ramirez Lewis Robinson Walker Young Allen King Wright Scott Torres Nguyen Hill Flores Green Adams Nelson Baker Hall Rivera Campbell Mitchell Carter Roberts Gomez Phillips Evans Turner Diaz Parker Cruz Edwards Collins Reyes Stewart Morris Morales Murphy Cook Rogers Gutierrez Ortiz Morgan Cooper Peterson Bailey Reed Kelly Howard Ramos Kim Cox Ward Richardson Watson Brooks Chavez Wood James Bennett Gray Mendoza Ruiz Hughes Price Alvarez Castillo Sanders Patel Myers Long Ross Foster Jimenez Powell Jenkins Perry Russell Sullivan Bell Coleman Butler Henderson Barnes Gonzales Fisher Vasquez Simmons Romero Jordan Patterson Alexander Hamilton Graham Reynolds Griffin Wallace Moreno West Cole Hayes Bryant Herrera Gibson Ellis Tran Medina Aguilar Stevens Murray Ford Castro Marshall Owens Harrison Fernandez McDonald Woods Washington Kennedy Wells Vargas Henry Chen Freeman Webb Tucker Guzman Burns Crawford Olson Simpson Porter Hunter Gordon Mendez Silva Shaw Snyder Mason Dixon Munoz Hunt Hicks Holmes Palmer Wagner Black Robertson Boyd Rose Stone Salazar Fox Warren Mills Meyer Rice Schmidt Garza Daniels Ferguson Nichols Stephens Soto Weaver Ryan Gardner Payne Grant Dunn Kelley Spencer Hawkins Arnold Pierce Vazquez Hansen Peters Santos Hart Bradley Knight Elliott Cunningham Duncan Armstrong Hudson Carroll Lane Riley Andrews Alvarado Ray Delgado Berry Perkins Hoffman Johnston Matthews Pena Richards Contreras Willis Carpenter Lawrence Sandoval'.split(' ');
const CITIES = ['Houston, TX', 'Dallas, TX', 'Austin, TX', 'San Antonio, TX', 'Phoenix, AZ', 'Tampa, FL', 'Orlando, FL', 'Miami, FL', 'Atlanta, GA', 'Charlotte, NC', 'Raleigh, NC', 'Nashville, TN', 'Denver, CO', 'Las Vegas, NV', 'Chicago, IL', 'Columbus, OH', 'Indianapolis, IN', 'Detroit, MI', 'Boston, MA', 'New York, NY', 'Philadelphia, PA', 'Pittsburgh, PA', 'Baltimore, MD', 'Richmond, VA', 'Seattle, WA', 'Portland, OR', 'San Diego, CA', 'Los Angeles, CA', 'Sacramento, CA', 'Salt Lake City, UT', 'Kansas City, MO', 'St. Louis, MO', 'Minneapolis, MN', 'Milwaukee, WI', 'Louisville, KY', 'Birmingham, AL', 'New Orleans, LA', 'Oklahoma City, OK', 'Albuquerque, NM', 'Boise, ID', ''];
const COMPANIES = ['', '', '', '', 'Elavon', 'Heartland Payment Systems', 'Global Payments', 'Fiserv', 'Worldpay', 'Paysafe', 'North American Bancard', 'TSYS', 'Clover', 'Square', 'Stripe', 'Wells Fargo Merchant Services', 'Bank of America Merchant Services', 'Chase Merchant Services', 'Payroc', 'Shift4', 'Nuvei', 'EVO Payments', 'Moneris', 'Priority Payments', 'Merchant Lynx', 'ADP', 'Paychex', 'Cintas', 'Comcast Business', 'Spectrum Business', 'Yelp', 'Vector Marketing'];
const ROLES = ['', '', '', 'Account Executive', 'Outside Sales Representative', 'Inside Sales Representative', 'Business Development Manager', 'Merchant Services Consultant', 'Sales Manager', 'Territory Manager', 'Relationship Manager', 'Retail Sales Associate', 'Customer Success Manager', 'Sales Development Representative', 'Independent Sales Agent', 'Insurance Agent', 'Real Estate Agent', 'Store Manager', 'Server', 'Recruiter'];
const NOTE_BITS = ['Applied Sep 12, 2026', 'applied for B2B Account Executive', 'LinkedIn: linkedin.com/in/someone', 'From: BambooHR applicants', 'Recruiting Monster/Jennifer: lm', 'vm/ni', 'left vm', 'cb after 5', 'Not interested (recruiter note)', 'In pipeline (handed to a WPI manager)', 'team Ice', 'From: New Purchase Industry List', 'wants base salary', 'has 10 yrs merchant services', 'sent to susan', 'appt 8/13 at 10:30 am', 'From: Recruiting Monster (Ceceila), Recruiting Monster (Jennifer)', 'Apple relay email (may not accept outside mail) — text instead'];
const DOMAINS = ['gmail.com', 'gmail.com', 'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com', 'comcast.net'];
const ago = (h) => new Date(Date.UTC(2026, 9, 2, 12) - h * 3600e3).toISOString();
const SUBJECT = 'Hiring B2B Account Executives — remote, uncapped commission';

(async () => {
  const db = await store.load();
  const used = new Set();
  db.candidates = Array.from({ length: N }, (_, i) => {
    const first = pick(FIRST); const last = pick(LAST);
    let email = `${first}.${last}${Math.floor(rnd() * 9999)}@${pick(DOMAINS)}`.toLowerCase();
    while (used.has(email)) email = email.replace('@', `${i}@`);
    used.add(email);
    const hasPhone = rnd() < 0.87;
    const area = pick(['617', '832', '713', '214', '512', '480', '813', '407', '404', '704', '615', '303', '702', '312', '614', '313', '215', '206', '619', '801']);
    const nBits = Math.floor(rnd() * 4);
    const notes = Array.from({ length: nBits }, () => pick(NOTE_BITS)).join(' · ');
    const c = {
      id: `p${i.toString(36)}x${Math.floor(rnd() * 1e6).toString(36)}`,
      name: `${first} ${last}`, firstName: first, lastName: last, email,
      phone: hasPhone ? `(${area}) ${200 + Math.floor(rnd() * 700)}-${String(Math.floor(rnd() * 10000)).padStart(4, '0')}` : '',
      role: pick(ROLES), company: pick(COMPANIES), location: pick(CITIES), notes, pastRoles: '',
      source: 'csv', status: 'new', addedAt: ago(200 + rnd() * 2000), lastEmailedAt: null, bookedAt: null,
    };
    const r = rnd();
    if (r < 0.62) { c.status = 'emailed'; c.lastEmailedAt = ago(2 + rnd() * 600); c.lastSubject = SUBJECT; c.gmailThreadId = `gt${i}`; c.followUpCount = rnd() < 0.3 ? 1 : 0; }
    if (r < 0.25) { c.status = 'opened'; c.openedAt = ago(1 + rnd() * 500); }
    if (r < 0.06) { c.status = 'replied'; c.lastReplyAt = ago(rnd() * 300); c.emailUnread = rnd() < 0.2; c.replies = [{ id: `r${i}`, from: c.email, date: c.lastReplyAt, text: ['Sounds good — when can we talk?', 'Not interested, thanks.', 'Can you send more details about the comp plan?', 'I am available Tuesday after 3pm.'][i % 4], kind: '' }]; }
    if (r < 0.012) { c.status = 'bounced'; c.replies = [{ id: `b${i}`, from: 'mailer-daemon@googlemail.com', date: ago(5), text: 'Address not found', kind: 'bounce' }]; }
    if (c.phone && rnd() < 0.22) {
      const n = 1 + Math.floor(rnd() * 7);
      c.textThread = Array.from({ length: n }, (_, k) => ({ dir: k % 2 ? 'in' : 'out', ts: ago(200 - k * 3 - rnd() * 10), text: k % 2 ? ['Yes I am interested', 'Who is this?', 'Call me after 5', 'Not right now'][k % 4] : 'Hi — Blake at Wholesale Payments. We are hiring remote B2B account executives. Open to a quick call this week?' }));
      c.lastTextedAt = c.textThread[0].ts; c.textStatus = n > 1 ? 'replied' : 'delivered'; c.textUnread = n > 1 && rnd() < 0.3;
      if (n > 1) c.textRepliedAt = c.textThread[1].ts;
    }
    if (r > 0.995) { c.status = 'booked'; c.bookedAt = ago(rnd() * 100); c.bookedEvent = 'Intro call'; }
    return c;
  });
  const events = [];
  for (const c of db.candidates) {
    if (events.length >= 800) break;
    if (c.openedAt && rnd() < 0.05) events.push({ id: `eo${events.length}`, type: 'opened', candidateId: c.id, name: c.name, ts: c.openedAt, message: 'Opened the email' });
    if (c.lastReplyAt && rnd() < 0.3) events.push({ id: `er${events.length}`, type: 'replied', candidateId: c.id, name: c.name, ts: c.lastReplyAt, message: 'Replied' });
  }
  db.events = events.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  db.interviews = db.candidates.filter((c) => c.status === 'booked').slice(0, 150).map((c, i) => ({ uri: `https://api.calendly.com/scheduled_events/${i}`, name: 'Intro call', status: 'active', start: ago(-24 * (i % 14)), end: ago(-24 * (i % 14) - 0.5), joinUrl: `https://zoom.us/j/${i}`, locationType: 'zoom', invitees: [{ name: c.name, email: c.email, status: 'active', createdAt: ago(48), phone: c.phone, rescheduleUrl: '', cancelUrl: '' }] }));
  db.settings.fromName = 'Blake Woodruff';
  await store.save(db);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'data'), OUT, { recursive: true });
  const d2 = await store.load();
  console.log(`fixture: ${d2.candidates.length} people, ${d2.candidates.filter((c) => c.textThread).length} text threads, ${d2.candidates.filter((c) => c.replies).length} with replies, ${d2.events.length} feed lines, ${d2.interviews.length} interviews → ${OUT}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
