// Candidates page on a laptop: working down the list. A status change keeps
// your place — the page you are on, the order, the search, who is ticked.
// Several changes made one straight after another all land, each where it
// was meant to, and a person changed twice ends up with the last choice.
// Removing somebody who is ticked takes them out of the selection. And the
// list opened afresh in the same browser shows what the server holds now,
// including what changed elsewhere while it was closed.
const { R, launch, openPage, ok, done, crash } = require('./helpers');
const H = require('./candidates-helpers');

(async () => {
  const s = await H.startCandidates(99);
  const P = s.people;
  const B = s.byId;
  const browser = await launch();
  const { ctx, page, errors } = await openPage(browser, s, { path: '/#candidates' });
  const sendCalls = [];
  for (const path of ['**/api/send', '**/api/queue', '**/api/texts/queue', '**/api/iq/invite', '**/api/iq/from-pipeline', '**/api/onboarding/send']) {
    await ctx.route(path, (route) => { sendCalls.push(route.request().url()); route.abort(); });
  }
  await H.openCandidates(page);

  const textQueue = require(R('lib/text-queue.js'));
  const phone = require(R('lib/phone.js'));
  const stored = async (id) => ((await s.store.load()).candidates.find((c) => c.id === id) || {}).status;
  const statusOf = (pg, id) => pg.$eval(`#candidateRows tr[data-id="${id}"] .status-select`, (el) => el.selectedOptions[0].textContent);
  const checked = () => page.$$eval('#candidateRows tr', (trs) => trs.filter((tr) => tr.querySelector('.row-check').checked).map((tr) => tr.dataset.id));
  const tick = (id) => page.click(`#candidateRows tr[data-id="${id}"] .row-check`);
  const selCount = async () => ((await page.$eval('#selectionBar', (el) => el.hidden)) ? null : H.text(page, '#selCount'));
  const look = (pg = page) => pg.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const LABEL = { new: 'Not contacted', emailed: 'Emailed', replied: 'Replied', booked: 'Booked', declined: 'Not interested', bounced: 'Bounced' };
  const n = { ...H.EXPECT.stage };
  let total = 150;
  const menuFor = () => [`Any stage (${total})`, ...Object.keys(LABEL).map((k) => `${LABEL[k]} (${n[k]})`)];
  const stageMenu = (pg = page) => H.options(pg, '#stageFilter');
  const move = (from, to) => { n[from] -= 1; n[to] += 1; };

  // ---- on page 2, two people ticked, a third person's status changes ----
  await page.click('#pagerNext');
  await page.waitForFunction(() => document.querySelector('#pagerPage').textContent === 'Page 2 of 3');
  const page2 = await H.rowIds(page);
  ok(JSON.stringify(page2) === JSON.stringify(P.slice(50, 100).map((c) => c.id)), 'page 2 of the order added');
  await tick('b09');
  await tick('e03');
  ok(await H.settle(page, selCount, '2 selected') === '2 selected', 'two people ticked on it');
  ok(B.e11.status === 'emailed' && page2.includes('e11'), `${B.e11.name} is on this page, Emailed`);
  await page.selectOption('#candidateRows tr[data-id="e11"] .status-select', 'replied');
  await H.until(page, async () => (await stored('e11')) === 'replied');
  move('emailed', 'replied');
  ok(JSON.stringify(await H.settle(page, stageMenu, menuFor())) === JSON.stringify(menuFor()), 'Emailed → Replied: stored, and the stage menu follows', await stageMenu());
  ok(await H.text(page, '#pagerPage') === 'Page 2 of 3' && JSON.stringify(await H.rowIds(page)) === JSON.stringify(page2), 'still on page 2, the same people in the same order');
  ok(JSON.stringify(await checked()) === JSON.stringify(['b09', 'e03']) && await selCount() === '2 selected', 'the two ticked are still ticked', await checked());
  ok(await statusOf(page, 'e11') === 'Replied', 'and the row says Replied');
  await page.click('#selClearBtn');

  // ---- searched, sorted by name, a status changes ----
  await page.fill('#searchInput', 'Sable');
  await H.settle(page, H.countText, '14 of 150');
  await page.selectOption('#sortBy', 'name');
  const sables = P.filter((c) => c.lastName === 'Sable').map((c) => c.name).sort((a, b) => a.localeCompare(b));
  ok(JSON.stringify(await H.settle(page, H.rowNames, sables)) === JSON.stringify(sables), 'searched "Sable", in name order: the fourteen Sables (the fifteenth has no name on file)');
  ok(B.e05.lastName === 'Sable' && B.e05.status === 'emailed', `${B.e05.name} is one of them, Emailed`);
  await page.selectOption('#candidateRows tr[data-id="e05"] .status-select', 'booked');
  await H.until(page, async () => (await stored('e05')) === 'booked');
  move('emailed', 'booked');
  await H.settle(page, stageMenu, menuFor());
  ok(await page.$eval('#searchInput', (el) => el.value) === 'Sable' && await H.countText(page) === '14 of 150' && await page.$eval('#sortBy', (el) => el.value) === 'name', 'the search and the order stay as they were');
  ok(JSON.stringify(await H.rowNames(page)) === JSON.stringify(sables) && await statusOf(page, 'e05') === 'Booked', 'the same fourteen, in the same order, with them now Booked');
  await page.fill('#searchInput', '');
  await page.selectOption('#sortBy', 'default');
  await H.settle(page, H.countText, '150 candidates');

  // ---- one change straight after another ----
  const opt = phone.normalize(B.e30.phone);
  ok(['e34', 'x12', 'e30', 'e26'].every((id) => P.slice(0, 50).some((c) => c.id === id)) && opt && !(await textQueue.loadQ()).optOut.includes(opt), 'four people on page 1');
  await page.selectOption('#candidateRows tr[data-id="e34"] .status-select', 'booked');
  await page.selectOption('#candidateRows tr[data-id="x12"] .status-select', 'replied');
  await page.selectOption('#candidateRows tr[data-id="e30"] .status-select', 'declined');
  await page.selectOption('#candidateRows tr[data-id="e26"] .status-select', 'replied');
  // A change of mind a moment later: as soon as the first choice has been saved.
  await H.until(page, async () => (await stored('e26')) === 'replied');
  await page.selectOption('#candidateRows tr[data-id="e26"] .status-select', 'booked');
  const want = { e34: 'booked', x12: 'replied', e30: 'declined', e26: 'booked' };
  const got = await H.until(page, async () => { const db = await s.store.load(); return Object.keys(want).every((id) => db.candidates.find((c) => c.id === id).status === want[id]); });
  ok(got, 'every one of them is stored, and the one changed twice keeps the second choice', await Promise.all(Object.keys(want).map(stored)));
  move('emailed', 'booked'); move('bounced', 'replied'); move('emailed', 'declined'); move('emailed', 'booked');
  // Whatever answers were in flight, a look now shows the server's truth.
  await look();
  ok(JSON.stringify(await H.settle(page, stageMenu, menuFor())) === JSON.stringify(menuFor()), 'the stage menu counts all four', await stageMenu());
  const rows = await Promise.all(Object.keys(want).map((id) => statusOf(page, id)));
  ok(JSON.stringify(rows) === JSON.stringify(Object.values(want).map((k) => LABEL[k])), 'each row says what was chosen last', rows);
  const pl = Object.fromEntries((await H.pills(page)).map((p) => [p.label, p.n]));
  ok(pl.Replied === String(n.replied) && pl.Booked === String(n.booked), `the pills: Replied ${n.replied}, Booked ${n.booked}`, pl);
  ok((await textQueue.loadQ()).optOut.includes(opt), 'the quick "Not interested" still put their number on the texting opt-out list');

  // ---- removing somebody who is ticked ----
  await tick('n01');
  await tick('e34');
  ok(await H.settle(page, selCount, '2 selected') === '2 selected', 'two ticked');
  await page.click('#candidateRows tr[data-id="n01"] [data-col="company"]');
  await page.waitForSelector('#profileModal:not([hidden])');
  page.once('dialog', (d) => d.accept());
  await page.click('#profRemove');
  await H.until(page, async () => !(await s.store.load()).candidates.some((c) => c.id === 'n01'));
  total -= 1; n.new -= 1;
  ok(await H.settle(page, selCount, '1 selected') === '1 selected' && await H.text(page, '#selEmailBtn') === 'Email 1', 'removed from their profile, they leave the selection: "1 selected", Email 1', await selCount());
  ok(await H.settle(page, H.countText, '149 candidates') === '149 candidates' && !(await H.rowIds(page)).includes('n01'), 'and the list: 149');
  ok(JSON.stringify(await checked()) === '["e34"]', 'the other stays ticked');
  await page.click('#selClearBtn');

  // ---- closed, changed elsewhere, opened again in the same browser ----
  await page.close();
  ok((await s.call('PATCH', '/api/candidates/e10', { status: 'booked' })).status === 200, 'while it is closed: someone is marked Booked elsewhere');
  ok((await s.call('DELETE', '/api/candidates/n02')).status === 200, 'someone is removed');
  const add = await s.json('POST', '/api/candidates', { firstName: 'Sky', lastName: 'Fairweather', name: 'Sky Fairweather', email: 'sky.fairweather@example.com', phone: '(617) 555-2997', role: 'Solar Consultant', company: 'Brightfield Solar' });
  ok(add.status === 200, 'someone is added');
  ok((await s.call('PATCH', '/api/candidates/x08', { phone: '' })).status === 200, 'and someone\'s number is taken off');
  move('emailed', 'booked'); n.new -= 1; n.new += 1;
  const p2 = await ctx.newPage();
  const errors2 = [];
  p2.on('pageerror', (e) => errors2.push(e.message));
  await p2.goto(`${s.base}/#candidates`, { waitUntil: 'networkidle' });
  await H.openCandidates(p2);
  // Whatever the page shows first, it must arrive at what the server holds
  // without anybody doing anything.
  const reading = async () => ({
    count: await H.countText(p2), menu: await stageMenu(p2),
    rows: await Promise.all(['e10', 'e34', 'e26', 'x12'].map((id) => statusOf(p2, id).catch(() => null))),
    x08: await p2.$eval('#candidateRows tr[data-id="x08"] [data-col="text"]', (td) => td.innerText.trim()).catch(() => null),
  });
  const wantView = { count: '149 candidates', menu: menuFor(), rows: ['Booked', 'Booked', 'Booked', 'Replied'], x08: '+ add number' };
  const v = await H.settle(p2, reading, wantView);
  ok(v.count === '149 candidates', 'opened again: 149 (one removed, one added)', v.count);
  ok(JSON.stringify(v.menu) === JSON.stringify(menuFor()), 'the stage menu counts what the server holds, this session\'s changes and the others alike', v.menu);
  ok(JSON.stringify(v.rows) === JSON.stringify(wantView.rows), 'row by row: the one changed elsewhere and the ones changed here', v.rows);
  ok(v.x08 === '+ add number', 'the number taken off is gone from their row', v.x08);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push(...await H.rowIds(p2));
    if (await p2.$eval('#pagerNext', (b) => b.disabled)) break;
    const firstId = (await H.rowIds(p2))[0];
    await p2.click('#pagerNext');
    await p2.waitForFunction((id) => document.querySelector('#candidateRows tr').dataset.id !== id, firstId);
  }
  ok(ids.length === 149 && !ids.includes('n02') && !ids.includes('n01') && ids[148] === add.body.candidate.id, 'every page: nobody removed, and the newcomer last in the order added', ids.length);
  ok(await p2.$eval('#selectionBar', (el) => el.hidden), 'and nobody is ticked');

  // ---- on a phone: page 2, a status picked, and one changed elsewhere ----
  const phoneSession = await openPage(browser, s, { phone: true, path: '/#candidates' });
  const ph = phoneSession.page;
  await H.openCandidates(ph);
  const face = (id) => ph.$eval(`#candidateRows tr[data-id="${id}"] .status-face`, (el) => el.textContent.trim());
  await ph.tap('#pagerNext');
  await ph.waitForFunction(() => document.querySelector('#pagerPage').textContent === 'Page 2 of 3');
  const phoneRows = await H.rowIds(ph);
  ok(phoneRows.includes('e07') && phoneRows.includes('e24') && await face('e07') === 'Emailed' && await face('e24') === 'Emailed', 'a phone on page 2: two Emailed cards');
  await ph.selectOption('#candidateRows tr[data-id="e07"] .status-select', 'declined');
  await H.until(ph, async () => (await stored('e07')) === 'declined');
  ok(await H.settle(ph, () => face('e07'), 'Not interested') === 'Not interested', 'picked on the phone: stored, and the card says Not interested');
  ok(await H.text(ph, '#pagerPage') === 'Page 2 of 3' && JSON.stringify(await H.rowIds(ph)) === JSON.stringify(phoneRows), 'still on page 2, the same cards in the same order');
  ok((await s.call('PATCH', '/api/candidates/e24', { status: 'booked' })).status === 200, 'elsewhere: another of them is marked Booked');
  await look(ph);
  ok(await H.settle(ph, () => face('e24'), 'Booked') === 'Booked', 'the next look: their card says Booked');
  ok(await H.text(ph, '#pagerPage') === 'Page 2 of 3' && await face('e07') === 'Not interested', 'and nothing else moved');

  ok(sendCalls.length === 0, 'nothing was sent from the page', sendCalls);
  ok(errors.length === 0 && errors2.length === 0 && phoneSession.errors.length === 0, 'no page errors', [...errors, ...errors2, ...phoneSession.errors]);
  await phoneSession.ctx.close();
  ok(H.outside.length === 0, 'nothing reached the outside world', H.outside);
  await ctx.close();
  await browser.close();
  await s.close();
  done();
})().catch(crash);
