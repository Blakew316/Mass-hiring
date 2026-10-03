// index.html itself: it loads with no page error and no failed request to its
// own server — signed out and signed in, on a laptop and on a phone — and both
// themes draw the logo and the page. Dark mode follows the device until a
// choice is made, a remembered choice wins over the device, and the switch
// flips it and keeps it across a reload.
const { startApp, launch, ok, done, crash, ago } = require('./helpers');
const { QUIET, openShell, inkIn } = require('./shell-helpers');

const OFFSET = 165;

const lum = (rgb) => {
  const m = String(rgb).match(/(\d+(?:\.\d+)?)/g);
  if (!m) return null;
  const [r, g, b] = m.map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

// What the page shows for the theme: the attribute, the page's own colour,
// and which picture the logo is drawn from (a stylesheet may replace the
// image's own source with its content property).
const drawnFrom = (img) => {
  const c = getComputedStyle(img).content || '';
  const m = c.match(/url\("?([^")]+)"?\)/);
  return m ? m[1] : img.currentSrc;
};
const looks = (page, sel) => page.evaluate(([s, fn]) => {
  const img = document.querySelector(s);
  const cs = img ? getComputedStyle(img) : null;
  const r = img ? img.getBoundingClientRect() : null;
  // eslint-disable-next-line no-new-func
  const drawn = img ? new Function(`return (${fn})`)()(img) : null;
  return {
    theme: document.documentElement.getAttribute('data-theme'),
    body: getComputedStyle(document.body).backgroundColor,
    drawn,
    box: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
    shown: Boolean(img && r.width > 20 && r.height > 8 && cs.visibility !== 'hidden' && cs.display !== 'none'),
  };
}, [sel, drawnFrom.toString()]);

// The picture a logo is drawn from loads and has pixels.
const decodes = (page, url) => page.evaluate(async (u) => {
  const i = new Image();
  i.src = u;
  try { await i.decode(); } catch (e) { return 0; }
  return i.naturalWidth;
}, url);

async function checkLogo(page, sel, dark, label) {
  // A theme change swaps the picture, which then has to arrive and be laid out.
  await page.waitForFunction(([x, d, fn]) => {
    const img = document.querySelector(x);
    const r = img && img.getBoundingClientRect();
    // eslint-disable-next-line no-new-func
    return r && r.height > 8 && /logo-dark/.test(new Function(`return (${fn})`)()(img)) === d;
  }, [sel, dark, drawnFrom.toString()], { timeout: 5000 }).catch(() => {});
  const l = await looks(page, sel);
  ok(l.theme === (dark ? 'dark' : 'light'), `${label}: the page is in ${dark ? 'dark' : 'light'} mode`, l.theme);
  const bodyLum = lum(l.body);
  ok(dark ? bodyLum < 0.2 : bodyLum > 0.75, `${label}: the page is drawn ${dark ? 'dark' : 'light'}`, l.body);
  ok(l.shown, `${label}: the logo is on screen`, l.box);
  if (dark) ok(/\/assets\/logo-dark-510\.png$/.test(l.drawn || ''), `${label}: the logo is the light-on-dark artwork`, l.drawn);
  else ok(/\/assets\/logo-510\.png$/.test(l.drawn || ''), `${label}: the logo is the standard artwork`, l.drawn);
  const url = dark ? '/assets/logo-dark-510.png' : '/assets/logo-510.png';
  ok((await decodes(page, url)) > 100, `${label}: ${url} loads as a picture`);
  if (l.box && l.box.height > 0) {
    const ink = await inkIn(page, l.box);
    ok(ink.inked > 0.03 && ink.contrast > 0.3, `${label}: the logo is drawn, and stands out from what is behind it`, ink);
  }
}

