// Who to text first.
//
// Texting is capped at 60-100 a day because Apple disables accounts that blast
// strangers, while email is effectively unlimited. That makes the ORDER of the
// text queue the whole strategy: the scarce sends have to go to the people a
// text reaches that an email cannot, and to the people most likely to answer.
//
// Three rules shaped this, and each one cost something obvious to get right:
//
//   * "Replied" is NOT a positive signal. Nothing in this app classifies reply
//     sentiment, so that bucket holds "yes, let's talk" and "take me off your
//     list" side by side. Ranking it up would send the very first texts to the
//     people most likely to report them as junk — which is the one thing the
//     daily cap exists to avoid. Repliers are excluded outright; they are a
//     human's job, not a queue's.
//   * A bounced email address is the strongest signal in the file. Not because
//     those people are better, but because a text is the ONLY channel left for
//     them, which is exactly what a scarce channel is for.
//   * Someone whose current job is not sales but whose history is full of
//     solar, security or merchant services is a better bet than their title
//     suggests. They know the money and they are underemployed. Ranking on the
//     current title alone misses them entirely.
const phone = require('./phone');

const DAY = 24 * 3600 * 1000;
const ageDays = (iso) => {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Infinity : (Date.now() - t) / DAY;
};
const hay = (...parts) => ` ${parts.filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ')} `;
const hits = (text, list) => list.some((k) => text.includes(k));

// ---- what somebody does, and whether they would take this job ----
const PAYMENTS_EMPLOYER = ['wholesale payments', 'fiserv', 'first data', 'worldpay', 'global payments', 'heartland payment', 'tsys', 'elavon', 'shift4', 'clover', 'north american bancard', 'priority payments', 'clearent', 'stax', 'fattmerchant', 'payroc', 'signapay', 'electronic merchant systems', 'cardconnect', 'harbortouch', 'paysafe', 'nuvei', 'evo payments', 'chase paymentech', 'gravity payments', 'leaders merchant', 'total merchant services', 'merchant one', 'riverside payments', 'bankcard', 'banccard', 'payment alliance', 'dharma merchant', 'helcim', 'paya', 'cynergy', 'ipayment', 'vantiv', 'bluepay', 'merchant lynx', 'swipesimple'];
const PAYMENTS_ROLE = ['merchant services', 'merchant service', 'payment processing', 'payment processor', 'credit card processing', 'card processing', 'merchant acquiring', 'payment solutions', 'merchant consultant', 'payments consultant', 'merchant sales', 'payment facilitator', 'payfac', 'iso rep', 'interchange', 'residuals', 'point of sale', 'pos systems', 'payment sales', 'acquiring', 'card services'];
const D2D = ['solar', 'sunrun', 'sunpower', 'trinity solar', 'titan solar', 'freedom forever', 'momentum solar', 'blue raven', 'semper solaris', 'elevation solar', 'home security', 'alarm', 'vivint', 'adt', 'brinks home', 'alder', 'safestreets', 'guardian protection', 'safe haven', 'pest control', 'aptive', 'terminix', 'orkin', 'moxie pest', 'greenix', 'hawx', 'timeshare', 'vacation ownership', 'westgate resorts', 'bluegreen', 'wyndham destinations', 'hilton grand vacations', 'marriott vacations', 'holiday inn club', 'diamond resorts', 'roofing', 'storm restoration', 'door to door', 'door-to-door', 'canvasser', 'in home sales', 'in-home sales', 'renewal by andersen', 'leaffilter', 'bath fitter', 'champion windows', 'culligan', 'directv', 'dish network', 'metronet', 'kinetic'];
const AUTO = ['car sales', 'auto sales', 'automotive sales', 'finance manager', 'f&i', 'internet sales manager', 'carmax', 'autonation', 'carvana', 'penske automotive', 'hendrick automotive', 'lithia', 'group 1 automotive', 'dealership', 'product specialist'];
// Reps who cold-walk the same small-business door a merchant-services rep does.
// Same motion, same buyer, same objections, no ramp — under-rated, and it ranks
// with the door-to-door verticals rather than below them.
const MAIN_STREET = ['adp', 'paychex', 'aflac', 'colonial life', 'combined insurance', 'heartland payroll', 'business telecom', 'restaurant technology', 'toast', 'square', 'spectrum business', 'comcast business', 'cintas', 'ecolab', 'uline', 'small business consultant', 'smb sales', 'main street'];
const GENERAL_B2B = ['account executive', 'outside sales', 'field sales', 'territory sales', 'territory manager', 'sales representative', 'sales rep', 'business development representative', 'business development manager', 'sales consultant', 'sales agent', 'closer', 'regional sales representative', 'b2b sales', 'commission sales', 'insurance agent', 'insurance producer', 'medicare sales', 'final expense'];
const WEAK_SALES = ['account manager', 'inside sales', 'sales associate', 'retail sales', 'sales development representative', 'sdr', 'bdr', 'telesales', 'call center', 'client relations', 'relationship manager'];
const IC_CLOSER = ['account executive', 'sales representative', 'sales rep', 'sales consultant', 'outside sales', 'field sales', 'territory sales', 'sales agent', 'closer', 'merchant consultant', 'payments consultant', 'district manager', 'territory manager', 'business development manager', 'finance manager', 'internet sales manager'];
// Nobody with equity, a salary and a team leaves for a commission seat. This is
// where a naive ranker does the most damage, by mistaking an impressive title
// for a good candidate.
const LEADERSHIP = ['vice president', ' vp ', ' svp', ' evp', 'chief ', ' cro ', ' ceo', 'president', 'founder', 'co-founder', 'cofounder', 'owner', 'managing partner', 'managing director', 'principal', 'director of sales', 'sales director', 'head of sales', 'general manager', 'regional director', 'national sales manager', 'vp of sales', 'partner at'];
const NON_CLOSING = ['sales engineer', 'solutions consultant', 'solution engineer', 'sales operations', 'sales enablement', 'sales trainer', 'sales support', 'customer success', 'retention specialist', 'recruiter', 'talent acquisition', 'staffing', 'sales analyst', 'sales coordinator', 'sales administrator'];
const NOT_SALES = ['software engineer', 'developer', 'data analyst', 'registered nurse', ' rn ', 'teacher', 'professor', 'accountant', 'bookkeeper', 'human resources', 'hr generalist', 'administrative assistant', 'office manager', 'operations manager', 'warehouse', 'truck driver', ' cdl ', 'marketing manager', 'graphic designer', 'customer service representative', 'technician', 'paralegal', 'attorney', 'physician', 'pharmacist', 'cashier', 'server', 'bartender', 'security guard', 'janitor', 'machine operator', 'welder', 'electrician', 'plumber'];

