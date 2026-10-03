// Candidates page on a laptop, from empty: the "No candidates yet" state,
// adding somebody by hand ("Add manually") — what is refused and why, what is
// stored, how the list and its counts take them in — and the list filling up
// when a large batch arrives from elsewhere.
const { launch, openPage, ok, done, crash, startApp } = require('./helpers');
const H = require('./candidates-helpers');

(async () => {
  const s = await startApp({ offset: 96 });
  H.guardOutside();
  const browser = await launch();
  const { ctx, page, errors } = await openPage(browser, s, { path: '/#candidates' });
  await page.waitForFunction(() => document.querySelector('#view-candidates.active'));
  await page.waitForFunction(() => document.querySelector('#candidatesEmpty').style.display === 'block');
  const sendCalls = [];
  await page.route('**/api/send', (route) => { sendCalls.push(route.request().url()); route.abort(); });
  const toastTexts = async () => (await H.toasts(page)).map((t) => t.text);

  // ---- an empty list ----
  ok(await H.visible(page, '#candidatesEmpty') && await H.text(page, '#candidatesEmpty h3') === 'No candidates yet', 'an empty list says "No candidates yet"');
  ok(!(await H.visible(page, '#candidatesNoMatch')) && await H.countText(page) === '' && (await H.pills(page)).length === 0, 'no "nobody matches", no count, no pills');
  ok((await H.rowIds(page)).length === 0 && await page.$eval('#candPager', (el) => el.hidden), 'no rows, no pager');
  await page.click('#candidatesEmpty [data-goto="import"]');
  await page.waitForFunction(() => document.querySelector('#view-import.active'));
  ok(true, '"Import candidates" goes to Import');
  await page.evaluate(() => document.querySelector('.nav-item[data-view="candidates"]').click());
  await page.waitForFunction(() => document.querySelector('#view-candidates.active'));

  // ---- Add manually ----
  await page.click('#addCandidateBtn');
  await page.waitForSelector('#addModal:not([hidden])');
  ok(await H.text(page, '#addModalTitle') === 'Add candidate' && await H.text(page, '#addSaveBtn') === 'Add candidate', 'Add manually opens an empty "Add candidate" window');
  await H.focused(page, 'addFirst');
  ok(true, 'with the cursor in the first name');
  ok((await page.$$eval('#addModal input', (is) => is.map((i) => i.value))).every((v) => v === ''), 'every field empty');
  ok(await H.text(page, '#addPhoneHint') === 'US and Canadian numbers in any format. Leave blank if you only have an email.', 'the number field says what it takes');
  await page.fill('#addFirst', 'Quinn');
  await page.fill('#addLast', 'Harlow');
  await page.fill('#addEmail', 'not-an-address');
  await page.click('#addSaveBtn');
  await H.until(page, async () => (await toastTexts()).length > 0);
  ok((await toastTexts()).includes('A valid email address is required.') && !(await page.$eval('#addModal', (el) => el.hidden)), 'a bad address is refused, and the window stays open', await toastTexts());
  await page.fill('#addEmail', 'Quinn.Harlow@Example.com');
  await page.fill('#addRole', 'Merchant Services Consultant');
  await page.fill('#addCompany', 'Harborline Payments');
  await page.fill('#addLocation', 'Austin, TX');
  await page.click('#addSaveBtn');
  await H.until(page, async () => (await toastTexts()).includes('Candidate added.'));
  ok((await toastTexts()).includes('Candidate added.') && await page.$eval('#addModal', (el) => el.hidden), '"Candidate added." and the window closes');
  const db = await s.store.load();
  const q = db.candidates[0];
  ok(db.candidates.length === 1 && q.name === 'Quinn Harlow' && q.email === 'Quinn.Harlow@Example.com' && q.status === 'new' && q.source === 'manual' && q.phone === '' && q.role === 'Merchant Services Consultant', 'the server stores them: not contacted, added by hand', q);
  await H.until(page, async () => (await H.countText(page)) === '1 candidate');
  ok(await H.countText(page) === '1 candidate', 'the count says "1 candidate"', await H.countText(page));
  ok(!(await H.visible(page, '#candidatesEmpty')) && JSON.stringify(await H.rowNames(page)) === '["Quinn Harlow"]', 'the empty message goes; their row is there');
  ok(JSON.stringify((await H.pills(page)).map((p) => `${p.label} ${p.n}`)) === JSON.stringify(['Everyone 1', 'Not contacted 1', 'Needs a number 1']), 'only the pills with somebody in them show', await H.pills(page));
  ok((await H.options(page, '#industryFilter')).includes('Merchant services & payments (1)'), 'their industry is in the menu');

  // The same person again, however the address is written, is refused.
  await page.click('#addCandidateBtn');
  await H.focused(page, 'addFirst');
  await page.fill('#addFirst', 'Quinn');
  await page.fill('#addEmail', 'quinn.harlow@example.com');
  await page.click('#addSaveBtn');
  await H.until(page, async () => (await toastTexts()).includes('A candidate with that email already exists.'));
  ok((await toastTexts()).includes('A candidate with that email already exists.') && (await s.store.load()).candidates.length === 1, 'the same address in other capitals is refused; still one on the server');
  await page.click('#addModal .modal-foot [data-close]');
  ok(await page.$eval('#addModal', (el) => el.hidden), 'Cancel closes the window');

  // ---- a big batch arrives from elsewhere ----
  const people = H.buildPeople();
  await s.store.update((d) => { d.candidates.push(...people.map((c) => ({ ...c }))); });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await H.until(page, async () => (await H.countText(page)) === '151 candidates');
  ok(await H.countText(page) === '151 candidates', 'the list takes them in: 151', await H.countText(page));
  ok(await H.text(page, '#pagerRange') === '1–50 of 151' && await H.text(page, '#pagerPage') === 'Page 1 of 4', 'four pages now');
  ok((await H.rowNames(page))[0] === 'Quinn Harlow', 'the one added by hand is still first in the order added');
  const pl = Object.fromEntries((await H.pills(page)).map((p) => [p.label, p.n]));
  ok(pl.Everyone === '151' && pl['Not contacted'] === '41' && pl['Needs a number'] === '55', 'and the pills count everyone', pl);

  ok(sendCalls.length === 0, 'nothing was sent', sendCalls);
  ok(errors.length === 0, 'no page errors', errors);
  ok(H.outside.length === 0, 'nothing reached the outside world', H.outside);
  await ctx.close();
  await browser.close();
  await s.close();
  done();
})().catch(crash);
