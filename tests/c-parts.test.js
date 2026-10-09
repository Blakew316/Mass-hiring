// A list too big for one answer (Netlify refuses one over 6 MB) comes in
// parts. For 26,000 made-up people: the parts put together are the same copy
// as the list sent whole, with or without the server's texting order; a part
// of another version is refused; a sync that would have sent everything says
// "whole" in a few hundred bytes instead; and the page itself, signed in,
// asks for the parts before its scripts arrive, puts them together, and
// draws the last person of the last part. Made-up people only; nothing is
// sent.
const { startApp, launch, ok, done, crash } = require('./helpers');
const { guardOutside, stubSenders } = require('./server-read-helpers');
const { Wire, people, body, fullCopy, sameCopy } = require('./c-helpers');

(async () => {
  const refused = guardOutside();
  const s = await startApp({ offset: 256 });
  stubSenders();
  const W = Wire();
  const N = 26000;
  try {
    await s.store.update((d) => { d.candidates = people(N); d.events = []; });
    const of = W.partsFor(N);
    ok(of === 3, `${N} people come in ${of} parts`, of);

    const whole = await fullCopy(s);
    const parts = async (count, ro = '') => {
      const rs = await Promise.all(Array.from({ length: count }, (_, i) => body(s, 'GET', `/api/candidates?v=2&part=${i}&of=${count}${ro}`)));
      ok(rs.every((r) => r.status === 200 && r.json), `parts of ${count}${ro ? ' (with the order)' : ''}: each answered`, rs.map((r) => r.status));
      return rs;
    };
    for (const count of [of, 5]) {
      const rs = await parts(count);
      const copy = await W.fromParts(rs.map((r) => r.json).reverse(), 'maverick');
      ok(sameCopy(copy, whole).length === 0, `${count} parts put together (in any order) are the list sent whole`, sameCopy(copy, whole));
      ok(new Set(rs.map((r) => r.tag)).size === count && rs.every((r) => /^W\/"c2-/.test(r.tag)), `${count} parts: each has a list tag of its own`, rs.map((r) => r.tag));
      ok(Math.max(...rs.map((r) => r.text.length)) < whole.n * 300 / count, `${count} parts: each is a ${count}th of the list`, rs.map((r) => r.text.length));
    }
    const ordered = await parts(of, '&ro=1');
    const withOrder = await W.fromParts(ordered.map((r) => r.json), 'maverick');
    ok(withOrder.ro && sameCopy(withOrder, whole).length === 0, 'with the order asked for: the same copy, carrying it');

    const again = await body(s, 'GET', `/api/candidates?v=2&part=1&of=${of}`, null, { 'if-none-match': (await parts(of))[1].tag });
    ok(again.status === 304, 'a part unchanged: 304', again.status);

    for (const q of ['part=3&of=3', 'part=-1&of=3', 'part=0&of=0', 'part=0&of=65', 'part=x&of=2', 'of=2']) {
      const r = await body(s, 'GET', `/api/candidates?v=2&${q}`);
      ok(r.status === 400, `?${q}: refused (400)`, r.status);
    }

    const rs = await parts(of);
    const msgs = rs.map((r) => r.json);
    await s.store.update((d) => { d.candidates[N - 1].notes = 'changed while the parts were on their way'; });
    const late = await body(s, 'GET', `/api/candidates?v=2&part=${of - 1}&of=${of}`);
    let mixed = null;
    try { await W.fromParts([msgs[0], msgs[1], late.json], 'maverick'); } catch (e) { mixed = e; }
    ok(mixed && mixed.refused, 'a part of another version: refused', mixed && mixed.message);
    let missing = null;
    try { await W.fromParts(msgs.slice(1), 'maverick'); } catch (e) { missing = e; }
    ok(missing && missing.refused, 'a part missing: refused', missing && missing.message);
    let twice = null;
    try { await W.fromParts([msgs[0], msgs[0], msgs[2]], 'maverick'); } catch (e) { twice = e; }
    ok(twice && twice.refused, 'a part twice: refused', twice && twice.message);

    const sync = await body(s, 'POST', '/api/candidates/sync?v=2', { ...W.syncBody(whole), nb: whole.nb + 1 });
    ok(sync.status === 200 && sync.json && sync.json.whole === true && sync.json.n === N && !sync.json.r && sync.text.length < 1000,
      'a sync that would send everything says "whole", in a few hundred bytes', { status: sync.status, bytes: sync.text.length, n: sync.json && sync.json.n });

    // The page: signed in, with nothing kept, then again with the count of
    // parts kept from last time (and no copy of the list kept on the device).
    const browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    const [name, value] = s.cookie.split('=');
    await ctx.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
    await ctx.route((u) => !u.href.startsWith(s.base), (r) => r.abort());
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let asked = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/candidates')) asked.push(`${r.method()} ${u.pathname}${u.search}`); });
    const last = (await fullCopy(s)).cands[N - 1];
    for (const round of ['first visit', 'next visit']) {
      asked = [];
      if (round === 'first visit') await page.goto(`${s.base}/#candidates`, { waitUntil: 'domcontentloaded' });
      else {
        // Without the copy this device keeps of the list, which would make
        // asking for it at all unnecessary (e-kept.test.js): once it is
        // kept, the page is told it is not.
        await page.waitForFunction(() => localStorage.getItem('wp-kept') === '1', null, { timeout: 30000 });
        await page.evaluate(() => localStorage.removeItem('wp-kept'));
        await page.reload({ waitUntil: 'domcontentloaded' });
      }
      await page.waitForSelector('#candidateRows tr[data-id]', { timeout: 60000 });
      await page.fill('#searchInput', last.email);
      await page.waitForSelector(`#candidateRows tr[data-id="${last.id}"]`, { timeout: 20000 }).catch(() => {});
      const shown = await page.$$eval(`#candidateRows tr[data-id="${last.id}"]`, (r) => r.length);
      ok(shown === 1, `${round}: the last person of the last part is found and drawn`, shown);
      const kept = await page.evaluate(() => localStorage.getItem('wp-list-of'));
      ok(kept === String(of), `${round}: the count of parts is kept for next time`, kept);
      const lists = asked.filter((a) => a.startsWith('GET /api/candidates?'));
      if (round === 'first visit') {
        ok(lists.length >= of && lists.filter((a) => a.includes('part=')).length === of, `${round}: the list is asked for in ${of} parts`, asked);
      } else {
        ok(lists.length === of && lists.every((a, i) => a === `GET /api/candidates?v=2&part=${i}&of=${of}`), `${round}: the ${of} parts are asked for once each, before the scripts arrive`, asked);
      }
    }
    ok(errors.length === 0, 'no page errors', errors);
    await browser.close();
    ok(refused.length === 0, 'nothing went out', refused);
  } finally {
    await s.close();
  }
  done();
})().catch(crash);
