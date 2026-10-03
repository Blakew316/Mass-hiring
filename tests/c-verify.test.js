// The whole copy of the list is checked against the server's digests when
// the page has nothing else to do. A copy that came in wrong — here the whole
// list is altered on its way to the page, one person's name changed, the
// digests left as the server made them — is drawn as it came, then found out
// by that check about half a minute later: the bucket that does not come out
// at its digest is asked for again, by itself, and the right name replaces
// the wrong one without the whole list being fetched again. A copy that is
// right costs nothing: the check asks the server for nothing. Made-up people
// only; nothing is sent.
const { startApp, launch, ok, done, crash, ago } = require('./helpers');
const { stubEverything, waitIn, person } = require('./views-helpers');
const { Wire } = require('./c-helpers');

(async () => {
  const s = await startApp({ offset: 248 });
  const rec = stubEverything();
  const W = Wire();
  await s.store.update((d) => {
    d.candidates = Array.from({ length: 250 }, (_, i) => person(`v${String(i).padStart(3, '0')}`, `Verify Person${String(i).padStart(3, '0')}`, { addedAt: ago(9000 - i) }));
    d.events = [];
  });
  const browser = await launch();
  const nb = W.bucketCount(250);

  for (const altered of [false, true]) {
    const tag = altered ? 'a copy that came in wrong' : 'a copy that is right';
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    const [name, value] = s.cookie.split('=');
    await ctx.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
    await ctx.route((u) => !u.href.startsWith(s.base), (r) => r.abort());
    let changedIn = -1;
    if (altered) {
      await ctx.route((u) => u.pathname === '/api/candidates' && u.search === '?v=2', async (route) => {
        const resp = await route.fetch();
        const msg = await resp.json();
        // Verify Person042's name, wherever the message keeps it.
        const nameAt = msg.f.indexOf('name');
        for (const row of msg.r) {
          const shape = msg.s[row[0]];
          let j = 1;
          for (let i = 0; i < nameAt; i++) if ('234'.includes(shape[i])) j += 1;
          if (shape[nameAt] === '3' && row[j] === 'Verify Person042') { row[j] = 'Tampered Name'; changedIn = W.bucketOf('v042', nb); }
        }
        await route.fulfill({ response: resp, body: JSON.stringify(msg), headers: { ...resp.headers(), 'content-encoding': 'identity' } });
      });
    }
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const asked = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/candidates')) asked.push({ what: `${r.method()} ${u.pathname}`, body: r.postData() || '' }); });
    await page.goto(`${s.base}/#candidates`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#candidateRows tr[data-id]');
    if (altered) {
      ok(changedIn >= 0, `${tag}: (the list was altered on its way)`);
      await page.fill('#searchInput', 'Tampered Name');
      ok(await waitIn(page, () => document.querySelectorAll('#candidateRows tr[data-id="v042"]').length === 1), `${tag}: is drawn as it came`);
    }
    const start = asked.length;
    // The check runs about thirty seconds after a whole list arrives.
    const fixed = altered
      ? await waitIn(page, () => document.querySelectorAll('#candidateRows tr[data-id]').length === 0, null, 60000)
      : (await page.waitForTimeout(45000), true);
    const after = asked.slice(start);
    if (altered) {
      ok(fixed, `${tag}: is found out, and the wrong name goes`, after.map((a) => a.what));
      const sync = after.find((a) => a.what === 'POST /api/candidates/sync');
      const b = sync ? JSON.parse(sync.body).b : '';
      ok(sync && b.slice(changedIn * 8, changedIn * 8 + 8) === W.UNKNOWN && b.split(W.UNKNOWN).length === 2, `${tag}: by asking for that one bucket again`, after.map((a) => a.what));
      ok(!after.some((a) => a.what === 'GET /api/candidates'), `${tag}: not the whole list`, after.map((a) => a.what));
      await page.fill('#searchInput', 'Verify Person042');
      ok(await waitIn(page, () => document.querySelectorAll('#candidateRows tr[data-id="v042"]').length === 1), `${tag}: the right name is back`);
    } else {
      ok(after.length === 0, `${tag}: is checked without asking the server for anything`, after.map((a) => a.what));
    }
    ok(errors.length === 0, `${tag}: no page errors`, errors);
    await ctx.close();
  }
  await browser.close();
  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await s.close();
  done();
})().catch(crash);