// ---- what industry somebody comes from ----
// Finer than the scoring buckets on purpose: "door to door" is one idea when
// ranking, but when browsing a list of 2,800 people, solar and timeshare are
// different pools you want to look at separately.
const SOLAR = ['solar', 'sunrun', 'sunpower', 'trinity solar', 'titan solar', 'freedom forever', 'momentum solar', 'blue raven', 'semper solaris', 'elevation solar'];
const SECURITY = ['home security', 'alarm', 'vivint', 'adt', 'brinks home', 'alder', 'safestreets', 'guardian protection', 'safe haven'];
const PEST = ['pest control', 'aptive', 'terminix', 'orkin', 'moxie pest', 'greenix', 'hawx', 'exterminator'];
const TIMESHARE = ['timeshare', 'vacation ownership', 'westgate resorts', 'bluegreen', 'wyndham destinations', 'hilton grand vacations', 'marriott vacations', 'holiday inn club', 'diamond resorts'];
const HOME_IMPROVEMENT = ['roofing', 'storm restoration', 'renewal by andersen', 'leaffilter', 'bath fitter', 'champion windows', 'culligan', 'in home sales', 'in-home sales', 'windows', 'remodeling'];
const TELECOM = ['directv', 'dish network', 'spectrum', 'metronet', 'kinetic', 'comcast business', 'business telecom', 'fiber'];
const INSURANCE = ['insurance', 'aflac', 'colonial life', 'combined insurance', 'medicare sales', 'final expense', 'insurance agent', 'insurance producer'];
const PAYROLL_SMB = ['adp', 'paychex', 'heartland payroll', 'cintas', 'ecolab', 'uline', 'toast', 'square', 'restaurant technology', 'small business consultant', 'smb sales'];

