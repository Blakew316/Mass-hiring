// Pages drawn when they are shown, on a laptop. Settings — its editors, its
// previews and the attachment's thumbnail (a large image fetched from the
// server) — is not drawn from other pages: the thumbnail is fetched the
// first time Settings is opened, not on every launch, and what changed on
// the server meanwhile is there when it is. Texting's header counts who can
// be texted when Texting is opened, after a status picked elsewhere. And a
// slow answer overtaken by a later one is not drawn over it when it lands.
// Made-up people only; nothing is sent.
const { startApp, launch, ok, done, crash, ago } = require('./helpers');
const { stubEverything, open, text, waitIn, waitText, settle, poke, go, person } = require('./views-helpers');

function people() {
  const out = [];
  for (let i = 1; i <= 8; i++) {
    out.push(person(`a${i}`, `Arrive Person${i}`, { phone: `(617) 555-02${10 + i}`, addedAt: ago(4000 - i) }));
  }
  return out;
}

(async () => {
  const s = await startApp({ offset: 210 });
  const rec = stubEverything();
  await s.store.update((d) => { d.candidates = people(); d.events = []; d.settings.fromName = 'First Name'; });
  const browser = await launch();
  const { ctx, page, errors } = await open(browser, s);
  // Every fetch of a thumbnail since the page loaded (the browser's own
  // record, so the ones made while it was starting count too).
  const thumbFetches = () => page.evaluate(() => performance.getEntriesByType('resource')
    .filter((e) => /\/api\/template\/attachments\/[^/]+\/preview/.test(new URL(e.name).pathname)).length);

  // ---- Settings is drawn when it is opened ----
  await poke(page);
  await page.waitForTimeout(500);
  ok(await thumbFetches() === 0, 'the attachment thumbnail is not fetched while Settings is not open', await thumbFetches());
  await s.store.update((d) => { d.settings.fromName = 'Changed Elsewhere'; d.textTemplate = { body: 'Hi {{firstName}}, changed elsewhere.' }; });
  await poke(page);
  await go(page, 'settings');
  ok(await waitIn(page, () => { const i = document.querySelector('#attachList .attach-thumb img'); return i && i.getAttribute('src').startsWith('data:image/'); }), 'opening Settings fetches it and shows it');
  ok(await thumbFetches() === 1, 'once', await thumbFetches());
  ok(await settle(() => page.inputValue('#setFromName'), 'Changed Elsewhere') === 'Changed Elsewhere', 'Settings shows what changed on the server while it was not open', await page.inputValue('#setFromName'));
  ok(await page.inputValue('#txBody') === 'Hi {{firstName}}, changed elsewhere.', 'the text editor too', await page.inputValue('#txBody'));
  ok(await waitText(page, '#txPreview', /changed elsewhere/), 'and its preview', await text(page, '#txPreview'));
  await go(page, 'dashboard');
  await go(page, 'settings');
  await page.waitForTimeout(300);
  ok(await thumbFetches() === 1, 'coming back to Settings does not fetch the thumbnail again', await thumbFetches());
  // While it is on screen, a new state draws it as before.
  await s.store.update((d) => { d.settings.fromName = 'Changed Again'; });
  await poke(page);
  ok(await settle(() => page.inputValue('#setFromName'), 'Changed Again') === 'Changed Again', 'on screen, it follows a new state', await page.inputValue('#setFromName'));

  // ---- Texting's header ----
  await go(page, 'texting');
  ok(await waitText(page, '#textSendAllBtn', 'Text 8 with a number'), 'Texting offers to text the eight', await text(page, '#textSendAllBtn'));
  await go(page, 'candidates');
  await page.waitForSelector('#candidateRows tr[data-id="a1"]');
  await page.selectOption('#candidateRows tr[data-id="a1"] .status-select', 'booked');
  await go(page, 'texting');
  ok(await waitText(page, '#textSendAllBtn', 'Text 7 with a number'), 'after someone is marked Booked on Candidates, Texting offers seven', await text(page, '#textSendAllBtn'));

  // ---- a slow answer overtaken by a later one ----
  await go(page, 'dashboard');
  ok(await waitText(page, '#statTotal', '8'), 'eight people');
  let fetched;
  const gotIt = new Promise((r) => { fetched = r; });
  let release;
  const held = new Promise((r) => { release = r; });
  let delivered;
  const landed = new Promise((r) => { delivered = r; });
  let armed = true;
  const hold = async (route) => {
    if (!armed) { await route.continue(); return; }
    armed = false;
    const resp = await route.fetch();
    fetched();
    await held;
    await route.fulfill({ response: resp });
    delivered(resp.status());
  };
  await page.route((u) => u.pathname.startsWith('/api/state'), hold);
  await s.store.update((d) => { d.candidates[1].notes = 'A change, so the first answer is a whole state'; });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await gotIt;   // the first answer (eight people) is held on its way
  await s.store.update((d) => { d.candidates.push(person('a9', 'Arrive Person9', { phone: '(617) 555-0219' })); });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  ok(await waitText(page, '#statTotal', '9'), 'a later look shows the ninth person', await text(page, '#statTotal'));
  release();
  ok(await landed === 200, '(the slow answer was a whole state)');
  await page.waitForTimeout(600);
  ok(await text(page, '#statTotal') === '9', 'the slow answer, landing afterwards, does not take the page back to eight', await text(page, '#statTotal'));
  await page.unroute((u) => u.pathname.startsWith('/api/state'), hold);
  await poke(page);
  ok(await text(page, '#statTotal') === '9', 'and the next look agrees');

  ok(errors.length === 0, 'no page errors', errors);
  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await ctx.close();
  await browser.close();
  await s.close();
  done();
})().catch(crash);
