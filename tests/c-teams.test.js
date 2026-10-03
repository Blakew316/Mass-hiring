// Teams and the compact list. Every new route — the state without the list,
// the whole list, the sync — is behind the session like every other: signed
// out, or with the Mac relay's token, it is refused. Each team gets its own
// list and nothing of another's: a tag one team was given never answers 304
// for another, and a sync that sends up another team's copy (its team, its
// digests, its bucket count) is answered with the session's own team's whole
// list. In a browser, a page whose session becomes another team's draws
// that team's list and none of the first's; a page signed out and into
// another team starts its list again rather than syncing the old one. Made-up
// people only; nothing is sent.
const { startApp, launch, ok, done, crash } = require('./helpers');
const { stubEverything, open, waitIn, poke } = require('./views-helpers');
const { addTeam, inTeam } = require('./server-read-helpers');
const { Wire, people, body } = require('./c-helpers');

(async () => {
  const s = await startApp({ offset: 224 });
  const rec = stubEverything();
  const W = Wire();
  const mine = people(400, { prefix: 'm', seed: 11 }).map((c) => ({ ...c, name: `Maverick ${c.name}` }));
  await s.store.update((d) => { d.candidates = mine; d.events = []; });
  const B = await addTeam(s, { name: 'Team Ranger', pin: '6391' });
  const theirs = people(300, { prefix: 'r', seed: 12 }).map((c) => ({ ...c, name: `Ranger ${c.name}`, email: `ranger.${c.email}` }));
  await inTeam(B.id, () => s.store.update((d) => { d.candidates = theirs; d.events = []; }));
  const asB = { ...s, cookie: B.cookie };
  const noOne = { ...s, cookie: '' };
  const leaks = (text, other) => other.filter((c) => text.includes(`"${c.email}"`) || text.includes(`"${c.id}"`)).length;

  // ---------- signed out, or the relay's token ----------
  const relayToken = (await s.json('POST', '/api/texts/relay-token')).body.token;
  for (const [method, url, payload] of [['GET', '/api/state?v=2'], ['GET', '/api/candidates?v=2'], ['POST', '/api/candidates/sync?v=2', { t: 'maverick' }]]) {
    const out = await body(noOne, method, url, payload);
    ok(out.status === 401 && !leaks(out.text, mine), `${method} ${url} signed out: refused, with nothing of the list`, out.status);
    const relay = await body(noOne, method, url, payload, { authorization: `Bearer ${relayToken}` });
    ok(relay.status === 401 && !leaks(relay.text, mine), `${method} ${url} with the relay's token: refused`, relay.status);
  }

  // ---------- each team its own ----------
  const listA = await body(s, 'GET', '/api/candidates?v=2');
  const listB = await body(asB, 'GET', '/api/candidates?v=2');
  const copyA = await W.fromFull(listA.json, 'maverick');
  const copyB = await W.fromFull(listB.json, B.id);
  ok(copyA.t === 'maverick' && copyA.n === 400 && copyA.ids.every((id) => id.startsWith('m')), 'the first team gets its own 400 people');
  ok(copyB.t === B.id && copyB.n === 300 && copyB.ids.every((id) => id.startsWith('r')), 'the other team its own 300');
  ok(!leaks(listA.text, theirs) && !leaks(listB.text, mine), 'and neither answer holds anything of the other team\'s');
  ok(listA.tag !== listB.tag && /^W\/"c2-/.test(listA.tag), 'their lists are tagged differently', [listA.tag, listB.tag]);
  const crossList = await body(asB, 'GET', '/api/candidates?v=2', null, { 'if-none-match': listA.tag });
  ok(crossList.status === 200 && crossList.json.t === B.id && !leaks(crossList.text, mine), 'the first team\'s list tag, sent by the other team, is a 200 with the other team\'s list', crossList.status);
  const stateA = await body(s, 'GET', '/api/state?v=2');
  const crossState = await body(asB, 'GET', '/api/state?v=2', null, { 'if-none-match': stateA.tag });
  ok(crossState.status === 200 && crossState.json.cands.t === B.id && crossState.json.team.id === B.id && !leaks(crossState.text, mine), 'and so is the first team\'s state tag', crossState.status);
  ok(stateA.json.cands.t === 'maverick' && stateA.json.cands.v === copyA.v && crossState.json.cands.v === copyB.v, 'each state names its own team\'s list');

  // ---------- syncs ----------
  const asIs = await body(asB, 'POST', '/api/candidates/sync?v=2', W.syncBody(copyA));
  ok(asIs.status === 200 && !asIs.json.ch && !asIs.json.same && asIs.json.t === B.id && asIs.json.n === 300 && !leaks(asIs.text, mine),
    'the first team\'s copy sent up under the other team\'s session: the other team\'s whole list, and nothing of the first\'s', { t: asIs.json.t, n: asIs.json.n });
  const relabelled = await body(asB, 'POST', '/api/candidates/sync?v=2', { ...W.syncBody(copyA), t: B.id });
  ok(relabelled.status === 200 && relabelled.json.t === B.id && !leaks(relabelled.text, mine), 'relabelled as the other team\'s: still only the other team\'s people', { t: relabelled.json.t, kind: relabelled.json.ch ? 'delta' : relabelled.json.same ? 'same' : 'full' });
  const sameBuckets = await body(asB, 'POST', '/api/candidates/sync?v=2', { ...W.syncBody(copyB), b: W.syncBody(copyA).b.slice(0, copyB.nb * 8) });
  ok(sameBuckets.status === 200 && sameBuckets.json.t === B.id && !leaks(sameBuckets.text, mine), 'the first team\'s digests under the other team\'s name: the other team\'s rows only');
  for (const [label, payload] of [['nothing', {}], ['digests that are not a string', { ...W.syncBody(copyA), b: 12 }], ['too few digests', { ...W.syncBody(copyA), b: 'abc' }], ['another bucket count', { ...W.syncBody(copyA), nb: 16 }], ['a team that does not exist', { ...W.syncBody(copyA), t: 'nobody' }]]) {
    const r = await body(s, 'POST', '/api/candidates/sync?v=2', payload);
    ok(r.status === 200 && r.json.t === 'maverick' && r.json.n === 400 && Array.isArray(r.json.r) && r.json.r.length === 400 && !leaks(r.text, theirs), `a sync sending ${label}: the team's own whole list`, r.status);
  }
  const own = await body(s, 'POST', '/api/candidates/sync?v=2', W.syncBody(copyA));
  ok(own.status === 200 && own.json.same === true && own.json.t === 'maverick', 'its own copy, unchanged: same');
  ok((await body(s, 'POST', '/api/candidates/sync?v=3', W.syncBody(copyA))).status === 400, 'a sync in a format this server does not write is refused');
  ok((await body(s, 'GET', '/api/candidates')).status === 400 && (await body(s, 'GET', '/api/candidates?v=1')).status === 400, 'so is the list without its format');

  // ---------- in a browser ----------
  const browser = await launch();
  {
    // The session becomes the other team's (signed in as it in another tab).
    const { ctx, page, errors } = await open(browser, s, { at: '/#candidates' });
    const syncs = [];
    const all = [];
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/candidates/sync') syncs.push(JSON.parse(r.postData() || '{}').t); });
    page.on('response', (r) => { if (/\/api\//.test(r.url())) all.push(`${r.request().method()} ${new URL(r.url()).pathname}${new URL(r.url()).search} ${r.status()}`); });
    await page.waitForSelector('#candidateRows tr[data-id]');
    ok(await waitIn(page, () => document.querySelector('#statTotal').textContent === '400'), 'a page signed in to the first team draws its 400', await page.$eval('#statTotal', (e) => e.textContent));
    const [name, value] = B.cookie.split('=');
    await ctx.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
    await poke(page);
    const anyStage = () => page.evaluate(() => (document.querySelector('#stageFilter option') || {}).textContent || '');
    ok(await waitIn(page, () => /\(300\)/.test((document.querySelector('#stageFilter option') || {}).textContent || '')), 'its session now the other team\'s, it draws the other team\'s 300', { stage: await anyStage(), all });
    ok(!all.some((a) => a.startsWith('POST /api/candidates/sync')), 'starting its list again (the whole list), rather than sending up the first team\'s copy', all);
    const shown = await page.evaluate(() => [...document.querySelectorAll('#candidateRows tr[data-id]')].map((r) => r.dataset.id));
    ok(shown.length > 0 && shown.every((id) => id.startsWith('r')), 'and none of the first team\'s people', shown.slice(0, 5));
    ok(!(await page.evaluate(() => document.body.innerText)).includes('Maverick '), 'no first-team name is left anywhere on the page');
    await inTeam(B.id, () => s.store.update((d) => { d.candidates[0].notes = 'changed for the other team'; }));
    syncs.length = 0;
    await poke(page);
    await page.waitForTimeout(400);
    ok(syncs.length === 1 && syncs[0] === B.id, 'its next sync is the other team\'s', { syncs, all });
    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  }
  {
    // Signed out, and into the other team, on the page itself.
    const { ctx, page, errors } = await open(browser, s);
    const asked = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/candidates')) asked.push(`${r.method()} ${u.pathname} ${r.postData() ? JSON.parse(r.postData()).t : ''}`.trim()); });
    ok(await waitIn(page, () => document.querySelector('#statTotal').textContent === '400'), 'a page signed in to the first team');
    await page.click('#signOutBtn').catch(() => page.evaluate(() => document.querySelector('#signOutBtn').click()));
    await page.waitForSelector('#loginScreen:not([hidden])');
    asked.length = 0;
    await page.click(`.team-option[data-team="${B.id}"]`);
    await page.fill('#loginPassword', '6391');
    await page.click('#loginBtn');
    ok(await waitIn(page, () => document.querySelector('#statTotal').textContent === '300'), 'signed in to the other team, it draws that team\'s 300');
    ok(asked.length >= 1 && asked[0] === 'GET /api/candidates' && !asked.some((a) => a.endsWith('maverick')), 'starting its list again: the whole list, never a sync of the first team\'s copy', asked);
    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  }
  await browser.close();
  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await s.close();
  done();
})().catch(crash);
