// Candidates page on a laptop: changing someone's status from the list (and
// from their profile). The row says the new status at once; the server
// stores it; the stage menu, the pills and the texting order all follow.
// Marking someone "Not interested" puts their number on the texting opt-out
// list, and that stays even if the status is changed back — nobody who said
// no is texted. A save that fails says so, and nothing changes on the server.
const { R, launch, openPage, ok, done, crash } = require('./helpers');
const H = require('./candidates-helpers');

(async () => {
  const s = await H.startCandidates(88);
  const B = s.byId;
  const browser = await launch();
  const { ctx, page, errors } = await openPage(browser, s, { path: '/#candidates' });
  await H.openCandidates(page);

  const stored = async (id) => (await s.store.load()).candidates.find((c) => c.id === id).status;
  const rowStatus = (id) => page.$eval(`#candidateRows tr[data-id="${id}"] .status-select`, (el) => el.selectedOptions[0].textContent);
  const stageMenu = () => H.options(page, '#stageFilter');
  const pillN = async (label) => ((await H.pills(page)).find((p) => p.label === label) || {}).n;
  const toastTexts = async () => (await H.toasts(page)).map((t) => t.text);
  async function change(id, value) {
    const before = JSON.stringify(await stageMenu());
    await page.selectOption(`#candidateRows tr[data-id="${id}"] .status-select`, value);
    await H.until(page, async () => JSON.stringify(await stageMenu()) !== before);
  }
  const menuFor = (n) => ['Any stage (150)', `Not contacted (${n.new})`, `Emailed (${n.emailed})`, `Replied (${n.replied})`, `Booked (${n.booked})`, `Not interested (${n.declined})`, `Bounced (${n.bounced})`];
  const n = { ...H.EXPECT.stage };
  ok(JSON.stringify(await stageMenu()) === JSON.stringify(menuFor(n)), 'the stage menu before anything changes');

  // ---- Emailed → Replied ----
  ok(B.e34.status === 'emailed' && await rowStatus('e34') === 'Emailed', `${B.e34.name} is Emailed`);
  await page.selectOption('#candidateRows tr[data-id="e34"] .status-select', 'replied');
  ok(await rowStatus('e34') === 'Replied', 'choosing Replied: the row says Replied straight away');
  await H.until(page, async () => (await stored('e34')) === 'replied');
  ok(await stored('e34') === 'replied', 'the server stores it');
  n.emailed -= 1; n.replied += 1;
  await H.until(page, async () => JSON.stringify(await stageMenu()) === JSON.stringify(menuFor(n)));
  ok(JSON.stringify(await stageMenu()) === JSON.stringify(menuFor(n)), 'the stage menu moves one from Emailed to Replied', await stageMenu());
  ok(await pillN('Replied') === '16' && await H.countText(page) === '150 candidates', 'the Replied pill says 16; the list is still 150', await pillN('Replied'));
  ok(await rowStatus('e34') === 'Replied', 'the row still says Replied once the list is redrawn');
  await page.selectOption('#rankFilter', '200');
  ok(await H.settle(page, H.countText, '59 of 150') === '59 of 150' && !(await H.rowIds(page)).includes('e34'), 'someone who replied is no longer in the texting order (60 → 59)', await H.countText(page));
  await page.selectOption('#rankFilter', '');
  await H.settle(page, H.countText, '150 candidates');

  // ---- Bounced → Not interested: their number goes on the opt-out list ----
  const textQueue = require(R('lib/text-queue.js'));
  const phone = require(R('lib/phone.js'));
  const x12 = phone.normalize(B.x12.phone);
  ok(B.x12.status === 'bounced' && x12 && !(await textQueue.loadQ()).optOut.includes(x12), `${B.x12.name} is Bounced, textable, and not opted out`);
  await change('x12', 'declined');
  await H.until(page, async () => (await stored('x12')) === 'declined');
  ok(await stored('x12') === 'declined' && await rowStatus('x12') === 'Not interested', 'Not interested: stored, and the row says so');
  ok((await textQueue.loadQ()).optOut.includes(x12), 'their number is on the texting opt-out list');
  n.bounced -= 1; n.declined += 1;
  await H.until(page, async () => JSON.stringify(await stageMenu()) === JSON.stringify(menuFor(n)));
  ok(JSON.stringify(await stageMenu()) === JSON.stringify(menuFor(n)), 'the stage menu follows', await stageMenu());

  // ---- under a filter, someone who no longer fits leaves the list ----
  await page.selectOption('#stageFilter', 'emailed');
  ok(await H.settle(page, H.countText, '59 of 150') === '59 of 150' && (await H.rowIds(page)).includes('e18'), `filtered to Emailed: 59, with ${B.e18.name}`, await H.countText(page));
  await page.selectOption('#candidateRows tr[data-id="e18"] .status-select', 'booked');
  await H.until(page, async () => (await H.countText(page)) === '58 of 150');
  ok(await H.countText(page) === '58 of 150' && !(await H.rowIds(page)).includes('e18'), 'marked Booked, they leave the Emailed list', await H.countText(page));
  ok(await stored('e18') === 'booked' && await pillN('Booked') === '11', 'stored, and the Booked pill says 11');
  n.emailed -= 1; n.booked += 1;
  ok(JSON.stringify(await stageMenu()) === JSON.stringify(menuFor(n)), 'the stage menu follows');
  await page.selectOption('#stageFilter', 'all');
  await H.settle(page, H.countText, '150 candidates');

  // ---- from the profile ----
  await page.click(`#candidateRows tr[data-id="e22"] [data-col="email"]`);
  await page.waitForSelector('#profileModal:not([hidden])');
  await page.selectOption('#profTags .status-select', 'booked');
  await H.until(page, async () => (await stored('e22')) === 'booked');
  ok(await stored('e22') === 'booked', 'changing the status in their profile stores it');
  n.emailed -= 1; n.booked += 1;
  await H.until(page, async () => JSON.stringify(await stageMenu()) === JSON.stringify(menuFor(n)));
  ok(await rowStatus('e22') === 'Booked' && await pillN('Booked') === '12', 'and their row and the pill follow', await pillN('Booked'));
  ok(await page.$eval('#profTags .status-select', (el) => el.value) === 'booked', 'the profile says Booked too');
  await page.click('#profileModal [data-close]');

  // ---- changed back, an opt-out stays ----
  await change('x12', 'bounced');
  await H.until(page, async () => (await stored('x12')) === 'bounced');
  ok(await stored('x12') === 'bounced' && (await textQueue.loadQ()).optOut.includes(x12), 'back to Bounced: stored, and the number stays opted out');
  n.bounced += 1; n.declined -= 1;
  await page.selectOption('#sortBy', 'texting');
  await page.fill('#searchInput', 'x12@example');
  await H.until(page, async () => JSON.stringify(await H.rowIds(page)) === '["x12"]');
  const why = await page.$eval('#candidateRows tr[data-id="x12"]', (tr) => ({ rank: tr.querySelector('[data-col="rank"]').textContent.trim(), not: tr.querySelector('.cand-sub.muted').textContent }));
  ok(why.rank === '—' && why.not === 'not texting: asked to stop', 'they are not texted, because they asked to stop', why);
  await page.fill('#searchInput', '');
  await page.selectOption('#sortBy', 'default');
  await page.selectOption('#rankFilter', '200');
  await H.until(page, async () => (await H.countText(page)) === '56 of 150');
  ok(await H.countText(page) === '56 of 150', 'four fewer to text than at the start (60 → 56)', await H.countText(page));
  ok(await pillN('Best to text next') === '50', 'the Best to text next pill still offers fifty');
  await page.selectOption('#rankFilter', '');

  // ---- a save that fails ----
  const menuBefore = JSON.stringify(await stageMenu());
  await page.route('**/api/candidates/e10', (route) => (route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Could not save just now.' }) })
    : route.continue()));
  await page.selectOption('#candidateRows tr[data-id="e10"] .status-select', 'bounced');
  await H.until(page, async () => (await toastTexts()).includes('Could not save just now.'));
  const err = (await H.toasts(page)).find((t) => t.text === 'Could not save just now.');
  ok(err && err.err, 'a save the server refuses says why, as an error', await H.toasts(page));
  ok(await stored('e10') === 'emailed', 'and nothing changed on the server');
  ok(JSON.stringify(await stageMenu()) === menuBefore && await pillN('Replied') === '16', 'the counts are as they were');
  await page.unroute('**/api/candidates/e10');
  await page.route('**/api/candidates/e10', (route) => (route.request().method() === 'PATCH' ? route.abort('failed') : route.continue()));
  const errsBefore = (await H.toasts(page)).filter((t) => t.err).length;
  await page.selectOption('#candidateRows tr[data-id="e10"] .status-select', 'replied');
  await H.until(page, async () => (await H.toasts(page)).filter((t) => t.err).length > errsBefore);
  ok((await H.toasts(page)).filter((t) => t.err).length > errsBefore, 'a save that never reaches the server says so too');
  ok(await stored('e10') === 'emailed', 'still nothing changed on the server');
  await page.unroute('**/api/candidates/e10');
  // What is on screen after a fresh look is what the server holds.
  await page.reload({ waitUntil: 'networkidle' });
  await H.openCandidates(page);
  ok(await rowStatus('e10') === 'Emailed', 'reloaded, the row shows the status the server kept');
  ok(JSON.stringify(await stageMenu()) === JSON.stringify(menuFor(n)), 'and every change that did save is still there', await stageMenu());
  ok(await rowStatus('e34') === 'Replied' && await rowStatus('x12') === 'Bounced', 'row by row');

  ok(errors.length === 0, 'no page errors', errors);
  ok(H.outside.length === 0, 'nothing reached the outside world', H.outside);
  await ctx.close();
  await browser.close();
  await s.close();
  done();
})().catch(crash);
