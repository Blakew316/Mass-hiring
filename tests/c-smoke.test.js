// The page with the compact list, in a real browser, against this server,
// against the server this stage started from (a rollback), and that server's
// page against this one (a page left open across the deploy):
//   - a person added, one taken off and one edited elsewhere are all on
//     screen after one poll, which is the slim state and one sync — never the
//     whole list again;
//   - a poll with nothing new is one request, answered 304;
//   - a status the server refuses is put back, and the next sync asks for
//     that person's bucket whatever its digest says;
//   - an answer overtaken by a newer one is not drawn over it;
//   - a conversation read here while the "seen" call was lost is told to the
//     server again once a new state has landed, because this page's edits
//     are lifted off before each one. A copy of the page with that step
//     taken out never tells it again (the negative control: the check
//     catches the fault it is there for).
// Made-up people only; nothing is sent.
const path = require('path');
const fs = require('fs');
const { startApp, launch, port, ROOT, R, ok, done, crash, ago } = require('./helpers');
const { stubEverything, open, waitIn, until, poke, go, person } = require('./views-helpers');
const { Wire, baseCopy, serve } = require('./c-helpers');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
// The shell (everything that is not the API) from another copy's public/.
async function shellFrom(ctx, base, dir) {
  await ctx.route((u) => u.href.startsWith(base) && !/^\/(api|auth|webhooks)(\/|$)/.test(u.pathname), (route) => {
    let p = decodeURIComponent(new URL(route.request().url()).pathname);
    if (p === '/') p = '/index.html';
    const file = path.join(dir, 'public', p);
    if (!file.startsWith(path.join(dir, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
}

function people(n) {
  return Array.from({ length: n }, (_, i) => {
    const k = String(i).padStart(3, '0');
    return person(`s${k}`, `Smoke Person${k}`, i % 4 === 0
      ? { status: 'emailed', lastEmailedAt: ago(3000 + i), gmailThreadId: `th-s${k}`, lastSubject: 'Quick question', phone: `(617) 555-2${k}` }
      : { addedAt: ago(9000 - i), phone: i % 3 ? `(617) 555-3${k}` : '' });
  });
}

// What a page asks of the API, as "METHOD /path?query".
function record(page) {
  const log = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (/^\/api\//.test(u.pathname)) log.push({ what: `${r.method()} ${u.pathname}${u.search}`, body: r.postData() || '' });
  });
  page.on('response', (r) => {
    const u = new URL(r.url());
    const e = [...log].reverse().find((x) => x.what === `${r.request().method()} ${u.pathname}${u.search}` && x.status === undefined);
    if (e) e.status = r.status();
  });
  return log;
}
const rowsShown = (page) => page.evaluate(() => [...document.querySelectorAll('#candidateRows tr[data-id]')].map((r) => r.dataset.id));
const total = (page) => page.evaluate(() => (document.querySelector('#statTotal') || {}).textContent || '');

(async () => {
  const s = await startApp({ offset: 226 });
  const rec = stubEverything();
  const W = Wire();
  await s.store.update((d) => { d.candidates = people(300); d.events = []; });
  const browser = await launch();

  // ================= this page, this server =================
  {
    const { ctx, page, errors } = await open(browser, s, { at: '/#candidates' });
    const log = record(page);
    await page.waitForSelector('#candidateRows tr[data-id]');
    ok(await waitIn(page, () => document.querySelector('#statTotal').textContent === '300'), 'the page draws the list: 300 people', await total(page));
    await page.fill('#searchInput', 'Smoke Person29');
    await waitIn(page, () => document.querySelectorAll('#candidateRows tr[data-id]').length === 10);
    ok((await rowsShown(page)).length === 10, 'and finds people in it', await rowsShown(page));
    await page.fill('#searchInput', '');

    // Settle whatever the page saves on arrival, then: nothing new is one 304.
    for (let i = 0; i < 3; i++) await poke(page);
    log.length = 0;
    await poke(page);
    await page.waitForTimeout(400);
    ok(log.length === 1 && log[0].what === 'GET /api/state?v=2' && log[0].status === 304, 'a poll with nothing new is one request, answered 304', log);

    // Added, taken off and edited elsewhere: on screen after one poll.
    await s.store.update((d) => {
      d.candidates.push(person('s900', 'Added Elsewhere', { addedAt: ago(1) }));
      s.store.removeCandidate(d, 's005');
      d.candidates.find((c) => c.id === 's010').name = 'Edited Elsewhere';
    });
    log.length = 0;
    await poke(page);
    await page.waitForTimeout(600);
    const asked = log.map((x) => `${x.what} ${x.status}`);
    ok(J(asked) === J(['GET /api/state?v=2 200', 'POST /api/candidates/sync?v=2 200']), 'one poll: the slim state and one sync, never the whole list', asked);
    await page.fill('#searchInput', 'Elsewhere');
    ok(await waitIn(page, () => document.querySelectorAll('#candidateRows tr[data-id]').length === 2), 'the added and the edited person are on screen', await rowsShown(page));
    ok(J((await rowsShown(page)).sort()) === J(['s010', 's900']), 'both of them', await rowsShown(page));
    await page.fill('#searchInput', 'Smoke Person005');
    await page.waitForTimeout(300);
    ok((await rowsShown(page)).length === 0, 'the one taken off is not', await rowsShown(page));
    await page.fill('#searchInput', '');
    ok(await waitIn(page, () => document.querySelector('#statTotal').textContent === '300'), 'and the count says 300', await total(page));

    // A status the server refuses.
    await page.waitForSelector('#candidateRows tr[data-id="s001"]');
    const failing = async (route) => { if (route.request().method() === 'PATCH') await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Pretend failure' }) }); else await route.continue(); };
    await page.route('**/api/candidates/s001', failing);
    log.length = 0;
    await page.selectOption('#candidateRows tr[data-id="s001"] .status-select', 'booked');
    const back = await waitIn(page, () => { const el = document.querySelector('#candidateRows tr[data-id="s001"] .status-select'); return el && el.value === 'new' ? 'new' : false; });
    ok(back === 'new', 'a status the server refuses is put back', back);
    await page.unroute('**/api/candidates/s001', failing);
    await page.waitForTimeout(1500);
    const after = log.slice(log.findIndex((x) => x.what === 'PATCH /api/candidates/s001') + 1);
    const sync = after.find((x) => x.what === 'POST /api/candidates/sync?v=2');
    const nb = W.bucketCount(300);
    const sentUp = sync ? JSON.parse(sync.body) : null;
    const bucket = W.bucketOf('s001', nb);
    ok(after[0] && after[0].what === 'GET /api/state?v=2' && after[0].status === 200, 'the look after it asks for the whole state', log.map((x) => `${x.what} ${x.status}`));
    ok(sentUp && sentUp.b.slice(bucket * 8, bucket * 8 + 8) === W.UNKNOWN && sentUp.b.split(W.UNKNOWN).length === 2, 'and its sync asks for that person\'s bucket, and only that one, whatever its digest', sentUp && sentUp.b.length);
    ok(await waitIn(page, () => { const el = document.querySelector('#candidateRows tr[data-id="s001"] .status-select'); return el && el.value === 'new'; }), 'and the row shows what the server holds');

    // An answer overtaken by a newer one is not drawn over it.
    let release;
    const held = new Promise((r) => { release = r; });
    let armed = true;
    let fetched;
    const gotIt = new Promise((r) => { fetched = r; });
    const hold = async (route) => {
      if (!armed || !route.request().url().includes('/api/state')) { await route.continue(); return; }
      armed = false;
      const resp = await route.fetch();
      fetched();
      await held;
      await route.fulfill({ response: resp });
    };
    await s.store.update((d) => { d.candidates.find((c) => c.id === 's020').name = 'Older Name'; });
    await page.route((u) => u.pathname.startsWith('/api/state'), hold);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await gotIt;
    await s.store.update((d) => { d.candidates.find((c) => c.id === 's020').name = 'Newer Name'; });
    await poke(page, 'visibility');
    await page.fill('#searchInput', 'Newer Name');
    ok(await waitIn(page, () => document.querySelectorAll('#candidateRows tr[data-id="s020"]').length === 1), 'the newer answer is drawn');
    release();
    await page.waitForTimeout(800);
    await page.unroute((u) => u.pathname.startsWith('/api/state'), hold);
    await page.fill('#searchInput', 'Older Name');
    await page.waitForTimeout(300);
    ok((await rowsShown(page)).length === 0, 'and the older one, landing after it, is not drawn over it', await rowsShown(page));
    await page.fill('#searchInput', '');

    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  }

  // ================= the load: everything asked for at once, each once =================
  {
    const { ctx, page, errors } = await open(browser, s);
    // Signed in, the page leaves itself the hint index.html reads.
    ok(await page.evaluate(() => localStorage.getItem('wp-signed-in')) === '1', 'signed in, the page notes it for its next load');
    const asked = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (/^\/(api\/|app\.js$)/.test(u.pathname)) asked.push(`${r.method()} ${u.pathname}${u.search}`); });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('.bell') && document.querySelector('#loginScreen').hidden);
    await page.waitForTimeout(500);
    const boot = asked.filter((a) => a !== 'POST /api/settings');
    const first = boot.slice(0, 3).sort();
    ok(J(first) === J(['GET /api/auth/status', 'GET /api/candidates?v=2', 'GET /api/state?v=2']), 'the session, the state and the list are asked for first, before app.js', boot);
    for (const one of ['GET /api/auth/status', 'GET /api/state?v=2', 'GET /api/candidates?v=2']) {
      ok(boot.filter((a) => a === one).length === 1, `and each once (${one})`, boot);
    }
    ok(!boot.some((a) => a.startsWith('POST /api/candidates/sync')), 'with no sync on top', boot);
    ok(errors.length === 0, 'no page errors', errors);

    // The hint left behind, but signed out since: the early answers are
    // refusals, which the page ignores; signed in again, it asks again.
    await ctx.clearCookies();
    asked.length = 0;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#loginScreen:not([hidden])');
    ok(await page.evaluate(() => localStorage.getItem('wp-signed-in')) === null, 'signed out, the sign-in screen takes the hint away');
    const [name, value] = s.cookie.split('=');
    await ctx.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
    asked.length = 0;
    await page.fill('#loginPassword', 'test-password');
    await page.click('#loginBtn');
    ok(await waitIn(page, () => document.querySelector('#statTotal').textContent === '300'), 'signed in again, the list is drawn', await total(page));
    ok(asked.includes('GET /api/state?v=2') && asked.includes('GET /api/candidates?v=2'), 'asked for again rather than taken from the refusals', asked);
    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  }

  // ================= a read lost on the way, and the negative control =================
  for (const control of [false, true]) {
    const tag = control ? 'without lifting (control)' : 'with this page';
    await s.store.update((d) => {
      replaceAll(s.store, d, people(300));
      const u = d.candidates.find((c) => c.id === 's001');
      Object.assign(u, { lastTextedAt: ago(600), textStatus: 'replied', textUnread: true, textRepliedAt: ago(30),
        textThread: [{ dir: 'out', ts: ago(600), text: 'Hi, worth a call?' }, { dir: 'in', ts: ago(30), text: 'Yes please' }] });
    });
    const { ctx, page, errors } = await open(browser, s);
    if (control) {
      // The same page, with lifting its edits off before a new state taken out.
      let takenOut = false;
      await ctx.route('**/app.js', async (route) => {
        const resp = await route.fetch();
        const was = await resp.text();
        const text = was.replace(/\n\s*liftOverlays\(\);\n(\s*if \(copy\) \{)/, '\n$1');
        takenOut = text !== was;
        await route.fulfill({ response: resp, body: text });
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('.bell') && document.querySelector('#loginScreen').hidden);
      ok(takenOut, `${tag}: the page is served with that one step taken out`);
    }
    const seen = [];
    let blocked = true;
    await page.route('**/api/texts/seen', async (route) => {
      seen.push({ at: Date.now(), blocked });
      if (blocked) await route.abort('failed'); else await route.continue();
    });
    await page.evaluate(() => [...document.querySelectorAll('.bell')].find((x) => x.getClientRects().length).click());
    await page.waitForSelector('#bellPanel:not([hidden])');
    await page.click('#bellClear');
    await page.keyboard.press('Escape');
    ok(await until(async () => seen.length >= 2, 8000), `${tag}: the "seen" call is lost, and so is its retry`, seen.length);
    const unread = async () => (await s.store.load()).candidates.find((c) => c.id === 's001').textUnread;
    ok(await unread() === true, `${tag}: the server still has it unread`);
    blocked = false;
    const firstTold = seen[0].at;
    await page.waitForTimeout(Math.max(0, firstTold + 21000 - Date.now()));
    // Something changes elsewhere, in another bucket: a new state lands.
    const nb = W.bucketCount(300);
    const other = people(300).find((c) => W.bucketOf(c.id, nb) !== W.bucketOf('s001', nb)).id;
    await s.store.update((d) => { d.candidates.find((c) => c.id === other).notes = `changed elsewhere ${control}`; });
    const before = seen.length;
    await poke(page);
    await page.waitForTimeout(1500);
    const toldAgain = seen.slice(before).filter((x) => !x.blocked).length;
    if (!control) {
      ok(toldAgain === 1, `${tag}: once a new state has landed, the page tells the server again`, seen.slice(before));
      ok(await until(async () => (await unread()) === false), `${tag}: and the server has it read`);
    } else {
      ok(toldAgain === 0, `${tag}: the page never tells the server again (this is the fault the check above catches)`, seen.slice(before));
      ok(await unread() === true, `${tag}: and the server keeps it unread`);
    }
    const bellN = await page.evaluate(() => { const b = [...document.querySelectorAll('.bell')].find((x) => x.getClientRects().length); const n = b.querySelector('.bell-n'); return n.hidden ? '' : n.textContent; });
    ok(bellN === '', `${tag}: the bell shows it read either way`, bellN);
    ok(errors.length === 0, `${tag}: no page errors`, errors);
    await ctx.close();
  }

  // ================= this page against the server it started from (a rollback) =================
  const baseDir = baseCopy();
  {
    await s.store.update((d) => { replaceAll(s.store, d, people(120)); d.events = []; });
    const old = await serve({ root: baseDir, port: port(227), data: R('data') });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    const [name, value] = old.cookie.split('=');
    await ctx.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
    await ctx.route((u) => !u.href.startsWith(old.base), (r) => r.abort());
    await shellFrom(ctx, old.base, ROOT);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const log = record(page);
    await page.goto(`${old.base}/`, { waitUntil: 'domcontentloaded' });
    ok(await waitIn(page, () => document.querySelector('#statTotal').textContent === '120', null, 15000), 'rollback: this page draws the old server\'s list', await total(page));
    // Loaded again, signed in: index.html asks for the state and the list at once.
    await page.waitForTimeout(500);
    log.length = 0;
    await page.reload({ waitUntil: 'domcontentloaded' });
    ok(await waitIn(page, () => document.querySelector('#loginScreen').hidden && document.querySelector('#statTotal').textContent === '120', null, 15000), 'rollback: and again on its next load', await total(page));
    await page.waitForTimeout(500);
    const states = log.filter((x) => x.what.startsWith('GET /api/state'));
    ok(states.length >= 1 && states.every((x) => x.status === 200 || x.status === 304), 'rollback: it asks for the state and is answered with the old one', states);
    ok(log.some((x) => x.what === 'GET /api/candidates?v=2' && x.status === 404) && !log.some((x) => x.what.startsWith('POST /api/candidates/sync')), 'rollback: the list the old server does not have is asked for once, at load, and never synced', log.map((x) => `${x.what} ${x.status}`));
    for (let i = 0; i < 3; i++) await poke(page);
    log.length = 0;
    await poke(page);
    ok(log.length === 1 && log[0].status === 304, 'rollback: a poll with nothing new is a 304', log);
    const patched = await fetch(`${old.base}/api/candidates/s003`, { method: 'PATCH', headers: { cookie: old.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Changed On The Old Server' }) });
    ok(patched.status === 200, 'rollback: (a change made on the old server)');
    await poke(page);
    await page.evaluate(() => document.querySelector('.nav-item[data-view="candidates"]').click());
    await page.fill('#searchInput', 'Changed On The Old');
    ok(await waitIn(page, () => document.querySelectorAll('#candidateRows tr[data-id="s003"]').length === 1), 'rollback: and draws a change after one poll');
    ok(errors.length === 0, 'rollback: no page errors', errors);
    await ctx.close();
    await old.close();
  }

  // ================= the old page against this server (a page open across the deploy) =================
  {
    await s.store.update((d) => { replaceAll(s.store, d, people(150)); d.events = []; });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    const [name, value] = s.cookie.split('=');
    await ctx.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
    await ctx.route((u) => !u.href.startsWith(s.base), (r) => r.abort());
    await shellFrom(ctx, s.base, baseDir);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const log = record(page);
    await page.goto(`${s.base}/`, { waitUntil: 'domcontentloaded' });
    ok(await waitIn(page, () => document.querySelector('#statTotal').textContent === '150', null, 15000), 'deploy: the old page draws this server\'s list', await total(page));
    ok(log.some((x) => x.what === 'GET /api/state' && x.status === 200) && !log.some((x) => /v=2|sync/.test(x.what)), 'deploy: from the old state, as it always asked for it', log.map((x) => x.what));
    for (let i = 0; i < 3; i++) await poke(page);
    log.length = 0;
    await poke(page);
    ok(log.length === 1 && log[0].what === 'GET /api/state' && log[0].status === 304, 'deploy: a poll with nothing new is a 304', log);
    await s.store.update((d) => { d.candidates.find((c) => c.id === 's004').name = 'Changed After The Deploy'; });
    await poke(page);
    await page.evaluate(() => document.querySelector('.nav-item[data-view="candidates"]').click());
    await page.fill('#searchInput', 'After The Deploy');
    ok(await waitIn(page, () => document.querySelectorAll('#candidateRows tr[data-id="s004"]').length === 1), 'deploy: and draws a change after one poll');
    ok(errors.length === 0, 'deploy: no page errors', errors);
    await ctx.close();
  }

  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await browser.close();
  await s.close();
  done();
})().catch(crash);

function J(v) { return JSON.stringify(v); }
// The whole list replaced, everybody taken off on purpose first (the store
// refuses a save that loses anybody otherwise).
function replaceAll(store, d, list) {
  for (const c of [...d.candidates]) store.removeCandidate(d, c.id);
  d.candidates.push(...list);
}
