// Candidates page on a laptop, left open while the list changes elsewhere —
// another device changing a status, adding and removing people, Sales IQ
// finishing, paperwork coming back signed. The next look for news (here: the
// tab coming back into view, which looks at once) brings all of it in: rows,
// counts, menus, pills and badges. Where you were — the page, the filters,
// the order, who is ticked — stays put. An open profile follows its person,
// and closes if they are removed. A look that finds nothing new changes nothing.
const { R, launch, openPage, ok, done, crash, ago } = require('./helpers');
const H = require('./candidates-helpers');

(async () => {
  const s = await H.startCandidates(94);
  const P = s.people;
  const B = s.byId;
  const browser = await launch();
  const { ctx, page, errors } = await openPage(browser, s, { path: '/#candidates' });
  await H.openCandidates(page);

  // The tab coming back into view looks for news straight away.
  const look = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const pillsNow = async () => Object.fromEntries((await H.pills(page)).map((p) => [p.label, p.n]));
  const siq = require(R('lib/salesiq.js'));
  const onboarding = require(R('lib/onboarding.js'));

  // ---- where the person is: page 2, someone ticked ----
  await page.click('#pagerNext');
  await page.waitForFunction(() => document.querySelector('#pagerPage').textContent === 'Page 2 of 3');
  const ticked = P[50].id;
  await page.click(`#candidateRows tr[data-id="${ticked}"] .row-check`);
  ok(await H.text(page, '#selCount') === '1 selected', 'on page 2 with one person ticked');
  const pageRows = await H.rowIds(page);

  // ---- a look that finds nothing new ----
  await look();
  await page.waitForTimeout(400);
  ok(JSON.stringify(await H.rowIds(page)) === JSON.stringify(pageRows) && await H.text(page, '#pagerPage') === 'Page 2 of 3' && await H.text(page, '#selCount') === '1 selected', 'a look that finds nothing new leaves the page as it was');

  // ---- meanwhile, on another device ----
  ok((await s.call('PATCH', '/api/candidates/e04', { status: 'replied' })).status === 200, 'elsewhere: someone is marked Replied');
  const added = await s.json('POST', '/api/candidates', { firstName: 'Riley', lastName: 'Newcomb', name: 'Riley Newcomb', email: 'riley.newcomb@example.com', phone: '(617) 555-2998', role: 'Account Executive', company: 'Northwind Logistics' });
  ok(added.status === 200, 'someone new is added by hand');
  ok((await s.call('DELETE', '/api/candidates/n03')).status === 200, 'someone not contacted yet is removed');
  await siq.update((doc) => { const c = doc.candidates.find((x) => x.crmId === 'e22'); c.status = 'completed'; c.score = 86; c.completedAt = ago(1); });
  ok(true, 'a Sales IQ questionnaire comes back (86)');
  await onboarding.update((doc) => { doc.hires.unshift({ id: 'ref-e32', reference: 'ref-e32', firstName: B.e32.firstName, lastName: B.e32.lastName, email: B.e32.email, signedAt: ago(1), documents: ['Offer letter'] }); });
  ok(true, 'and a packet comes back signed');

  await look();
  await H.until(page, async () => (await pillsNow()).Replied === '16');
  const pl = await pillsNow();
  ok(JSON.stringify(pl) === JSON.stringify({ Everyone: '150', 'Best to text next': '50', Replied: '16', 'Not contacted': '40', Booked: '10', 'Needs a number': '54', 'Sales IQ done': '7', 'Docs awaiting signature': '1', 'Docs signed': '4' }),
    'the pills: +1 replied, +1 and −1 not contacted, +1 Sales IQ done, one packet moved from awaiting to signed', pl);
  ok(JSON.stringify(await H.options(page, '#stageFilter')) === JSON.stringify(['Any stage (150)', 'Not contacted (40)', 'Emailed (59)', 'Replied (16)', 'Booked (10)', 'Not interested (10)', 'Bounced (15)']), 'the stage menu', await H.options(page, '#stageFilter'));
  const iqMenu = await H.options(page, '#iqFilter');
  ok(iqMenu.includes('Questionnaire done (7)') && iqMenu.includes('Elite Talent (85+) (3)') && iqMenu.includes('Questionnaire sent (3)'), 'the Sales IQ menu', iqMenu);
  ok((await H.options(page, '#onbFilter')).includes('Docs signed (4)'), 'the Onboarding menu');
  ok((await H.options(page, '#roleFilter')).includes('Account Executive (20)'), 'the role menu counts the newcomer');
  ok(await H.text(page, '#pagerPage') === 'Page 2 of 3' && await H.text(page, '#pagerRange') === '51–100 of 150', 'still on page 2');
  ok(await H.text(page, '#selCount') === '1 selected' && await page.$eval(`#candidateRows tr[data-id="${ticked}"] .row-check`, (el) => el.checked), 'and the same person still ticked');
  await page.click('#selClearBtn');

  // The rows themselves.
  await page.fill('#searchInput', B.e22.email);
  await H.until(page, async () => JSON.stringify(await H.rowIds(page)) === '["e22"]');
  ok(await page.$eval('#candidateRows tr[data-id="e22"] .cand-iq', (el) => el.textContent.trim()) === 'Sales IQ 86/100', 'the finished questionnaire shows on their row with its score');
  await page.fill('#searchInput', B.e32.email);
  await H.until(page, async () => JSON.stringify(await H.rowIds(page)) === '["e32"]');
  ok(await page.$eval('#candidateRows tr[data-id="e32"] .cand-iq', (el) => el.textContent.trim()) === 'Docs signed', 'the signed packet shows on theirs');
  await page.fill('#searchInput', B.e04.email);
  await H.until(page, async () => JSON.stringify(await H.rowIds(page)) === '["e04"]');
  ok(await page.$eval('#candidateRows tr[data-id="e04"] .status-select', (el) => el.value) === 'replied', 'the status changed elsewhere shows on the row');
  await page.fill('#searchInput', B.n03.email);
  await H.until(page, async () => (await H.countText(page)) === '0 of 150');
  ok(await H.countText(page) === '0 of 150', 'the person removed elsewhere is gone');
  await page.fill('#searchInput', '');
  await H.until(page, async () => (await H.countText(page)) === '150 candidates');

  // The newcomer: last in the order added, first in newest first.
  await page.click('#pagerNext');
  await page.click('#pagerNext');
  await page.waitForFunction(() => document.querySelector('#pagerPage').textContent === 'Page 3 of 3');
  ok((await H.rowNames(page)).slice(-1)[0] === 'Riley Newcomb', 'the newcomer is last in the order added');
  const rowText = await page.$eval('#candidateRows tr:last-child', (tr) => ({ text: tr.querySelector('[data-col="text"]').innerText.trim(), status: tr.querySelector('.status-select').value, last: tr.querySelector('[data-col="last"] .d-only').textContent.trim() }));
  ok(JSON.stringify(rowText) === JSON.stringify({ text: '(617) 555-2998', status: 'new', last: 'never' }), 'not contacted, never emailed, with their number', rowText);
  await page.selectOption('#sortBy', 'newest');
  ok(await H.settle(page, async () => (await H.rowNames(page))[0], 'Riley Newcomb') === 'Riley Newcomb', 'and first in newest first');
  await page.selectOption('#sortBy', 'default');

  // ---- under a filter and an order, the same ----
  await page.selectOption('#stageFilter', 'emailed');
  await page.selectOption('#sortBy', 'name');
  await page.click('#pagerNext');
  await page.waitForFunction(() => document.querySelector('#pagerPage').textContent === 'Page 2 of 2');
  await s.call('PATCH', '/api/candidates/e05', { status: 'booked' });
  await look();
  await H.until(page, async () => (await H.text(page, '#pagerRange')) === '51–58 of 58');
  ok(await H.text(page, '#pagerRange') === '51–58 of 58' && await page.$eval('#stageFilter', (el) => el.value) === 'emailed' && await page.$eval('#sortBy', (el) => el.value) === 'name', 'filtered and sorted on page 2: one fewer Emailed, same page, same filter, same order', await H.text(page, '#pagerRange'));
  const names = await H.rowNames(page);
  ok(names.every((n, i) => i === 0 || names[i - 1].localeCompare(n) <= 0), 'still in name order');
  await page.selectOption('#stageFilter', 'all');
  await page.selectOption('#sortBy', 'default');

  // ---- an open profile follows its person ----
  await page.fill('#searchInput', B.e30.email);
  await H.until(page, async () => JSON.stringify(await H.rowIds(page)) === '["e30"]');
  await page.click('#candidateRows tr[data-id="e30"] [data-col="company"]');
  await page.waitForSelector('#profileModal:not([hidden])');
  await page.click('#profName');   // reading it, not choosing a status
  await s.call('PATCH', '/api/candidates/e30', { status: 'booked', role: 'Senior Account Executive' });
  await look();
  await H.until(page, async () => (await page.$eval('#profTags .status-select', (el) => el.value)) === 'booked');
  ok(await page.$eval('#profTags .status-select', (el) => el.value) === 'booked' && (await H.text(page, '#profSub')).startsWith('Senior Account Executive'), 'an open profile shows what changed elsewhere', await H.text(page, '#profSub'));
  await s.call('DELETE', '/api/candidates/e30');
  await look();
  await H.until(page, async () => page.$eval('#profileModal', (el) => el.hidden));
  ok(await page.$eval('#profileModal', (el) => el.hidden), 'and closes when they are removed elsewhere');
  await page.fill('#searchInput', '');
  await H.until(page, async () => (await H.countText(page)) === '149 candidates');
  ok(await H.countText(page) === '149 candidates', 'the count says 149');

  ok(errors.length === 0, 'no page errors', errors);
  ok(H.outside.length === 0, 'nothing reached the outside world', H.outside);
  await ctx.close();
  await browser.close();
  await s.close();
  done();
})().catch(crash);
