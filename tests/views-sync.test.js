// Keeping two screens and the server in step: a laptop and a phone signed in
// to the same team. What one device reads is read on the other at its next
// look; an answer to a poll that set off before a conversation was opened
// never brings its unread flag back (nor rings for it); a look that finds
// nothing new changes nothing on screen; someone removed elsewhere leaves
// every list, count and the bell; someone renamed elsewhere shows under the
// new name, in the lists and in the conversation open on screen.
const { startApp, launch, ok, done, crash, ago, R } = require('./helpers');
const { stubEverything, open, quiet, text, texts, waitIn, waitText, settle, same, until, poke, go, stored, byId, person } = require('./views-helpers');

const DAY = 1440;
function people() {
  const texter = (id, name, ph, mins, said, unread) => person(id, name, {
    phone: `(617) 555-02${ph}`, lastTextedAt: ago(mins + 60), textStatus: 'replied', textUnread: unread,
    textThread: [{ dir: 'out', ts: ago(mins + 60), text: `Hi ${name.split(' ')[0]}, worth a call?` }, { dir: 'in', ts: ago(mins), text: said }],
  });
  const mailer = (c, mins, said, unread) => Object.assign(c, {
    status: 'replied', lastEmailedAt: ago(mins + 2000), gmailThreadId: `th-${c.id}`, lastSubject: 'Quick question', emailUnread: unread,
    replies: [{ id: `r-${c.id}`, date: ago(mins), text: said, kind: null }], lastReplyAt: ago(mins),
  });
  return [
    texter('s1', 'Sid Texter', '61', 10, 'Text me back please', true),
    texter('s2', 'Sue Second', '62', 20, 'Is it still open?', true),
    mailer(person('s3', 'Sam Mailer'), 30, 'Sounds interesting', true),
    // Removed from another device during the test: unread on both channels.
    mailer(texter('s4', 'Zoe Leaving', '64', 40, 'Zoe by text', true), 45, 'Zoe by email', true),
    // Renamed from another device during the test: read on both channels.
    mailer(texter('s5', 'Wes Oldname', '65', 2 * DAY, 'Wes by text', false), 2 * DAY + 5, 'Wes by email', false),
    person('s6', 'Ola Quiet'),
    person('s7', 'Pat Quiet'),
  ];
}

// Counts every time a bell starts ringing.
const RING_WATCH = () => {
  window.__rings = 0;
  new MutationObserver((muts) => {
    for (const m of muts) if (m.target.classList && m.target.classList.contains('bell') && m.target.classList.contains('ring') && !(m.oldValue || '').includes('ring')) window.__rings++;
  }).observe(document, { attributes: true, attributeOldValue: true, subtree: true, attributeFilter: ['class'] });
};

