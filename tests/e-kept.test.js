// The copy of the list this device keeps between visits (public/app.js, "The
// copy kept on this device"), in a real browser, for 3,000 made-up people:
//   - the first visit fetches the whole list and keeps it;
//   - the next visit fetches none of it: one sync of what changed (a status,
//     someone added) and the page shows the server's list, the change
//     rewriting a group or two of the copy, not all of it;
//   - a copy so far behind that the server sends the whole list is not used;
//   - a copy altered on the device (with the key) is put right by the idle
//     check against the server's digests, without the whole list, and what
//     is kept of it is written again;
//   - another team's copy, one in another format, or one whose fields have
//     since been renamed, is never used as it is;
//   - a copy written over by something else (this team in another tab) is
//     gone on from as that tab stored it, a group or two rewritten, and what
//     is kept stays whole;
//   - moving to another team keeps that team's copy in its place, and the
//     first team's is not used for it nor it for the first;
//   - signing out leaves nothing kept;
//   - what is kept cannot be read without the key the server hands only to
//     a signed-in session, a copy changed without it is never used, and
//     signing the team out everywhere changes the key.
// Nothing is sent.
const { startApp, launch, ok, done, crash } = require('./helpers');
const { stubEverything, ready, waitIn, until, poke } = require('./views-helpers');
const { addTeam, inTeam } = require('./server-read-helpers');
const { Wire, people, body } = require('./c-helpers');

// The kept records, in the page: { head, ids, g0, ... } as stored.
const PAGE_KEPT = `
  window.__kept = {
    db: () => new Promise((resolve) => {
      const rq = indexedDB.open('wp-kept', 1);
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains('kept')) rq.result.createObjectStore('kept'); };
      rq.onerror = () => resolve(null);
      rq.onsuccess = () => resolve(rq.result);
    }),
    all: async () => {
      const db = await window.__kept.db();
      if (!db) return null;
      const out = await new Promise((resolve) => {
        const tx = db.transaction('kept', 'readonly');
        const st = tx.objectStore('kept');
        const keys = st.getAllKeys();
        const vals = st.getAll();
        tx.oncomplete = () => { const o = {}; keys.result.forEach((k, i) => { o[k] = vals.result[i]; }); resolve(o); };
      });
      db.close();
      return out;
    },
    put: async (k, v) => {
      const db = await window.__kept.db();
      await new Promise((resolve) => { const tx = db.transaction('kept', 'readwrite'); tx.objectStore('kept').put(v, k); tx.oncomplete = resolve; });
      db.close();
    },
    key: (raw) => {
      const bin = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
      return crypto.subtle.importKey('raw', Uint8Array.from(bin, (c) => c.charCodeAt(0)), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    },
    open: async (raw, rec) => new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, await window.__kept.key(raw), rec.data)),
    seal: async (raw, text) => { const iv = crypto.getRandomValues(new Uint8Array(12)); return { iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await window.__kept.key(raw), new TextEncoder().encode(text)) }; },
  };`;
