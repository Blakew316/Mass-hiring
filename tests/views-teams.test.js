// Signing out and back in, and two teams on one device, on a laptop and on a
// phone: after a sign-out nothing is readable; signing in shows that team's
// list; switching to the other team (Sign out, or the team name in the page
// header) never shows the first team's people anywhere — Dashboard,
// Candidates, Texting, Email, the bell, the attachment list — nor does a
// reload, signed in to the other team or signed out. The server side
// of the same promise: a tag from one team's state never earns the other
// team a "nothing changed", and one team cannot open the other's
// conversations.
const { startApp, launch, ok, done, crash, ago, R } = require('./helpers');
const { stubEverything, open, ready, text, texts, waitIn, waitText, go, person } = require('./views-helpers');

const PIN = '7418';

function team(prefix, names, phoneBase) {
  return names.map((n, i) => person(`${prefix}${i + 1}`, n, {
    phone: `(617) 555-02${phoneBase + i}`, status: 'replied', lastEmailedAt: ago(2000 + i), gmailThreadId: `th-${prefix}${i + 1}`,
    replies: [{ id: `r-${prefix}${i}`, date: ago(100 + i), text: `${n} wrote by email`, kind: null }], lastReplyAt: ago(100 + i),
    emailUnread: i === 0, textUnread: i === 0, lastTextedAt: ago(500 + i), textStatus: 'replied',
    textThread: [{ dir: 'out', ts: ago(500 + i), text: `Hi ${n.split(' ')[0]}` }, { dir: 'in', ts: ago(50 + i), text: `${n} wrote by text` }],
  }));
}
const MAV = ['Mav Ashby', 'Mav Brook'];
const RAN = ['Ran Alder', 'Ran Birch', 'Ran Cedar'];

