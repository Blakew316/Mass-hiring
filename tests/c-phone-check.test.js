// The kept copy of the list in the two browsers that lack something it uses.
//   - Safari, on every iPhone, has no requestIdleCallback. The whole-copy
//     check (public/app.js checkBuckets) then runs on a timer, and must still
//     go a few milliseconds at a time: here each row is made slow to read, as
//     on a phone, and the longest stretch the check holds the page for is
//     measured. It still finds a row that came in wrong and asks for that
//     bucket alone.
//   - A page opened over plain http on another machine (not localhost) has no
//     crypto.subtle, so nothing can be checked against a digest. It still
//     draws the list, and a change after one poll, from the whole list.
// Made-up people only; nothing is sent.
const { startApp, launch, ok, done, crash, ago } = require('./helpers');
const { stubEverything, waitIn, poke, person } = require('./views-helpers');
const { Wire } = require('./c-helpers');

async function context(browser, s, init) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const [name, value] = s.cookie.split('=');
  await ctx.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
  await ctx.route((u) => !u.href.startsWith(s.base), (r) => r.abort());
  await ctx.addInitScript(init);
  return ctx;
}

(async () => {
  const s = await startApp({ offset: 234 });
  const rec = stubEverything();
  const W = Wire();
  await s.store.update((d) => {
    d.candidates = Array.from({ length: 250 }, (_, i) => person(`p${String(i).padStart(3, '0')}`, `Phone Person${String(i).padStart(3, '0')}`, { addedAt: ago(9000 - i) }));
    d.events = [];
  });
  const browser = await launch();
  const nb = W.bucketCount(250);

  // ================= no requestIdleCallback =================
  {
    const ctx = await context(browser, s, () => {
      window.requestIdleCallback = undefined;
      // Each row the check reads takes half a millisecond, and when it was
      // read is noted.
      window.__reads = [];
      let wire;
      Object.defineProperty(window, 'Wire', {
        configurable: true,
        get: () => wire,
        set: (w) => {
          const read = w.rowText;
          w.rowText = (...args) => {
            const t = performance.now();
            while (performance.now() - t < 0.5) { /* a slow phone */ }
            window.__reads.push(performance.now());
            return read(...args);
          };
          wire = w;
        },
      });
    });
    let changedIn = -1;
    await ctx.route((u) => u.pathname === '/api/candidates' && u.search === '?v=2', async (route) => {
      const resp = await route.fetch();
      const msg = await resp.json();
      const nameAt = msg.f.indexOf('name');
      for (const row of msg.r) {
        const shape = msg.s[row[0]];
        let j = 1;
        for (let i = 0; i < nameAt; i++) if ('234'.includes(shape[i])) j += 1;
        if (shape[nameAt] === '3' && row[j] === 'Phone Person042') { row[j] = 'Wrong Name'; changedIn = W.bucketOf('p042', nb); }
      }
      await route.fulfill({ response: resp, body: JSON.stringify(msg), headers: { ...resp.headers(), 'content-encoding': 'identity' } });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const asked = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/candidates')) asked.push({ what: `${r.method()} ${u.pathname}`, body: r.postData() || '' }); });
    await page.goto(`${s.base}/#candidates`, { waitUntil: 'domcontentloaded' });
    ok(await waitIn(page, () => typeof window.requestIdleCallback !== 'function' && document.querySelector('#statTotal').textContent === '250', null, 15000), 'no requestIdleCallback: the page draws the list');
    ok(changedIn >= 0, '(one row was altered on its way to the page)');
    await page.fill('#searchInput', 'Wrong Name');
    ok(await waitIn(page, () => document.querySelectorAll('#candidateRows tr[data-id="p042"]').length === 1), 'and draws it as it came');
    const start = asked.length;
    // The check runs about thirty seconds after a whole list arrives.
    ok(await waitIn(page, () => document.querySelectorAll('#candidateRows tr[data-id]').length === 0, null, 60000), 'the check finds the wrong row, and it goes');
    const after = asked.slice(start);
    const sync = after.find((a) => a.what === 'POST /api/candidates/sync');
    const b = sync ? JSON.parse(sync.body).b : '';
    ok(sync && b.slice(changedIn * 8, changedIn * 8 + 8) === W.UNKNOWN && b.split(W.UNKNOWN).length === 2 && !after.some((a) => a.what === 'GET /api/candidates'),
      'by asking for that one bucket again, not the whole list', after.map((a) => a.what));
    // Reads less than a few milliseconds apart are one stretch of the page
    // being held; between stretches the page is free.
    const reads = await page.evaluate(() => window.__reads);
    const stretches = [];
    let first = reads[0];
    for (let i = 1; i <= reads.length; i++) {
      if (i === reads.length || reads[i] - reads[i - 1] > 4) { stretches.push(reads[i - 1] - first); first = reads[i]; }
    }
    const longest = Math.max(...stretches);
    ok(reads.length >= 250 && stretches.length >= 5, `the check read every row (${reads.length}) in ${stretches.length} stretches, not one`, { reads: reads.length, stretches: stretches.length });
    ok(longest < 40, `and never held the page for more than a few milliseconds at a time (longest ${Math.round(longest)} ms)`, stretches.map(Math.round));
    await page.fill('#searchInput', 'Phone Person042');
    ok(await waitIn(page, () => { const tr = document.querySelector('#candidateRows tr[data-id="p042"]'); return Boolean(tr && tr.textContent.includes('Phone Person042')); }), 'the right name is back');
    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  }

  // ================= no crypto.subtle =================
  {
    const ctx = await context(browser, s, () => { Object.defineProperty(window.crypto, 'subtle', { value: undefined, configurable: true }); });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const asked = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) asked.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${s.base}/#candidates`, { waitUntil: 'domcontentloaded' });
    ok(await waitIn(page, () => !window.crypto.subtle && document.querySelector('#statTotal').textContent === '250', null, 15000), 'no crypto.subtle: the page draws the list',
      await page.evaluate(() => (document.querySelector('#statTotal') || {}).textContent));
    await s.store.update((d) => { d.candidates.find((c) => c.id === 'p007').name = 'Changed Over Http'; });
    asked.length = 0;
    await poke(page);
    await page.fill('#searchInput', 'Changed Over Http');
    ok(await waitIn(page, () => document.querySelectorAll('#candidateRows tr[data-id="p007"]').length === 1), 'and a change after one poll');
    ok(asked.includes('GET /api/candidates') && !asked.includes('POST /api/candidates/sync'), 'from the whole list: there is nothing to check a part of it against', asked);
    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  }

  await browser.close();
  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await s.close();
  done();
})().catch(crash);
