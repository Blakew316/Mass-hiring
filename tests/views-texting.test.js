// The Texting page, on a laptop and on a phone: the conversation list (newest
// first, a tapback never moves a conversation, "You:" on our own last word,
// unread marked), growing the list as it is scrolled without losing order,
// opening a conversation (its messages, read here and on the server, every
// unread count following), replying (queued for that person and nobody else,
// even when two conversations are opened in quick succession), a draft kept
// per conversation, STOP honoured, and a poll that brings a new message —
// including one into the conversation already on screen, which is read as
// it arrives. Nothing leaves the queue: there is no relay.
const { startApp, launch, ok, done, crash, ago, R } = require('./helpers');
const { stubEverything, open, text, texts, waitIn, waitText, until, poke, state, byId, person } = require('./views-helpers');

const pad = (i) => String(i).padStart(2, '0');
const N = 70;
const UNREAD = new Set([2, 5, 65]);
const STOPPED = 7;   // replied STOP: on the opt-out list

function conversations() {
  const out = [];
  for (let i = 1; i <= N; i++) {
    const p = pad(i);
    const thread = [{ dir: 'out', ts: ago(i * 10 + 300), text: `Hi ${p}, worth a quick call this week?` }];
    if (i === 3) {
      // Our last word, then a tapback on it: the tapback is not what the
      // conversation was last about, and does not move it up the list.
      thread.push({ dir: 'out', ts: ago(30), text: 'Checking in 03' });
      thread.push({ dir: 'in', ts: ago(25), text: 'Liked “Checking in 03”', kind: 'reaction' });
    } else if (i % 2 === 1 || UNREAD.has(i)) {
      thread.push({ dir: 'in', ts: ago(i * 10), text: UNREAD.has(i) ? `Tell me more ${p}` : `Reply from person ${p}` });
    } else {
      thread.push({ dir: 'out', ts: ago(i * 10), text: `Following up ${p}` });
    }
    out.push(person(`t${p}`, `Text Person${p}`, {
      phone: `(617) 555-02${p}`, status: 'new', lastTextedAt: ago(i * 10 + 300), textStatus: i % 2 ? 'replied' : 'delivered',
      textThread: thread, textUnread: UNREAD.has(i),
    }));
  }
  // Someone never texted: not a conversation.
  out.push(person('quiet', 'Quiet Person', { phone: '(617) 555-0299' }));
  return out;
}
const order = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => `t${pad(from + k)}`);