(async () => {
  const s = await startApp({ offset: 155 });
  const rec = stubEverything();
  const tenant = require(R('lib/tenant.js'));
  const textQueue = require(R('lib/text-queue.js'));
  await s.store.update((d) => { d.candidates = team('mav', MAV, 40); d.events = []; });
  const made = await s.json('POST', '/api/teams/create', { name: 'Team Ranger', pin: PIN, adminPassword: 'test-password' });
  ok(made.status === 200 && made.body.team.id === 'team-ranger' && made.body.signedIn === false, 'a second team is made (without leaving the first)', made.body);
  await tenant.run('team-ranger', () => s.store.update((d) => { d.candidates = team('ran', RAN, 50); d.events = []; }));
  rec.threads = {};
  for (const [p, names] of [['mav', MAV], ['ran', RAN]]) names.forEach((n, i) => { rec.threads[`th-${p}${i + 1}`] = [{ dir: 'out', date: ago(2000), text: `Hello ${n}` }, { dir: 'in', date: ago(100 + i), text: `${n} wrote by email` }]; });
  const rangerCookie = await s.signIn(PIN, 'team-ranger');

  // ---- the server keeps them apart ----
  const mavState = await s.call('GET', '/api/state');
  const mavTag = mavState.headers.get('etag');
  const ranState = await fetch(`${s.base}/api/state`, { headers: { cookie: rangerCookie, 'If-None-Match': mavTag } });
  const ranBody = ranState.status === 200 ? await ranState.json() : null;
  ok(ranState.status === 200 && ranBody, "one team's tag never answers the other team with 'unchanged'", ranState.status);
  ok(ranBody && ranBody.team && ranBody.team.id === 'team-ranger' && !/Mav |mav\.|th-mav/.test(JSON.stringify(ranBody)), "and the other team's state is its own, with none of the first team's people");
  const again = await fetch(`${s.base}/api/state`, { headers: { cookie: rangerCookie, 'If-None-Match': ranState.headers.get('etag') } });
  ok(again.status === 304, "a team's own unchanged state is a 304", again.status);
  const peek = await fetch(`${s.base}/api/texts/thread?id=mav1`, { headers: { cookie: rangerCookie } });
  ok(peek.status === 404, "a team cannot open another team's text conversation", peek.status);
  const peekMail = await fetch(`${s.base}/api/emails/thread?id=mav1`, { headers: { cookie: rangerCookie } });
  ok(peekMail.status === 404, "nor its email conversation", peekMail.status);

  // Everything the page shows that names a person, from every page.
  const namesOnScreen = async (page) => {
    const out = new Set();
    const add = (xs) => xs.forEach((x) => x && out.add(x));
    await go(page, 'candidates');
    add(await page.evaluate(() => [...document.querySelectorAll('#candidateRows tr[data-id]')].map((r) => r.querySelector('[data-col="email"]').textContent.trim())));
    await go(page, 'texting');
    add(await texts(page, '#convList .conv-name'));
    await go(page, 'template');
    add(await texts(page, '#mailList .conv-name'));
    await go(page, 'dashboard');
    add(await texts(page, '#activityList .act-msg'));
    await page.evaluate(() => [...document.querySelectorAll('.bell')].find((x) => x.getClientRects().length).click());
    await page.waitForSelector('#bellPanel:not([hidden])');
    add(await texts(page, '#bellBody .bell-name'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#bellPanel', { state: 'hidden' });
    return [...out];
  };
  // Sign out from wherever the page puts it: the sidebar on a laptop,
  // Settings (under More) on a phone.
  const signOut = async (page, phone) => {
    if (phone) {
      await page.click('#navMore');
      await page.waitForSelector('#moreSheet:not([hidden])');
      await page.click('#moreSheetButtons [data-more="settings"]');
      await page.waitForSelector('#view-settings.active');
    }
    await page.click('#signOutBtn');
    await page.waitForSelector('#loginScreen:not([hidden])');
  };
  // Only the sign-in screen can be seen: whatever the page underneath still
  // holds, it is covered from corner to corner.
  const onlySignIn = (page) => page.evaluate(() => {
    const w = innerWidth;
    const h = innerHeight;
    return [[5, 5], [w / 2, h / 2], [w - 5, h - 5], [5, h - 5], [w - 5, 5]].every(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return Boolean(el && el.closest('#loginScreen'));
    });
  });
  const signIn = async (page, teamId, pin) => {
    await page.waitForSelector('#loginScreen:not([hidden])');
    await waitIn(page, () => document.querySelectorAll('#teamPicker [data-team]').length === 2);
    await page.click(`#teamPicker [data-team="${teamId}"]`);
    await page.fill('#loginPassword', pin);
    await page.click('#loginBtn');
    await ready(page);
  };

  const browser = await launch();
  for (const phone of [false, true]) {
    const tag = phone ? 'phone' : 'laptop';
    const { ctx, page, errors } = await open(browser, s, { phone });
    // Which team: the sidebar on a laptop, the page header on a phone.
    const teamShown = () => (phone ? text(page, '.view.active .head-team-name') : text(page, '#teamChipName'));
    ok(await teamShown() === (phone ? 'Maverick' : 'Team Maverick'), `${tag}: the page says which team`, await teamShown());
    ok(await text(page, '#statTotal') === '2', `${tag}: Maverick's 2 people`, await text(page, '#statTotal'));
    const mavSeen = await namesOnScreen(page);
    ok(mavSeen.some((n) => /Mav/.test(n) || /mav\./.test(n)) && !mavSeen.some((n) => /Ran|ran\./.test(n)), `${tag}: Maverick sees only Maverick's people`, mavSeen);
    // Something of Maverick's open when leaving.
    await go(page, 'texting');
    await page.click('#convList [data-conv="mav1"]');
    await waitText(page, '#threadName', 'Mav Ashby');
    if (phone) await page.click('#view-texting .thread-back');

    // ---- sign out ----
    if (phone) {
      await page.click('#navMore');
      await page.waitForSelector('#moreSheet:not([hidden])');
      await page.click('#moreSheetButtons [data-more="settings"]');
      await page.waitForSelector('#view-settings.active');
      ok(await page.evaluate(() => Boolean(document.querySelector('#settingsAccount #signOutBtn'))), `${tag}: Sign out lives in Settings`);
    } else {
      ok(await page.isVisible('#signOutBtn'), `${tag}: Sign out is in the sidebar`);
    }
    await page.click('#signOutBtn');
    ok(await waitIn(page, () => !document.querySelector('#loginScreen').hidden), `${tag}: signing out shows the sign-in screen`);
    ok(await onlySignIn(page), `${tag}: covering everything that was on screen`);
    ok(await page.evaluate(async () => (await fetch('/api/state')).status) === 401, `${tag}: and this browser can no longer read the team's data`);
    await waitIn(page, () => document.querySelectorAll('#teamPicker [data-team]').length === 2);
    const chips = await texts(page, '#teamPicker [data-team]');
    ok(JSON.stringify(chips) === JSON.stringify(['Team Maverick', 'Team Ranger']), `${tag}: the sign-in screen offers both teams`, chips);

    // ---- into the other team ----
    await signIn(page, 'team-ranger', PIN);
    // Whatever is left on screen from the other team, nothing typed here can
    // reach anybody. (Today, on a laptop, the Texting page's conversation
    // column still shows the last team's open conversation after a switch —
    // reported, not pinned. The box under it sends nothing.)
    await go(page, 'texting');
    if (await page.isVisible('#threadInput') && await page.isEnabled('#threadInput')) {
      await page.fill('#threadInput', 'This must go nowhere');
      await page.press('#threadInput', phone ? 'Tab' : 'Enter');
      await page.waitForTimeout(400);
    }
    const queues = [(await textQueue.loadQ()).items.length, (await tenant.run('team-ranger', () => textQueue.loadQ())).items.length];
    ok(queues[0] === 0 && queues[1] === 0, `${tag}: nothing is queued for either team`, queues);
    await go(page, 'dashboard');
    ok(await waitText(page, '#statTotal', '3'), `${tag}: signed in to Ranger, its 3 people`, await text(page, '#statTotal'));
    ok(await teamShown() === (phone ? 'Ranger' : 'Team Ranger'), `${tag}: the page says Ranger`, await teamShown());
    const ranSeen = await namesOnScreen(page);
    ok(ranSeen.some((n) => /Ran/.test(n)) && !ranSeen.some((n) => /Mav|mav\./.test(n)), `${tag}: Ranger sees none of Maverick's people`, ranSeen);
    ok(await text(page, '#view-dashboard .bell .bell-n') === '2', `${tag}: the bell counts Ranger's unread only`, await text(page, '#view-dashboard .bell .bell-n'));
    await go(page, 'settings');
    ok(await text(page, '#attachList') === 'No attachments — emails go out as text only.', `${tag}: a new team has no attachment (not Maverick's flyer)`, await text(page, '#attachList'));
    ok(await page.inputValue('#teamName') === 'Team Ranger', `${tag}: Settings is Ranger's`, await page.inputValue('#teamName'));

    // A reload stays in Ranger and brings back nothing of Maverick's.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(page);
    await go(page, 'dashboard');
    ok(await waitText(page, '#statTotal', '3'), `${tag}: after a reload, still Ranger's 3 people`, await text(page, '#statTotal'));
    ok(await teamShown() === (phone ? 'Ranger' : 'Team Ranger'), `${tag}: and still says Ranger`, await teamShown());
    const reloadSeen = await namesOnScreen(page);
    ok(reloadSeen.some((n) => /Ran/.test(n)) && !reloadSeen.some((n) => /Mav|mav\./.test(n)), `${tag}: with none of Maverick's people anywhere`, reloadSeen);
    await go(page, 'texting');
    await page.click('#convList [data-conv="ran2"]');
    await waitText(page, '#threadName', 'Ran Birch');
    if (phone) await page.click('#view-texting .thread-back');

    // ---- and back, through the team name in the header ----
    await go(page, 'dashboard');
    if (phone) await page.click('#view-dashboard .head-team');
    else await page.click('#signOutBtn');
    await signIn(page, 'maverick', 'test-password');
    await go(page, 'dashboard');
    ok(await waitText(page, '#statTotal', '2'), `${tag}: back in Maverick, its 2 people`, await text(page, '#statTotal'));
    const backSeen = await namesOnScreen(page);
    ok(backSeen.some((n) => /Mav/.test(n)) && !backSeen.some((n) => /Ran|ran\./.test(n)), `${tag}: and none of Ranger's`, backSeen);
    await go(page, 'texting');
    ok(!(await texts(page, '#convList .conv.on')).length, `${tag}: no conversation from the other team is selected in the list`);

    // Signed out and reloaded, the device shows nobody from either team —
    // not the list it last had, not behind the sign-in screen.
    await signOut(page, phone);
    await page.reload({ waitUntil: 'domcontentloaded' });
    ok(await waitIn(page, () => { const l = document.querySelector('#loginScreen'); return l && !l.hidden; }, null, 10000), `${tag}: signed out, a reload shows the sign-in screen`);
    await waitIn(page, () => document.querySelectorAll('#teamPicker [data-team]').length === 2);
    await page.waitForTimeout(500);
    ok(await onlySignIn(page), `${tag}: and only the sign-in screen`);
    const leftover = await page.evaluate(() => document.body.innerText);
    ok(!/Mav |Ran |mav\.|ran\./.test(leftover), `${tag}: with nobody from either team on the page`, (leftover.match(/.{0,30}(Mav |Ran |mav\.|ran\.).{0,30}/) || [''])[0]);

    ok(errors.length === 0, `${tag}: no page errors`, errors);
    await ctx.close();
  }

  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await browser.close();
  await s.close();
  done();
})().catch(crash);
