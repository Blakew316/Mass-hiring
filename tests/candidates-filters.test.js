// Candidates page on a laptop: every filter menu with the counts it offers,
// what each choice shows, the starting-point pills and their numbers, the
// chips that say which filters are in force, filters combined, and the
// "nobody matches" state. Sales IQ and Onboarding docs (seeded the way the
// app stores them) show on the rows as badges and drive two of the menus.
const { launch, openPage, ok, done, crash } = require('./helpers');
const H = require('./candidates-helpers');

const E = H.EXPECT;
const LABEL = { new: 'Not contacted', emailed: 'Emailed', replied: 'Replied', booked: 'Booked', declined: 'Not interested', bounced: 'Bounced' };

(async () => {
  const s = await H.startCandidates(82);
  const P = s.people;
  const browser = await launch();
  const { ctx, page, errors } = await openPage(browser, s, { path: '/#candidates' });
  await H.openCandidates(page);

  const shown = () => H.countText(page);
  const chips = () => page.$$eval('#activeFilters .filter-tag', (bs) => bs.map((b) => b.textContent.replace('×', '').trim()));
  const ids = () => H.rowIds(page);
  // Pick from a menu and read what the list then says: once the chips show
  // the new choice has been taken up (every pick changes them), and the
  // count reads as expected.
  async function pick(sel, value, want) {
    const before = JSON.stringify(await chips());
    await page.selectOption(sel, value);
    await H.until(page, async () => JSON.stringify(await chips()) !== before);
    return want === undefined ? shown() : H.settle(page, shown, want);
  }
  const countFor = (n) => (n === 150 ? '150 candidates' : `${n} of 150`);

  // ---- the menus, and the counts each choice carries ----
  ok(JSON.stringify(await H.options(page, '#stageFilter')) === JSON.stringify(['Any stage (150)', 'Not contacted (40)', 'Emailed (60)', 'Replied (15)', 'Booked (10)', 'Not interested (10)', 'Bounced (15)']), 'stage menu: every stage, with how many are in it', await H.options(page, '#stageFilter'));
  ok(JSON.stringify(await H.options(page, '#roleFilter')) === JSON.stringify(['All roles (150)', 'Account Executive (19)', 'Alarm Systems Rep (10)', 'Inside Sales Associate (10)', 'Insurance Agent (10)', 'Merchant Services Consultant (10)', 'Solar Consultant (10)', 'Car Sales Consultant (9)', 'Fiber Sales Rep (9)', 'Office Manager (9)', 'Pest Control Sales (9)', 'Roofing Sales Rep (9)', 'Server (9)', 'Small Business Consultant (9)', 'Timeshare Sales Agent (9)', 'No role on file (9)']),
    'role menu: most common first, a role written two ways counted once, then "No role on file"', await H.options(page, '#roleFilter'));
  const ind = await H.options(page, '#industryFilter');
  const indSet = ind.slice(1).sort();
  ok(ind[0] === 'Any industry' && JSON.stringify(indSet) === JSON.stringify(['Car sales (9)', 'General B2B sales (19)', 'Home improvement (9)', 'Home security (10)', 'Inside & account management (10)', 'Insurance (10)', 'Merchant services & payments (10)', 'Other (18)', 'Pest control (9)', 'Small-business field sales (9)', 'Solar (19)', 'Telecom & cable (9)', 'Timeshare (9)']), 'industry menu: every industry in the list, with its count', ind);
  const indN = ind.slice(1).map((o) => Number(o.match(/\((\d+)\)$/)[1]));
  ok(indN.every((n, i) => i === 0 || indN[i - 1] >= n), 'biggest industry first', indN);
  ok(JSON.stringify(await H.options(page, '#iqFilter')) === JSON.stringify(['Sales IQ: any', 'On Sales IQ (13)', 'Not on Sales IQ (137)', 'Sales IQ · not sent (3)', 'Questionnaire sent (4)', 'Questionnaire done (6)', 'Elite Talent (85+) (2)', 'Strong Potential (70–84) (2)', 'Developing (50–69) (1)', 'Not Sales-Ready (under 50) (1)']), 'Sales IQ menu: every step and tier, with counts', await H.options(page, '#iqFilter'));
  ok(JSON.stringify(await H.options(page, '#onbFilter')) === JSON.stringify(['Onboarding: any', 'In Onboarding docs (9)', 'Not in Onboarding docs (141)', 'Docs · packet not sent (4)', 'Docs sent · awaiting signature (2)', 'Docs signed (3)']), 'Onboarding menu: every stage, with counts', await H.options(page, '#onbFilter'));
  ok(JSON.stringify(await H.options(page, '#textedFilter')) === JSON.stringify(['Texted or not', 'Never texted', 'Ready to text', 'Texted today', 'Texted this week', 'Texted at some point', 'No phone number']), 'texting menu');
  ok(JSON.stringify(await H.options(page, '#rankFilter')) === JSON.stringify(['Any ranking', 'Top 50 to text', 'Top 200 to text', 'Top 500 to text', 'Not being texted']), 'ranking menu');
  ok(JSON.stringify(await H.options(page, '#addedFilter')) === JSON.stringify(['Added any time', 'Added today', 'Added this week', 'Added this month', 'Added in 90 days', 'Added over 90 days ago']), 'added menu');

  // ---- the pills ----
  const pills0 = await H.pills(page);
  ok(JSON.stringify(pills0) === JSON.stringify([
    { label: 'Everyone', n: '150', on: true }, { label: 'Best to text next', n: '50', on: false }, { label: 'Replied', n: '15', on: false },
    { label: 'Not contacted', n: '40', on: false }, { label: 'Booked', n: '10', on: false }, { label: 'Needs a number', n: '54', on: false },
    { label: 'Sales IQ done', n: '6', on: false }, { label: 'Docs awaiting signature', n: '2', on: false }, { label: 'Docs signed', n: '3', on: false },
  ]), 'pills: each starting point with its number, Everyone lit', pills0);

  // ---- stage, one choice at a time ----
  for (const [k, n] of Object.entries(E.stage)) {
    const c = await pick('#stageFilter', k, countFor(n));
    const statuses = await page.$$eval('#candidateRows .status-select', (ss) => ss.map((x) => x.value));
    ok(c === countFor(n) && statuses.length === Math.min(n, 50) && statuses.every((v) => v === k), `stage ${LABEL[k]}: ${n} people, all ${LABEL[k]}`, { c, rows: statuses.length });
    ok(JSON.stringify(await chips()) === JSON.stringify([`Stage: ${LABEL[k]}`]), `  a chip says "Stage: ${LABEL[k]}"`, await chips());
    ok(await page.$eval('#candPager', (el) => el.hidden) === (n <= 50), `  the pager shows only when there is more than a page (${n})`);
  }
  ok(JSON.stringify(await H.pills(page)) === JSON.stringify(pills0.map((p) => ({ ...p, on: false }))), 'the pills keep their whole-list numbers under a filter, and none is lit for Bounced');
  ok(JSON.stringify(await H.options(page, '#iqFilter')).includes('Questionnaire done (6)'), 'and so do the menus');
  await pick('#stageFilter', 'all', '150 candidates');
  ok(await shown() === '150 candidates' && (await chips()).length === 0, 'Any stage: everyone again, no chip');

  // ---- industry ----
  ok(await pick('#industryFilter', 'solar', '19 of 150') === '19 of 150', 'Solar: 19 — solar now, and the office manager who sold solar before', await shown());
  const solar = new Set(P.filter((c) => c.role === 'Solar Consultant' || c.role === 'Office Manager').map((c) => c.id));
  ok((await ids()).length === 19 && (await ids()).every((id) => solar.has(id)), '  exactly those people');
  ok(JSON.stringify(await chips()) === JSON.stringify(['Industry: Solar']), '  chip "Industry: Solar"', await chips());
  ok(await pick('#industryFilter', 'other', '18 of 150') === '18 of 150', 'Other: 18 — the servers and those with no role', await shown());
  ok(await pick('#industryFilter', 'payments', '10 of 150') === '10 of 150', 'Merchant services & payments: 10');
  await pick('#industryFilter', '', '150 candidates');

  // ---- role ----
  ok(await pick('#roleFilter', 'account executive', '19 of 150') === '19 of 150', 'Account Executive: 19, whichever way it was written', await shown());
  const roles = await page.$$eval('#candidateRows [data-col="role"]', (tds) => tds.map((td) => td.firstChild.textContent.trim()));
  ok(roles.every((r) => r.toLowerCase() === 'account executive') && roles.some((r) => r === 'account executive') && roles.some((r) => r === 'Account Executive'), '  both spellings are in it', [...new Set(roles)]);
  ok(JSON.stringify(await chips()) === JSON.stringify(['Role: Account Executive (19)']), '  chip in the menu\'s own words', await chips());
  ok(await pick('#roleFilter', '__none', '9 of 150') === '9 of 150', 'No role on file: 9');
  ok((await page.$$eval('#candidateRows [data-col="role"]', (tds) => tds.map((td) => td.textContent.trim()))).every((t) => t === '—'), '  each shows a dash for a role');
  ok(JSON.stringify(await chips()) === JSON.stringify(['Role: No role on file (9)']), '  chip "Role: No role on file (9)"', await chips());
  await pick('#roleFilter', '', '150 candidates');

  // ---- when they were added ----
  const addedLabel = { 1: 'Added today', 7: 'Added this week', 30: 'Added this month', 90: 'Added in 90 days', old: 'Added over 90 days ago' };
  for (const [k, n] of Object.entries(E.added)) {
    ok(await pick('#addedFilter', k, countFor(n)) === countFor(n), `${addedLabel[k]}: ${n}`, await shown());
  }
  ok(JSON.stringify(await chips()) === JSON.stringify(['Added: Added over 90 days ago']), '  chip "Added: Added over 90 days ago"', await chips());
  await pick('#addedFilter', '', '150 candidates');

  // ---- texting ----
  const texted = { never: E.neverTexted, ready: 60, 1: E.textedToday, 7: E.textedWeek, any: E.textedAny, nonumber: E.needsNumber };
  for (const [k, n] of Object.entries(texted)) ok(await pick('#textedFilter', k, countFor(n)) === countFor(n), `texting "${k}": ${n}`, await shown());
  const pips = await page.$$eval('#candidateRows [data-col="text"] .text-pip', (ps) => ps.map((p) => p.textContent.trim()));
  ok(pips.length === 50 && pips.every((t) => t === '+ add number' || t === 'bad number'), '  "No phone number": each row offers to add one or says the number is bad', [...new Set(pips)]);
  ok(pips.includes('bad number') && pips.includes('+ add number'), '  (both kinds are there: no number at all, and one that cannot be texted)', [...new Set(pips)]);
  ok(JSON.stringify(await chips()) === JSON.stringify(['Texting: No phone number']), '  chip "Texting: No phone number"', await chips());
  await pick('#textedFilter', '1', countFor(5));
  ok(JSON.stringify((await ids()).sort()) === JSON.stringify(['e03', 'e04', 'e05', 'r03', 'r04']), 'Texted today: exactly the five texted in the last day', await ids());
  const todayPips = await page.$$eval('#candidateRows [data-col="text"] .text-pip', (ps) => ps.map((p) => p.textContent.trim()).sort());
  ok(JSON.stringify(todayPips) === JSON.stringify(['Delivered', 'Read', 'Replied', 'Replied', 'Sent']), '  and their Text column says how each text went', todayPips);
  await pick('#textedFilter', '', '150 candidates');

  // ---- ranking ----
  for (const [k, n] of Object.entries({ 50: 50, 200: 60, 500: 60, unranked: 90 })) ok(await pick('#rankFilter', k, countFor(n)) === countFor(n), `ranking "${k}": ${n}`, await shown());
  ok(JSON.stringify(await chips()) === JSON.stringify(['Ranking: Not being texted']), '  chip "Ranking: Not being texted"', await chips());
  await pick('#rankFilter', '', '150 candidates');

  // ---- Sales IQ ----
  for (const [k, n] of Object.entries(E.iq)) ok(await pick('#iqFilter', k, countFor(n)) === countFor(n), `Sales IQ "${k}": ${n}`, await shown());
  const badges = async () => Object.fromEntries(await page.$$eval('#candidateRows tr', (trs) => trs.map((tr) => [tr.dataset.id, [...tr.querySelectorAll('.cand-iq .badge')].map((b) => b.textContent.trim()).join(' + ')])));
  await pick('#iqFilter', 'completed', countFor(6));
  ok(JSON.stringify(await badges()) === JSON.stringify(Object.fromEntries(P.filter((c) => ['e20', 'e21', 'r05', 'b03', 'b04', 'e25'].includes(c.id)).map((c) => [c.id, { e20: 'Sales IQ 92/100', e21: 'Sales IQ 78/100', r05: 'Sales IQ 61/100', b03: 'Sales IQ 40/100', b04: 'Sales IQ 88/100', e25: 'Sales IQ 72/100' }[c.id]]))),
    'Questionnaire done: each row carries its score (someone listed twice counts at the furthest step)', await badges());
  ok(JSON.stringify(await chips()) === JSON.stringify(['Sales IQ: Questionnaire done']), '  chip "Sales IQ: Questionnaire done"', await chips());
  await pick('#iqFilter', 'invited', countFor(4));
  ok(JSON.stringify(Object.keys(await badges()).sort()) === JSON.stringify(['e22', 'e23', 'e24', 'n05']) && Object.values(await badges()).every((b) => b === 'Questionnaire sent'), 'Questionnaire sent: four, including one Sales IQ knows by another address', await badges());
  await pick('#iqFilter', 'added', countFor(3));
  ok(Object.values(await badges()).every((b) => b === 'Sales IQ · not sent') && Object.keys(await badges()).length === 3, 'Sales IQ · not sent: three, so badged', await badges());
  await pick('#iqFilter', 'elite', countFor(2));
  ok(JSON.stringify((await ids()).sort()) === JSON.stringify(['b04', 'e20']), 'Elite Talent: the 92 and the 88');
  await pick('#iqFilter', '', '150 candidates');

  // ---- Onboarding docs ----
  for (const [k, n] of Object.entries(E.onb)) ok(await pick('#onbFilter', k, countFor(n)) === countFor(n), `Onboarding "${k}": ${n}`, await shown());
  await pick('#onbFilter', 'pipeline', countFor(4));
  ok(JSON.stringify(Object.keys(await badges()).sort()) === JSON.stringify(['e30', 'e31', 'e34', 'n10']) && Object.values(await badges()).every((b) => b === 'Docs · not sent'), 'Docs · packet not sent: four, including one whose send never went (email was not set up)', await badges());
  await pick('#onbFilter', 'sent', countFor(2));
  ok(JSON.stringify(await badges()) === JSON.stringify(Object.fromEntries(P.filter((c) => ['e32', 'e33'].includes(c.id)).map((c) => [c.id, 'Docs sent']))), 'Docs sent: two, badged "Docs sent"', await badges());
  await pick('#onbFilter', 'signed', countFor(3));
  ok(JSON.stringify(Object.keys(await badges()).sort()) === JSON.stringify(['b05', 'b06', 'b07']) && Object.values(await badges()).every((b) => /Docs signed$/.test(b)), 'Docs signed: three, including one who signed without being on the pipeline list', await badges());
  ok(JSON.stringify(await chips()) === JSON.stringify(['Onboarding: Docs signed']), '  chip "Onboarding: Docs signed"', await chips());
  await pick('#onbFilter', '', '150 candidates');

  // ---- filters together, chips, and taking them off ----
  await pick('#stageFilter', 'booked', countFor(10));
  await pick('#iqFilter', 'elite', countFor(1));
  ok(await shown() === '1 of 150' && JSON.stringify(await ids()) === JSON.stringify(['b04']), 'Booked + Elite Talent: the one person who is both');
  ok(JSON.stringify(await chips()) === JSON.stringify(['Stage: Booked', 'Sales IQ: Elite Talent (85+)']), 'two chips', await chips());
  ok(await page.$eval('#activeFilters [data-clear="all"]', (b) => b.textContent.trim()) === 'Clear all', 'and a "Clear all" once there is more than one');
  await page.click('#activeFilters .filter-tag[data-clear="0"]');
  await H.until(page, async () => (await shown()) === '2 of 150');
  ok(await shown() === '2 of 150' && await page.$eval('#stageFilter', (el) => el.value) === 'all', 'the × on "Stage: Booked" takes off just that filter, and the menu follows', await shown());
  ok(JSON.stringify(await chips()) === JSON.stringify(['Sales IQ: Elite Talent (85+)']) && !(await page.$('#activeFilters [data-clear="all"]')), 'one chip left, no "Clear all"');
  await pick('#stageFilter', 'declined', countFor(0));
  await pick('#industryFilter', 'solar');
  await page.click('#activeFilters [data-clear="all"]');
  await H.until(page, async () => (await shown()) === '150 candidates');
  const menus = await page.$$eval('#candFilters select', (ss) => ss.map((x) => x.value));
  ok(await shown() === '150 candidates' && JSON.stringify(menus) === JSON.stringify(['all', '', '', '', '', '', '', '', 'default']), '"Clear all" puts every menu back', menus);
  ok(await page.$eval('#activeFilters', (el) => el.hidden), 'and the chips go');

  // ---- nobody matches ----
  await pick('#stageFilter', 'new', countFor(40));
  await pick('#iqFilter', 'completed', countFor(0));
  ok(await shown() === '0 of 150', 'Not contacted + Questionnaire done: nobody', await shown());
  ok(await H.visible(page, '#candidatesNoMatch') && !(await H.visible(page, '#candidatesEmpty')), 'says nobody matches, not that the list is empty');
  ok(await H.text(page, '#candidatesNoMatch h3') === 'Nobody matches those filters' && await H.text(page, '#noMatchLine') === '150 people are in the list — none of them fit this combination.', 'in those words', await H.text(page, '#noMatchLine'));
  ok((await ids()).length === 0 && await page.$eval('#candPager', (el) => el.hidden), 'no rows, no pager');
  await page.click('#emptyClear');
  await H.until(page, async () => (await shown()) === '150 candidates');
  ok(await shown() === '150 candidates' && !(await H.visible(page, '#candidatesNoMatch')), '"Clear the filters" brings everyone back');

  // ---- a filter starts again at page 1 ----
  await page.click('#pagerNext');
  await page.waitForFunction(() => document.querySelector('#pagerPage').textContent === 'Page 2 of 3');
  await pick('#stageFilter', 'emailed', countFor(60));
  ok(await H.text(page, '#pagerPage') === 'Page 1 of 2' && await H.text(page, '#pagerRange') === '1–50 of 60', 'narrowing the list goes back to page 1', await H.text(page, '#pagerRange'));
  await pick('#stageFilter', 'all', '150 candidates');

  // ---- the pills ----
  // Tap a pill; read the count and which pill is lit once they read as expected.
  async function pill(label, want) {
    await page.evaluate((l) => [...document.querySelectorAll('#candViews .view-pill')].find((b) => b.firstChild.textContent.trim() === l).click(), label);
    return H.settle(page, async () => ({ count: await shown(), lit: (await H.pills(page)).filter((p) => p.on).map((p) => p.label) }), want);
  }
  await pick('#roleFilter', 'server', countFor(9));
  ok(JSON.stringify(await pill('Replied', { count: '15 of 150', lit: ['Replied'] })) === JSON.stringify({ count: '15 of 150', lit: ['Replied'] }), 'Replied pill: the fifteen who replied, lit', await shown());
  ok(await page.$eval('#stageFilter', (el) => el.value) === 'replied' && await page.$eval('#roleFilter', (el) => el.value) === '', '  it sets the stage menu, and starts fresh (the role filter is gone)');
  ok(JSON.stringify(await pill('Not contacted', { count: '40 of 150', lit: ['Not contacted'] })) === JSON.stringify({ count: '40 of 150', lit: ['Not contacted'] }), 'Not contacted pill: 40');
  ok(JSON.stringify(await pill('Booked', { count: '10 of 150', lit: ['Booked'] })) === JSON.stringify({ count: '10 of 150', lit: ['Booked'] }), 'Booked pill: 10');
  ok(JSON.stringify(await pill('Needs a number', { count: '54 of 150', lit: ['Needs a number'] })) === JSON.stringify({ count: '54 of 150', lit: ['Needs a number'] }) && await page.$eval('#textedFilter', (el) => el.value) === 'nonumber', 'Needs a number pill: 54, as "No phone number"');
  ok(JSON.stringify(await pill('Sales IQ done', { count: '6 of 150', lit: ['Sales IQ done'] })) === JSON.stringify({ count: '6 of 150', lit: ['Sales IQ done'] }) && await page.$eval('#iqFilter', (el) => el.value) === 'completed', 'Sales IQ done pill: 6');
  ok(JSON.stringify(await pill('Docs awaiting signature', { count: '2 of 150', lit: ['Docs awaiting signature'] })) === JSON.stringify({ count: '2 of 150', lit: ['Docs awaiting signature'] }), 'Docs awaiting signature pill: 2');
  ok(JSON.stringify(await pill('Docs signed', { count: '3 of 150', lit: ['Docs signed'] })) === JSON.stringify({ count: '3 of 150', lit: ['Docs signed'] }), 'Docs signed pill: 3');
  const best = await pill('Best to text next', { count: '50 of 150', lit: ['Best to text next'] });
  ok(JSON.stringify(best) === JSON.stringify({ count: '50 of 150', lit: ['Best to text next'] }), 'Best to text next pill: the top fifty', best);
  ok(await page.$eval('#sortBy', (el) => el.value) === 'texting' && await page.$eval('#rankFilter', (el) => el.value) === '50' && !(await page.$eval('#rankHead', (el) => el.hidden)), '  in texting order, numbered');
  ok(JSON.stringify(await H.rowNames(page)).startsWith(JSON.stringify(['Jules Ashdown', 'Noel Underhill', 'Morgan Thorne']).slice(0, -1)), '  best first');
  await page.selectOption('#sortBy', 'name');
  ok(await H.settle(page, async () => (await H.pills(page)).filter((p) => p.on).length, 0) === 0, 'sorted another way, that pill no longer describes the list and is not lit');
  const every = await pill('Everyone', { count: '150 candidates', lit: ['Everyone'] });
  ok(JSON.stringify(every) === JSON.stringify({ count: '150 candidates', lit: ['Everyone'] }) && await page.$eval('#sortBy', (el) => el.value) === 'default', 'Everyone: the whole list, in the order added', every);
  await page.fill('#searchInput', 'Quill');
  await H.until(page, async () => (await shown()) === '15 of 150');
  ok(await H.settle(page, async () => (await H.pills(page)).filter((p) => p.on).length, 0) === 0, 'with a search typed, no pill is lit');
  await page.fill('#searchInput', '');

  ok(errors.length === 0, 'no page errors', errors);
  ok(H.outside.length === 0, 'nothing reached the outside world', H.outside);
  await ctx.close();
  await browser.close();
  await s.close();
  done();
})().catch(crash);
