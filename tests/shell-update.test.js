// A new version of the shell (a new sw.js build) is taken only at a safe
// moment. The new worker installs and waits; the page moves to it by itself
// only while it is still starting (the first 20 seconds) or on the way back
// into the app, and only when nothing is in flight — no dialog open, nothing
// typed. Otherwise it says "A new version is ready" with a Reload button, and
// waits, the new worker untouched. The × puts the offer away, and it stays
// away when the page refreshes its data; the app still moves the next time it
// is opened, or on the way back in. On a phone, pulling the page down to
// refresh is somebody asking for the latest, so a pull moves too. A first
// install is not an update. When another window takes the update, this one is
// not reloaded under its user, and its Reload still works. The old shell cache
// goes; the picture cache stays.
//
// "Moves" is judged two ways: the page reloading onto the new build, and —
// for coming back into the app and for a pull — the new worker being told to
// take over (the front door's test build reports its skipWaiting). Both of
// those also start the state poll at the same moment, and Chromium can hold
// back a skipWaiting sent while the page has a request in flight until the
// old worker goes idle (30 seconds in Chrome; never, with DevTools attached as
// here), so there the reload itself is not required.
const { startApp, launch, ok, done, crash, ago } = require('./helpers');
const { QUIET, openShell, frontDoor, buildStamp, workerText, cacheContents, until } = require('./shell-helpers');

const OFFSET = 175;   // and 176 and 177 for the two front doors
const NOTICE = /A new version is ready/;

