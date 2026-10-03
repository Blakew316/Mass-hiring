// A sync that never answers does not hold up the ones after it. The page's
// syncs go one at a time, so one stuck on a dead connection used to be a
// list that never moved again; each now gives up after about twenty seconds
// (reading the body included), and the sync queued behind it then goes out
// and brings everything that changed meanwhile. A sync that fails outright
// is a failure — the page does not fetch the whole list over a connection
// that has just failed to carry a few kilobytes — and the next poll syncs as
// usual. Made-up people only; nothing is sent.
const { startApp, launch, ok, done, crash, ago } = require('./helpers');
const { stubEverything, open, waitIn, poke, person } = require('./views-helpers');

(async () => {
  const s = await startApp({ offset: 246 });
  const rec = stubEverything();
  await s.store.update((d) => {
    d.candidates = Array.from({ length: 200 }, (_, i) => person(`t${String(i).padStart(3, '0')}`, `Timeout Person${String(i).padStart(3, '0')}`, { addedAt: ago(9000 - i) }));
    d.events = [];
  });
  const browser = await launch();
  const { ctx, page, errors } = await open(browser, s, { at: '/#candidates' });
  await page.waitForSelector('#candidateRows tr[data-id]');
  const log = [];
  const t0 = Date.now();
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/candidates')) log.push({ what: `${r.method()} ${u.pathname}`, at: Date.now() - t0, r }); });
  const failed = [];
  page.on('requestfailed', (r) => { if (new URL(r.url()).pathname === '/api/candidates/sync') failed.push({ at: Date.now() - t0, why: r.failure() && r.failure().errorText }); });
  const shows = async (text) => {
    await page.fill('#searchInput', text);
    return waitIn(page, () => document.querySelectorAll('#candidateRows tr[data-id]').length === 1, null, 4000);
  };

  // ---------- one that never answers ----------
  let stuck = 0;
  const hang = async (route) => {
    if (stuck === 0) { stuck += 1; return; }   // never answered
    await route.continue();
  };
  await page.route('**/api/candidates/sync*', hang);
  await s.store.update((d) => { d.candidates[1].name = 'First Change'; });
  await poke(page);
  await page.waitForTimeout(3000);
  ok(stuck === 1 && log.filter((x) => x.what === 'POST /api/candidates/sync').length === 1, 'a sync goes out and is not answered');
  await s.store.update((d) => { d.candidates[2].name = 'Second Change'; });
  await poke(page);
  const firstAt = log.find((x) => x.what === 'POST /api/candidates/sync').at;
  let secondSent = null;
  for (const end = Date.now() + 30000; Date.now() < end && secondSent === null;) {
    const syncs = log.filter((x) => x.what === 'POST /api/candidates/sync');
    if (syncs.length >= 2) secondSent = syncs[1].at;
    else await new Promise((r) => setTimeout(r, 200));
  }
  ok(failed.length === 1 && failed[0].at - firstAt >= 18000 && failed[0].at - firstAt <= 24000, 'the stuck sync is given up after about twenty seconds', { failed, firstAt });
  ok(secondSent !== null && secondSent - firstAt < 26000, 'and the one queued behind it then goes out', { firstAt, secondSent });
  ok(await shows('First Change') && await shows('Second Change'), 'bringing both changes made meanwhile');
  ok(!log.some((x) => x.what === 'GET /api/candidates'), 'without the whole list being fetched', log.map((x) => x.what));
  await page.unroute('**/api/candidates/sync*', hang);

  // ---------- one that fails outright ----------
  let broke = false;
  const fail = async (route) => { if (!broke) { broke = true; await route.abort('failed'); } else await route.continue(); };
  await page.route('**/api/candidates/sync*', fail);
  await s.store.update((d) => { d.candidates[3].name = 'Third Change'; });
  log.length = 0;
  await poke(page);
  await page.waitForTimeout(1500);
  ok(broke && !log.some((x) => x.what === 'GET /api/candidates'), 'a sync that fails is not followed by fetching the whole list', log.map((x) => x.what));
  await poke(page);
  ok(await shows('Third Change'), 'the next poll syncs as usual and brings the change');
  ok(!log.some((x) => x.what === 'GET /api/candidates'), 'still without the whole list', log.map((x) => x.what));
  await page.unroute('**/api/candidates/sync*', fail);

  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();
  await browser.close();
  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await s.close();
  done();
})().catch(crash);
