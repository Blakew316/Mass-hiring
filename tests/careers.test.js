// WPI Careers: the live careers site (wpiagentpay.com, the paystructrure
// repo) as a page of the CRM, for Team Maverick only. Signed in to Team
// Maverick, the sidebar's last item is WPI Careers; its page frames the live
// site's Team Maverick page, and the link candidates get is that site, with
// Blake's details — never the hiring site. Another team never sees the item,
// and a link to the page takes it to the Dashboard. Nothing is sent.
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
    // The page frames the live careers site, and every way out of it — the
    // frame, Open in new tab, Copy link — is that site: never this one.
    const links = await page.evaluate(async () => {
      let copied = '';
      try { navigator.clipboard.writeText = async (t) => { copied = t; }; } catch { /* read-only */ }
      window.prompt = (_m, t) => { copied = t; return null; };
      document.querySelector('#careersCopy').click();
      await new Promise((r) => setTimeout(r, 200));
      return { frame: document.querySelector('#careersFrame').getAttribute('src'), open: document.querySelector('#careersOpen').getAttribute('href'), copied };
    });
    const live = (u) => { try { const x = new URL(u); return x.origin === 'https://wpiagentpay.com' && x.pathname === '/team/maverick/'; } catch { return false; } };
    ok(live(links.frame) && live(links.open) && live(links.copied), 'the frame, Open in new tab and Copy link are all the live site\'s Team Maverick page (wpiagentpay.com)', links);
    ok(![links.frame, links.open, links.copied].some((u) => /wpioutreach|localhost|\/careers\//.test(u)), 'none of them is the hiring site', links);
    const t = new URL(links.copied).searchParams.get('t');
    const carried = t && t[0] === 'j' ? JSON.parse(Buffer.from(t.slice(1), 'base64url').toString()) : null;
    ok(carried && carried.contactPhone === '210-480-6345' && carried.contactEmail === 'justin.woodruff@wholesalepayments.com', 'the link carries Blake\'s phone and email, in the careers site\'s own link format', carried);
    ok(await page.evaluate(() => location.hash) === '#careers', 'and the page is reachable by its own address (#careers)');
    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();

    // Nothing of the careers site is served here any more.
    const local = await fetch(`${s.base}/careers/team/maverick/`);
    ok(local.status === 404, 'the hiring site serves no careers page of its own (old links are redirected to the live site by netlify.toml)', local.status);

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
