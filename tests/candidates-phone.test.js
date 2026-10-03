// Candidates page on a phone (390 px): each row is a card — name, badges,
// role · company, the number, a status pill that opens the phone's own
// picker, "Emailed …", and Call / Message / Mail through the phone's own
// apps. The filter menus fold away behind a Filters button that counts what
// is in force. Searching, pills, paging, ticking, changing a status, the
// texting order's rank badges and the profile sheet all work at this width.
const { launch, openPage, ok, done, crash } = require('./helpers');
const H = require('./candidates-helpers');

(async () => {
  const s = await H.startCandidates(92);
  const B = s.byId;
  const browser = await launch();
  const { ctx, page, errors } = await openPage(browser, s, { phone: true, path: '/#candidates' });
  const sendCalls = [];
  for (const path of ['**/api/send', '**/api/queue', '**/api/texts/queue', '**/api/iq/invite', '**/api/iq/from-pipeline', '**/api/onboarding/send']) {
    await page.route(path, (route) => { sendCalls.push(route.request().url()); route.abort(); });
  }
  await H.openCandidates(page);

  const seen = (sel) => page.$eval(sel, (el) => el.checkVisibility()).catch(() => false);
  const card = (id) => page.$eval(`#candidateRows tr[data-id="${id}"]`, (tr) => ({
    text: tr.innerText.split('\n').map((l) => l.trim()).filter(Boolean),
    roleCell: tr.querySelector('[data-col="role"]').checkVisibility(),
    companyCell: tr.querySelector('[data-col="company"]').checkVisibility(),
    face: tr.querySelector('.status-face').checkVisibility() ? tr.querySelector('.status-face').textContent : null,
    native: [...tr.querySelectorAll('.native-act')].filter((a) => a.checkVisibility()).map((a) => ({ label: a.innerText.trim(), href: a.getAttribute('href') || '', off: a.classList.contains('is-off') })),
  }));
  async function find(q, id) {
    await page.fill('#searchInput', q);
    await page.waitForFunction((x) => { const trs = document.querySelectorAll('#candidateRows tr'); return trs.length === 1 && trs[0].dataset.id === x; }, id);
  }
  const shown = () => H.countText(page);
  const toastTexts = async () => (await H.toasts(page)).map((t) => t.text);

  ok(await shown() === '150 candidates', 'the list opens on a phone with its count');
  ok(JSON.stringify((await H.pills(page)).map((p) => `${p.label} ${p.n}`)) === JSON.stringify(['Everyone 150', 'Best to text next 50', 'Replied 15', 'Not contacted 40', 'Booked 10', 'Needs a number 54', 'Sales IQ done 6', 'Docs awaiting signature 2', 'Docs signed 3']), 'the same pills, with the same numbers');
  ok(await seen('#candPager') && await H.text(page, '#pagerRange') === '1–50 of 150', 'fifty to a page, as on a laptop');

  // ---- a card ----
  const e34 = B.e34;
  let c = await card('e34');
  ok(JSON.stringify(c.text.slice(0, 4)) === JSON.stringify(['NU', e34.name, 'Docs · not sent', 'Timeshare Sales Agent · Seaside Resorts']) && c.text.includes('Docs · not sent') && c.text.includes('Timeshare Sales Agent · Seaside Resorts'), 'a card: initials, name, badge, role · company', c.text);
  ok(c.text.includes(e34.email) && c.text.includes('(617) 555-2073'), 'their address, and the number written properly', c.text);
  ok(c.face === 'Emailed' && c.text.includes('Emailed 11h ago') && !c.text.includes('11h ago'), 'a status pill, and when they were emailed in words', c);
  ok(!c.roleCell && !c.companyCell, 'no separate role and company columns');
  ok(JSON.stringify(c.native) === JSON.stringify([{ label: 'Call', href: 'tel:+16175552073', off: false }, { label: 'Message', href: 'sms:+16175552073', off: false }, { label: 'Mail', href: `mailto:${e34.email}`, off: false }]), 'Call, Message and Mail through the phone\'s own apps', c.native);
  c = await card('n01');
  ok(c.text.includes('+ add number') && c.text.includes('Not emailed yet') && c.face === 'Not contacted', 'no number: "+ add number"; never emailed: "Not emailed yet"', c.text);
  ok(JSON.stringify(c.native.map((n) => [n.label, n.off])) === JSON.stringify([['Call', true], ['Message', true], ['Mail', false]]), 'Call and Message are greyed with no number; Mail still works', c.native);
  await find('n16@example', 'n16');
  c = await card('n16');
  ok(c.text.includes('Office Manager · Dental Partners') && c.text.includes('was Solar Consultant +1 more'), 'what they did before is on the card too', c.text);
  await find('617.555.0111', 'e08');
  c = await card('e08');
  ok(c.text.includes('bad number') && JSON.stringify(c.native.map((n) => [n.label, n.off, n.href])) === JSON.stringify([['Call', false, 'tel:6175550111'], ['Message', false, 'sms:6175550111'], ['Mail', false, `mailto:${B.e08.email}`]]), 'a number that cannot be texted says so, but can still be rung', c.native);
  await page.fill('#searchInput', '');
  await H.until(page, async () => (await shown()) === '150 candidates');

  // "+ add number" on a card goes straight to the number.
  await page.tap('#candidateRows tr[data-id="n01"] [data-col="text"] .add-number');
  await page.waitForSelector('#addModal:not([hidden])');
  await H.focused(page, 'addPhone');
  ok(await H.text(page, '#addModalTitle') === `Edit ${B.n01.name}`, '"+ add number" opens them to edit, at the number');
  await page.tap('#addModal .modal-foot [data-close]');
  ok(await page.$eval('#profileModal', (el) => el.hidden), 'and does not open the profile underneath');

  // ---- the filters fold away ----
  ok(!(await seen('#candFilters')) && await seen('#filtersToggle'), 'the filter menus are folded away behind a Filters button');
  ok(await H.text(page, '#filtersLabel') === 'Filters' && await page.$eval('#filtersToggle', (b) => b.getAttribute('aria-expanded')) === 'false', 'which says "Filters"');
  await page.tap('#filtersToggle');
  ok(await seen('#candFilters') && await page.$eval('#filtersToggle', (b) => b.getAttribute('aria-expanded')) === 'true', 'tapped, they open');
  await page.selectOption('#stageFilter', 'replied');
  ok(await H.settle(page, shown, '15 of 150') === '15 of 150' && await H.text(page, '#filtersLabel') === 'Filters · 1', 'a stage: 15, and the button says one filter is on', await H.text(page, '#filtersLabel'));
  await page.selectOption('#iqFilter', 'completed');
  ok(await H.settle(page, shown, '1 of 150') === '1 of 150' && JSON.stringify(await H.rowIds(page)) === '["r05"]' && await H.text(page, '#filtersLabel') === 'Filters · 2', 'and Sales IQ done: the one person, "Filters · 2"');
  await page.tap('#filtersToggle');
  ok(!(await seen('#candFilters')) && await H.text(page, '#filtersLabel') === 'Filters · 2', 'folded again, the button still says two are on');
  ok(await seen('#activeFilters'), 'and the chips are still showing');
  await page.tap('#activeFilters [data-clear="all"]');
  await H.until(page, async () => (await shown()) === '150 candidates');
  ok(await shown() === '150 candidates' && await H.text(page, '#filtersLabel') === 'Filters', '"Clear all" from the chips', await H.text(page, '#filtersLabel'));

  // ---- pills, paging, search ----
  await page.tap('#candViews .view-pill:nth-child(6)');
  ok(await H.settle(page, shown, '54 of 150') === '54 of 150' && (await H.pills(page)).find((p) => p.on).label === 'Needs a number', 'tapping "Needs a number": 54');
  await page.tap('#candViews .view-pill:nth-child(1)');
  await H.settle(page, shown, '150 candidates');
  await page.tap('#pagerNext');
  await page.waitForFunction(() => document.querySelector('#pagerRange').textContent === '51–100 of 150');
  ok(await H.text(page, '#pagerPage') === 'Page 2 of 3', 'Next: page 2');
  await page.tap('#pagerPrev');
  await page.waitForFunction(() => document.querySelector('#pagerRange').textContent === '1–50 of 150');
  await find('+1 617 555 2043', 'e04');
  ok(true, 'searching by number on a phone finds them');
  await page.fill('#searchInput', '');
  await H.until(page, async () => (await shown()) === '150 candidates');

  // ---- texting order: the rank is a badge on the avatar ----
  await page.tap('#candViews .view-pill:nth-child(2)');
  await page.waitForFunction(() => !document.querySelector('#rankHead').hidden && (document.querySelector('#candidateRows tr [data-col="rank"]') || {}).textContent === '1');
  const ranks = await page.$$eval('#candidateRows [data-col="rank"]', (tds) => tds.slice(0, 3).map((td) => (td.checkVisibility() ? td.textContent.trim() : null)));
  ok(JSON.stringify(ranks) === '["1","2","3"]' && JSON.stringify((await H.rowNames(page)).slice(0, 3)) === JSON.stringify(['Jules Ashdown', 'Noel Underhill', 'Morgan Thorne']), 'Best to text next: numbered badges, best first', ranks);
  await page.tap('#filtersToggle');
  await page.selectOption('#rankFilter', '');
  await H.settle(page, shown, '150 candidates');
  await page.tap('#pagerNext');
  await page.waitForFunction(() => document.querySelector('#pagerPage').textContent === 'Page 2 of 3');
  const unranked = await page.$$eval('#candidateRows tr.row-muted [data-col="rank"]', (tds) => tds.map((td) => td.checkVisibility()));
  ok(unranked.length === 40 && unranked.every((v) => !v), 'nobody unranked gets a badge', unranked.length);
  await page.selectOption('#sortBy', 'default');
  await page.tap('#filtersToggle');
  await page.tap('#candViews .view-pill:nth-child(1)');
  await H.settle(page, async () => (await H.rowIds(page))[1], 'e34');

  // ---- changing a status with the phone's own picker ----
  await page.selectOption('#candidateRows tr[data-id="e34"] .status-select', 'replied');
  ok((await card('e34')).face === 'Replied', 'the pill says the new status straight away');
  await H.until(page, async () => (await s.store.load()).candidates.find((x) => x.id === 'e34').status === 'replied');
  ok((await s.store.load()).candidates.find((x) => x.id === 'e34').status === 'replied', 'the server stores it');
  await H.until(page, async () => ((await H.pills(page)).find((p) => p.label === 'Replied') || {}).n === '16');
  ok(((await H.pills(page)).find((p) => p.label === 'Replied') || {}).n === '16' && (await card('e34')).face === 'Replied', 'the Replied pill counts them, and the card still says Replied');
  await page.route('**/api/candidates/e10', (route) => (route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Could not save just now.' }) }) : route.continue()));
  await page.selectOption('#candidateRows tr[data-id="e10"] .status-select', 'booked');
  await H.until(page, async () => (await toastTexts()).includes('Could not save just now.'));
  ok((await toastTexts()).includes('Could not save just now.') && (await s.store.load()).candidates.find((x) => x.id === 'e10').status === 'emailed', 'a failed save says so, and the server keeps what it had');
  await page.unroute('**/api/candidates/e10');

  // ---- ticking on a phone ----
  await page.tap('#candidateRows tr[data-id="x12"] .row-check');
  ok(await H.settle(page, async () => (await seen('#selectionBar')) && H.text(page, '#selCount'), '1 selected') === '1 selected', 'tapping the box selects them');
  ok(await page.$eval('#profileModal', (el) => el.hidden), 'without opening their profile');
  await page.tap('#selClearBtn');
  ok(await H.settle(page, () => seen('#selectionBar'), false) === false, 'Clear');

  // ---- the profile, as a sheet ----
  await page.tap(`#candidateRows tr[data-id="n01"] .cand-name`);
  await page.waitForSelector('#profileModal:not([hidden])');
  const prof = await page.$eval('#profileModal', (m) => ({
    name: m.querySelector('#profName').textContent,
    acts: [...m.querySelectorAll('#profActs .profile-act')].map((b) => b.innerText.trim()),
    native: [...m.querySelectorAll('#profNative .native-act')].filter((a) => a.checkVisibility()).map((a) => a.innerText.trim()),
  }));
  ok(prof.name === B.n01.name && JSON.stringify(prof.acts) === JSON.stringify(['Email', 'Add #', 'Sales IQ', 'Docs']), 'tapping a card opens their profile, with short labels', prof);
  ok(JSON.stringify(prof.native) === JSON.stringify(['Call', 'Message', 'Mail']), 'and the phone\'s own Call, Message and Mail', prof.native);
  await page.tap('#profileModal .profile-close');
  ok(await page.$eval('#profileModal', (el) => el.hidden), 'the × closes it');

  ok(sendCalls.length === 0, 'nothing was sent from the page', sendCalls);
  ok(errors.length === 0, 'no page errors', errors);
  ok(H.outside.length === 0, 'nothing reached the outside world', H.outside);
  await ctx.close();
  await browser.close();
  await s.close();
  done();
})().catch(crash);