(async () => {
  const s = await startApp({ offset: OFFSET });
  await s.store.update((d) => {
    d.candidates = Array.from({ length: 6 }, (_, i) => ({
      id: `u${i}`, name: `Update Person ${i}`, firstName: 'Update', lastName: `Person ${i}`,
      email: `update.person.${i}@example.com`, phone: `(617) 555-04${String(i).padStart(2, '0')}`,
      status: i % 2 ? 'emailed' : 'new', addedAt: ago(200 + i), source: 'csv',
    }));
  });
  const OLD = buildStamp(workerText());
  const door = await frontDoor(s.app, OFFSET + 1);
  // A second copy of the site, for a phone beside the laptop: its own origin,
  // so its own worker, and its own new build.
  const door2 = await frontDoor(s.app, OFFSET + 2);
  const browser = await launch({ args: QUIET });

  // A page reloading under the question is an answer too, not a crash.
  const noticeText = (page) => page.evaluate(() => document.querySelector('#notices').innerText).catch(() => '(the page was reloading)');
  const shellsOf = async (page) => Object.keys(await cacheContents(page)).filter((n) => n.startsWith('shell-'));
  const toldToTakeOver = (stamp, d = door) => d.tookOver().some((x) => x.build === stamp);
  // The browser looking for a new worker, as it does on a navigation or when
  // the app comes back into view. Not waited on: the page may reload under it.
  const lookForUpdate = (page) => page.evaluate(() => { navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {}); }).catch(() => {});
  // The new worker waits, and the page keeps running against its own version
  // (its shell cache still there) until it moves.
  const held = (page) => page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return { waiting: Boolean(r && r.waiting), shells: (await caches.keys()).filter((n) => n.startsWith('shell-')) };
  });
  // What the page and its worker are doing, for a failure message.
  const why = async (v, page = v.page, d = door) => {
    try {
      return {
        loads: v.loads ? v.loads() : undefined,
        tookOver: d.tookOver().map((x) => x.build),
        ...(await page.evaluate(async () => {
          const r = await navigator.serviceWorker.getRegistration();
          const el = document.activeElement;
          return {
            waiting: r && r.waiting ? r.waiting.state : null,
            installing: r && r.installing ? r.installing.state : null,
            active: r && r.active ? r.active.state : null,
            shells: (await caches.keys()).filter((n) => n.startsWith('shell-')),
            notice: document.querySelector('#notices').innerText.slice(0, 80),
            focus: el ? `${el.tagName}#${el.id}` : '',
            dialogs: [...document.querySelectorAll('.modal-backdrop:not([hidden])')].map((m) => m.id),
            hidden: document.hidden,
          };
        })),
      };
    } catch (e) { return { error: e.message }; }
  };
  const noticeShown = (page) => page.waitForFunction((re) => new RegExp(re).test(document.querySelector('#notices').innerText), NOTICE.source, { timeout: 15000 }).then(() => true, () => false);
  const reloadedOnto = async (v, before, stamp, page = v.page) => {
    const moved = await until(() => v.loads() > before, { timeout: 15000 });
    if (!moved) return false;
    await page.waitForLoadState('networkidle');
    const ready = await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller) && Boolean(document.querySelector('#view-dashboard')), null, { timeout: 10000 }).then(() => true, () => false);
    const shells = await shellsOf(page);
    return ready && shells.includes(`shell-${stamp}`) && !shells.includes(`shell-${OLD}`);
  };

  // However many reloads it takes, the page ends up on the new build.
  const landsOn = async (page, stamp) => Boolean(await until(async () => {
    try {
      const shells = await shellsOf(page);
      const up = await page.evaluate(() => Boolean(navigator.serviceWorker.controller) && Boolean(document.querySelector('#view-dashboard.active')));
      return up && shells.includes(`shell-${stamp}`) && !shells.includes(`shell-${OLD}`);
    } catch (e) { return false; }   // in the middle of a reload
  }, { timeout: 15000, every: 250 }));

  // A finger pulling the page down from the top and letting go, as real
  // touch input.
  async function pullDown(page) {
    const cdp = await page.context().newCDPSession(page);
    const x = 195;
    const y = 260;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let dy = 12; dy <= 240; dy += 12) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + dy }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }

  // A page on the current version, opened with that worker already in
  // charge — the everyday case of opening the app again.
  async function onCurrentVersion(label, { d = door, phone = false } = {}) {
    d.setWorker(null);
    const v = await openShell(browser, d.base, { cookie: s.cookie, phone });
    await v.page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15000 });
    await v.page.waitForTimeout(800);   // long enough for a reload to have started, were one coming
    ok(v.loads() === 1 && !NOTICE.test(await noticeText(v.page)), `${label}: the first install neither reloads the page nor offers an update`, v.loads());
    await v.page.reload({ waitUntil: 'networkidle' });
    return v;
  }

  // ---------- while starting, nothing in flight: taken by itself ----------
  {
    const v = await onCurrentVersion('starting');
    const stamp = door.newBuild('a000000001');
    const before = v.loads();
    await lookForUpdate(v.page);
    ok(await reloadedOnto(v, before, stamp), 'a new version found while the app is starting is taken by itself, onto the new build', await why(v));
    await v.page.waitForTimeout(1000);
    ok(v.loads() === before + 1, 'with exactly one reload', v.loads() - before);
    ok(!NOTICE.test(await noticeText(v.page)), 'and there is nothing left to offer');
    const caches = Object.keys(await cacheContents(v.page));
    ok(caches.includes('assets-v1') && caches.filter((n) => n.startsWith('shell-')).length === 1, 'the old shell cache is gone, the picture cache kept', caches);
    ok(v.errors.length === 0, 'starting: no page errors', v.errors);
    await v.ctx.close();
  }

  // ---------- a dialog open: offered, not taken; the × puts it away; the next open takes it ----------
  {
    const v = await onCurrentVersion('dialog');
    await v.page.click('.stat-card[data-tile="emailed"]');
    await v.page.waitForSelector('#tileModal:not([hidden])');
    const stamp = door.newBuild('b000000002');
    const before = v.loads();
    await lookForUpdate(v.page);
    ok(await noticeShown(v.page), 'with a dialog open, the new version is offered instead', await why(v));
    ok(await v.page.isVisible('#reloadForUpdate'), 'the offer has a Reload button');
    await v.page.waitForTimeout(1000);
    ok(v.loads() === before && await v.page.isVisible('#tileModal'), 'the page is not reloaded out from under the dialog');
    const h1 = await held(v.page);
    ok(h1.waiting && h1.shells.includes(`shell-${OLD}`) && !toldToTakeOver(stamp), 'and the new version is left waiting: nothing is swapped under the open page', { ...h1, tookOver: door.tookOver() });
    // Coming back to the app with the dialog still open changes nothing.
    await v.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await v.page.waitForTimeout(1000);
    ok(v.loads() === before && await v.page.isVisible('#tileModal') && !toldToTakeOver(stamp), 'coming back with the dialog open does not move either');
    await v.page.keyboard.press('Escape');
    await v.page.waitForSelector('#tileModal', { state: 'hidden' });
    await v.page.click('#dismissUpdate');
    const gone = await v.page.waitForFunction((re) => !new RegExp(re).test(document.querySelector('#notices').innerText), NOTICE.source, { timeout: 5000 }).then(() => true, () => false);
    await v.page.waitForTimeout(500);
    ok(gone && v.loads() === before && !toldToTakeOver(stamp), 'its × puts the offer away, and changes nothing else');
    // "It installs by itself the next time you open the app."
    await v.page.reload({ waitUntil: 'load' });
    ok(await landsOn(v.page, stamp), 'the next time the app is opened, it moves to the new version by itself', await why(v));
    ok(v.errors.length === 0, 'dialog: no page errors', v.errors);
    await v.ctx.close();
  }

  // ---------- something typed: offered, and Reload takes it ----------
  {
    const v = await onCurrentVersion('typing');
    await v.page.click('.nav-item[data-view="candidates"]');
    await v.page.waitForSelector('#view-candidates.active');
    await v.page.click('#searchInput');
    await v.page.keyboard.type('half a thought');
    const stamp = door.newBuild('c000000003');
    const before = v.loads();
    await lookForUpdate(v.page);
    ok(await noticeShown(v.page), 'with something typed, the new version is offered instead', await why(v));
    await v.page.waitForTimeout(1000);
    ok(v.loads() === before && (await v.page.inputValue('#searchInput')) === 'half a thought', 'and what was typed is still there');
    const h2 = await held(v.page);
    ok(h2.waiting && h2.shells.includes(`shell-${OLD}`) && !toldToTakeOver(stamp), 'the new version is left waiting until asked', h2);
    // Coming back to the app while something is typed changes nothing either.
    await v.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await v.page.waitForTimeout(1000);
    ok(v.loads() === before && !toldToTakeOver(stamp) && (await v.page.inputValue('#searchInput')) === 'half a thought', 'coming back with something typed does not move either');
    await v.page.click('#reloadForUpdate');
    ok(await reloadedOnto(v, before, stamp), 'Reload moves to the new version', await why(v));
    ok(!NOTICE.test(await noticeText(v.page)), 'after which nothing is offered');
    ok(v.errors.length === 0, 'typing: no page errors', v.errors);
    await v.ctx.close();
  }

  // ---------- two windows: one takes it, the other is left alone and its Reload works ----------
  {
    const a = await onCurrentVersion('two windows');
    const pageB = await a.ctx.newPage();
    let loadsB = 0;
    const errorsB = [];
    pageB.on('load', () => { loadsB += 1; });
    pageB.on('pageerror', (e) => errorsB.push(e.message));
    await pageB.goto(`${door.base}/`, { waitUntil: 'networkidle' });
    for (const page of [a.page, pageB]) {
      await page.click('.nav-item[data-view="candidates"]');
      await page.waitForSelector('#view-candidates.active');
      await page.click('#searchInput');
      await page.keyboard.type('still typing');
    }
    const stamp = door.newBuild('d000000004');
    const beforeA = a.loads();
    const beforeB = loadsB;
    await lookForUpdate(a.page);
    ok(await noticeShown(a.page) && await noticeShown(pageB), 'both windows offer the new version', await why(a));
    await a.page.click('#reloadForUpdate');
    ok(await reloadedOnto(a, beforeA, stamp), 'the first window\'s Reload moves it to the new version', await why(a));
    await pageB.waitForTimeout(1500);
    ok(loadsB === beforeB && (await pageB.inputValue('#searchInput')) === 'still typing', 'the other window is not reloaded under its user');
    ok(NOTICE.test(await noticeText(pageB)), 'it still offers the new version');
    await pageB.click('#reloadForUpdate');
    const bMoved = await until(() => loadsB > beforeB, { timeout: 10000 });
    ok(bMoved, 'and its Reload works straight away');
    await pageB.waitForLoadState('networkidle');
    ok((await shellsOf(pageB)).includes(`shell-${stamp}`) && !NOTICE.test(await noticeText(pageB)), 'onto the new version, with nothing left to offer');
    ok(a.errors.length === 0 && errorsB.length === 0, 'two windows: no page errors', a.errors.concat(errorsB));
    await a.ctx.close();
  }

  // ---------- after the first 20 seconds: offered, not taken; a refresh keeps it put away; coming back, or a pull on a phone, takes it ----------
  {
    const p = await onCurrentVersion('settled, phone', { d: door2, phone: true });
    const v = await onCurrentVersion('settled');
    await v.page.waitForTimeout(21000);   // the starting window is 20 seconds
    const stamp = door.newBuild('e000000005');
    const before = v.loads();
    await lookForUpdate(v.page);
    ok(await noticeShown(v.page), 'once the app has settled, a new version is offered, not forced', await why(v));
    await v.page.waitForTimeout(1000);
    ok(v.loads() === before, 'the page is not reloaded while somebody may be reading it');
    const h3 = await held(v.page);
    ok(h3.waiting && h3.shells.includes(`shell-${OLD}`) && !toldToTakeOver(stamp), 'and the new version is left waiting', h3);

    // Put away, the offer stays away for this version, however often the
    // page refreshes what it shows; and a refresh is not a moment to move.
    await v.page.click('#dismissUpdate');
    const gone = await v.page.waitForFunction((re) => !new RegExp(re).test(document.querySelector('#notices').innerText), NOTICE.source, { timeout: 5000 }).then(() => true, () => false);
    const totalBefore = Number((await v.page.textContent('#statTotal')).replace(/\D/g, ''));
    await s.store.update((d) => {
      d.candidates.push({ id: 'u6', name: 'Update Person 6', firstName: 'Update', lastName: 'Person 6', email: 'update.person.6@example.com', phone: '(617) 555-0406', status: 'new', addedAt: ago(100), source: 'csv' });
    });
    await v.page.evaluate(() => window.dispatchEvent(new Event('online')));   // the connection is back: the page looks again
    const refreshed = await v.page.waitForFunction((n) => document.querySelector('#statTotal').textContent.replace(/\D/g, '') === String(n), totalBefore + 1, { timeout: 10000 }).then(() => true, () => false);
    await v.page.waitForTimeout(500);
    ok(gone && refreshed && !NOTICE.test(await noticeText(v.page)), 'put away, the offer stays away when the page refreshes and shows new data', { gone, refreshed, totalBefore, notice: await noticeText(v.page) });
    ok(v.loads() === before && !toldToTakeOver(stamp), 'and that refresh, after the first 20 seconds, does not move it');

    // Coming back to the app from somewhere else, nothing in flight.
    await v.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const told = await until(() => toldToTakeOver(stamp), { timeout: 8000 });
    ok(told, 'coming back into the app, with nothing in flight, it moves to the new version by itself', await why(v));
    // The reload that follows is not waited for (see the top of the file).
    ok(v.errors.length === 0, 'settled: no page errors', v.errors);

    // The phone, settled as long: nothing has looked for a new version since
    // it opened. Pulling the page down looks, finds it, and moves to it.
    const pstamp = door2.newBuild('f000000006');
    const swAsked = door2.seen.filter((x) => x.url.split('?')[0] === '/sw.js').length;
    await pullDown(p.page);
    const pulled = await until(() => toldToTakeOver(pstamp, door2), { timeout: 10000 });
    ok(door2.seen.filter((x) => x.url.split('?')[0] === '/sw.js').length > swAsked, 'on a phone, pulling the page down to refresh looks for a new version');
    ok(pulled, 'and, after the first 20 seconds and with nothing in flight, moves to it by itself', await why(p, p.page, door2));
    ok(p.errors.length === 0, 'settled, phone: no page errors', p.errors);
    await p.ctx.close();
    await v.ctx.close();
  }

  await browser.close();
  await door.close();
  await door2.close();
  await s.close();
  done();
})().catch(crash);
