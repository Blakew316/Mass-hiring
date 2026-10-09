// The copy of the list this device keeps between visits (public/app.js, "The
// copy kept on this device"), in a real browser, for 3,000 made-up people:
//   - the first visit fetches the whole list and keeps it;
//   - the next visit fetches none of it: one sync of what changed (a status,
//     someone added) and the page shows the server's list, the change
//     rewriting a group or two of the copy, not all of it;
//   - a copy altered on the device is put right by the idle check against
//     the server's digests, without the whole list;
//   - another team's copy, or one in another format, is never used;
//   - a copy written over by something else (this team in another tab) is
//     never patched as if it were this page's, and what is kept stays whole;
//   - moving to another team keeps that team's copy in its place, and the
//     first team's is not used for it nor it for the first;
//   - signing out leaves nothing kept.
// Nothing is sent.
const { startApp, launch, ok, done, crash } = require('./helpers');
const { stubEverything, ready, waitIn, until, poke } = require('./views-helpers');
const { addTeam, inTeam } = require('./server-read-helpers');
const { Wire, people, body } = require('./c-helpers');

// Everything kept, as { head, ids, g0, g1, ... }, or {} when nothing is.
const keptNow = (page) => page.evaluate(() => new Promise((resolve) => {
  const rq = indexedDB.open('wp-kept', 1);
  rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains('kept')) rq.result.createObjectStore('kept'); };
  rq.onerror = () => resolve(null);
  rq.onsuccess = () => {
    const db = rq.result;
    const tx = db.transaction('kept', 'readonly');
    const st = tx.objectStore('kept');
    const keys = st.getAllKeys();
    const vals = st.getAll();
    tx.oncomplete = () => { const out = {}; keys.result.forEach((k, i) => { out[k] = vals.result[i]; }); db.close(); resolve(out); };
  };
}));
// One kept record changed in place, as something on the device might.
const alterKept = (page, key, how) => page.evaluate(([k, fn]) => new Promise((resolve) => {
  const rq = indexedDB.open('wp-kept', 1);
  rq.onsuccess = () => {
    const db = rq.result;
    const tx = db.transaction('kept', 'readwrite');
    const st = tx.objectStore('kept');
    const g = st.get(k);
    // eslint-disable-next-line no-new-func
    g.onsuccess = () => st.put(new Function('v', fn)(g.result), k);
    tx.oncomplete = () => { db.close(); resolve(true); };
  };
}), [key, how]);
const hinted = (page, timeout = 20000) => waitIn(page, () => localStorage.getItem('wp-kept') === '1', null, timeout);
// Until what is kept passes `test`; what is kept then.
const keptWhen = async (page, test, timeout = 20000) => {
  let k = null;
  await until(async () => { k = await keptNow(page); return Boolean(k && test(k)); }, timeout, 250);
  return k && test(k) ? k : null;
};
// How many people the Candidates page counts ("All roles (3001)").
const total = (page) => page.$eval('#roleFilter option', (e) => (e.textContent.match(/\((\d+)\)/) || [])[1] || '');
const totalIs = (page, n, timeout = 8000) => waitIn(page, (want) => ((document.querySelector('#roleFilter option') || {}).textContent || '').includes(`(${want})`), n, timeout);
const groupKeys = (k) => Object.keys(k).filter((x) => /^g\d+$/.test(x));

