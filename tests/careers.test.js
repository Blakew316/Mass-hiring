// WPI Careers: the careers site (public/careers/, from the paystructrure
// repo) as a page of the CRM, for Team Maverick only. Signed in to Team
// Maverick, the sidebar's last item is WPI Careers, and its page shows the
// careers site's Team Maverick page with Blake's details; another team never
// sees the item, and a link to the page takes it to the Dashboard. The page
// recruits get stands on its own. Nothing is sent.
const { startApp, launch, ok, done, crash } = require('./helpers');
const { stubEverything, open, waitIn } = require('./views-helpers');
const { addTeam } = require('./server-read-helpers');

(async () => {
  const s = await startApp({ offset: 278 });
  stubEverything();
  const browser = await launch();
  try {
    // Team Maverick.
    const { ctx, page, errors } = await open(browser, s);
    const item = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.sidebar .nav-item[data-view]')].filter((b) => !b.hidden && b.offsetParent);
      const last = items[items.length - 1];
      return last ? { view: last.dataset.view, label: last.querySelector('.nav-label').textContent.trim() } : null;
    });
    ok(item && item.view === 'careers' && item.label === 'WPI Careers', 'Team Maverick: the last item in the sidebar is WPI Careers', item);
    ok(await page.evaluate(() => !document.querySelector('#careersFrame').getAttribute('src')), 'not loaded with the dashboard');
    await page.evaluate(() => document.querySelector('.nav-item[data-view="careers"]').click());
    await page.waitForSelector('#view-careers.active');
    const frame = await (await page.waitForSelector('#careersFrame')).contentFrame();
    await frame.waitForLoadState('load');
    const shown = await waitIn(frame, () => {
      const t = document.body.textContent;
      return /Team Maverick/.test(t) && /Blake Woodruff/.test(t) && document.querySelector('a[href^="tel:"]') && document.querySelector('a[href^="mailto:"]')
        ? { tel: document.querySelector('a[href^="tel:"]').getAttribute('href'), mail: document.querySelector('a[href^="mailto:"]').getAttribute('href') } : false;
    }, null, 15000);
    ok(shown && /2104806345/.test(shown.tel.replace(/\D/g, '')) && /justin\.woodruff@wholesalepayments\.com/.test(shown.mail),
      'its page is the careers site\'s Team Maverick page, with Blake\'s phone and email', shown);
    ok(new URL(frame.url()).pathname.startsWith('/careers/'), 'served from the CRM\'s own site (/careers/)', frame.url());
    ok(await page.evaluate(() => location.hash) === '#careers', 'and reachable by its own address (#careers)');
    ok(await page.$eval('#careersOpen', (a) => a.getAttribute('href')) === '/careers/team/maverick/', 'Open in new tab is the Team Maverick link');
    ok(errors.length === 0, 'no page errors', errors);
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
    await ctx.close();

    // The page recruits get, on its own.
    const solo = await browser.newContext();
    const sp = await solo.newPage();
    await sp.goto(`${s.base}/careers/team/maverick/`, { waitUntil: 'load' });
    const soloText = await waitIn(sp, () => /Team Maverick/.test(document.body.textContent) && /Blake Woodruff/.test(document.body.textContent), null, 15000);
    ok(Boolean(soloText) && new URL(sp.url()).searchParams.get('team') === 'maverick', 'the link recruits get opens the Team Maverick page on its own, signed in or not', sp.url());
    await solo.close();

    // Another team.
    const B = await addTeam(s, { name: 'Team Ranger', pin: '6392' });
    const other = await open(browser, { ...s, cookie: B.cookie }, { at: '/#careers' });
    const hidden = await other.page.evaluate(() => document.querySelector('.nav-item[data-view="careers"]').hidden);
    ok(hidden, 'another team: no WPI Careers in the sidebar');
    ok(await other.page.evaluate(() => document.querySelector('#view-dashboard.active') !== null && !document.querySelector('#view-careers.active')), 'and a link to it lands on the Dashboard');
    await other.page.evaluate(() => document.querySelector('#navMore').click());
    const more = await other.page.$$eval('#moreSheetButtons [data-more]', (bs) => bs.map((b) => b.dataset.more));
    ok(!more.includes('careers'), 'nor in the phone\'s More list', more);
    await other.ctx.close();
  } finally {
    await browser.close();
    await s.close();
  }
  done();
})().catch(crash);
