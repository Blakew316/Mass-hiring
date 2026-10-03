// The page's poll of /api/state, in a real browser: an unchanged poll is a
// 304 and the list stays on screen; a change on the server arrives as a 200
// and is drawn; the poll after that is a 304 again. And when the browser's
// session turns into another team's (signed in elsewhere in another tab), the
// page's remembered tag must not be answered 304 — it draws the other team's
// list and name, and none of the first team's people.
//
// A poll is started the way the page starts one when the connection comes
// back (the window's "online" event), and each step waits for its answer.
const { startApp, launch, openPage, ok, done, crash } = require('./helpers');
const { guardOutside, stubSenders, addTeam, inTeam, daysAgo } = require('./server-read-helpers');

(async () => {
  const refused = guardOutside();
  const s = await startApp({ offset: 7 });
  const sent = stubSenders();
  await s.store.update((d) => {
    d.candidates = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `Poll Person ${i}`, email: `poll.${i}@example.com`, status: 'new', addedAt: daysAgo(3), source: 'csv' }));
  });

  const browser = await launch();
  const { ctx, page, errors } = await openPage(browser, s);
  const poll = async () => {
    const [resp] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/state', { timeout: 15000 }),
      page.evaluate(() => window.dispatchEvent(new Event('online'))),
    ]);
    return resp;
  };
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#candidateRows tr.cand-row')].map((r) => r.dataset.id).sort().join());
  await page.evaluate(() => { const el = document.querySelector('.nav-item[data-view="candidates"]'); if (el) el.click(); });
  await page.waitForFunction(() => document.querySelectorAll('#candidateRows tr.cand-row').length === 5, null, { timeout: 10000 });
  ok(await rows() === 'p0,p1,p2,p3,p4', 'the list is drawn from the state');

  // The page may save something of its own on arrival (the browser's time
  // zone); once that has come back, an unchanged poll is a 304.
  let r = await poll();
  for (let i = 0; i < 3 && r.status() !== 304; i++) r = await poll();
  ok(r.status() === 304 && Boolean(r.request().headers()['if-none-match']), 'an unchanged poll asks with its tag and is answered 304', r.status());
  ok(await rows() === 'p0,p1,p2,p3,p4', 'after a 304 the list is still on screen');

  await s.store.update((d) => { d.candidates.push({ id: 'p5', name: 'Poll Person 5', email: 'poll.5@example.com', status: 'new', addedAt: daysAgo(1), source: 'manual' }); });
  r = await poll();
  ok(r.status() === 200, 'after a change on the server the poll is a 200', r.status());
  await page.waitForFunction(() => Boolean(document.querySelector('#candidateRows tr.cand-row[data-id="p5"]')), null, { timeout: 10000 }).catch(() => {});
  ok(await rows() === 'p0,p1,p2,p3,p4,p5', 'and the new person is drawn', await rows());
  r = await poll();
  ok(r.status() === 304, 'the poll after that is a 304 again', r.status());
  ok(await rows() === 'p0,p1,p2,p3,p4,p5', 'with the list unchanged');

  // ---------- the session becomes another team's ----------
  const B = await addTeam(s, { name: 'Team Orange', pin: '6185' });
  await inTeam(B.id, () => s.store.update((d) => {
    d.candidates = [{ id: 'o1', name: 'Orange Person', email: 'orange.person@example.com', status: 'new', addedAt: daysAgo(2), source: 'manual' }];
  }));
  const [name, value] = B.cookie.split('=');
  await ctx.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
  r = await poll();
  ok(r.status() === 200 && Boolean(r.request().headers()['if-none-match']), 'with the first team\'s tag, the other team\'s state is a 200, not a 304', r.status());
  await page.waitForFunction(() => Boolean(document.querySelector('#candidateRows tr.cand-row[data-id="o1"]')), null, { timeout: 10000 }).catch(() => {});
  ok(await rows() === 'o1', 'the other team\'s list is drawn, and none of the first team\'s people', await rows());
  const chip = await page.evaluate(() => (document.querySelector('#teamChipName') || {}).textContent || '');
  ok(chip === 'Team Orange', 'the page names the team it now shows', chip);
  ok(!(await page.evaluate(() => document.body.innerText)).includes('Poll Person'), 'no first-team name is left anywhere on the page');

  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();
  await browser.close();
  ok(sent.count() === 0, 'nothing was sent', sent);
  ok(refused.length === 0, 'nothing reached outside this machine', refused);
  await s.close();
  done();
})().catch(crash);
