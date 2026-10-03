// What the page asks the server for in the background as it starts, on a
// laptop. The first look for email replies and the first Calendly sync each
// make the server read (and perhaps rewrite) the whole list, and used to go
// out the moment the page was up — on top of its own first load. They wait
// about fifteen seconds now, then keep their pace. A Calendly sync that says
// it changed nothing is not followed by fetching the whole state; one from a
// server that does not say (an older one) still is. Both answers are made up
// by the test in the browser: nothing reaches Gmail or Calendly.
const { startApp, launch, ok, done, crash } = require('./helpers');
const { stubEverything, open, person } = require('./views-helpers');

(async () => {
  const s = await startApp({ offset: 212 });
  const rec = stubEverything();
  await s.store.update((d) => {
    d.candidates = [person('b1', 'Boot Person')];
    d.events = [];
    d.settings.calendlyToken = 'test-calendly-token';
  });
  const browser = await launch();

  // Two pages side by side, each told something different by "Calendly".
  async function watch(answer) {
    const v = await open(browser, s);
    const t0 = Date.now();
    v.log = [];
    v.page.on('request', (r) => {
      const p = new URL(r.url()).pathname;
      if (p === '/api/replies/check' || p === '/api/calendly/sync' || p === '/api/state') v.log.push({ p, at: Date.now() - t0 });
    });
    await v.page.route('**/api/replies/check', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, checked: 0, replies: 0 }) }));
    await v.page.route('**/api/calendly/sync', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) }));
    return v;
  }
  const quiet = await watch({ ok: true, newBookings: 0, changed: false, syncedAt: new Date().toISOString() });
  const older = await watch({ ok: true, newBookings: 0 });

  await quiet.page.waitForTimeout(10000);
  for (const [tag, v] of [['changed: false', quiet], ['no changed field', older]]) {
    ok(!v.log.some((x) => x.p !== '/api/state'), `${tag}: nothing in the background in the first ten seconds`, v.log);
  }
  await quiet.page.waitForTimeout(9000);
  for (const [tag, v] of [['changed: false', quiet], ['no changed field', older]]) {
    const replies = v.log.filter((x) => x.p === '/api/replies/check');
    const sync = v.log.filter((x) => x.p === '/api/calendly/sync');
    ok(replies.length === 1 && replies[0].at >= 12000, `${tag}: the first look for replies goes about fifteen seconds in`, replies);
    ok(sync.length === 1 && sync[0].at >= 12000, `${tag}: and the first Calendly sync`, sync);
  }
  const after = (v) => { const sync = v.log.find((x) => x.p === '/api/calendly/sync'); return v.log.filter((x) => x.p === '/api/state' && x.at > sync.at); };
  ok(after(quiet).length === 0, 'a sync that changed nothing is not followed by fetching the state', quiet.log);
  ok(after(older).length === 1, 'one from a server that does not say still is', older.log);

  for (const v of [quiet, older]) {
    ok(v.errors.length === 0, 'no page errors', v.errors);
    await v.ctx.close();
  }
  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await browser.close();
  await s.close();
  done();
})().catch(crash);