(async () => {
  const s = await startApp({ offset: OFFSET });
  await s.store.update((d) => {
    d.candidates = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`, name: `Shell Person ${i}`, firstName: 'Shell', lastName: `Person ${i}`,
      email: `shell.person.${i}@example.com`, phone: `(617) 555-02${String(i).padStart(2, '0')}`,
      status: ['new', 'emailed', 'replied', 'booked'][i % 4], addedAt: ago(500 + i), source: 'csv',
    }));
  });
  const browser = await launch({ args: QUIET });

  // ---- signed out: the sign-in screen ----
  for (const [phone, dark] of [[false, false], [false, true], [true, false], [true, true]]) {
    const label = `signed out, ${phone ? 'phone' : 'laptop'}, ${dark ? 'dark' : 'light'}`;
    const v = await openShell(browser, s.base, { phone, colorScheme: dark ? 'dark' : 'light' });
    ok(v.response && v.response.status() === 200, `${label}: the page loads`);
    const login = await v.page.evaluate(() => { const el = document.querySelector('#loginScreen'); return Boolean(el && !el.hidden); });
    ok(login, `${label}: the sign-in screen is up`);
    await checkLogo(v.page, '#loginScreen .login-logo', dark, label);
    ok(v.errors.length === 0, `${label}: no page errors`, v.errors);
    ok(v.failures.length === 0, `${label}: no failed requests to the site`, v.failures);
    await v.ctx.close();
  }

  // ---- signed in, every page, both themes, laptop and phone ----
  for (const [phone, dark] of [[false, false], [false, true], [true, false], [true, true]]) {
    const label = `signed in, ${phone ? 'phone' : 'laptop'}, ${dark ? 'dark' : 'light'}`;
    const v = await openShell(browser, s.base, { cookie: s.cookie, phone, colorScheme: dark ? 'dark' : 'light' });
    ok(v.response && v.response.status() === 200, `${label}: the page loads`);
    const app = await v.page.evaluate(() => ({
      login: !document.querySelector('#loginScreen').hidden,
      dashboard: Boolean(document.querySelector('#view-dashboard.active')),
      title: document.title,
    }));
    ok(!app.login && app.dashboard && /WPI Outreach/.test(app.title), `${label}: the dashboard is up`, app);
    if (!phone) await checkLogo(v.page, '.sidebar .brand-logo', dark, label);
    else {
      const l = await looks(v.page, '.sidebar .brand-logo');
      ok(l.theme === (dark ? 'dark' : 'light') && (dark ? lum(l.body) < 0.2 : lum(l.body) > 0.75), `${label}: the page is drawn ${dark ? 'dark' : 'light'}`, l);
    }
    const views = await v.page.evaluate(() => [...document.querySelectorAll('.nav-item[data-view]')].map((b) => b.dataset.view));
    const unopened = [];
    for (const view of views) {
      await v.page.evaluate((x) => document.querySelector(`.nav-item[data-view="${x}"]`).click(), view);
      const shown = await v.page.waitForFunction((x) => Boolean(document.querySelector(`#view-${x}.active`)), view, { timeout: 5000 }).then(() => true, () => false);
      if (!shown) unopened.push(view);
    }
    ok(views.length >= 6 && unopened.length === 0, `${label}: every page opens (${views.join(', ')})`, unopened);
    await v.page.waitForLoadState('networkidle');
    ok(v.errors.length === 0, `${label}: no page errors`, v.errors);
    ok(v.failures.length === 0, `${label}: no failed requests to the site`, v.failures);
    await v.ctx.close();
  }

  // ---- a remembered choice wins over the device ----
  for (const [device, saved] of [['dark', 'light'], ['light', 'dark']]) {
    const v = await openShell(browser, s.base, { cookie: s.cookie, colorScheme: device, theme: saved });
    const label = `device ${device}, chosen ${saved}`;
    await checkLogo(v.page, '.sidebar .brand-logo', saved === 'dark', label);
    ok(v.errors.length === 0, `${label}: no page errors`, v.errors);
    await v.ctx.close();
  }

  // ---- the switch ----
  {
    const v = await openShell(browser, s.base, { cookie: s.cookie, colorScheme: 'light' });
    const sw = v.page.locator('.theme-switch:visible').first();
    ok(await sw.count() === 1 && (await sw.getAttribute('aria-checked')) === 'false', 'the theme switch is there, off in light mode');
    await sw.click();
    await checkLogo(v.page, '.sidebar .brand-logo', true, 'switched to dark');
    ok((await sw.getAttribute('aria-checked')) === 'true', 'the switch says dark');
    ok(await v.page.evaluate(() => localStorage.getItem('wp-theme')) === 'dark', 'the choice is kept on this device');
    await v.page.reload({ waitUntil: 'networkidle' });
    await checkLogo(v.page, '.sidebar .brand-logo', true, 'reloaded after choosing dark');
    await v.page.locator('.theme-switch:visible').first().click();
    await checkLogo(v.page, '.sidebar .brand-logo', false, 'switched back to light');
    ok(await v.page.evaluate(() => localStorage.getItem('wp-theme')) === 'light', 'the light choice is kept too');
    ok(v.errors.length === 0, 'switching themes: no page errors', v.errors);
    ok(v.failures.length === 0, 'switching themes: no failed requests to the site', v.failures);
    await v.ctx.close();
  }

  await browser.close();
  await s.close();
  done();
})().catch(crash);
