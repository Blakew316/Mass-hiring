// A status picked on the page, on a laptop and on a phone. It shows at once
// — the row, the stage menu, the pills — before the server has answered; a
// poll that set off before the pick cannot flip it back; and a save the
// server refuses (or that never reaches it) puts everything back as it was
// and says why: the row's menu, the phone's status pill, an open profile and
// a Dashboard tile's list alike, with the server's own words. After a
// refused save the next look asks for the whole state rather than being
// told nothing changed. Made-up people only; nothing is sent.
const { startApp, launch, ok, done, crash, ago } = require('./helpers');
const { stubEverything, open, text, texts, waitIn, settle, until, poke, go, stored, byId, person } = require('./views-helpers');

const LABEL = { new: 'Not contacted', emailed: 'Emailed', replied: 'Replied', booked: 'Booked', declined: 'Not interested', bounced: 'Bounced' };
function people() {
  const out = [];
  for (let i = 1; i <= 12; i++) {
    const id = `s${String(i).padStart(2, '0')}`;
    out.push(person(id, `Stat Person${String(i).padStart(2, '0')}`, i <= 6
      ? { status: 'emailed', lastEmailedAt: ago(2000 + i), gmailThreadId: `th-${id}`, lastSubject: 'Quick question' }
      : { addedAt: ago(5000 - i) }));
  }
  return out;
}

