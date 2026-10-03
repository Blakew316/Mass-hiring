// The device's clock put back an hour while the page is open, on a laptop
// (by hand, or a network time correction). The page orders its answers —
// one asked for before the state on screen is dropped as older — and lets go
// of a status picked here once a state asked for after the save has come
// back. Timed by the device's clock, every answer after the change was
// "older" than the one on screen and was dropped, and a status picked here
// stayed laid over every new state, whatever anyone else changed it to,
// until the clock caught up. Made-up people only; nothing is sent.
const { startApp, launch, ok, done, crash, ago } = require('./helpers');
const { stubEverything, open, text, settle, until, poke, go, stored, byId, person } = require('./views-helpers');

// Date.now() as the page sees it, moved by the test.
function movableClock() {
  const real = Date.now;
  window.__clockShift = 0;
  Date.now = () => real() + window.__clockShift;
}

(async () => {
  const s = await startApp({ offset: 216 });
  const rec = stubEverything();
  await s.store.update((d) => {
    d.candidates = [1, 2, 3].map((i) => person(`c${i}`, `Clock Person${i}`, { status: 'emailed', lastEmailedAt: ago(3000 + i), gmailThreadId: `th-c${i}`, lastSubject: 'Quick question' }));
    d.events = [];
  });
  const browser = await launch();
  const { ctx, page, errors } = await open(browser, s, { at: '/#candidates', init: movableClock });
  await page.waitForSelector('#candidateRows tr[data-id="c1"]');
  const row = (id) => page.$eval(`#candidateRows tr[data-id="${id}"] .status-select`, (el) => el.value).catch(() => null);

  // A status picked here, and saved.
  await page.selectOption('#candidateRows tr[data-id="c1"] .status-select', 'replied');
  ok(await until(async () => (byId(await stored(s), 'c1') || {}).status === 'replied'), 'a status picked here is saved');
  await page.waitForTimeout(800);

  // The clock goes back an hour.
  await page.evaluate(() => { window.__clockShift = -3600000; });

  // Someone is added elsewhere: the next look shows them.
  await s.store.update((d) => { d.candidates.push(person('c4', 'Clock Person4', { status: 'emailed', lastEmailedAt: ago(10) })); });
  await poke(page);
  ok(await settle(() => text(page, '#candCount'), '4 candidates') === '4 candidates', 'after the clock goes back, a new state is still drawn', await text(page, '#candCount'));

  // And the status picked here, changed elsewhere since, shows the change.
  await s.store.update((d) => { byId(d, 'c1').status = 'booked'; });
  await poke(page);
  ok(await settle(() => row('c1'), 'booked') === 'booked', 'a status picked here before the clock went back does not stay over a change made elsewhere', await row('c1'));

  await go(page, 'dashboard');
  ok(errors.length === 0, 'no page errors', errors);
  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await ctx.close();
  await browser.close();
  await s.close();
  done();
})().catch(crash);
