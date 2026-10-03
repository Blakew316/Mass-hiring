// Who is ticked on the Candidates page, kept honest. A search hides people
// as surely as a filter does, so it lets go of anyone ticked who no longer
// shows, and says so (it used to keep them, ready to be emailed unseen).
// Someone removed on another device leaves the selection at the next look
// (it used to keep counting them: "3 selected" over two people). Ticking
// the page's box and Clear set the boxes on screen without redrawing the
// list. And on a phone, Next goes to the top of the new page — the page
// scrolls inside .main there, and scrolling the window did nothing.
const { startApp, launch, ok, done, crash, ago } = require('./helpers');
const { stubEverything, open, text, waitIn, settle, poke, person } = require('./views-helpers');

function people() {
  const out = [];
  for (let i = 1; i <= 120; i++) {
    const n = String(i).padStart(3, '0');
    out.push(person(`p${n}`, `${i % 2 ? 'Quinn' : 'Rory'} Picker${n}`, { addedAt: ago(9000 - i), company: i % 3 ? 'Acme' : 'Globex' }));
  }
  return out;
}

(async () => {
  const s = await startApp({ offset: 204 });
  const rec = stubEverything();
  await s.store.update((d) => { d.candidates = people(); d.events = []; });
  const browser = await launch();

  // ================= laptop =================
  {
    const { ctx, page, errors } = await open(browser, s, { at: '/#candidates' });
    await page.waitForSelector('#candidateRows tr[data-id="p001"]');
    const count = async () => ((await page.$eval('#selectionBar', (el) => el.hidden)) ? null : text(page, '#selCount'));
    const toasts = () => page.$$eval('#toasts .toast', (ts) => ts.map((t) => t.textContent));
    const checked = () => page.$$eval('#candidateRows tr', (trs) => trs.filter((tr) => tr.querySelector('.row-check').checked).map((tr) => tr.dataset.id));

    // ---- the page's box and Clear, without drawing the list again ----
    await page.evaluate(() => { window.__rowsDrawn = 0; new MutationObserver((m) => { if (m.some((x) => x.type === 'childList')) window.__rowsDrawn++; }).observe(document.querySelector('#candidateRows'), { childList: true }); });
    await page.check('#checkAll');
    ok(await settle(count, '50 selected') === '50 selected' && (await checked()).length === 50, 'the page\'s box ticks the fifty on screen', await count());
    await page.click('#selClearBtn');
    ok(await settle(count, null) === null && (await checked()).length === 0 && !(await page.$eval('#checkAll', (el) => el.checked)), 'Clear empties every box and the page\'s box');
    ok(await page.evaluate(() => window.__rowsDrawn) === 0, 'neither drew the rows again', await page.evaluate(() => window.__rowsDrawn));

    // ---- a search lets go of whoever it hides ----
    await page.check('#checkAll');
    await settle(count, '50 selected');
    await page.fill('#searchInput', 'Quinn');
    ok(await settle(count, '25 selected') === '25 selected', 'searching "Quinn" keeps the 25 Quinns ticked on page 1, and lets go of the Rorys', await count());
    ok((await toasts()).includes('25 selected people fell outside this search and are no longer selected.'), 'and says so', await toasts());
    await page.fill('#searchInput', '');
    await settle(() => text(page, '#candCount'), '120 candidates');
    ok(await count() === '25 selected', 'clearing the search does not bring them back', await count());
    // One left out, in the singular.
    await page.click('#selClearBtn');
    await page.click('#candidateRows tr[data-id="p001"] .row-check');
    await page.click('#candidateRows tr[data-id="p002"] .row-check');
    await settle(count, '2 selected');
    await page.fill('#searchInput', 'Picker001');
    ok(await settle(count, '1 selected') === '1 selected' && (await toasts()).includes('1 selected person fell outside this search and is no longer selected.'), 'one hidden by a search is said in the singular', await toasts());
    await page.fill('#searchInput', '');
    await settle(() => text(page, '#candCount'), '120 candidates');

    // ---- removed on another device, gone from the selection ----
    await page.click('#selClearBtn');
    for (const id of ['p003', 'p004', 'p005']) await page.click(`#candidateRows tr[data-id="${id}"] .row-check`);
    ok(await settle(count, '3 selected') === '3 selected', 'three ticked');
    await s.store.update((d) => { s.store.removeCandidate(d, 'p004'); });
    await poke(page);
    ok(await settle(count, '2 selected') === '2 selected', 'someone removed elsewhere leaves the selection on the next look', await count());
    ok(await settle(() => text(page, '#selEmailBtn'), 'Email 2') === 'Email 2', 'and Email offers the two who are left', await text(page, '#selEmailBtn'));
    ok(await settle(checked, ['p003', 'p005']).then((c) => JSON.stringify(c) === '["p003","p005"]'), 'the other two stay ticked', await checked());

    ok(errors.length === 0, 'laptop: no page errors', errors);
    await ctx.close();
  }

  // ================= phone =================
  {
    const { ctx, page, errors } = await open(browser, s, { phone: true, at: '/#candidates' });
    await page.waitForSelector('#candidateRows tr');
    const top = () => page.evaluate(() => document.querySelector('.main').scrollTop);
    await page.evaluate(() => { const m = document.querySelector('.main'); m.scrollTop = m.scrollHeight; });
    await page.waitForTimeout(200);
    const down = await top();
    ok(down > 500, 'phone: scrolled down to the pager', down);
    await page.tap('#pagerNext');
    await page.waitForFunction(() => document.querySelector('#pagerPage').textContent === 'Page 2 of 3');
    ok(await waitIn(page, () => document.querySelector('.main').scrollTop < 50, null, 4000), 'phone: Next goes back to the top of the new page', await top());
    ok(errors.length === 0, 'phone: no page errors', errors);
    await ctx.close();
  }

  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await browser.close();
  await s.close();
  done();
})().catch(crash);
