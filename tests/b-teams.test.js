// Leaving a team on a laptop, where each conversation column shows beside
// its list the whole time. After signing out and into another team — or
// back into the same one — neither the Texting nor the Email column still
// shows the last conversation opened (its messages, the name over them, a
// reply box addressed to that person): both are back to "Pick a
// conversation". And a look for news that was on its way when the sign-out
// happened is not drawn when it lands: it would put the old team back on
// the page. Made-up people only; nothing is sent.
const { startApp, launch, ok, done, crash, ago, R } = require('./helpers');
const { stubEverything, open, ready, text, waitIn, waitText, go, person } = require('./views-helpers');

const PIN = '6152';
function team(prefix, names) {
  return names.map((n, i) => person(`${prefix}${i + 1}`, n, {
    phone: `(617) 555-02${60 + i}`, status: 'replied', lastEmailedAt: ago(2000 + i), gmailThreadId: `th-${prefix}${i + 1}`, lastSubject: 'Quick question',
    replies: [{ id: `r-${prefix}${i}`, date: ago(100 + i), text: `${n} wrote by email`, kind: null }], lastReplyAt: ago(100 + i),
    lastTextedAt: ago(500 + i), textStatus: 'replied',
    textThread: [{ dir: 'out', ts: ago(500 + i), text: `Hi ${n.split(' ')[0]}` }, { dir: 'in', ts: ago(50 + i), text: `${n} wrote by text` }],
  }));
}

