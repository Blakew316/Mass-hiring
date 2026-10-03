// The bell with a great many unread replies, on a laptop and on a phone. It
// used to draw every one of them as it opened (thousands at the live list's
// size, two seconds on a phone); it opens on the newest forty and adds the
// next forty as its list is scrolled, newest first throughout, with the
// week's read replies still under Earlier. A look for news while it is open
// keeps what has been brought in. The count, and Mark all read, cover every
// unread reply, not just the ones drawn. Made-up people only.
const { startApp, launch, ok, done, crash, ago } = require('./helpers');
const { stubEverything, open, waitIn, settle, until, poke, stored, person } = require('./views-helpers');

const UNREAD = 100;
function people() {
  const out = [];
  for (let i = 1; i <= UNREAD; i++) {
    const n = String(i).padStart(3, '0');
    out.push(person(`u${n}`, `Unread Person${n}`, { phone: `(617) 555-${String(2000 + i)}`, lastTextedAt: ago(i * 3 + 600), textStatus: 'replied', textUnread: true,
      textThread: [{ dir: 'out', ts: ago(i * 3 + 600), text: 'Hi, worth a call?' }, { dir: 'in', ts: ago(i * 3), text: `Reply ${n}` }] }));
  }
  for (let k = 1; k <= 3; k++) {
    out.push(person(`r${k}`, `Read Person${k}`, { phone: `(617) 555-${String(2200 + k)}`, lastTextedAt: ago(k * 1440 + 60), textStatus: 'replied',
      textThread: [{ dir: 'out', ts: ago(k * 1440 + 60), text: 'Hi' }, { dir: 'in', ts: ago(k * 1440), text: `Earlier ${k}` }] }));
  }
  return out;
}
const names = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => `Unread Person${String(from + k).padStart(3, '0')}`);

(async () => {
  const s = await startApp({ offset: 208 });
  const rec = stubEverything();
  const browser = await launch();
  for (const phone of [false, true]) {
    const tag = phone ? 'phone' : 'laptop';
    await s.store.update((d) => { d.candidates = people(); d.events = []; });
    const { ctx, page, errors } = await open(browser, s, { phone });
    const bellN = () => page.evaluate(() => {
      const b = [...document.querySelectorAll('.bell')].find((x) => x.getClientRects().length);
      const n = b && b.querySelector('.bell-n');
      return n && !n.hidden ? n.textContent : '';
    });
    const sections = () => page.evaluate(() => {
      const out = { New: [], Earlier: [] };
      let cur = '';
      for (const el of document.querySelector('#bellBody').children) {
        if (el.classList.contains('bell-sec')) { cur = el.textContent.trim(); continue; }
        if (out[cur] && el.classList.contains('bell-row')) out[cur].push(el.querySelector('.bell-name').textContent.trim());
      }
      return out;
    });
    const scrollDown = () => page.evaluate(() => { const b = document.querySelector('#bellBody'); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event('scroll')); });
    const openBell = async () => {
      await page.evaluate(() => [...document.querySelectorAll('.bell')].find((x) => x.getClientRects().length).click());
      await page.waitForSelector('#bellPanel:not([hidden])');
    };

    ok(await settle(bellN, '99+') === '99+', `${tag}: the bell counts all ${UNREAD} unread`, await bellN());
    await openBell();
    let sec = await settle(async () => (await sections()).New.length, 40).then(() => sections());
    ok(JSON.stringify(sec.New) === JSON.stringify(names(1, 40)), `${tag}: it opens on the newest forty, newest first`, sec.New.slice(0, 3).concat(['…', sec.New.length]));
    ok(JSON.stringify(sec.Earlier) === JSON.stringify(['Read Person1', 'Read Person2', 'Read Person3']), `${tag}: with the week's read replies under Earlier`, sec.Earlier);

    await scrollDown();
    sec = await settle(async () => (await sections()).New.length, 80).then(() => sections());
    ok(JSON.stringify(sec.New) === JSON.stringify(names(1, 80)), `${tag}: scrolled to the bottom, the next forty follow in order`, sec.New.length);
    ok(sec.Earlier.length === 3, `${tag}: still above Earlier`, sec.Earlier);

    // A look for news while it is open keeps what was brought in.
    await s.store.update((d) => { d.candidates.find((c) => c.id === 'r1').notes = 'Changed elsewhere'; });
    await poke(page);
    ok((await settle(async () => (await sections()).New.length, 80)) === 80, `${tag}: a look for news keeps the eighty drawn`, (await sections()).New.length);

    await scrollDown();
    sec = await settle(async () => (await sections()).New.length, UNREAD).then(() => sections());
    ok(JSON.stringify(sec.New) === JSON.stringify(names(1, UNREAD)), `${tag}: and the rest, until every one is listed`, sec.New.length);
    await scrollDown();
    await page.waitForTimeout(300);
    ok((await sections()).New.length === UNREAD, `${tag}: and no further`, (await sections()).New.length);

    // Opened again, it starts from the top with forty.
    await page.keyboard.press('Escape');
    await waitIn(page, () => document.querySelector('#bellPanel').hidden);
    await openBell();
    ok((await settle(async () => (await sections()).New.length, 40)) === 40 && await page.evaluate(() => document.querySelector('#bellBody').scrollTop) === 0, `${tag}: opened again, it starts at the top with forty`);

    // Mark all read reads every one, not just the forty drawn.
    await page.click('#bellClear');
    ok(await until(async () => (await bellN()) === ''), `${tag}: Mark all read clears the count`, await bellN());
    ok(await until(async () => (await stored(s)).candidates.every((c) => !c.textUnread)), `${tag}: and all ${UNREAD} are read on the server`);
    ok(errors.length === 0, `${tag}: no page errors`, errors);
    await ctx.close();
  }
  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await browser.close();
  await s.close();
  done();
})().catch(crash);
