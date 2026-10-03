// The phone shell: the tab bar (Home, People, Inbox, Hiring, More) and where
// each tab goes, the More sheet, Inbox and Hiring each going back to the one
// of their pair last used, the page living in the address bar (Back goes back
// a page, a reload stays put), pulling the page down to refresh, a device
// coming back online asking again, and the Offline marker. The laptop's
// sidebar is checked for the same pages.
const { startApp, launch, ok, done, crash, ago } = require('./helpers');
const { stubEverything, open, ready, text, texts, waitIn, waitText, poke, person } = require('./views-helpers');

(async () => {
  const s = await startApp({ offset: 152 });
  const rec = stubEverything();
  await s.store.update((d) => {
    d.candidates = Array.from({ length: 40 }, (_, i) => person(`p${i}`, `Phone Person${i}`, { addedAt: ago(5000 - i) }));
  });
  const browser = await launch();

  // ================= phone =================
  {
    const tag = 'phone';
    const { ctx, page, errors } = await open(browser, s, { phone: true });
    const tabs = await page.evaluate(() => [...document.querySelectorAll('.nav > .nav-item')].filter((t) => t.getClientRects().length).map((t) => t.dataset.short));
    ok(JSON.stringify(tabs) === JSON.stringify(['Home', 'People', 'Inbox', 'Hiring', 'More']), `${tag}: the tab bar is Home, People, Inbox, Hiring, More`, tabs);
    const lit = () => page.evaluate(() => [...document.querySelectorAll('.nav > .nav-item')].filter((t) => t.getClientRects().length && t.classList.contains('active')).map((t) => t.dataset.short));
    const active = () => page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    ok(await active() === 'view-dashboard' && JSON.stringify(await lit()) === '["Home"]', `${tag}: it opens on Home`, [await active(), await lit()]);

    const tap = async (sel, view, short) => {
      await page.click(sel);
      const got = await waitIn(page, (v) => (document.querySelector(`#view-${v}.active`) ? v : false), view, 5000);
      ok(got === view && JSON.stringify(await lit()) === JSON.stringify([short]), `${tag}: ${short} opens ${view} and lights its tab`, [await active(), await lit()]);
    };
    await tap('.nav-item[data-view="candidates"]', 'candidates', 'People');
    ok(await waitText(page, '#candCount', '40 candidates'), `${tag}: People is the candidate list`, await text(page, '#candCount'));
    await tap('.nav-group[data-group="inbox"]', 'template', 'Inbox');
    const inboxSwitch = await texts(page, '#view-template .group-tab');
    ok(JSON.stringify(inboxSwitch) === JSON.stringify(['Email', 'Texts']), `${tag}: Inbox switches between Email and Texts`, inboxSwitch);
    ok(await text(page, '#view-template .group-title') === 'Inbox', `${tag}: under the title Inbox`, await text(page, '#view-template .group-title'));
    await page.click('#view-template .group-tab[data-goto="texting"]');
    ok(await waitIn(page, () => Boolean(document.querySelector('#view-texting.active'))) && JSON.stringify(await lit()) === '["Inbox"]', `${tag}: Texts is still the Inbox tab`, await lit());
    await tap('.nav-group[data-group="hiring"]', 'salesiq', 'Hiring');
    const hiringSwitch = await texts(page, '#view-salesiq .group-tab');
    ok(JSON.stringify(hiringSwitch) === JSON.stringify(['Sales IQ', 'Onboarding docs']), `${tag}: Hiring switches between Sales IQ and Onboarding docs`, hiringSwitch);
    await tap('.nav-item[data-view="dashboard"]', 'dashboard', 'Home');
    await tap('.nav-group[data-group="inbox"]', 'texting', 'Inbox');

    // More: the pages with no tab of their own.
    await page.click('#navMore');
    await page.waitForSelector('#moreSheet:not([hidden])');
    const more = await texts(page, '#moreSheetButtons .more-label');
    ok(JSON.stringify(more) === JSON.stringify(['Import', 'Settings']), `${tag}: More lists Import and Settings`, more);
    await page.click('#moreSheetButtons [data-more="settings"]');
    ok(await waitIn(page, () => Boolean(document.querySelector('#view-settings.active'))), `${tag}: a page from More opens`);
    ok(await page.isHidden('#moreSheet'), `${tag}: and the sheet goes away`);
    ok(JSON.stringify(await lit()) === '["More"]', `${tag}: More is lit while on one of its pages`, await lit());
    await page.click('#navMore');
    await page.waitForSelector('#moreSheet:not([hidden])');
    ok(await page.evaluate(() => document.querySelector('#moreSheetButtons [data-more="settings"]').classList.contains('is-current')), `${tag}: the sheet marks the page you are on`);
    await page.click('#moreSheetButtons [data-more="import"]');
    ok(await waitIn(page, () => Boolean(document.querySelector('#view-import.active'))), `${tag}: Import from More`);

    // The page is in the address bar: Back goes back a page, a reload stays.
    ok(await page.evaluate(() => location.hash) === '#import', `${tag}: the address says which page`, await page.evaluate(() => location.hash));
    await page.goBack();
    ok(await waitIn(page, () => Boolean(document.querySelector('#view-settings.active'))), `${tag}: Back goes to the page before`, await active());
    await page.goBack();
    ok(await waitIn(page, () => Boolean(document.querySelector('#view-texting.active'))), `${tag}: and the one before that`, await active());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(page);
    ok(await waitIn(page, () => Boolean(document.querySelector('#view-texting.active'))), `${tag}: a reload stays on the page`, await active());

    // Tapping the tab you are on goes back to the top.
    await page.click('.nav-item[data-view="candidates"]');
    await page.waitForSelector('#view-candidates.active');
    await page.evaluate(() => { document.querySelector('.main').scrollTop = 600; });
    await page.waitForTimeout(100);
    const down = await page.evaluate(() => document.querySelector('.main').scrollTop);
    await page.click('.nav-item[data-view="candidates"]');
    ok(down > 0 && await waitIn(page, () => document.querySelector('.main').scrollTop === 0), `${tag}: tapping the current tab scrolls to the top`, down);

    // Pull down to refresh.
    await page.click('.nav-item[data-view="dashboard"]');
    await page.waitForSelector('#view-dashboard.active');
    ok(await text(page, '#statTotal') === '40', `${tag}: 40 on the Dashboard`, await text(page, '#statTotal'));
    await s.store.update((d) => { d.candidates.push(person('pnew', 'Pulled Person')); });
    const asked = page.waitForRequest((r) => r.url().endsWith('/api/state'), { timeout: 8000 }).catch(() => null);
    const cdp = await ctx.newCDPSession(page);
    const x = 195;
    const y0 = 260;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + i * 25 }] });
      await page.waitForTimeout(16);
    }
    const pulled = await page.evaluate(() => { const v = document.querySelector('#view-dashboard'); return v.style.transform; });
    ok(/translateY\(\d+/.test(pulled), `${tag}: the page follows the finger down`, pulled);
    ok(await page.evaluate(() => document.querySelector('.ptr').classList.contains('is-armed')), `${tag}: past the mark the spinner is armed`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    ok(Boolean(await asked), `${tag}: letting go asks the server again`);
    ok(await waitText(page, '#statTotal', '41'), `${tag}: and shows what changed`, await text(page, '#statTotal'));
    ok(await waitIn(page, () => !document.querySelector('#view-dashboard').style.transform), `${tag}: the page settles back`);
    ok(!(await page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => /Couldn/.test(t.textContent)))), `${tag}: with no "couldn't refresh"`);

    // Coming back online asks again; going offline says so.
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    ok(await waitIn(page, () => { const c = document.querySelector('#view-dashboard .conn-lost'); return c && !c.hidden && document.documentElement.classList.contains('is-offline'); }), `${tag}: going offline shows the Offline marker`);
    await s.store.update((d) => { d.candidates.push(person('pnew2', 'Online Person')); });
    await poke(page, 'online');
    ok(await waitText(page, '#statTotal', '42'), `${tag}: back online it asks again and shows the change`, await text(page, '#statTotal'));
    ok(await waitIn(page, () => document.querySelector('#view-dashboard .conn-lost').hidden && !document.documentElement.classList.contains('is-offline')), `${tag}: and the marker goes`);

    ok(errors.length === 0, `${tag}: no page errors`, errors);
    await ctx.close();
  }

  // ================= laptop =================
  {
    const tag = 'laptop';
    const { ctx, page, errors } = await open(browser, s);
    const side = await page.evaluate(() => [...document.querySelectorAll('.nav > .nav-item')].filter((t) => t.getClientRects().length).map((t) => t.querySelector('.nav-label').textContent.trim()));
    ok(JSON.stringify(side) === JSON.stringify(['Dashboard', 'Candidates', 'Import', 'Email', 'Texting', 'Sales IQ', 'Onboarding docs', 'Settings']), `${tag}: the sidebar lists every page`, side);
    for (const v of ['candidates', 'import', 'template', 'texting', 'salesiq', 'onboarding', 'settings', 'dashboard']) {
      await page.click(`.nav-item[data-view="${v}"]`);
      ok(await waitIn(page, (x) => Boolean(document.querySelector(`#view-${x}.active`)) && document.querySelector(`.nav-item[data-view="${x}"]`).classList.contains('active'), v), `${tag}: ${v} opens from the sidebar`);
    }
    // A change arrives when the tab is looked at again.
    await s.store.update((d) => { d.candidates.push(person('pnew3', 'Visible Person')); });
    await poke(page, 'visibilitychange');
    ok(await waitText(page, '#statTotal', '43'), `${tag}: coming back to the tab shows the change`, await text(page, '#statTotal'));
    ok(errors.length === 0, `${tag}: no page errors`, errors);
    await ctx.close();
  }

  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await browser.close();
  await s.close();
  done();
})().catch(crash);