(async () => {
  const s = await startApp({ offset: 206 });
  const rec = stubEverything();
  const tenant = require(R('lib/tenant.js'));
  await s.store.update((d) => { d.candidates = team('mav', ['Mav Archer', 'Mav Bishop']); d.events = []; });
  const made = await s.json('POST', '/api/teams/create', { name: 'Team Ranger', pin: PIN, adminPassword: 'test-password' });
  ok(made.status === 200, 'a second team is made', made.body);
  await tenant.run('team-ranger', () => s.store.update((d) => { d.candidates = team('ran', ['Ran Cooper', 'Ran Dyer']); d.events = []; }));
  rec.threads = {};
  for (const [p, names] of [['mav', ['Mav Archer', 'Mav Bishop']], ['ran', ['Ran Cooper', 'Ran Dyer']]]) {
    names.forEach((n, i) => { rec.threads[`th-${p}${i + 1}`] = [{ dir: 'out', date: ago(2000), text: `Hello ${n}` }, { dir: 'in', date: ago(100 + i), text: `${n} wrote by email` }]; });
  }

  const browser = await launch();
  const { ctx, page, errors } = await open(browser, s);
  const columns = () => page.evaluate(() => ({
    textLive: !document.querySelector('#threadLive').hidden, textEmpty: !document.querySelector('#threadEmpty').hidden,
    textBody: document.querySelector('#threadBody').textContent.trim(), textName: document.querySelector('#threadName').textContent.trim(),
    textBox: document.querySelector('#threadInput').value,
    mailLive: !document.querySelector('#mailLive').hidden, mailEmpty: !document.querySelector('#mailEmpty').hidden,
    mailBody: document.querySelector('#mailBody').textContent.trim(), mailName: document.querySelector('#mailName').textContent.trim(),
    mailBox: document.querySelector('#mailInput').value,
  }));
  const cleared = { textLive: false, textEmpty: true, textBody: '', textName: '', textBox: '', mailLive: false, mailEmpty: true, mailBody: '', mailName: '', mailBox: '' };
  const signIn = async (teamId, pin) => {
    await page.waitForSelector('#loginScreen:not([hidden])');
    await waitIn(page, () => document.querySelectorAll('#teamPicker [data-team]').length === 2);
    await page.click(`#teamPicker [data-team="${teamId}"]`);
    await page.fill('#loginPassword', pin);
    await page.click('#loginBtn');
    await ready(page);
  };
  // Open one of each, and leave something half-typed under them.
  const openBoth = async (id, name) => {
    await go(page, 'texting');
    await page.click(`#convList [data-conv="${id}"]`);
    await waitText(page, '#threadName', name);
    await waitIn(page, (n) => document.querySelector('#threadBody').textContent.includes(`${n} wrote by text`), name);
    await page.fill('#threadInput', `A draft for ${name}`);
    await go(page, 'template');
    await page.click(`#mailList [data-mail="${id}"]`);
    await waitText(page, '#mailName', name);
    await waitIn(page, (n) => document.querySelector('#mailBody').textContent.includes(`${n} wrote by email`), name);
    await page.fill('#mailInput', `An email draft for ${name}`);
  };

  // ---- into another team ----
  await openBoth('mav1', 'Mav Archer');
  const before = await columns();
  ok(before.textLive && before.mailLive && before.textName === 'Mav Archer' && before.mailName === 'Mav Archer', 'Maverick: a text and an email conversation are open', before);
  await page.click('#signOutBtn');
  await page.waitForSelector('#loginScreen:not([hidden])');
  await signIn('team-ranger', PIN);
  ok(await waitText(page, '#teamChipName', 'Team Ranger'), 'signed in to Ranger');
  await go(page, 'texting');
  let after = await columns();
  ok(JSON.stringify(after) === JSON.stringify(cleared), 'neither column still shows Maverick\'s conversation, nor a reply box addressed to them', after);
  await go(page, 'template');
  ok(!(await page.isVisible('#mailLive')) && await page.isVisible('#mailEmpty'), 'the Email page offers to pick a conversation');
  await go(page, 'texting');
  ok(!(await page.isVisible('#threadLive')) && await page.isVisible('#threadEmpty'), 'and so does Texting');
  ok(!(await page.evaluate(() => document.body.innerText)).includes('Mav '), 'nothing of Maverick\'s people is on the page');

  // ---- and back into the same team ----
  await openBoth('ran2', 'Ran Dyer');
  await page.click('#signOutBtn');
  await signIn('team-ranger', PIN);
  await go(page, 'template');
  after = await columns();
  ok(JSON.stringify(after) === JSON.stringify(cleared), 'signing out and back into the same team starts with no conversation open', after);

  // ---- a look on its way when the sign-out happens ----
  let fetched;
  const gotIt = new Promise((r) => { fetched = r; });
  let release;
  const held = new Promise((r) => { release = r; });
  let delivered;
  const landed = new Promise((r) => { delivered = r; });
  let armed = true;
  const hold = async (route) => {
    if (!armed) { await route.continue(); return; }
    armed = false;
    const resp = await route.fetch();
    fetched();
    await held;
    await route.fulfill({ response: resp });
    delivered(resp.status());
  };
  await page.route((u) => u.pathname.startsWith('/api/state'), hold);
  // Something changed, so the answer is a whole new state, not "no change".
  await tenant.run('team-ranger', () => s.store.update((d) => { d.candidates[0].notes = 'Changed elsewhere'; }));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await gotIt;
  await page.click('#signOutBtn');
  await page.waitForSelector('#loginScreen:not([hidden])');
  release();
  const answer = await landed;
  ok(answer === 200, '(the answer held on its way was a whole new state)', answer);
  await page.waitForTimeout(600);
  ok(await page.evaluate(() => document.querySelector('#teamChip').hidden), 'the answer, landing after the sign-out, does not put Ranger back on the page');
  ok(await page.evaluate(() => [...document.querySelectorAll('.head-team')].every((b) => b.hidden)), 'nor in any page\'s header');
  await page.unroute((u) => u.pathname.startsWith('/api/state'), hold);
  await signIn('maverick', 'test-password');
  ok(await waitText(page, '#teamChipName', 'Team Maverick'), 'signing in afterwards shows the team signed in to');
  ok(await waitText(page, '#statTotal', '2'), 'with its own people', await text(page, '#statTotal'));

  ok(errors.length === 0, 'no page errors', errors);
  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await ctx.close();
  await browser.close();
  await s.close();
  done();
})().catch(crash);