// Ordered: the first match wins, so the most specific pools are tested first.
const INDUSTRIES = [
  ['payments', 'Merchant services & payments', (now, all) => hits(now, PAYMENTS_ROLE) || hits(now, PAYMENTS_EMPLOYER)],
  ['solar', 'Solar', (now) => hits(now, SOLAR)],
  ['security', 'Home security', (now) => hits(now, SECURITY)],
  ['pest', 'Pest control', (now) => hits(now, PEST)],
  ['timeshare', 'Timeshare', (now) => hits(now, TIMESHARE)],
  ['auto', 'Car sales', (now) => hits(now, AUTO)],
  ['home', 'Home improvement', (now) => hits(now, HOME_IMPROVEMENT)],
  ['telecom', 'Telecom & cable', (now) => hits(now, TELECOM)],
  ['insurance', 'Insurance', (now) => hits(now, INSURANCE)],
  ['smb', 'Small-business field sales', (now) => hits(now, PAYROLL_SMB) || hits(now, MAIN_STREET)],
  ['b2b', 'General B2B sales', (now) => hits(now, GENERAL_B2B) || hits(now, IC_CLOSER)],
  ['weak', 'Inside & account management', (now) => hits(now, WEAK_SALES)],
];

// Where someone comes from. Falls back to their history when the current job
// says nothing useful, so an ex-solar warehouse worker files under Solar rather
// than vanishing into "Other" — that is the whole point of having the field.
function industry(c) {
  const now = hay(c.role, c.company);
  const past = hay(c.pastRoles);
  for (const [code, label, test] of INDUSTRIES) if (test(now)) return { code, label, from: 'now' };
  for (const [code, label, test] of INDUSTRIES) if (test(past)) return { code, label, from: 'past' };
  return { code: 'other', label: 'Other', from: '' };
}
const INDUSTRY_LABELS = Object.fromEntries([...INDUSTRIES.map(([c, l]) => [c, l]), ['other', 'Other']]);