(async () => {
  const s = await startApp({ offset: 125 });
  const rec = stubEverything();
  const textQueue = require(R('lib/text-queue.js'));
  const seed = async () => {
    await s.store.update((d) => { d.candidates = conversations(); d.events = []; });
    await textQueue.updateQ((q) => {
      Object.assign(q, { items: [], leases: {}, templates: {}, failed: [], attempts: {}, sentLog: [], total: 0, sent: 0, startedAt: null });
      q.optOut = [`+1617555020${STOPPED}`];
    });
  };
  // What is waiting in the queue for whom, by message.
  const queued = async () => {
    const q = await textQueue.loadQ();
    return q.items.map((i) => ({ id: i.id, phone: i.phone, text: (q.templates[i.t] || {}).body }));
  };
  const rows = (page) => page.evaluate(() => [...document.querySelectorAll('#convList [data-conv]')].map((b) => b.dataset.conv));
  const unreadRows = (page) => page.evaluate(() => [...document.querySelectorAll('#convList .conv.unread')].map((b) => b.dataset.conv));
  const bubbles = (page) => page.evaluate(() => [...document.querySelectorAll('#threadBody .msg')].map((m) => `${m.classList.contains('out') ? '>' : '<'} ${m.querySelector('.bubble').textContent.trim()}`));
  const counts = (page) => page.evaluate(() => ({
    list: document.querySelector('#convUnreadN').textContent,
    inbox: document.querySelector('#navInboxCount').textContent,
    switch: (document.querySelector('.group-count[data-count-for="texting"]') || {}).textContent,
    bell: document.querySelector('.bell .bell-n').hidden ? '' : document.querySelector('.bell .bell-n').textContent,
  }));
  const openConv = async (page, id) => { await page.click(`#convList [data-conv="${id}"]`); };

  const browser = await launch();

  // ================= laptop =================
  await seed();
  {
    const tag = 'laptop';
    const { ctx, page, errors } = await open(browser, s, { at: '/#texting' });
    await page.waitForSelector('#view-texting.active');
    await page.waitForSelector('#convList [data-conv]');

    ok(JSON.stringify(await rows(page)) === JSON.stringify(order(1, 60)), `${tag}: the first 60 conversations, newest first`, await rows(page));
    ok(await text(page, '#convList .conv-more') === '10 more', `${tag}: and says how many more there are`, await text(page, '#convList .conv-more'));
    ok(!(await rows(page)).includes('quiet'), `${tag}: someone never texted is not a conversation`);
    ok(JSON.stringify(await unreadRows(page)) === JSON.stringify(['t02', 't05']), `${tag}: unread conversations are marked`, await unreadRows(page));
    const last = (id) => text(page, `#convList [data-conv="${id}"] .conv-last`);
    ok(await last('t01') === 'Reply from person 01', `${tag}: their last word is the preview`, await last('t01'));
    ok(await last('t04') === 'You: Following up 04', `${tag}: ours is marked "You:"`, await last('t04'));
    ok(await last('t03') === 'You: Checking in 03', `${tag}: a tapback is not the preview`, await last('t03'));
    ok(JSON.stringify(await counts(page)) === JSON.stringify({ list: '3', inbox: '3', switch: '3', bell: '3' }), `${tag}: every unread count says 3`, await counts(page));

    await page.click('[data-conv-tab="unread"]');
    ok(JSON.stringify(await rows(page)) === JSON.stringify(['t02', 't05', 't65']), `${tag}: Unread lists all three, including one beyond the first page`, await rows(page));
    await page.click('[data-conv-tab="all"]');

    // Scrolled to the bottom, the list grows, in the same order.
    await page.evaluate(() => { const l = document.querySelector('#convList'); l.scrollTop = l.scrollHeight; l.dispatchEvent(new Event('scroll')); });
    await waitIn(page, () => document.querySelectorAll('#convList [data-conv]').length >= 70);
    ok(JSON.stringify(await rows(page)) === JSON.stringify(order(1, 70)), `${tag}: scrolling down loads the rest, in order`, (await rows(page)).slice(-12));
    ok(await text(page, '#convList .conv-more') === null, `${tag}: and nothing is left to load`);

    // Search covers every conversation: by name, by number however typed, by the last message.
    // Typing is debounced, so each search waits for the list it should produce.
    const search = async (q, want) => {
      await page.fill('#convSearch', q);
      await waitIn(page, ([w]) => JSON.stringify([...document.querySelectorAll('#convList [data-conv]')].map((b) => b.dataset.conv)) === w, [JSON.stringify(want)], 5000);
      return rows(page);
    };
    ok(JSON.stringify(await search('Person66', ['t66'])) === JSON.stringify(['t66']), `${tag}: searching a name finds that conversation`, await rows(page));
    ok(JSON.stringify(await search('555-0267', ['t67'])) === JSON.stringify(['t67']), `${tag}: so does a number, typed any way`, await rows(page));
    ok(JSON.stringify(await search('reply from person 69', ['t69'])) === JSON.stringify(['t69']), `${tag}: and the words of the last message`, await rows(page));
    await page.fill('#convSearch', 'nobody-matches-this');
    ok(await waitText(page, '#convList .conv-none', 'No results for “nobody-matches-this”.'), `${tag}: no match says so`, await text(page, '#convList'));
    await page.click('[data-conv-tab="unread"]');
    ok(JSON.stringify(await search('Person01', ['t01'])) === JSON.stringify(['t01']), `${tag}: search looks past the Unread filter`, await rows(page));
    await page.click('[data-conv-tab="all"]');
    ok(JSON.stringify(await search('', order(1, 60))) === JSON.stringify(order(1, 60)), `${tag}: clearing the search brings the list back`, (await rows(page)).length);

    // Opening one: its messages, and it is read — here, everywhere, and on the server.
    await openConv(page, 't02');
    ok(await waitText(page, '#threadName', 'Text Person02'), `${tag}: opening a conversation shows who it is with`, await text(page, '#threadName'));
    await waitIn(page, () => document.querySelectorAll('#threadBody .msg').length === 2);
    ok(JSON.stringify(await bubbles(page)) === JSON.stringify(['> Hi 02, worth a quick call this week?', '< Tell me more 02']), `${tag}: and its messages, oldest first`, await bubbles(page));
    ok(await text(page, '#threadSub') === '(617) 555-0202', `${tag}: with their number`, await text(page, '#threadSub'));
    await waitIn(page, () => document.querySelector('#convUnreadN').textContent === '2');
    ok(JSON.stringify(await counts(page)) === JSON.stringify({ list: '2', inbox: '2', switch: '2', bell: '2' }), `${tag}: every unread count drops to 2`, await counts(page));
    ok(!(await unreadRows(page)).includes('t02'), `${tag}: its row is no longer unread`);
    ok(await until(async () => byId(await state(s), 't02').textUnread === false), `${tag}: the server has it read`);
    ok(byId(await state(s), 't05').textUnread === true, `${tag}: nobody else was marked read`);
    ok(/offline/.test(await text(page, '#threadNote')), `${tag}: the thread says replies wait for the Mac`, await text(page, '#threadNote'));

    // Replying: queued for this person.
    await page.fill('#threadInput', 'Happy to talk at 3pm');
    await page.press('#threadInput', 'Enter');
    ok(await waitIn(page, () => [...document.querySelectorAll('#threadBody .msg.pending')].some((m) => /Happy to talk at 3pm/.test(m.textContent) && /Sending/.test(m.textContent))),
      `${tag}: a sent reply shows at once as sending`);
    ok(await page.inputValue('#threadInput') === '', `${tag}: and the box is cleared`);
    let q = await until(async () => { const x = await queued(); return x.length ? x : null; });
    ok(q && q.length === 1 && q[0].id === 't02' && q[0].phone === '+16175550202' && q[0].text === 'Happy to talk at 3pm', `${tag}: the reply is queued for that person's number`, q);
    const thread02 = (await s.json('GET', '/api/texts/thread?id=t02')).body;
    ok(thread02.pending.length === 1 && thread02.pending[0].text === 'Happy to talk at 3pm', `${tag}: and their conversation shows it pending`, thread02.pending);

    // Two opened in quick succession: the reply goes to the one on screen.
    await openConv(page, 't08');
    await openConv(page, 't04');
    ok(await waitText(page, '#threadName', 'Text Person04'), `${tag}: the last one opened is the one shown`, await text(page, '#threadName'));
    await waitIn(page, () => /Following up 04/.test(document.querySelector('#threadBody').textContent));
    ok(JSON.stringify(await bubbles(page)) === JSON.stringify(['> Hi 04, worth a quick call this week?', '> Following up 04']), `${tag}: with its own messages`, await bubbles(page));
    await page.fill('#threadInput', 'Still interested?');
    await page.press('#threadInput', 'Enter');
    q = await until(async () => { const x = await queued(); return x.length === 2 ? x : null; });
    ok(q && q.some((i) => i.id === 't04' && i.phone === '+16175550204' && i.text === 'Still interested?') && !q.some((i) => i.id === 't08'),
      `${tag}: the reply went to the person on screen, not the one opened a moment before`, q);

    // The send has finished on the page too (box cleared, button back).
    await waitIn(page, () => !document.querySelector('#threadSend').disabled && document.querySelector('#threadInput').value === '');

    // A half-written reply belongs to its own conversation.
    await page.fill('#threadInput', 'Draft for 04 only');
    await page.dispatchEvent('#threadInput', 'input');
    await openConv(page, 't06');
    await waitText(page, '#threadName', 'Text Person06');
    ok(await page.inputValue('#threadInput') === '', `${tag}: another conversation does not inherit the draft`, await page.inputValue('#threadInput'));
    await openConv(page, 't04');
    await waitText(page, '#threadName', 'Text Person04');
    ok(await page.inputValue('#threadInput') === 'Draft for 04 only', `${tag}: coming back to it brings the draft back`, await page.inputValue('#threadInput'));
    await page.fill('#threadInput', '');
    await page.dispatchEvent('#threadInput', 'input');

    // STOP is final.
    await openConv(page, `t0${STOPPED}`);
    await waitText(page, '#threadName', `Text Person0${STOPPED}`);
    await waitIn(page, () => document.querySelector('#threadInput').disabled);
    ok(await page.isDisabled('#threadInput') && await page.isDisabled('#threadSend'), `${tag}: someone who replied STOP cannot be replied to`);
    ok(/replied STOP/.test(await text(page, '#threadNote')), `${tag}: and the page says why`, await text(page, '#threadNote'));
    const refused = await s.json('POST', '/api/texts/reply', { id: `t0${STOPPED}`, body: 'Are you sure?' });
    ok(refused.status === 409 && (await queued()).every((i) => i.id !== `t0${STOPPED}`), `${tag}: nor through the server`, refused);

    // A poll that brings a new message: it goes to the top, unread.
    await s.store.update((d) => {
      const c = d.candidates.find((x) => x.id === 't70');
      c.textThread.push({ dir: 'in', ts: new Date().toISOString(), text: 'Just saw this, call me' });
      c.textUnread = true;
    });
    await poke(page);
    ok(await waitIn(page, () => document.querySelector('#convList [data-conv]').dataset.conv === 't70'), `${tag}: a new message moves its conversation to the top`, (await rows(page)).slice(0, 3));
    ok(await last('t70') === 'Just saw this, call me', `${tag}: with the new message as its preview`, await last('t70'));
    ok((await unreadRows(page)).includes('t70'), `${tag}: marked unread`);
    ok(JSON.stringify(await counts(page)) === JSON.stringify({ list: '3', inbox: '3', switch: '3', bell: '3' }), `${tag}: and counted with the two still unread`, await counts(page));

    // A message into the conversation on screen is read as it arrives.
    await openConv(page, 't04');
    await waitText(page, '#threadName', 'Text Person04');
    const before = await counts(page);
    await s.store.update((d) => {
      const c = d.candidates.find((x) => x.id === 't04');
      c.textThread.push({ dir: 'in', ts: new Date().toISOString(), text: 'Yes! Call me now' });
      c.textUnread = true;
    });
    await poke(page);
    ok(await waitIn(page, () => /Yes! Call me now/.test(document.querySelector('#threadBody').textContent)), `${tag}: a reply into the open conversation appears in it`, await bubbles(page));
    ok(JSON.stringify(await counts(page)) === JSON.stringify(before), `${tag}: and never lights a count for something already on screen`, { before, after: await counts(page) });
    ok(await until(async () => byId(await state(s), 't04').textUnread === false), `${tag}: the server has it read`);

    ok(errors.length === 0, `${tag}: no page errors`, errors);
    await ctx.close();
  }

  // ================= phone =================
  await seed();
  {
    const tag = 'phone';
    const { ctx, page, errors } = await open(browser, s, { phone: true });
    ok(await text(page, '#navInboxCount') === '3', `${tag}: the Inbox tab carries the unread count`, await text(page, '#navInboxCount'));
    await page.click('.nav-group[data-group="inbox"]');
    await page.waitForSelector('#view-template.active');
    ok(await text(page, '#view-template .group-count[data-count-for="texting"]') === '3', `${tag}: the Texts switch says 3 unread`, await text(page, '#view-template .group-count[data-count-for="texting"]'));
    await page.click('#view-template .group-tab[data-goto="texting"]');
    await page.waitForSelector('#view-texting.active');
    await page.waitForSelector('#convList [data-conv]');
    ok(JSON.stringify((await rows(page)).slice(0, 6)) === JSON.stringify(order(1, 6)), `${tag}: conversations newest first`, (await rows(page)).slice(0, 6));
    ok(JSON.stringify(await unreadRows(page)) === JSON.stringify(['t02', 't05']), `${tag}: unread marked`, await unreadRows(page));

    await page.click('#convList [data-conv="t05"]');
    ok(await waitIn(page, () => document.querySelector('#view-texting .messenger').classList.contains('thread-open')), `${tag}: a conversation opens as its own screen`);
    ok(await waitText(page, '#threadName', 'Text Person05'), `${tag}: with who it is`, await text(page, '#threadName'));
    ok(await waitIn(page, () => /Tell me more 05/.test(document.querySelector('#threadBody').textContent)), `${tag}: and their messages`, await bubbles(page));
    ok(await waitText(page, '#navInboxCount', '2'), `${tag}: the Inbox tab drops to 2`, await text(page, '#navInboxCount'));
    ok(await until(async () => byId(await state(s), 't05').textUnread === false), `${tag}: read on the server`);

    // On a phone the return key makes a new line; the button sends.
    await page.click('#threadInput');
    await page.keyboard.type('See you');
    await page.keyboard.press('Enter');
    await page.keyboard.type('at noon');
    await page.waitForTimeout(300);
    ok((await queued()).length === 0, `${tag}: Return does not send`);
    await page.click('#threadSend');
    const q = await until(async () => { const x = await queued(); return x.length ? x : null; });
    ok(q && q.length === 1 && q[0].id === 't05' && q[0].phone === '+16175550205' && q[0].text === 'See you\nat noon', `${tag}: the send button queues it for that person`, q);

    await page.click('#view-texting .thread-back');
    ok(await waitIn(page, () => !document.querySelector('#view-texting .messenger').classList.contains('thread-open')), `${tag}: Back returns to the list`);
    ok(!(await unreadRows(page)).includes('t05'), `${tag}: where it is no longer unread`);

    // The bell's count follows.
    ok(await text(page, '#view-texting .bell .bell-n') === '2', `${tag}: the bell says 2`, await text(page, '#view-texting .bell .bell-n'));

    // A poll that brings news while on the list.
    await s.store.update((d) => {
      const c = d.candidates.find((x) => x.id === 't30');
      c.textThread.push({ dir: 'in', ts: new Date().toISOString(), text: 'Is this still open?' });
      c.textUnread = true;
    });
    await poke(page, 'visibilitychange');
    ok(await waitIn(page, () => document.querySelector('#convList [data-conv]').dataset.conv === 't30'), `${tag}: coming back to the app shows the new message on top`, (await rows(page)).slice(0, 3));
    ok(await waitText(page, '#navInboxCount', '3'), `${tag}: and counts it`, await text(page, '#navInboxCount'));

    ok(errors.length === 0, `${tag}: no page errors`, errors);
    await ctx.close();
  }

  ok(rec.sent.length === 0 && rec.outside.length === 0, 'no email was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await browser.close();
  await s.close();
  done();
})().catch(crash);