(async () => {
  const s = await startApp({ offset: 202 });
  const rec = stubEverything();
  const seed = () => s.store.update((d) => { d.candidates = people(); d.events = []; });
  await seed();
  const statusOf = async (id) => (byId(await stored(s), id) || {}).status;
  const browser = await launch();

  // ================= laptop =================
  {
    const { ctx, page, errors } = await open(browser, s, { at: '/#candidates' });
    await page.waitForSelector('#candidateRows tr[data-id="s01"]');
    const row = (id) => page.$eval(`#candidateRows tr[data-id="${id}"] .status-select`, (el) => el.selectedOptions[0].textContent).catch(() => null);
    const stage = () => texts(page, '#stageFilter option');
    const pill = async (label) => {
      const all = await page.$$eval('#candViews .view-pill', (bs) => bs.map((b) => [b.firstChild.textContent.trim(), b.querySelector('.view-n').textContent.trim()]));
      return (all.find(([l]) => l === label) || [])[1] || '0';
    };
    const errToasts = () => page.$$eval('#toasts .toast.err', (ts) => ts.map((t) => t.textContent));

    // ---- shown at once, before the server answers ----
    let release;
    let held = new Promise((r) => { release = r; });
    const hold = async (route) => { if (route.request().method() === 'PATCH') await held; await route.continue(); };
    await page.route('**/api/candidates/s01', hold);
    await page.selectOption('#candidateRows tr[data-id="s01"] .status-select', 'replied');
    ok(await row('s01') === 'Replied', 'the row says Replied straight away');
    ok(await settle(stage, ['Any stage (12)', 'Not contacted (6)', 'Emailed (5)', 'Replied (1)', 'Booked (0)', 'Not interested (0)', 'Bounced (0)'])
      .then((m) => m[2] === 'Emailed (5)' && m[3] === 'Replied (1)'), 'the stage menu has moved one from Emailed to Replied', await stage());
    ok(await pill('Replied') === '1', 'and the Replied pill counts them', await pill('Replied'));
    ok(await statusOf('s01') === 'emailed', '(while the server has not been told yet)');
    release();
    ok(await until(async () => (await statusOf('s01')) === 'replied'), 'the server stores it once the save goes through');
    await page.unroute('**/api/candidates/s01', hold);

    // ---- a poll that set off before the pick does not flip it back ----
    let fetched;
    const gotIt = new Promise((r) => { fetched = r; });
    held = new Promise((r) => { release = r; });
    let armed = true;
    const holdState = async (route) => {
      if (!armed) { await route.continue(); return; }
      armed = false;
      const resp = await route.fetch();
      fetched();
      await held;
      await route.fulfill({ response: resp });
    };
    await page.route((u) => u.pathname.startsWith('/api/state'), holdState);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await gotIt;   // the server has answered (s02 still Emailed) — the answer is held on its way
    await page.selectOption('#candidateRows tr[data-id="s02"] .status-select', 'booked');
    ok(await until(async () => (await statusOf('s02')) === 'booked'), 'a second pick is saved');
    release();
    await page.waitForTimeout(600);
    ok(await row('s02') === 'Booked', 'the old answer, landing afterwards, does not put the row back to Emailed', await row('s02'));
    ok((await stage())[4] === 'Booked (1)', 'nor the stage menu', await stage());
    await page.unroute((u) => u.pathname.startsWith('/api/state'), holdState);
    await poke(page);
    ok(await row('s02') === 'Booked' && (await stage())[4] === 'Booked (1)', 'and the next look agrees');

    // ---- a save the server refuses puts the row back ----
    const refuse = (route) => (route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Could not save that just now.' }) })
      : route.continue());
    await page.route('**/api/candidates/s03', refuse);
    const before = await stage();
    await page.selectOption('#candidateRows tr[data-id="s03"] .status-select', 'declined');
    ok(await waitIn(page, () => [...document.querySelectorAll('#toasts .toast.err')].some((t) => t.textContent === 'Could not save that just now.')), 'a refused save says why, in the server\'s words', await errToasts());
    ok(await settle(() => row('s03'), 'Emailed') === 'Emailed', 'the row\'s menu is back to Emailed', await row('s03'));
    ok(await page.$eval('#candidateRows tr[data-id="s03"] .status-select', (el) => el.classList.contains('tint-blue') && !el.classList.contains('tint-red')), 'in Emailed\'s colour');
    ok(JSON.stringify(await stage()) === JSON.stringify(before), 'the stage menu is as it was', await stage());
    ok(await statusOf('s03') === 'emailed', 'and the server never changed');

    // The next look asks for everything, not "anything newer than this?".
    const asked = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/state');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const req = await asked;
    ok(!req.headers()['if-none-match'], 'after a refused save the next look fetches the whole state', req.headers()['if-none-match']);
    await page.waitForTimeout(400);

    // ---- from the profile ----
    await page.click('#candidateRows tr[data-id="s03"] [data-col="email"]');
    await page.waitForSelector('#profileModal:not([hidden])');
    await page.selectOption('#profTags .status-select', 'booked');
    ok(await waitIn(page, () => document.querySelectorAll('#toasts .toast.err').length >= 2), 'refused from the profile, it says so too', await errToasts());
    ok(await settle(() => page.$eval('#profTags .status-select', (el) => el.selectedOptions[0].textContent), 'Emailed') === 'Emailed', 'the profile\'s menu is put back', await page.$eval('#profTags .status-select', (el) => el.value));
    ok(await row('s03') === 'Emailed', 'and so is the row under it');
    await page.keyboard.press('Escape');
    await page.unroute('**/api/candidates/s03', refuse);

    // ---- a save that never reaches the server ----
    await page.route('**/api/candidates/s04', (route) => (route.request().method() === 'PATCH' ? route.abort('failed') : route.continue()));
    const n = (await errToasts()).length;
    await page.selectOption('#candidateRows tr[data-id="s04"] .status-select', 'replied');
    ok(await waitIn(page, (k) => document.querySelectorAll('#toasts .toast.err').length > k, n), 'a save lost on the way says so');
    ok(await settle(() => row('s04'), 'Emailed') === 'Emailed', 'and the row goes back', await row('s04'));

    // ---- from a Dashboard tile's list ----
    await go(page, 'dashboard');
    await page.route('**/api/candidates/s05', refuse);
    const replied = await text(page, '#statReplied');
    await page.click('.stat-card[data-tile="emailed"]');
    await page.waitForSelector('#tileModal:not([hidden])');
    await page.selectOption('#tileList .tile-status[data-id="s05"]', 'replied');
    ok(await waitIn(page, () => [...document.querySelectorAll('#toasts .toast.err')].filter((t) => t.textContent === 'Could not save that just now.').length >= 2), 'refused from a tile\'s list, it says so');
    ok(await settle(() => page.$eval('#tileList .tile-status[data-id="s05"]', (el) => el.value), 'emailed') === 'emailed', 'the menu in the list is put back');
    ok(await settle(() => text(page, '#statReplied'), replied) === replied, 'and the Replied tile does not count them', [replied, await text(page, '#statReplied')]);
    await page.keyboard.press('Escape');

    ok(errors.length === 0, 'laptop: no page errors', errors);
    await ctx.close();
  }

  // ================= phone =================
  await seed();
  {
    const { ctx, page, errors } = await open(browser, s, { phone: true, at: '/#candidates' });
    await page.waitForSelector('#candidateRows tr[data-id="s06"]');
    const face = (id) => page.$eval(`#candidateRows tr[data-id="${id}"] .status-face`, (el) => el.textContent.trim());
    await page.route('**/api/candidates/s06', (route) => (route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Could not save that just now.' }) })
      : route.continue()));
    await page.selectOption('#candidateRows tr[data-id="s06"] .status-select', 'booked');
    ok(await waitIn(page, () => [...document.querySelectorAll('#toasts .toast.err')].some((t) => t.textContent === 'Could not save that just now.')), 'phone: a refused save says why');
    ok(await settle(() => face('s06'), LABEL.emailed) === LABEL.emailed, 'phone: the status pill goes back to Emailed', await face('s06'));
    ok(await page.$eval('#candidateRows tr[data-id="s06"] .status-select', (el) => el.value) === 'emailed', 'phone: and the picker under it');
    ok(await statusOf('s06') === 'emailed', 'phone: the server never changed');
    ok(errors.length === 0, 'phone: no page errors', errors);
    await ctx.close();
  }

  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await browser.close();
  await s.close();
  done();
})().catch(crash);