// A plain refusal that never said the word STOP, so the opt-out rule missed it.
const SOFT_NO = /\b(not interested|no thanks|no thank you|please remove|remove me|don'?t contact|do not contact|stop contacting|unsubscribe|lose my number|not looking)\b/i;

// Why someone cannot be texted at all. Returned as a sentence, or '' when they can.
function blockedReason(c, { optOut = new Set() } = {}) {
  const p = phone.normalize(c.phone);
  if (!p) return String(c.phone || '').trim() ? 'that number cannot be texted' : 'no phone number';
  if (optOut.has(p)) return 'asked to stop';
  if (c.status === 'declined') return 'marked not interested';
  if (c.status === 'booked') return 'already booked in';
  // No sentiment classification exists anywhere, so a reply is a human's to read.
  if (c.status === 'replied' || c.repliedAt || c.textRepliedAt) return 'already replied — read it before texting';
  if (c.textStatus === 'not-imessage') return 'no iMessage account on that number';
  if (c.lastTextedAt) return 'already texted';
  const words = `${c.notes || ''} ${(c.textThread || []).filter((m) => m.dir === 'in').map((m) => m.text).join(' ')}`;
  if (SOFT_NO.test(words)) return 'said no without saying STOP';
  // The queue would hold these forever anyway: no timezone is known for them,
  // so it cannot tell whether it is the middle of their night.
  if (!/^\+1/.test(p)) return 'outside North America';
  // A job with no selling in it and no selling anywhere in their history. Not a
  // judgement about the person — just not who this role is for, and a text
  // spent here is a text not spent on someone who is.
  const nowText = hay(c.role, c.company);
  if (hits(nowText, NOT_SALES)) {
    const allText = hay(c.role, c.company, c.pastRoles);
    const sellsSomewhere = hits(allText, PAYMENTS_ROLE) || hits(allText, PAYMENTS_EMPLOYER)
      || hits(allText, D2D) || hits(allText, AUTO) || hits(allText, MAIN_STREET) || hits(allText, GENERAL_B2B);
    if (!sellsSomewhere) return 'no sales background';
  }
  return '';
}

// A score, plus the one phrase that explains it.
function score(c, { maxFollowUps = 2 } = {}) {
  const role = String(c.role || '');
  const company = String(c.company || '');
  const past = String(c.pastRoles || '');
  const nowText = hay(role, company);
  const allText = hay(role, company, past);
  const reasons = [];
  let points = 0;

  // ---- what they do ----
  let fit = 'none';
  if (hits(nowText, PAYMENTS_ROLE) || hits(nowText, PAYMENTS_EMPLOYER)) { points += 100; fit = 'payments'; reasons.push('in payments now'); }
  else if (hits(allText, PAYMENTS_ROLE) || hits(allText, PAYMENTS_EMPLOYER)) { points += 62; fit = 'payments-past'; reasons.push('used to be in payments'); }
  else if (hits(nowText, D2D)) { points += 55; fit = 'd2d'; reasons.push('door-to-door closer'); }
  else if (hits(nowText, AUTO)) { points += 55; fit = 'auto'; reasons.push('car sales'); }
  else if (hits(nowText, MAIN_STREET)) { points += 55; fit = 'smb'; reasons.push('sells to small business door to door'); }
  else if (hits(allText, D2D) || hits(allText, AUTO) || hits(allText, MAIN_STREET)) { points += 40; fit = 'vertical-past'; reasons.push('closed door to door before'); }
  else if (hits(nowText, GENERAL_B2B)) { points += 26; fit = 'b2b'; reasons.push('B2B sales'); }
  else if (hits(nowText, WEAK_SALES)) { points += 8; fit = 'weak'; }

  // ---- would they take it ----
  if (hits(nowText, LEADERSHIP)) { points -= 60; reasons.push('runs a team — unlikely to move'); }
  else if (hits(nowText, IC_CLOSER)) points += 15;
  if (hits(nowText, NON_CLOSING)) points -= 25;
  // A non-sales job on top of a real closing history is the underemployed
  // ex-closer: the highest-response group in the list, and the one a
  // title-only ranking throws away.
  if (hits(nowText, NOT_SALES)) {
    // Anyone here already passed blockedReason, so they do have selling in
    // their history — they are just not doing it right now.
    reasons.push('out of sales now — likely wants back in');
    points -= 10;
  }

  // ---- has email already done its work ----
  const opened = ageDays(c.openedAt);
  if (c.status === 'bounced') {
    points += fit === 'payments' ? 34 : 28;
    reasons.unshift('email bounced — a text is the only way to reach them');
  } else if (Number.isFinite(opened)) {
    if (opened <= 14) { points += 22; reasons.unshift('opened your email in the last two weeks'); }
    else if (opened <= 75) { points += 14; reasons.unshift('opened your email'); }
    else { points += 6; reasons.unshift('opened your email months ago'); }
  }
  const followUps = Number(c.followUpCount || 0);
  if (followUps >= maxFollowUps) {
    if (!c.openedAt) { points += 18; reasons.unshift('every email ignored — a text is what gets through'); }
    else points += 12;
  }
  if (c.source === 'manual' || /referr|sent by|knows /i.test(c.notes || '')) { points += 10; reasons.push('you added them yourself'); }
  else if (String(c.notes || '').trim()) points += 5;

  // ---- penalties ----
  // Email is free and unlimited; spending a capped text on someone it has not
  // even been tried on is the wrong way round.
  if (c.status === 'new' || !c.lastEmailedAt) { points -= 14; reasons.push('not emailed yet — try the free channel first'); }
  if (c.lastEmailedAt && ageDays(c.lastEmailedAt) < 3 && !c.openedAt) points -= 18;
  if (ageDays(c.addedAt) > 540 || (c.lastEmailedAt && ageDays(c.lastEmailedAt) > 180)) points -= 12;
  if (!role.trim() && !company.trim() && !past.trim()) { points -= 20; reasons.push('nothing on file to judge them by'); }

  return { score: Math.round(points), fit, reason: reasons.slice(0, 2).join(' · ') || 'no strong signal either way' };
}

// The textable candidates, best first, each carrying why. Duplicate humans
// sharing one number are collapsed to the richest row before ranking, since the
// queue only dedupes what is in front of it.
function rank(candidates, { maxFollowUps = 2, optOut = [] } = {}) {
  const blocked = new Set(optOut.map((p) => phone.normalize(p)).filter(Boolean));
  const byNumber = new Map();
  for (const c of candidates) {
    if (blockedReason(c, { optOut: blocked })) continue;
    const p = phone.normalize(c.phone);
    const richness = [c.role, c.company, c.pastRoles, c.notes, c.openedAt].filter(Boolean).length;
    const seen = byNumber.get(p);
    if (!seen || richness > seen.richness) byNumber.set(p, { c, richness });
  }
  return [...byNumber.values()]
    .map(({ c }) => ({ id: c.id, ...score(c, { maxFollowUps }) }))
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
}

module.exports = { rank, score, blockedReason, industry, INDUSTRY_LABELS };
