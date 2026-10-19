// Opening the app again is quick however slow the server is:
//   - the team document is stored one person to a line, and still reads as
//     the same JSON; a document in the old layout reads as it always did
//   - a new version re-reads only the people whose lines changed: everyone
//     else is the very same (frozen) object as in the version before, and
//     two identical lines are still two people
//   - in the browser, the state is kept beside the list (sealed like it),
//     and the next visit shows the list from what this device kept before
//     the server has answered, marked "Updating…", then the server's answer
//     replaces it
//   - signing out leaves nothing kept, the state included
// Made-up people only; nothing is sent.
const fs = require('fs');
const { startApp, launch, R, ok, done, crash } = require('./helpers');
const { stubEverything, ready } = require('./views-helpers');

const N = 400;
const person = (i) => ({
  id: `fo${i}`, name: `Sample Person${i}`, firstName: 'Sample', lastName: `Person${i}`, email: `sample.person${i}@example.com`,
  phone: '', role: i % 3 ? 'Account Executive' : 'Sales Rep', company: 'Example Co', location: 'Austin, TX', notes: '',
  status: 'new', source: 'csv', addedAt: new Date(Date.now() - i * 60000).toISOString(), lastEmailedAt: null, bookedAt: null,
});

(async () => {
  const s = await startApp({ offset: 288 });
  stubEverything();
  const storage = require(R('lib/storage.js'));
  const store = require(R('lib/store.js'));

  // ---- the stored layout ----
  await s.store.update((d) => { d.candidates = Array.from({ length: N }, (_, i) => person(i)); });
  let entry = await storage.getTextWithEtag('db');
  let text = entry.bytes.toString('utf8');
  const at = text.indexOf('"candidates":[\n');
  const lines = text.slice(at + '"candidates":[\n'.length, text.length - 3).split(',\n');
  ok(at > 0 && text.endsWith('\n]}') && lines.length === N && lines.every((l) => l.startsWith('{"id":"fo')), 'stored one person to a line, the rest of the document first', { at, lines: lines.length });
  const parsed = JSON.parse(text);
  ok(parsed.candidates.length === N && parsed.candidates[7].email === 'sample.person7@example.com' && parsed.settings && parsed.template, 'and it is the same JSON as ever');

  // ---- reading a new version: only who changed ----
  // (Saved once more first, as every list already has been: the first save
  // after people are added gives each the empty text history it reads with.)
  await s.store.update((d) => { d.candidates[1].notes = 'saved'; });
  const v1 = await store.read();
  await s.store.update((d) => { d.candidates[5].status = 'emailed'; d.candidates.push(person(N)); });
  const v2 = await store.read();
  const same = v1.candidates.filter((c, i) => i !== 5 && v2.candidates[i] === c).length;
  ok(v2 !== v1 && same === N - 1, 'a new version: everyone unchanged is the very same object as before', { same, of: N - 1 });
  ok(v2.candidates[5] !== v1.candidates[5] && v2.candidates[5].status === 'emailed' && v1.candidates[5].status === 'new', 'the one who changed is read again (and the old version is untouched)');
  ok(v2.candidates.length === N + 1 && v2.candidates[N].id === `fo${N}` && Object.isFrozen(v2.candidates[N]) && Object.isFrozen(v2.candidates[0]), 'someone added is read; everyone is frozen');
  await s.store.update((d) => { d.candidates.push(structuredClone(d.candidates[0])); });
  const v3 = await store.read();
  ok(v3.candidates[N + 1] !== v3.candidates[0] && v3.candidates[N + 1].id === v3.candidates[0].id, 'two identical lines are two people, not one object twice');
  const loaded = await s.store.load();
  ok(!Object.isFrozen(loaded.candidates[0]) && loaded.candidates.length === N + 2, 'a copy to change (load()) is still its own');
  await s.store.update((d) => { d.candidates.pop(); });

  // ---- the old layout ----
  const file = R(`data/${storage.scopedKey('db')}.json`);
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify(before, null, 2));
  const old = await store.read();
  ok(old.candidates.length === N + 1 && old.candidates[5].status === 'emailed', 'a document in the old layout reads as it always did');
  await s.store.update((d) => { d.candidates[6].notes = 'saved again'; });
  entry = await storage.getTextWithEtag('db');
  ok(entry.bytes.toString('utf8').includes('"candidates":[\n'), 'and is written one person to a line the next time it is saved');

  // ---- the browser: shown from what was kept, before the server answers ----
  const browser = await launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const [cn, cv] = s.cookie.split('=');
    await ctx.addCookies([{ name: cn, value: cv, domain: 'localhost', path: '/' }]);
    await ctx.route((u) => !u.href.startsWith(s.base), (r) => r.abort());
    let slow = 0;
    await ctx.route(/\/api\/(state|candidates)/, async (route) => {
      if (slow) await new Promise((r) => setTimeout(r, slow));
      route.continue().catch(() => {});
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const keptKeys = () => page.evaluate(() => new Promise((resolve) => {
      const rq = indexedDB.open('wp-kept', 1);
      rq.onerror = () => resolve(null);
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains('kept')) rq.result.createObjectStore('kept'); };
      rq.onsuccess = () => {
        const tx = rq.result.transaction('kept', 'readonly');
        const k = tx.objectStore('kept').getAllKeys();
        tx.oncomplete = () => { rq.result.close(); resolve(k.result.map(String)); };
      };
    }));
    const rowsShown = () => page.evaluate(() => [...document.querySelectorAll('#candidateRows tr[data-id]')].length);
    await page.goto(`${s.base}/#candidates`);
    await ready(page);
    await page.waitForFunction(() => document.querySelectorAll('#candidateRows tr[data-id]').length > 0);
    let keys = null;
    for (let i = 0; i < 80 && !(keys && keys.includes('state') && keys.includes('head')); i++) { await page.waitForTimeout(250); keys = await keptKeys(); }
    ok(keys && keys.includes('state') && keys.includes('head') && keys.includes('ids'), 'the state is kept beside the list', keys);
    const sealed = await page.evaluate(() => new Promise((resolve) => {
      const rq = indexedDB.open('wp-kept', 1);
      rq.onsuccess = () => { const tx = rq.result.transaction('kept', 'readonly'); const g = tx.objectStore('kept').get('state'); tx.oncomplete = () => { rq.result.close(); const v = g.result; resolve(Boolean(v && v.iv instanceof Uint8Array && v.data instanceof ArrayBuffer && !new TextDecoder().decode(v.data).includes('Example Co'))); }; };
    }));
    ok(sealed, 'sealed, like the list: nothing in it readable as stored');

    // The list changes on the server, and the server is slow to say so.
    await s.store.update((d) => { d.candidates[0].name = 'Renamed Sample'; d.candidates[0].firstName = 'Renamed'; });
    slow = 5000;
    await page.goto('about:blank');
    const t0 = Date.now();
    await page.goto(`${s.base}/#candidates`, { waitUntil: 'commit' });
    await page.waitForFunction(() => document.querySelectorAll('#candidateRows tr[data-id]').length > 0 && document.querySelector('#view-candidates.active'), null, { timeout: 15000, polling: 50 });
    const shownAt = Date.now() - t0;
    const early = await page.evaluate(() => ({
      updating: [...document.querySelectorAll('.conn-updating')].some((el) => !el.hidden),
      total: (document.querySelector('#statTotal') || {}).textContent,
      names: [...document.querySelectorAll('#candidateRows tr[data-id]')].map((r) => r.textContent).join(' '),
    }));
    ok(shownAt < 4500, `the list is on screen before the server answers (${shownAt} ms; the server takes 5,000)`, shownAt);
    ok(early.updating, 'marked "Updating…" while it is the copy this device kept', early);
    ok(!/Renamed Sample/.test(early.names), 'what is shown is what was kept (the change is not here yet)');
    await page.waitForFunction(() => ![...document.querySelectorAll('.conn-updating')].some((el) => !el.hidden), null, { timeout: 30000 });
    slow = 0;
    await page.fill('#searchInput', 'Renamed');
    await page.waitForFunction(() => [...document.querySelectorAll('#candidateRows tr[data-id]')].some((r) => /Renamed Sample/.test(r.textContent)), null, { timeout: 10000 });
    ok(true, 'then the server\'s answer replaces it, and "Updating…" goes');
    ok(await rowsShown() >= 1, 'the change is on screen');

    // ---- signing out ----
    await page.evaluate(() => document.querySelector('#signOutBtn').click());
    await page.waitForFunction(() => !document.querySelector('#loginScreen').hidden);
    let left = null;
    for (let i = 0; i < 40; i++) { left = await keptKeys(); if (left && !left.length) break; await page.waitForTimeout(250); }
    ok(left && left.length === 0, 'signed out: nothing kept, the state included', left);
    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  } finally {
    await browser.close();
    await s.close();
  }
  done();
})().catch(crash);
