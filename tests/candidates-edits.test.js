// Candidates page on a laptop: an edit reaches every part of the list, not
// just the row. Renamed, given a new job, given a number — here, or on
// another device — the person is found by what is on file now and not by
// what was there before; the role and industry menus, the name order, the
// texting filters and the "Needs a number" pill all count them where they
// are now. A search that is typed stays typed when news arrives, and the
// pager never strands you on a page that has gone.
const { launch, openPage, ok, done, crash } = require('./helpers');
const H = require('./candidates-helpers');

(async () => {
  const s = await H.startCandidates(98);
  const P = s.people;
  const B = s.byId;
  const browser = await launch();
  const { ctx, page, errors } = await openPage(browser, s, { path: '/#candidates' });
  const sendCalls = [];
  for (const path of ['**/api/send', '**/api/queue', '**/api/texts/queue', '**/api/iq/invite', '**/api/iq/from-pipeline', '**/api/onboarding/send']) {
    await page.route(path, (route) => { sendCalls.push(route.request().url()); route.abort(); });
  }
  await H.openCandidates(page);

  const shown = () => H.countText(page);
  const chips = () => page.$$eval('#activeFilters .filter-tag', (bs) => bs.map((b) => b.textContent.replace('×', '').trim()));
  const toastTexts = async () => (await H.toasts(page)).map((t) => t.text);
  const pillN = async (label) => ((await H.pills(page)).find((p) => p.label === label) || {}).n;
  const look = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const stored = async (id) => (await s.store.load()).candidates.find((c) => c.id === id);
  // Type a search and wait for the list to take it up (its chip says so).
  async function search(q, want) {
    await page.fill('#searchInput', q);
    await H.until(page, async () => { const c = await chips(); return q ? c.includes(`Search: “${q}”`) : !c.some((x) => x.startsWith('Search:')); });
    if (want !== undefined) await H.settle(page, shown, want);
    return { count: await shown(), ids: (await H.rowIds(page)).sort() };
  }
  async function pick(sel, value, want) {
    await page.selectOption(sel, value);
    return H.settle(page, shown, want);
  }

  // ---- Edit details: a new first name, a new job ----
  const n01 = B.n01;
  ok(n01.name === 'Avery Quill' && n01.role === 'Merchant Services Consultant' && !n01.phone && P[0].id === 'n01', `${n01.name}, a merchant services consultant with no number, is first in the order added`);
  await page.click('#candidateRows tr[data-id="n01"] [data-col="company"]');
  await page.waitForSelector('#profileModal:not([hidden])');
  await page.click('#profEdit');
  await page.waitForSelector('#addModal:not([hidden])');
  await H.focused(page, 'addFirst');
  await page.fill('#addFirst', 'Zara');
  await page.fill('#addRole', 'Pest Control Sales');
  await page.fill('#addCompany', 'Greenleaf Pest Control');
  await page.click('#addSaveBtn');
  await H.until(page, async () => (await toastTexts()).includes('Saved.'));
  ok((await toastTexts()).includes('Saved.') && await page.$eval('#addModal', (el) => el.hidden), '"Saved." and the window closes', await toastTexts());
  const saved = await stored('n01');
  ok(saved.name === 'Zara Quill' && saved.firstName === 'Zara' && saved.lastName === 'Quill' && saved.role === 'Pest Control Sales' && saved.company === 'Greenleaf Pest Control' && saved.email === n01.email && saved.status === 'new', 'the server stores the new name and job, and nothing else about them changes', saved);
  const row = await H.settle(page, () => page.$eval('#candidateRows tr[data-id="n01"]', (tr) => [tr.querySelector('.cand-name').textContent.trim(), tr.querySelector('[data-col="role"]').innerText.trim(), tr.querySelector('[data-col="company"]').innerText.trim()]), ['Zara Quill', 'Pest Control Sales', 'Greenleaf Pest Control']);
  ok(JSON.stringify(row) === JSON.stringify(['Zara Quill', 'Pest Control Sales', 'Greenleaf Pest Control']), 'their row says so', row);
  ok(JSON.stringify(await H.options(page, '#roleFilter')) === JSON.stringify(['All roles (150)', 'Account Executive (19)', 'Alarm Systems Rep (10)', 'Inside Sales Associate (10)', 'Insurance Agent (10)', 'Pest Control Sales (10)', 'Solar Consultant (10)', 'Car Sales Consultant (9)', 'Fiber Sales Rep (9)', 'Merchant Services Consultant (9)', 'Office Manager (9)', 'Roofing Sales Rep (9)', 'Server (9)', 'Small Business Consultant (9)', 'Timeshare Sales Agent (9)', 'No role on file (9)']),
    'the role menu counts them under their new role, and one fewer under the old', await H.options(page, '#roleFilter'));
  const ind = await H.options(page, '#industryFilter');
  ok(ind.includes('Pest control (10)') && ind.includes('Merchant services & payments (9)'), 'the industry menu moves them from payments to pest control', ind);
  ok(await pick('#roleFilter', 'pest control sales', '10 of 150') === '10 of 150' && (await H.rowIds(page)).includes('n01'), 'filtering by their new role finds them');
  await pick('#roleFilter', 'merchant services consultant', '9 of 150');
  ok(!(await H.rowIds(page)).includes('n01'), 'filtering by the old one does not');
  await pick('#roleFilter', '', '150 candidates');
  await pick('#industryFilter', 'pest', '10 of 150');
  ok((await H.rowIds(page)).includes('n01'), 'nor does the industry filter leave them behind');
  await pick('#industryFilter', '', '150 candidates');

  let r = await search('Zara', '1 of 150');
  ok(r.count === '1 of 150' && JSON.stringify(r.ids) === '["n01"]', 'searching the new name finds them', r);
  r = await search('Avery Quill', '0 of 150');
  ok(r.count === '0 of 150', 'the old name finds nobody', r.count);
  r = await search('Greenleaf', '10 of 150');
  ok(r.count === '10 of 150' && r.ids.includes('n01'), 'their new employer finds them with the other nine there', r.count);
  r = await search('Harborline', '9 of 150');
  ok(r.count === '9 of 150' && !r.ids.includes('n01'), 'the old employer no longer does', r.count);
  await search('', '150 candidates');

  // Name A–Z puts them where the new name goes: last.
  const nowNames = P.map((c) => (c.id === 'n01' ? 'Zara Quill' : c.name));
  const byName = P.map((c, i) => ({ c, name: nowNames[i] })).sort((a, b) => String(a.name || a.c.email).localeCompare(String(b.name || b.c.email))).map((x) => x.name || '—');
  await page.selectOption('#sortBy', 'name');
  const first = await H.settle(page, H.rowNames, byName.slice(0, 50));
  ok(JSON.stringify(first) === JSON.stringify(byName.slice(0, 50)), 'Name A–Z, page 1, with them out of the As', first.slice(0, 3));
  await page.click('#pagerNext');
  await page.waitForFunction(() => document.querySelector('#pagerPage').textContent === 'Page 2 of 3');
  await page.click('#pagerNext');
  await page.waitForFunction(() => document.querySelector('#pagerPage').textContent === 'Page 3 of 3');
  const last = await H.rowNames(page);
  ok(JSON.stringify(last) === JSON.stringify(byName.slice(100)) && last[49] === 'Zara Quill', 'and on the last page, Zara Quill at the very end', last.slice(-2));
  await page.selectOption('#sortBy', 'default');
  await H.settle(page, async () => (await H.rowIds(page))[0], 'n01');

  // ---- a number, from the row's "+ add number" ----
  ok(await pillN('Needs a number') === '54', '54 need a number before');
  await page.click('#candidateRows tr[data-id="n01"] [data-col="text"] .add-number');
  await page.waitForSelector('#addModal:not([hidden])');
  await H.focused(page, 'addPhone');
  ok(await H.text(page, '#addModalTitle') === 'Edit Zara Quill', '"+ add number" opens them, under their new name', await H.text(page, '#addModalTitle'));
  await page.fill('#addPhone', '617-555-2999');
  await page.click('#addSaveBtn');
  await H.until(page, async () => (await toastTexts()).includes('Saved. (617) 555-2999 is ready to text.'));
  ok((await stored('n01')).phone === '617-555-2999', 'the server stores the number as typed');
  ok(await H.settle(page, () => pillN('Needs a number'), '53') === '53', '"Needs a number" says 53');
  ok(await H.settle(page, () => page.$eval('#candidateRows tr[data-id="n01"] [data-col="text"]', (td) => td.innerText.trim()), '(617) 555-2999') === '(617) 555-2999', 'the Text column shows it, written properly');
  for (const q of ['(617) 555-2999', '6175552999', '+1 617 555 2999']) {
    r = await search(q, '1 of 150');
    ok(JSON.stringify(r.ids) === '["n01"]', `the number they were just given finds them, typed "${q}"`, r);
  }
  await search('', '150 candidates');
  ok(await pick('#textedFilter', 'nonumber', '53 of 150') === '53 of 150' && !(await H.rowIds(page)).includes('n01'), 'Texting "No phone number": 53, without them');
  ok(await pick('#textedFilter', 'ready', '61 of 150') === '61 of 150' && (await H.rowIds(page)).includes('n01'), 'Texting "Ready to text": 61, with them (the server ranks them now)');
  await pick('#textedFilter', '', '150 candidates');
  ok(await pick('#rankFilter', '200', '61 of 150') === '61 of 150', 'and the texting order has room for them: 61 in the top 200');
  await pick('#rankFilter', '', '150 candidates');
  ok(await pillN('Best to text next') === '50', 'Best to text next still offers fifty');

  // ---- edited on another device ----
  const e05 = B.e05;
  ok(e05.name === 'Oakley Sable' && e05.phone === '(617) 555-2044' && e05.location === 'Austin, TX', `${e05.name}, in Austin, on (617) 555-2044`);
  const patched = await s.call('PATCH', '/api/candidates/e05', { name: 'Robin Sable', firstName: 'Robin', email: 'robin.sable@example.com', phone: '', location: 'Denver, CO', notes: 'Prefers mornings' });
  ok(patched.status === 200, 'elsewhere: renamed, a new address, the number taken off, moved to Denver');
  await look();
  ok(await H.settle(page, () => pillN('Needs a number'), '54') === '54', 'the next look brings it in: "Needs a number" is 54 again');
  r = await search(e05.email, '0 of 150');
  ok(r.count === '0 of 150', 'their old address finds nobody', r.count);
  r = await search('617-555-2044', '0 of 150');
  ok(r.count === '0 of 150', 'nor does their old number', r.count);
  r = await search('Denver', '1 of 150');
  ok(JSON.stringify(r.ids) === '["e05"]', 'their new town finds them', r);
  r = await search('robin.sable@', '1 of 150');
  const e05Row = await page.$eval('#candidateRows tr[data-id="e05"]', (tr) => ({ name: tr.querySelector('.cand-name').textContent.trim(), email: tr.querySelector('[data-col="email"]').textContent.trim(), text: tr.querySelector('[data-col="text"]').innerText.trim() }));
  ok(JSON.stringify(e05Row) === JSON.stringify({ name: 'Robin Sable', email: 'robin.sable@example.com', text: '+ add number' }), 'their new address finds them: the new name, the new address, and an offer to add a number', e05Row);
  r = await search('Austin', '49 of 150');
  ok(r.count === '49 of 150' && !r.ids.includes('e05'), 'Austin has one fewer', r.count);
  await search('Robin Sable', '1 of 150');
  await page.click('#candidateRows tr[data-id="e05"] [data-col="company"]');
  await page.waitForSelector('#profileModal:not([hidden])');
  ok(await H.text(page, '#profName') === 'Robin Sable' && await H.text(page, '#profNotes') === 'Prefers mornings' && (await H.text(page, '#profSub')).endsWith('Denver, CO'), 'their profile says it all too', [await H.text(page, '#profName'), await H.text(page, '#profNotes')]);
  await page.keyboard.press('Escape');

  // ---- a search stays typed while news arrives ----
  r = await search('Northwind', '10 of 150');
  ok(r.count === '10 of 150', '"Northwind": ten people', r.count);
  const add = await s.json('POST', '/api/candidates', { firstName: 'Riley', lastName: 'Newcomb', name: 'Riley Newcomb', email: 'riley.newcomb@example.com', phone: '(617) 555-2998', role: 'Account Executive', company: 'Northwind Logistics' });
  ok(add.status === 200 && add.body.candidate, 'elsewhere: somebody from Northwind is added');
  const newId = add.body.candidate.id;
  await look();
  ok(await H.settle(page, shown, '11 of 151') === '11 of 151', 'the search takes them in: 11 of 151', await shown());
  ok((await H.rowIds(page)).includes(newId) && await page.$eval('#searchInput', (el) => el.value) === 'Northwind' && JSON.stringify(await chips()) === JSON.stringify(['Search: “Northwind”']), 'the box still says Northwind, and its chip is still there');

  // ---- the pager when the last page goes ----
  await search('', '151 candidates');
  for (let i = 2; i <= 4; i++) {
    await page.click('#pagerNext');
    await page.waitForFunction((n) => document.querySelector('#pagerPage').textContent === `Page ${n} of 4`, i);
  }
  ok(await H.text(page, '#pagerRange') === '151–151 of 151' && JSON.stringify(await H.rowNames(page)) === '["Riley Newcomb"]', 'a fourth page, holding only the newcomer', await H.text(page, '#pagerRange'));
  ok((await s.call('DELETE', `/api/candidates/${newId}`)).status === 200, 'elsewhere: the newcomer is removed again');
  await look();
  ok(await H.settle(page, () => H.text(page, '#pagerPage'), 'Page 3 of 3') === 'Page 3 of 3', 'the page they were on is gone: the last page that is left', await H.text(page, '#pagerPage'));
  ok(await H.text(page, '#pagerRange') === '101–150 of 150' && (await H.rowIds(page)).length === 50 && await page.$eval('#pagerNext', (b) => b.disabled) && !(await page.$eval('#pagerPrev', (b) => b.disabled)), '"101–150 of 150", Next off, Previous on');

  ok(sendCalls.length === 0, 'nothing was sent from the page', sendCalls);
  ok(errors.length === 0, 'no page errors', errors);
  ok(H.outside.length === 0, 'nothing reached the outside world', H.outside);
  await ctx.close();
  await browser.close();
  await s.close();
  done();
})().catch(crash);
