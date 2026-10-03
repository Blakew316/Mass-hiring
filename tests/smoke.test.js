// The app starts, signs in, answers its state, and every page draws without
// a page error on a laptop and on a phone.
const { startApp, launch, openPage, ok, done, crash, ago } = require('./helpers');

(async () => {
  const s = await startApp({ offset: 0 });
  await s.store.update((d) => {
    d.candidates = Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`, name: `Test Person ${i}`, firstName: 'Test', lastName: `Person ${i}`,
      email: `test.person.${i}@example.com`, phone: `(617) 555-01${String(i).padStart(2, '0')}`,
      status: ['new', 'emailed', 'replied'][i % 3], addedAt: ago(1000 + i), source: 'csv',
    }));
  });
  const st = await s.json('GET', '/api/state');
  ok(st.status === 200 && st.body && st.body.stats && st.body.stats.total === 30, 'signed in, the state answers with the list', st.status);
  const anon = await fetch(`${s.base}/api/state`);
  ok(anon.status === 401, 'signed out, it does not', anon.status);
  const browser = await launch();
  for (const phone of [false, true]) {
    const { ctx, page, errors } = await openPage(browser, s, { phone });
    for (const view of ['dashboard', 'candidates', 'texting', 'template', 'salesiq', 'onboarding', 'settings', 'import']) {
      await page.evaluate((v) => { const el = document.querySelector(`.nav-item[data-view="${v}"]`); if (el) el.click(); }, view);
      await page.waitForTimeout(250);
      const shown = await page.evaluate((v) => Boolean(document.querySelector(`#view-${v}.active`)), view);
      ok(shown, `${phone ? 'phone' : 'laptop'}: ${view} opens`);
    }
    ok(errors.length === 0, `${phone ? 'phone' : 'laptop'}: no page errors`, errors);
    await ctx.close();
  }
  await browser.close();
  await s.close();
  done();
})().catch(crash);
