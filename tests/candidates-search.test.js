// Candidates page on a laptop: the search box. By name, email, company,
// role, past roles and location, and by phone number however it was stored
// and however it is typed back — (617) 555-2044, 617-555-2044, 6175552044,
// +1 617 555 2044 all find the same person. Search works with the filters
// and the order, says itself as a chip, and clears.
const { launch, openPage, ok, done, crash } = require('./helpers');
const H = require('./candidates-helpers');

(async () => {
  const s = await H.startCandidates(84);
  const P = s.people;
  const B = s.byId;
  const browser = await launch();
  const { ctx, page, errors } = await openPage(browser, s, { path: '/#candidates' });
  await H.openCandidates(page);

  const shown = () => H.countText(page);
  // Type a search the way a person does (the list follows a moment later).
  async function search(q, { typed = false } = {}) {
    const before = await shown();
    if (typed) { await page.fill('#searchInput', ''); await page.type('#searchInput', q, { delay: 20 }); }
    else await page.fill('#searchInput', q);
    // The list redraws a beat after the last keystroke.
    await H.until(page, async () => {
      const chips = await page.$$eval('#activeFilters .filter-tag', (bs) => bs.map((b) => b.textContent.replace('×', '').trim()));
      return q ? chips.includes(`Search: “${q}”`) : !chips.some((c) => c.startsWith('Search:'));
    });
    return { count: await shown(), ids: (await H.rowIds(page)).sort(), before };
  }
  const idsWhere = (fn) => P.filter(fn).map((c) => c.id).sort();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ---- by name ----
  let r = await search('quill', { typed: true });
  ok(r.count === '15 of 150' && same(r.ids, idsWhere((c) => c.lastName === 'Quill')), 'a last name, typed in lower case, finds the fifteen Quills', r.count);
  ok(JSON.stringify(await page.$$eval('#activeFilters .filter-tag', (bs) => bs.map((b) => b.textContent.replace('×', '').trim()))) === JSON.stringify(['Search: “quill”']), 'a chip says what was searched for');
  r = await search('Noel Underhill');
  ok(r.count === '1 of 150' && (await H.rowNames(page))[0] === 'Noel Underhill', 'a full name finds that one person', r.count);
  r = await search('  Noel Underhill  ');
  ok(r.count === '1 of 150', 'spaces around it do not matter', r.count);

  // ---- by email ----
  r = await search('e33@example');
  ok(r.count === '1 of 150' && same(r.ids, ['e33']), 'part of an email address', r.ids);
  r = await search('WHOLESALEPAYMENTS.COM');
  ok(same(r.ids, ['e40']), 'an address in capitals still matches', r.ids);
  r = await search('no.name.n40');
  ok(same(r.ids, ['n40']) && (await H.rowNames(page))[0] === '—', 'someone with only an email is found by it', await H.rowNames(page));

  // ---- by company, role, past roles, location ----
  r = await search('brightfield solar');
  ok(r.count === '10 of 150' && same(r.ids, idsWhere((c) => c.company === 'Brightfield Solar')), 'a company', r.count);
  r = await search('Timeshare');
  ok(r.count === '9 of 150' && same(r.ids, idsWhere((c) => c.role === 'Timeshare Sales Agent')), 'a role', r.count);
  r = await search('account executive');
  ok(r.count === '19 of 150', 'a role written two ways finds both', r.count);
  r = await search('door to door');
  ok(r.count === '9 of 150' && same(r.ids, idsWhere((c) => /door to door/i.test(c.pastRoles))), 'something they did before', r.count);
  r = await search('Austin');
  ok(r.count === '50 of 150' && same(r.ids, idsWhere((c) => c.location === 'Austin, TX')), 'where they live', r.count);
  ok(await page.$eval('#candPager', (el) => el.hidden), 'fifty fit on one page: no pager');
  r = await search('spring job fair');
  ok(r.count === '0 of 150', 'notes are not searched', r.count);

  // ---- by phone, however it is written ----
  ok(B.e05.phone === '(617) 555-2044' && B.e06.phone === '617.555.2045' && B.e03.phone === '+1 617 555 2042' && B.e04.phone === '6175552043', 'four people whose numbers were stored four different ways');
  for (const [q, id] of [['(617) 555-2044', 'e05'], ['617-555-2044', 'e05'], ['6175552044', 'e05'], ['+1 617 555 2044', 'e05'], ['1 (617) 555-2045', 'e06'],
    ['617 555 2042', 'e03'], ['(617) 555-2042', 'e03'], ['555-2043', 'e04'], ['2043', 'e04'], ['+16175552043', 'e04']]) {
    r = await search(q);
    ok(same(r.ids, [id]), `phone "${q}" finds ${B[id].name} (stored as ${B[id].phone})`, r.ids);
  }
  r = await search('555');
  ok(r.count === '119 of 150', '"555" finds everyone with a number', r.count);
  r = await search('617.555.01');
  ok(r.count === '23 of 150' && same(r.ids, idsWhere((c) => /555-01\d\d$/.test(c.phone))), 'the start of a number finds every number that starts that way', r.count);
  const pip = await page.$$eval('#candidateRows [data-col="text"] .text-pip', (ps) => [...new Set(ps.map((p) => p.textContent.trim()))]);
  ok(JSON.stringify(pip) === JSON.stringify(['bad number']), '  (those are the numbers that cannot be texted, and each says so)', pip);

  // ---- with the filters and the order ----
  r = await search('Austin');
  await page.selectOption('#stageFilter', 'emailed');
  ok(await H.settle(page, shown, '20 of 150') === '20 of 150' && same((await H.rowIds(page)).sort(), idsWhere((c) => c.location === 'Austin, TX' && c.status === 'emailed')), 'a search and a stage together', await shown());
  ok((await page.$$eval('#activeFilters .filter-tag', (bs) => bs.length)) === 2, 'two chips');
  await page.selectOption('#sortBy', 'name');
  const wantNames = P.filter((c) => c.location === 'Austin, TX' && c.status === 'emailed').map((c) => c.name).sort((a, b) => a.localeCompare(b));
  const names = await H.settle(page, H.rowNames, wantNames);
  ok(same(names, wantNames), 'in the order chosen', names.slice(0, 3));
  await page.selectOption('#sortBy', 'default');
  await page.selectOption('#stageFilter', 'all');
  await H.settle(page, shown, '50 of 150');

  // A search starts again at page 1.
  await search('');
  ok(await shown() === '150 candidates', 'emptying the box shows everyone');
  await page.click('#pagerNext');
  await page.waitForFunction(() => document.querySelector('#pagerPage').textContent === 'Page 2 of 3');
  r = await search('Ashdown');
  ok(r.count === '15 of 150' && await page.$eval('#candPager', (el) => el.hidden), 'searching from page 2 shows the first (and only) page of results', r.count);

  // ---- nobody, and clearing ----
  r = await search('zzzz');
  ok(r.count === '0 of 150' && await H.visible(page, '#candidatesNoMatch'), 'a search that finds nobody says nobody matches', r.count);
  await page.click('#activeFilters .filter-tag');
  await H.until(page, async () => (await shown()) === '150 candidates');
  ok(await shown() === '150 candidates' && await page.$eval('#searchInput', (el) => el.value) === '', 'the chip\'s × clears the search and the box');
  await search('zzzz');
  await page.click('#emptyClear');
  await H.until(page, async () => (await shown()) === '150 candidates');
  ok(await page.$eval('#searchInput', (el) => el.value) === '' && await shown() === '150 candidates', '"Clear the filters" clears a search too');

  ok(errors.length === 0, 'no page errors', errors);
  ok(H.outside.length === 0, 'nothing reached the outside world', H.outside);
  await ctx.close();
  await browser.close();
  await s.close();
  done();
})().catch(crash);