// Everything kept, as { head, ids, g0, g1, ... } with each sealed record as
// { iv, bytes, readable } (readable: whether `plain` shows in it as it is
// stored), or {} when nothing is.
const keptNow = (page, plain = '') => page.evaluate(async (look) => {
  const all = await window.__kept.all();
  if (!all) return null;
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    out[k] = v && v.iv instanceof Uint8Array && v.data instanceof ArrayBuffer
      ? { sealed: true, iv: Array.from(v.iv).join('.'), bytes: v.data.byteLength, readable: Boolean(look) && new TextDecoder().decode(v.data).includes(look) }
      : v;
  }
  return out;
}, plain);
// One kept record changed in place, as something on the device might: a
// sealed one opened with `raw` (the session's key), changed and sealed again.
const alterKept = (page, key, how, raw = null) => page.evaluate(async ([k, fn, keyRaw]) => {
  const all = await window.__kept.all();
  // eslint-disable-next-line no-new-func
  const change = new Function('v', fn);
  const was = all[k];
  const now = keyRaw && was && was.iv ? await window.__kept.seal(keyRaw, change(await window.__kept.open(keyRaw, was))) : change(was);
  await window.__kept.put(k, now);
  return true;
}, [key, how, raw]);
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
  await ctx.addInitScript(PAGE_KEPT);
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
    let k = await keptNow(page, crowd[0].email);
    const groups = W.groupsFor(W.bucketCount(3000));
    ok(k.head && k.head.t === 'maverick' && k.head.n === 3000 && k.head.groups === groups && groupKeys(k).length === groups && k.ids && k.ids.sealed,
      `first visit: kept as a head, the order and ${groups} groups`, k.head && { t: k.head.t, n: k.head.n, groups: k.head.groups, keys: Object.keys(k).length });
    ok(groupKeys(k).every((g) => k[g].sealed && !k[g].readable) && !JSON.stringify(k.head).includes(crowd[0].email),
      'first visit: nobody in it can be read as it is stored (sealed with the session\'s key)');
    const keyRaw = (await body(s, 'GET', '/api/auth/status')).json.keepKey;
    ok(typeof keyRaw === 'string' && keyRaw.length >= 40, '(the session is handed its key)');
    const opened = await page.evaluate(async ([raw, rec]) => {
      const all = await window.__kept.all();
      return window.__kept.open(raw, all[rec]);
    }, [keyRaw, 'g0']);
    ok(/^\{"f":\[/.test(opened), 'first visit: and with the key it opens to a group of the list', opened.slice(0, 40));

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
    const rewritten = groupKeys(k).filter((g) => k[g].iv !== before[g].iv);
    ok(k.head.n === 3001 && k.ids.iv !== before.ids.iv, 'next visit: what is kept is brought up to date', k.head && k.head.n);
    ok(rewritten.length >= 1 && rewritten.length <= 2, `next visit: a change to two people rewrites ${rewritten.length} of ${groups} groups`, rewritten);

    // ---- a copy far behind (most of the list changed since) ----
    await s.store.update((d) => { d.candidates.forEach((c, i) => { c.notes = `moved on ${i}`; }); });
    const farChanged = crowd[42];
    await body(s, 'PATCH', `/api/candidates/${farChanged.id}`, { status: 'declined' });
    await reload();
    ok(lists().length === 0 && syncs().length === 1, 'far behind: one sync, whose answer is the whole list (a short one), and nothing else', asked);
    await page.fill('#searchInput', farChanged.email);
    await waitIn(page, (x) => { const sel = document.querySelector(`#candidateRows tr[data-id="${x}"] .status-select`); return sel && sel.value === 'declined'; }, farChanged.id);
    ok(await shownStatus(farChanged.id) === 'declined', 'far behind: the page shows the server\'s list', await shownStatus(farChanged.id));
    await page.fill('#searchInput', '');
    k = (await keptWhen(page, (x) => x.head && x.head.v !== k.head.v && x.head.n === 3001)) || await keptNow(page);

    // ---- a copy altered on the device ----
    const victim = crowd[2000];
    const g = `g${W.groupOf(W.bucketOf(victim.id, k.head.nb))}`;
    await alterKept(page, g, `return v.split(${JSON.stringify(JSON.stringify(victim.name))}).join('"Tampered Kept"');`, keyRaw);
    const altered = await keptNow(page);
    ok(altered[g].iv !== k[g].iv, '(the kept copy is altered with the key: one name changed, its digests left as they were)');
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
    const keptText = (gk) => page.evaluate(async ([raw, key]) => { const all = await window.__kept.all(); return all[key] ? window.__kept.open(raw, all[key]) : ''; }, [keyRaw, gk]);
    ok(await until(async () => !(await keptText(g)).includes('Tampered Kept'), 20000, 500), 'altered: and what is kept of that group is written again, put right');

    // ---- a copy changed without the key ----
    await page.evaluate(async () => {
      const all = await window.__kept.all();
      const bytes = new Uint8Array(all.g3.data.slice(0));
      bytes[10] ^= 1;
      await window.__kept.put('g3', { iv: all.g3.iv, data: bytes.buffer });
    });
    await reload();
    ok(lists().length === 1, 'changed without the key: it does not open, and is never used; the whole list is fetched', asked);
    ok(await total(page) === '3001', 'changed without the key: the page draws the server\'s 3,001', await total(page));
    ok(Boolean(await keptWhen(page, (x) => x.head && x.g3 && x.g3.sealed)) && (await keptText('g3')).startsWith('{'), 'changed without the key: kept again, whole');

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

    // ---- kept under fields since renamed (a copy kept across a deploy) ----
    ok(Boolean(await keptWhen(page, (x) => x.head && x.head.keep === 1)), '(kept again)');
    const rename = 'const m = typeof v === "string" ? JSON.parse(v) : v; m.f = m.f.map((x) => (x === "role" ? "jobRole" : x)); return typeof v === "string" ? JSON.stringify(m) : m;';
    await alterKept(page, 'head', rename);
    for (const gk of groupKeys(await keptNow(page))) await alterKept(page, gk, rename, keyRaw);
    await reload();
    ok(lists().length === 1, 'fields renamed since: the copy is not taken for current; the whole list is fetched', asked);
    const roleShown = await page.$eval('#roleFilter', (e) => e.options.length > 2);
    ok(roleShown, 'fields renamed since: the page has everyone\'s role, under the name it reads it by');
    ok(Boolean(await keptWhen(page, (x) => x.head && x.head.f.includes('role') && !x.head.f.includes('jobRole'))), 'fields renamed since: and it is kept again under the fields it has');

    // ---- written over by something else ----
    ok(Boolean(await keptWhen(page, (x) => x.head && x.head.keep === 1)), '(kept again)');
    await alterKept(page, 'head', 'v.wid = "another-tab"; return v;');
    const byOther = await keptNow(page);
    const other = crowd[500];
    await body(s, 'PATCH', `/api/candidates/${other.id}`, { status: 'declined' });
    await poke(page);
    await page.fill('#searchInput', other.email);
    await waitIn(page, (x) => { const sel = document.querySelector(`#candidateRows tr[data-id="${x}"] .status-select`); return sel && sel.value === 'declined'; }, other.id);
    await page.fill('#searchInput', '');
    const after = await keptWhen(page, (x) => x.head && x.head.wid !== 'another-tab', 30000);
    const redone = after ? groupKeys(after).filter((gk) => after[gk].iv !== byOther[gk].iv) : [];
    ok(after && redone.length >= 1 && redone.length <= 2, `written over: this page goes on from what the other tab stored, rewriting ${redone.length} group(s), not all of them`, redone);
    await reload();
    ok(lists().length === 0, 'written over: the copy there is still whole, and used', asked);
    await page.fill('#searchInput', other.email);
    await waitIn(page, (x) => document.querySelectorAll(`#candidateRows tr[data-id="${x}"]`).length === 1, other.id);
    ok(await shownStatus(other.id) === 'declined', 'written over: and brought up to date by its sync', await shownStatus(other.id));
    await page.fill('#searchInput', '');

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
    await page.evaluate(async () => { window.__old = (await window.__kept.all()).g0; });
    await page.evaluate(() => document.querySelector('#signOutBtn').click());
    await page.waitForFunction(() => !document.querySelector('#loginScreen').hidden);
    const gone = await keptWhen(page, (x) => Object.keys(x).length === 0, 10000);
    ok(Boolean(gone), 'signed out: nothing is kept');
    ok(await page.evaluate(() => localStorage.getItem('wp-kept')) === null, 'signed out: and the page no longer says it keeps anything');

    // ---- signed out everywhere ----
    // A copy left on a device nobody opens again: once the team is signed
    // out everywhere, the key it was sealed with is gone.
    const fresh = await s.signIn();
    const asFresh = async (method, url) => (await fetch(s.base + url, { method, headers: { cookie: fresh } })).json();
    const keyThen = (await asFresh('GET', '/api/auth/status')).keepKey;
    await asFresh('POST', '/api/teams/sign-out-all');
    const again = await s.signIn();
    const keyNow = (await (await fetch(`${s.base}/api/auth/status`, { headers: { cookie: again } })).json()).keepKey;
    const opens = await page.evaluate(async ([a, b]) => {
      const tryOpen = async (raw) => { try { await window.__kept.open(raw, window.__old); return true; } catch { return false; } };
      return [await tryOpen(a), await tryOpen(b)];
    }, [keyThen, keyNow]);
    ok(keyThen === keyRaw && opens[0], '(a group kept before, opened with the key of the time)');
    ok(keyNow && keyNow !== keyThen && !opens[1], 'signed out everywhere: the key changes, and what was kept no longer opens', { opens });
    const signedOutStatus = await (await fetch(`${s.base}/api/auth/status`)).json();
    ok(signedOutStatus.keepKey === null && !signedOutStatus.authed, 'signed out: no key is handed out', signedOutStatus.keepKey);

    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
    await browser.close();
  } finally {
    await s.close();
  }
  done();
})().catch(crash);
