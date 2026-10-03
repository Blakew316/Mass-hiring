// The service worker, in a real browser. It installs from the page, keeps the
// shell (and only the shell) in one cache named for its build, and paints the
// app from that cache — online, and with no connection at all. It never
// touches /api, /auth or /webhooks: those still reach the server as if there
// were no worker, so the session cookie, the conditional poll's 304, the
// Google sign-in redirect and the open-tracking pixel all keep working. It
// never answers for the paperwork portal or the questionnaire. An app opened
// with no connection signs in by itself, in the same page, once the
// connection is back. A shell that has been evicted gives the offline page,
// not a blank one. And a request that fails offline stays failed: nothing
// replays it once the connection is back.
const { startApp, launch, ok, done, crash, ago } = require('./helpers');
const { QUIET, openShell, frontDoor, precacheList, buildStamp, workerText, cacheContents, until } = require('./shell-helpers');

const OFFSET = 170;
const LIVE = /^\/(api|auth|webhooks)(\/|$)/;

(async () => {
  const s = await startApp({ offset: OFFSET });
  await s.store.update((d) => {
    d.candidates = Array.from({ length: 5 }, (_, i) => ({
      id: `w${i}`, name: `Worker Person ${i}`, firstName: 'Worker', lastName: `Person ${i}`,
      email: `worker.person.${i}@example.com`, phone: `(617) 555-03${String(i).padStart(2, '0')}`,
      status: 'new', addedAt: ago(300 + i), source: 'csv',
    }));
  });
  const worker = workerText();
  const BUILD = buildStamp(worker);
  const PRECACHE = precacheList(worker);
  // The browser goes through a front door that records what reaches the
  // server, and can drop every connection for the offline part.
  const door = await frontDoor(s.app, OFFSET + 1);
  const base = door.base;
  const reached = (re) => door.seen.filter((x) => re.test(x.url));
  const browser = await launch({ args: QUIET });
  const v = await openShell(browser, base, { cookie: s.cookie });
  const { ctx, page } = v;
  const path = (u) => new URL(u).pathname;

  // Everything from here on: what the worker asked the network for, and what
  // the page was answered with by the worker.
  const fromWorker = [];      // requests the worker itself made
  const answeredByWorker = []; // page responses that came out of the worker
  const responses = [];
  ctx.on('request', (r) => { if (r.serviceWorker()) fromWorker.push(`${r.method()} ${r.url()}`); });
  ctx.on('response', (r) => {
    responses.push(r);
    // A navigation the server redirects is reported under its first address
    // with the answer to the last (the app, from the cache), so navigations
    // are judged by what reached the server instead.
    if (r.fromServiceWorker() && !r.request().isNavigationRequest()) answeredByWorker.push(r.url());
  });

  // ---------- install ----------
  const controlled = await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15000 }).then(() => true, () => false);
  ok(controlled, 'the worker installs and takes charge of the page');
  const reg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return r && { scope: r.scope, script: r.active && r.active.scriptURL, waiting: Boolean(r.waiting) };
  });
  ok(reg && reg.scope === `${base}/` && reg.script === `${base}/sw.js` && !reg.waiting, 'it is /sw.js, controlling the whole site', reg);
  let caches = await until(async () => { const c = await cacheContents(page); return c[`shell-${BUILD}`] && c[`shell-${BUILD}`].length >= PRECACHE.length ? c : null; });
  caches = caches || await cacheContents(page);
  await page.waitForTimeout(800);   // long enough for a reload to have started, were one coming
  ok(v.loads() === 1, 'a first install does not reload the page', v.loads());
  const notice = await page.evaluate(() => document.querySelector('#notices').innerText);
  ok(!/new version/i.test(notice), 'and does not offer an update', notice);
  const shells = Object.keys(caches).filter((n) => n.startsWith('shell-'));
  ok(shells.length === 1 && shells[0] === `shell-${BUILD}`, `one shell cache, named for this build (shell-${BUILD})`, Object.keys(caches));
  const shell = caches[`shell-${BUILD}`] || [];
  ok(PRECACHE.every((p) => shell.includes(p)), 'it holds every file in the precache list', { missing: PRECACHE.filter((p) => !shell.includes(p)) });
  ok(shell.every((p) => PRECACHE.includes(p)), 'and nothing else', shell.filter((p) => !PRECACHE.includes(p)));

  // ---------- controlled: the shell from the cache, the API from the server ----------
  fromWorker.length = 0; answeredByWorker.length = 0; responses.length = 0;
  const reloaded = await page.reload({ waitUntil: 'networkidle' });
  ok(reloaded.status() === 200 && reloaded.fromServiceWorker(), 'a page load is answered from the shell cache');
  // Every script and stylesheet index.html loads from the site, whatever
  // they are called.
  const html = await (await fetch(`${s.base}/index.html`)).text();
  const pageFiles = [...html.matchAll(/<(script|link)\b[^>]*>/g)].map((m) => m[0])
    .filter((t) => /^<script/.test(t) || /\srel="stylesheet"/.test(t))
    .map((t) => (t.match(/\s(?:src|href)="([^"]*)"/) || [])[1])
    .filter((ref) => ref && ref.startsWith('/') && !ref.startsWith('//'))
    .map((ref) => ref.split(/[?#]/)[0]);
  const fromNetwork = pageFiles.filter((p) => !answeredByWorker.some((u) => path(u) === p));
  ok(pageFiles.length >= 5 && fromNetwork.length === 0, `so is every script and stylesheet the page loads (${pageFiles.length})`, { fromNetwork, answered: answeredByWorker.map(path) });
  const dash = await page.waitForFunction(() => Boolean(document.querySelector('#view-dashboard.active')) && document.querySelector('#loginScreen').hidden, null, { timeout: 10000 }).then(() => true, () => false);
  ok(dash, 'the app signs in and draws the dashboard under the worker');

  const state = await page.evaluate(async () => {
    const a = await fetch('/api/state');
    const tag = a.headers.get('ETag');
    const body = await a.json();
    const b = tag ? await fetch('/api/state', { headers: { 'If-None-Match': tag } }) : null;
    return { status: a.status, total: body && body.stats && body.stats.total, tag: Boolean(tag), again: b && b.status };
  });
  ok(state.status === 200 && state.total === 5, 'the page reads its state through the worker, signed in', state);
  const stateCalls = reached(/^\/api\/state/);
  ok(stateCalls.length >= 2 && stateCalls.every((x) => x.cookie), 'every state request reached the server with the session cookie', stateCalls);
  ok(!state.tag || state.again === 304, 'an unchanged state still comes back 304 to the page', state);

  // The open-tracking pixel, opened as a page.
  const pixel = await page.goto(`${base}/webhooks/open/not-a-real-token`);
  ok(pixel.status() === 200 && /image\/gif/.test(pixel.headers()['content-type'] || '') && !pixel.fromServiceWorker(), 'a tracking pixel comes from the server, not the shell', { status: pixel.status(), type: pixel.headers()['content-type'] });
  ok(reached(/^\/webhooks\/open\/not-a-real-token$/).length === 1, 'and the request for it reached the server');

  // The end of a Google sign-in: the server's redirect, then the app saying why.
  const back = await page.goto(`${base}/auth/google/callback?error=access_denied`, { waitUntil: 'networkidle' });
  const callback = reached(/^\/auth\/google\/callback\?error=access_denied$/);
  ok(callback.length === 1 && callback[0].status === 302 && callback[0].cookie, 'the Google callback reaches the server, with the session cookie, and is answered with its redirect', callback);
  ok(back && new URL(page.url()).pathname === '/', 'and lands back on the app', page.url());
  const toast = await page.waitForFunction(() => /Google sign-in problem: access_denied/.test(document.querySelector('#toasts').innerText), null, { timeout: 5000 }).then(() => true, () => false);
  ok(toast, 'which says what went wrong');

  const api = await page.goto(`${base}/api/no-such-route-here`);
  const apiBody = await page.content();
  ok(api && api.status() === 404 && !api.fromServiceWorker() && !/loginScreen/.test(apiBody) && reached(/^\/api\/no-such-route-here$/).length === 1,
    'an /api address opened as a page is the server\'s answer (404), not the dashboard', api && api.status());

  const paperwork = await page.goto(`${base}/paperwork/`, { waitUntil: 'networkidle' });
  ok(paperwork.status() === 200 && !paperwork.fromServiceWorker() && /Paperwork/.test(await page.title()), 'the paperwork portal is never answered with the dashboard\'s shell', await page.title());
  const iq = await page.goto(`${base}/assessment/?preview=1`, { waitUntil: 'networkidle' });
  ok(iq.status() === 200 && !iq.fromServiceWorker() && /Questionnaire/.test(await page.title()), 'nor is the questionnaire', await page.title());

  const live = fromWorker.filter((x) => LIVE.test(path(x.split(' ')[1])));
  ok(live.length === 0, 'the worker never itself requested anything under /api, /auth or /webhooks', live);
  const liveAnswered = answeredByWorker.filter((u) => LIVE.test(path(u)));
  ok(liveAnswered.length === 0, 'and never answered one the page made', liveAnswered);
  const sawLive = responses.filter((r) => LIVE.test(path(r.url()))).length;
  ok(sawLive >= 5, 'while the page did use them', sawLive);

  // ---------- pictures ----------
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  const pics = await page.evaluate(async () => {
    const missing = await fetch('/icons/no-such-icon.png');
    const there = await fetch('/icons/favicon-48.png');
    return { missing: missing.status, there: there.status };
  });
  ok(pics.missing === 404 && pics.there === 200, 'pictures are fetched through the worker', pics);
  const kept = await until(async () => ((await cacheContents(page))['assets-v1'] || []).includes('/icons/favicon-48.png'));
  ok(kept, 'a picture is kept for next time');
  const all = await cacheContents(page);
  const everything = Object.values(all).flat();
  ok(!everything.includes('/icons/no-such-icon.png'), 'a 404 is never kept', all['assets-v1']);
  ok(!everything.some((p) => LIVE.test(p)), 'no cache holds anything from /api, /auth or /webhooks', everything.filter((p) => LIVE.test(p)));

  // ---------- offline ----------
  v.errors.length = 0;
  const failuresBefore = v.failures.length;
  door.setDown(true);
  await ctx.setOffline(true);
  const off = await page.reload({ waitUntil: 'load' });
  ok(off && off.status() === 200 && off.fromServiceWorker(), 'with no connection the app still opens, from the cache');
  const offline = await page.waitForFunction(() => document.documentElement.classList.contains('is-offline'), null, { timeout: 8000 }).then(() => true, () => false);
  const drawn = await page.evaluate(() => ({
    title: document.title,
    shell: Boolean(document.querySelector('.shell .sidebar')),
    styled: getComputedStyle(document.documentElement).getPropertyValue('--navy').trim(),
    logo: (document.querySelector('.brand-logo') || {}).naturalWidth || 0,
    marker: (() => { const el = document.querySelector('.conn-lost'); return el && !el.hidden ? el.innerText.trim() : ''; })(),
  }));
  ok(/WPI Outreach/.test(drawn.title) && drawn.shell && drawn.styled && drawn.logo > 0, 'the whole shell is drawn offline: page, styles and logo', drawn);
  ok(offline && /offline/i.test(drawn.marker), 'and says it is offline', drawn.marker);
  const offFetch = await page.evaluate(async () => {
    const css = await fetch('/styles.css').then((r) => r.status, () => 0);
    const add = await fetch('/api/candidates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'tunnel.person@example.com', firstName: 'Tunnel' }) })
      .then((r) => `answered ${r.status}`, (e) => `failed: ${e.name}`);
    return { css, add };
  });
  ok(offFetch.css === 200, 'a shell file is there offline', offFetch);
  ok(/^failed/.test(offFetch.add), 'a change made offline fails, visibly, to the page that made it', offFetch.add);
  ok(v.errors.length === 0, 'opening offline: no page errors', v.errors);

  // ---------- the connection comes back ----------
  // The app opened with no connection keeps trying on its own: once the
  // network is back it signs in and shows the list, in the same page. Today
  // that is the next retry, ten seconds after the first failure; the wait
  // allows for the longest retry (thirty).
  fromWorker.length = 0;
  const seenAtReturn = door.seen.length;
  const loadsOffline = v.loads();
  door.setDown(false);
  await ctx.setOffline(false);
  const failuresAtReturn = v.failures.length;
  const recovered = await page.waitForFunction(() => Boolean(document.querySelector('#view-dashboard.active'))
    && document.querySelector('#loginScreen').hidden
    && !document.documentElement.classList.contains('is-offline')
    && [...document.querySelectorAll('.conn-lost')].every((el) => el.hidden)
    && document.querySelector('#statTotal').textContent.trim() === '5', null, { timeout: 40000 }).then(() => true, () => false);
  ok(recovered, 'opened offline, the app signs in by itself once the connection is back, shows the list, and stops saying Offline',
    await page.evaluate(() => ({ offline: document.documentElement.classList.contains('is-offline'), total: (document.querySelector('#statTotal') || {}).textContent })));
  ok(v.loads() === loadsOffline, 'without reloading the page', v.loads() - loadsOffline);
  await page.waitForLoadState('networkidle');
  ok(v.errors.length === 0, 'coming back online: no page errors', v.errors);
  ok(v.failures.length === failuresAtReturn, 'and no request to the site failed once it was back', v.failures.slice(failuresAtReturn));

  // ---------- evicted ----------
  door.setDown(true);
  await ctx.setOffline(true);
  await page.evaluate(async () => { for (const n of await caches.keys()) if (n.startsWith('shell-')) await caches.delete(n); });
  const evicted = await page.reload({ waitUntil: 'load' });
  const offPage = await page.evaluate(() => ({ title: document.title, text: document.body.innerText, button: Boolean([...document.querySelectorAll('button')].find((b) => /try again/i.test(b.innerText))) }));
  ok(evicted && evicted.status() === 503 && /offline/i.test(offPage.title) && /No connection/.test(offPage.text) && offPage.button, 'with the shell evicted and no connection: the offline page, with a way to try again', { status: evicted && evicted.status(), ...offPage });

  // ---------- back online ----------
  // What failed while there was no connection was meant to.
  v.failures.splice(failuresBefore);
  door.setDown(false);
  await ctx.setOffline(false);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('text=Try again')]);
  const again = await page.waitForFunction(() => Boolean(document.querySelector('#view-dashboard.active')), null, { timeout: 10000 }).then(() => true, () => false);
  ok(again && /WPI Outreach/.test(await page.title()), '"Try again" with the connection back opens the app');
  await page.waitForTimeout(1000);
  const db = await s.store.load();
  ok(!db.candidates.some((c) => c.email === 'tunnel.person@example.com'), 'the change that failed offline was not replayed when the connection came back (twice)');
  const resent = door.seen.slice(seenAtReturn).filter((x) => x.method === 'POST' && /^\/api\/candidates/.test(x.url));
  ok(resent.length === 0, 'nothing sent it again', resent);
  ok(!fromWorker.some((x) => /^POST /.test(x)), 'the worker sent nothing of its own', fromWorker.filter((x) => /^POST /.test(x)));
  ok(v.failures.filter((f) => !/no-such-/.test(f)).length === 0, 'online, no request to the site failed (but the two addresses that do not exist)', v.failures);

  await ctx.close();
  await browser.close();
  await door.close();
  await s.close();
  done();
})().catch(crash);
