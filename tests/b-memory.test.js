// Old copies of the list are let go of, on a laptop and on a phone. The
// page keeps what it works out from the list (counts, the filtered rows, the
// conversation lists, the bell's items) rather than working it out again on
// every render, and each of those holds the copy of the list it was made
// from. At the live list's size a copy is tens of megabytes: kept until a
// page was next drawn, a copy for each page visited between new states stayed
// alive beside the current one — five times the memory a phone needed. Here
// every page is visited between new states, the browser collects what is
// unreachable, and only the list now on screen is still alive. Made-up
// people only; nothing is sent.
const { startApp, launch, ok, done, crash, ago } = require('./helpers');
const { stubEverything, open, poke, go, person } = require('./views-helpers');

function people() {
  const out = [];
  for (let i = 1; i <= 60; i++) {
    const n = String(i).padStart(2, '0');
    out.push(person(`m${n}`, `Memory Person${n}`, i % 3 ? { addedAt: ago(5000 - i) } : {
      phone: `(617) 555-02${n}`, lastTextedAt: ago(900 + i), textStatus: 'replied', textUnread: i % 2 === 0, textCount: 2,
      status: 'emailed', lastEmailedAt: ago(3000 + i), gmailThreadId: `th-m${n}`, lastSubject: 'Quick question',
      textThread: [{ dir: 'out', ts: ago(900 + i), text: 'Hi, worth a call?' }, { dir: 'in', ts: ago(i), text: `Reply ${n}` }],
    }));
  }
  return out;
}

// Every list the page has been sent, held weakly: alive only while the page
// itself still holds on to it. A state with the list in it (a server from
// before the compact list); otherwise each copy of the list the page makes
// from what the server sends (public/wire.js: the whole list, or a copy
// patched with the buckets that changed), since the state no longer carries
// one.
function watchLists() {
  window.__lists = [];
  const json = Response.prototype.json;
  Response.prototype.json = async function () {
    const v = await json.call(this);
    try {
      if (new URL(this.url).pathname === '/api/state' && v && Array.isArray(v.candidates)) window.__lists.push(new WeakRef(v.candidates));
    } catch { /* not a state */ }
    return v;
  };
  let wire;
  Object.defineProperty(window, 'Wire', {
    configurable: true,
    get: () => wire,
    set: (w) => {
      for (const name of ['fromFull', 'applyDelta']) {
        const made = w[name];
        w[name] = async (...args) => { const copy = await made(...args); window.__lists.push(new WeakRef(copy.cands)); return copy; };
      }
      wire = w;
    },
  });
}

(async () => {
  const s = await startApp({ offset: 214 });
  const rec = stubEverything();
  const browser = await launch();
  for (const phone of [false, true]) {
    const tag = phone ? 'phone' : 'laptop';
    await s.store.update((d) => { d.candidates = people(); d.events = []; });
    const { ctx, page, errors } = await open(browser, s, { phone, init: watchLists });
    const cdp = await ctx.newCDPSession(page);
    let k = 0;
    // Something changed elsewhere, so the next look brings a whole new list.
    const newState = async () => {
      k += 1;
      await s.store.update((d) => { d.candidates[0].notes = `changed elsewhere ${k}`; });
      await poke(page);
      await page.waitForTimeout(200);
    };
    const bell = () => page.evaluate(() => [...document.querySelectorAll('.bell')].find((x) => x.getClientRects().length).click());

    await go(page, 'candidates');
    await page.waitForSelector('#candidateRows tr[data-id]');
    await page.fill('#searchInput', 'person0');
    await page.waitForTimeout(400);
    await page.fill('#searchInput', '');
    await page.waitForTimeout(400);
    await newState();
    await go(page, 'texting');
    await newState();
    await go(page, 'template');
    await newState();
    await bell();
    await page.waitForSelector('#bellPanel:not([hidden])');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#bellPanel').hidden);
    await newState();
    await go(page, 'dashboard');
    await newState();

    await cdp.send('HeapProfiler.collectGarbage');
    await page.waitForTimeout(100);
    await cdp.send('HeapProfiler.collectGarbage');
    const lists = await page.evaluate(() => ({ sent: window.__lists.length, alive: window.__lists.filter((r) => r.deref()).length, newest: Boolean(window.__lists[window.__lists.length - 1].deref()) }));
    ok(lists.sent >= 6, `${tag}: six whole lists came, one per new state`, lists);
    ok(lists.alive === 1 && lists.newest, `${tag}: only the newest is still held — none of the older copies the pages were drawn from`, lists);
    ok(errors.length === 0, `${tag}: no page errors`, errors);
    await ctx.close();
  }
  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await browser.close();
  await s.close();
  done();
})().catch(crash);