(async () => {
  const s = await startApp({ offset: 158 });
  const rec = stubEverything();
  await s.store.update((d) => { d.candidates = people(); d.events = []; });
  rec.threads = {};
  for (const c of people()) if (c.gmailThreadId) rec.threads[c.gmailThreadId] = [{ dir: 'out', date: c.lastEmailedAt, text: 'Hello' }, { dir: 'in', date: c.lastReplyAt, text: c.replies[0].text }];

  const bellN = (page) => page.evaluate(() => {
    const b = [...document.querySelectorAll('.bell')].find((x) => x.getClientRects().length);
    const n = b && b.querySelector('.bell-n');
    return n && !n.hidden ? n.textContent : '';
  });
  const convRows = (page) => page.evaluate(() => [...document.querySelectorAll('#convList [data-conv]')].map((b) => `${b.dataset.conv}${b.classList.contains('unread') ? '*' : ''} ${b.querySelector('.conv-name').textContent.trim()}`));
  const mailRows = (page) => page.evaluate(() => [...document.querySelectorAll('#mailList [data-mail]')].map((b) => `${b.dataset.mail}${b.classList.contains('unread') ? '*' : ''} ${b.querySelector('.conv-name').textContent.trim()}`));
  const seeAll = async (get, want, msg) => { const got = await settle(get, want); ok(same(got, want), msg, got); return got; };

  const browser = await launch();
  const A = await open(browser, s, { at: '/#texting', init: RING_WATCH });            // the laptop
  const B = await open(browser, s, { phone: true });                                  // the phone
  const laptop = A.page;
  const phone = B.page;

  // ---- both start from the same place ----
  ok(await settle(() => bellN(phone), '5') === '5', 'phone: the bell counts five unread (three texts, two emails)', await bellN(phone));
  ok(await settle(() => bellN(laptop), '5') === '5', 'laptop: so does the laptop', await bellN(laptop));

  // ---- read on one device, read on the other ----
  await laptop.waitForSelector('#convList [data-conv="s1"]');
  await laptop.click('#convList [data-conv="s1"]');
  ok(await waitText(laptop, '#threadName', 'Sid Texter'), 'laptop: opens Sid’s conversation', await text(laptop, '#threadName'));
  ok(await until(async () => byId(await stored(s), 's1').textUnread === false), 'the server has it read');
  await poke(phone, 'visibilitychange');
  ok(await settle(() => bellN(phone), '4') === '4', 'phone: on its next look, the bell drops to four', await bellN(phone));
  ok(await waitText(phone, '#navInboxCount', '4'), 'phone: and so does the Inbox tab', await text(phone, '#navInboxCount'));
  await go(phone, 'texting');
  await seeAll(() => convRows(phone), ['s1 Sid Texter', 's2* Sue Second', 's4* Zoe Leaving', 's5 Wes Oldname'], 'phone: Sid’s conversation is no longer unread there');

  // ---- an answer that set off before the tap never brings the flag back ----
  // The laptop asks for the state; the answer (Sue still unread) is held on
  // its way while Sue's conversation is opened and read, then delivered.
  let fetched;
  const gotIt = new Promise((r) => { fetched = r; });
  let release;
  const held = new Promise((r) => { release = r; });
  let delivered;
  const deliveredP = new Promise((r) => { delivered = r; });
  const isState = (u) => u.pathname.startsWith('/api/state');
  let armed = true;
  // Only the first request for the state is held; any other goes straight on.
  const hold = async (route) => {
    if (!armed) { await route.continue(); return; }
    armed = false;
    const resp = await route.fetch();
    fetched();
    await held;
    await route.fulfill({ response: resp });
    delivered();
  };
  await laptop.route(isState, hold);
  await laptop.evaluate(() => window.dispatchEvent(new Event('online')));
  await gotIt;
  const ringsBefore = await laptop.evaluate(() => window.__rings);
  await laptop.click('#convList [data-conv="s2"]');
  ok(await waitText(laptop, '#threadName', 'Sue Second'), 'laptop: Sue’s conversation opens', await text(laptop, '#threadName'));
  ok(await until(async () => byId(await stored(s), 's2').textUnread === false), 'the server has Sue read');
  await waitIn(laptop, () => document.querySelector('#convUnreadN').textContent === '1');
  // Read, and left: off to the Dashboard before the old answer lands.
  await go(laptop, 'dashboard');
  const beforeStale = { bell: await bellN(laptop), inbox: await text(laptop, '#navInboxCount') };
  release();
  await deliveredP;
  await laptop.unroute(isState, hold);
  await quiet(laptop);
  await laptop.waitForTimeout(300);
  const afterStale = { bell: await bellN(laptop), inbox: await text(laptop, '#navInboxCount') };
  ok(same(afterStale, beforeStale) && afterStale.bell === '3', 'laptop: an answer that set off before the tap does not bring Sue’s unread back', { beforeStale, afterStale });
  ok(await laptop.evaluate(() => window.__rings) === ringsBefore, 'laptop: nor ring the bell for her');
  await go(laptop, 'texting');
  await seeAll(() => convRows(laptop), ['s1 Sid Texter', 's2 Sue Second', 's4* Zoe Leaving', 's5 Wes Oldname'], 'laptop: her conversation is still read in the list');
  await poke(laptop);
  ok(!(await convRows(laptop)).includes('s2* Sue Second') && await bellN(laptop) === '3', 'laptop: and the next look agrees', await convRows(laptop));

  // ---- a look that finds nothing new changes nothing ----
  await poke(phone);
  const snap = async () => ({ rows: await convRows(phone), bell: await bellN(phone), inbox: await text(phone, '#navInboxCount') });
  const still = await snap();
  await poke(phone);
  await poke(phone, 'visibilitychange');
  ok(same(await snap(), still) && still.rows.length === 4, 'phone: a look that finds nothing new leaves the list and every count as they were', { still, now: await snap() });
  ok(!(await texts(phone, '.toast')).some((t) => /Couldn|fail/i.test(t)), 'phone: and says nothing went wrong', await texts(phone, '.toast'));

  // ---- someone removed elsewhere leaves everything ----
  const totalBefore = Number(await text(phone, '#statTotal'));
  await s.store.update((d) => { s.store.removeCandidate(d, 's4'); });
  await poke(phone);
  await seeAll(() => convRows(phone), ['s1 Sid Texter', 's2 Sue Second', 's5 Wes Oldname'], 'phone: someone removed elsewhere leaves the Texting list on the next look');
  ok(await settle(() => bellN(phone), '1') === '1', 'phone: and the bell (only Sam’s email is left unread)', await bellN(phone));
  ok(await waitText(phone, '#navInboxCount', '1'), 'phone: and the Inbox tab', await text(phone, '#navInboxCount'));
  await go(phone, 'template');
  await seeAll(() => mailRows(phone), ['s3* Sam Mailer', 's5 Wes Oldname'], 'phone: and the Email list');
  await go(phone, 'dashboard');
  ok(totalBefore === 7 && await waitText(phone, '#statTotal', '6'), 'phone: and the Candidates count', [totalBefore, await text(phone, '#statTotal')]);
  await poke(laptop);
  await seeAll(() => convRows(laptop), ['s1 Sid Texter', 's2 Sue Second', 's5 Wes Oldname'], 'laptop: gone from the laptop’s list too');
  ok(await settle(() => bellN(laptop), '1') === '1', 'laptop: and from its bell', await bellN(laptop));

  // ---- someone renamed elsewhere shows under the new name ----
  await laptop.click('#convList [data-conv="s5"]');
  ok(await waitText(laptop, '#threadName', 'Wes Oldname'), 'laptop: Wes’s conversation open');
  await s.store.update((d) => { const c = d.candidates.find((x) => x.id === 's5'); c.name = 'Wesley Newname'; c.firstName = 'Wesley'; c.lastName = 'Newname'; });
  await poke(laptop);
  ok(await waitText(laptop, '#threadName', 'Wesley Newname'), 'laptop: the open conversation shows the new name on the next look', await text(laptop, '#threadName'));
  ok(await waitIn(laptop, () => /Wesley Newname/.test(document.querySelector('#convList [data-conv="s5"] .conv-name').textContent)), 'laptop: and so does its row', await convRows(laptop));
  await poke(phone);
  await go(phone, 'texting');
  ok((await settle(async () => (await convRows(phone)).find((r) => r.startsWith('s5')), 's5 Wesley Newname')) === 's5 Wesley Newname', 'phone: the Texting list shows the new name', await convRows(phone));
  await go(phone, 'template');
  ok((await settle(async () => (await mailRows(phone)).find((r) => r.startsWith('s5')), 's5 Wesley Newname')) === 's5 Wesley Newname', 'phone: and the Email list', await mailRows(phone));

  ok(A.errors.length === 0 && B.errors.length === 0, 'no page errors on either device', [...A.errors, ...B.errors]);
  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await A.ctx.close();
  await B.ctx.close();
  await browser.close();
  await s.close();
  done();
})().catch(crash);