(async () => {
  const s = await startApp({ offset: 270 });
  stubEverything();
  const W = Wire();
  const crowd = people(3000);
  await s.store.update((d) => { d.candidates = crowd; d.events = []; });
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const [n0, v0] = s.cookie.split('=');
  await ctx.addCookies([{ name: n0, value: v0, domain: 'localhost', path: '/' }]);
  await ctx.route((u) => !u.href.startsWith(s.base), (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  let asked = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/candidates')) asked.push(`${r.method()} ${u.pathname}${u.search}`); });
  await page.goto(`${s.base}/#candidates`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  const lists = () => asked.filter((a) => a.startsWith('GET /api/candidates?'));
  const syncs = () => asked.filter((a) => a.startsWith('POST /api/candidates/sync'));
  const reload = async () => { asked = []; await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page); await page.waitForSelector('#candidateRows tr[data-id]'); };
  const find = async (q, id) => {
    await page.fill('#searchInput', q);
    const got = await waitIn(page, (x) => document.querySelectorAll(`#candidateRows tr[data-id="${x}"]`).length === 1, id);
    await page.fill('#searchInput', '');
    return Boolean(got);
  };
  const shownStatus = (id) => page.evaluate((x) => { const sel = document.querySelector(`#candidateRows tr[data-id="${x}"] .status-select`); return sel ? sel.value : null; }, id);
  try {
    // ---- the first visit ----
    await page.waitForSelector('#candidateRows tr[data-id]');
    ok(await total(page) === '3000', 'first visit: the page draws the 3,000', await total(page));
    ok(lists().length === 1, 'first visit: the whole list is fetched', asked);
    ok(await hinted(page), 'first visit: and kept on the device a few seconds later');
    let k = await keptNow(page);
    const groups = W.groupsFor(W.bucketCount(3000));
    ok(k.head && k.head.t === 'maverick' && k.head.n === 3000 && k.head.groups === groups && groupKeys(k).length === groups && typeof k.ids === 'string',
      `first visit: kept as a head, the order and ${groups} groups`, k.head && { t: k.head.t, n: k.head.n, groups: k.head.groups, keys: Object.keys(k).length });

    // ---- the next visit, after a change and someone added ----
    const changed = crowd[10];
    const r1 = await body(s, 'PATCH', `/api/candidates/${changed.id}`, { status: 'booked' });
    const r2 = await body(s, 'POST', '/api/candidates', { name: 'Kept Newcomer', email: 'kept.newcomer@example.com', phone: '(617) 555-2998', role: 'Account Executive' });
    if (r1.status !== 200 || r2.status !== 200) throw new Error(`changes answered ${r1.status}, ${r2.status}`);
    const newcomer = r2.json.candidate || (r2.json.candidates || []).find((c) => c.email === 'kept.newcomer@example.com') || {};
    const before = k;
    await reload();
    ok(lists().length === 0, 'next visit: none of the list is fetched', asked);
    ok(syncs().length === 1, 'next visit: one sync of what changed', asked);
    ok(await totalIs(page, 3001), 'next visit: the page draws the 3,001', await total(page));
    ok(await find('kept.newcomer@example.com', newcomer.id || ''), 'next visit: the person added is there', newcomer.id);
    await page.fill('#searchInput', changed.email);
    await waitIn(page, (x) => document.querySelectorAll(`#candidateRows tr[data-id="${x}"]`).length === 1, changed.id);
    ok(await shownStatus(changed.id) === 'booked', 'next visit: the status changed elsewhere is shown', await shownStatus(changed.id));
    await page.fill('#searchInput', '');
    k = (await keptWhen(page, (x) => x.head && x.head.n === 3001 && x.head.v !== before.head.v)) || await keptNow(page);
    const rewritten = groupKeys(k).filter((g) => k[g] !== before[g]);
    ok(k.head.n === 3001 && k.ids !== before.ids, 'next visit: what is kept is brought up to date', k.head && k.head.n);
    ok(rewritten.length >= 1 && rewritten.length <= 2, `next visit: a change to two people rewrites ${rewritten.length} of ${groups} groups`, rewritten);

    // ---- a copy altered on the device ----
    const victim = crowd[2000];
    const g = `g${W.groupOf(W.bucketOf(victim.id, k.head.nb))}`;
    await alterKept(page, g, `return v.split(${JSON.stringify(JSON.stringify(victim.name))}).join('"Tampered Kept"');`);
    const altered = await keptNow(page);
    ok(altered[g] !== k[g] && altered[g].includes('Tampered Kept'), '(the kept copy is altered: one name changed, its digests left as they were)');
    await reload();
    ok(lists().length === 0, 'altered: the copy is still used (it fits its own digests)', asked);
    await page.fill('#searchInput', 'Tampered Kept');
    const shownWrong = await waitIn(page, (x) => document.querySelectorAll(`#candidateRows tr[data-id="${x}"]`).length === 1, victim.id);
    ok(Boolean(shownWrong), 'altered: drawn as it was kept, at first');
    asked = [];
    const putRight = await waitIn(page, (x) => document.querySelectorAll(`#candidateRows tr[data-id="${x}"]`).length === 0, victim.id, 60000);
    ok(Boolean(putRight), 'altered: the idle check finds it out and the right name replaces it', asked);
    ok(lists().length === 0 && syncs().length >= 1, 'altered: by asking for that bucket, not the whole list', asked);
    await page.fill('#searchInput', '');

    // ---- another team's copy, another format ----
    await alterKept(page, 'head', 'v.t = "someone-else"; return v;');
    await reload();
    ok(lists().length === 1, 'another team\'s copy: never used; the whole list is fetched', asked);
    ok(await total(page) === '3001', 'another team\'s copy: the page draws this team\'s 3,001', await total(page));
    ok(await hinted(page), 'another team\'s copy: this team\'s is kept in its place');
    ok((await keptNow(page)).head.t === 'maverick', '(kept for this team)');
    await alterKept(page, 'head', 'v.keep = 99; return v;');
    await reload();
    ok(lists().length === 1, 'another format: never used; the whole list is fetched', asked);

    // ---- written over by something else ----
    ok(Boolean(await keptWhen(page, (x) => x.head && x.head.keep === 1)), '(kept again)');
    await alterKept(page, 'head', 'v.wid = "another-tab"; return v;');
    const other = crowd[500];
    await body(s, 'PATCH', `/api/candidates/${other.id}`, { status: 'declined' });
    await poke(page);
    await page.fill('#searchInput', other.email);
    await waitIn(page, (x) => { const sel = document.querySelector(`#candidateRows tr[data-id="${x}"] .status-select`); return sel && sel.value === 'declined'; }, other.id);
    await page.fill('#searchInput', '');
    await page.waitForTimeout(7000);
    const after = await keptNow(page);
    ok(after.head.wid === 'another-tab', 'written over: this page does not patch a copy it did not write', after.head.wid);
    await reload();
    ok(lists().length === 0, 'written over: the copy there is still whole, and used', asked);
    await page.fill('#searchInput', other.email);
    await waitIn(page, (x) => document.querySelectorAll(`#candidateRows tr[data-id="${x}"]`).length === 1, other.id);
    ok(await shownStatus(other.id) === 'declined', 'written over: and brought up to date by its sync', await shownStatus(other.id));
    await page.fill('#searchInput', '');
    ok(Boolean(await keptWhen(page, (x) => x.head && x.head.wid !== 'another-tab')), 'written over: and then written whole by this page');

    // ---- another team ----
    const B = await addTeam(s, { name: 'Team Ranger', pin: '6391' });
    await inTeam(B.id, () => s.store.update((d) => { d.candidates = people(200, { prefix: 'r' }); d.events = []; }));
    const [name, value] = B.cookie.split('=');
    await ctx.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
    await poke(page);
    ok(await totalIs(page, 200), 'another team: a page whose session moves to it draws its 200', { total: await total(page), asked });
    ok(Boolean(await keptWhen(page, (x) => x.head && x.head.t === B.id && x.head.n === 200)), 'another team: its list is kept in place of the first team\'s');
    await reload();
    ok(lists().length === 0 && await total(page) === '200', 'another team: and used on its next visit', asked);
    await ctx.addCookies([{ name: n0, value: v0, domain: 'localhost', path: '/' }]);
    await reload();
    ok(lists().length === 1 && await total(page) === '3001', 'back to the first team: the other team\'s copy is not used for it', { asked, total: await total(page) });
    const shownIds = await page.evaluate(() => [...document.querySelectorAll('#candidateRows tr[data-id]')].map((r) => r.dataset.id));
    ok(!shownIds.some((id) => id.startsWith('r')), 'back to the first team: none of the other team\'s people', shownIds.slice(0, 5));

    // ---- signing out ----
    ok(await hinted(page), '(kept for the first team)');
    await page.evaluate(() => document.querySelector('#signOutBtn').click());
    await page.waitForFunction(() => !document.querySelector('#loginScreen').hidden);
    const gone = await keptWhen(page, (x) => Object.keys(x).length === 0, 10000);
    ok(Boolean(gone), 'signed out: nothing is kept');
    ok(await page.evaluate(() => localStorage.getItem('wp-kept')) === null, 'signed out: and the page no longer says it keeps anything');

    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
    await browser.close();
  } finally {
    await s.close();
  }
  done();
})().catch(crash);
