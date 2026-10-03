// The Email page (the inbox), on a laptop and on a phone, with Gmail answered
// by the test: the Replied / Unread / All sent lists and their order, a bounce
// flagged and never counted as a reply, growing the list as it is scrolled,
// opening a conversation (read from "Gmail", quoted history folded away, read
// here and on the server, every unread count following), replying (to that
// person, in that thread, through the stubbed mailer — once, even for a
// double tap on Send; a reply Gmail refuses says so and keeps what was
// typed), and a poll that brings a new reply, including one into the
// conversation on screen.
const { startApp, launch, ok, done, crash, ago, R } = require('./helpers');
const { stubEverything, open, text, texts, waitIn, waitText, settle, same, until, poke, stored, byId, person } = require('./views-helpers');

const pad = (i) => String(i).padStart(2, '0');
const N = 64;
const UNREAD = new Set([3, 7, 61]);

function inbox() {
  const out = [];
  for (let i = 1; i <= N; i++) {
    const p = pad(i);
    const c = person(`m${p}`, `Mail Person${p}`, {
      status: 'emailed', lastEmailedAt: ago(i * 10 + 1000), gmailThreadId: `th-m${p}`, lastSubject: `Quick question ${p}`,
    });
    if (i % 2 === 1) {
      Object.assign(c, { status: 'replied', replies: [{ id: `r-${p}`, date: ago(i * 10), text: `Reply ${p}`, kind: null }], lastReplyAt: ago(i * 10), repliedAt: ago(i * 10) });
    }
    if (UNREAD.has(i)) c.emailUnread = true;
    out.push(c);
  }
  // A bounce: listed under All sent with a flag, never as a reply.
  Object.assign(out[N - 1], { status: 'bounced', replies: [{ id: 'r-bounce', date: ago(N * 10 + 990), text: 'Delivery Status Notification (Failure)', kind: 'bounce' }] });
  // Never emailed: not in the inbox at all.
  out.push(person('never', 'Never Emailed', {}));
  return out;
}
const odd = () => Array.from({ length: N / 2 }, (_, k) => `m${pad(2 * k + 1)}`);
const even = () => Array.from({ length: N / 2 }, (_, k) => `m${pad(2 * k + 2)}`);

function gmail(rec) {
  rec.threads = {};
  for (let i = 1; i <= N; i++) {
    const p = pad(i);
    const t = [{ dir: 'out', date: ago(i * 10 + 1000), text: `Hi Mail, are you open to a new role? (${p})`, subject: `Quick question ${p}` }];
    if (i % 2 === 1) t.push({ dir: 'in', date: ago(i * 10), text: `Reply ${p}\n\nOn Mon, Sep 28, 2026 at 9:00 AM Blake Woodruff wrote:\n> Hi Mail, are you open to a new role?`, subject: `Re: Quick question ${p}` });
    rec.threads[`th-m${p}`] = t;
  }
}

(async () => {
  const s = await startApp({ offset: 130 });
  const rec = stubEverything();
  const seed = async () => {
    await s.store.update((d) => { d.candidates = inbox(); d.events = []; });
    gmail(rec);
    rec.sent.length = 0;
  };
  const rows = (page) => page.evaluate(() => [...document.querySelectorAll('#mailList [data-mail]')].map((b) => b.dataset.mail));
  const unreadRows = (page) => page.evaluate(() => [...document.querySelectorAll('#mailList .conv.unread')].map((b) => b.dataset.mail));
  const counts = (page) => page.evaluate(() => ({
    list: document.querySelector('#mailUnreadN').textContent,
    email: document.querySelector('#navEmailCount').textContent,
    inbox: document.querySelector('#navInboxCount').textContent,
    switch: (document.querySelector('.group-count[data-count-for="template"]') || {}).textContent,
    bell: document.querySelector('.bell .bell-n').hidden ? '' : document.querySelector('.bell .bell-n').textContent,
  }));
  const msgs = (page) => page.evaluate(() => [...document.querySelectorAll('#mailBody .msg')].map((m) => `${m.classList.contains('out') ? '>' : '<'} ${m.querySelector('.msg-who').textContent.trim()}: ${m.querySelector('.bubble').firstChild.textContent.trim()}`));
  const all3 = (n) => ({ list: n, email: n, inbox: n, switch: n, bell: n });

  const browser = await launch();

  // ================= laptop =================
  await seed();
  {
    const tag = 'laptop';
    const { ctx, page, errors } = await open(browser, s, { at: '/#template' });
    await page.waitForSelector('#view-template.active');
    await page.waitForSelector('#mailList [data-mail]');

    const replied = await settle(() => rows(page), odd());
    ok(same(replied, odd()), `${tag}: Replied lists everyone who wrote back, newest reply first`, replied);
    ok(same(await settle(() => unreadRows(page), ['m03', 'm07', 'm61']), ['m03', 'm07', 'm61']), `${tag}: unread marked`, await unreadRows(page));
    ok(await text(page, '#mailList [data-mail="m01"] .conv-last') === 'Reply 01', `${tag}: their reply is the preview`, await text(page, '#mailList [data-mail="m01"] .conv-last'));
    const three = await settle(() => counts(page), all3('3'));
    ok(same(three, all3('3')), `${tag}: every unread count says 3`, three);

    await page.click('[data-mail-tab="unread"]');
    ok(same(await settle(() => rows(page), ['m03', 'm07', 'm61']), ['m03', 'm07', 'm61']), `${tag}: Unread lists the three`, await rows(page));
    await page.click('[data-mail-tab="all"]');
    // A first screenful (today 60 of the 64) by latest activity, and how many
    // more; then the rest as it is scrolled, in the same order.
    const everyone = [...odd(), ...even()];
    // (Drawn once it lists someone who has not replied.)
    const first = await until(async () => { const r = await rows(page); return r.length > N / 2 && same(r, everyone.slice(0, r.length)) ? r : null; }, 5000) || await rows(page);
    const firstLen = first.length;
    ok(firstLen < N && same(first, everyone.slice(0, firstLen)), `${tag}: All sent: the first ones, by latest activity`, first);
    ok(await text(page, '#mailList .conv-more') === `${N - firstLen} more`, `${tag}: and says how many more`, await text(page, '#mailList .conv-more'));
    ok(await text(page, '#mailList [data-mail="m02"] .conv-last') === 'You: Quick question 02', `${tag}: no reply yet shows our subject`, await text(page, '#mailList [data-mail="m02"] .conv-last'));
    for (let k = 0; k < 10 && (await rows(page)).length < N; k++) {
      const had = (await rows(page)).length;
      await page.evaluate(() => { const l = document.querySelector('#mailList'); l.scrollTop = l.scrollHeight; l.dispatchEvent(new Event('scroll')); });
      await waitIn(page, (n) => document.querySelectorAll('#mailList [data-mail]').length > n, had, 3000);
    }
    ok(same(await rows(page), everyone), `${tag}: scrolled down, the rest load in the same order`, (await rows(page)).slice(-6));
    ok(!(await rows(page)).includes('never'), `${tag}: someone never emailed is not in the inbox`);
    ok(await text(page, '#mailList [data-mail="m64"] .conv-flag') === '!', `${tag}: a bounce is flagged`, await text(page, '#mailList [data-mail="m64"] .conv-flag'));
    await page.click('[data-mail-tab="replied"]');
    ok(same(await settle(() => rows(page), odd()), odd()), `${tag}: and is not a reply`, await rows(page));

    // Search covers every conversation, whatever tab is showing. Typing is
    // debounced, so each search waits for the list it should produce.
    const search = async (q, want) => {
      await page.fill('#mailSearch', q);
      await waitIn(page, ([w]) => JSON.stringify([...document.querySelectorAll('#mailList [data-mail]')].map((b) => b.dataset.mail)) === w, [JSON.stringify(want)], 5000);
      return rows(page);
    };
    ok(JSON.stringify(await search('Person40', ['m40'])) === JSON.stringify(['m40']), `${tag}: searching on Replied finds someone who has not replied`, await rows(page));
    ok(JSON.stringify(await search('Reply 05', ['m05'])) === JSON.stringify(['m05']), `${tag}: and finds the words of a reply`, await rows(page));
    ok(JSON.stringify(await search('', odd())) === JSON.stringify(odd()), `${tag}: clearing it brings the Replied list back`, await rows(page));

    // Open one: read from Gmail, quoted history folded, read everywhere.
    await page.click('#mailList [data-mail="m03"]');
    ok(await waitText(page, '#mailName', 'Mail Person03'), `${tag}: opening shows who it is with`, await text(page, '#mailName'));
    ok(await waitIn(page, () => document.querySelectorAll('#mailBody .msg').length === 2), `${tag}: the conversation is read from Gmail`, await text(page, '#mailBody'));
    const m03 = await settle(() => msgs(page), ['> You: Hi Mail, are you open to a new role? (03)', '< Mail Person03: Reply 03']);
    ok(same(m03, ['> You: Hi Mail, are you open to a new role? (03)', '< Mail Person03: Reply 03']), `${tag}: oldest first, ours and theirs`, m03);
    ok(await page.evaluate(() => { const d = document.querySelector('#mailBody .msg.in details.msg-quote'); return Boolean(d && !d.open && /Blake Woodruff wrote/.test(d.textContent)); }), `${tag}: the history it quotes is folded away`);
    ok(/th-m03/.test(await page.getAttribute('#mailGmail', 'href') || ''), `${tag}: Open in Gmail goes to that thread`);
    ok(await waitIn(page, () => document.querySelector('#mailUnreadN').textContent === '2'), `${tag}: unread drops to 2`, await counts(page));
    ok(same(await settle(() => counts(page), all3('2')), all3('2')), `${tag}: every count follows`, await counts(page));
    ok(await until(async () => byId(await stored(s), 'm03').emailUnread === false), `${tag}: read on the server`);
    ok(byId(await stored(s), 'm07').emailUnread === true, `${tag}: and nobody else`);

    // Reply: to that person, in that thread, once.
    await page.fill('#mailInput', 'Great, talk Tuesday');
    await page.press('#mailInput', 'Control+Enter');
    const sent = await until(() => rec.sent.length >= 1);
    const m = rec.sent[0] || {};
    ok(sent && rec.sent.length === 1 && m.to === 'mail.person03@example.com' && m.threadId === 'th-m03' && m.text === 'Great, talk Tuesday',
      `${tag}: the reply goes to that person, in their thread`, rec.sent.map((x) => ({ to: x.to, threadId: x.threadId, text: x.text })));
    ok(m.subject === 'Re: Quick question 03' && m.inReplyTo === '<th-m03-1@example.com>', `${tag}: as a Re: of their last message`, { subject: m.subject, inReplyTo: m.inReplyTo });
    ok(await waitIn(page, () => [...document.querySelectorAll('.toast')].some((t) => t.textContent === 'Reply sent.')), `${tag}: the page says it was sent`);
    ok(await page.inputValue('#mailInput') === '', `${tag}: and clears the box`);
    const after = byId(await stored(s), 'm03');
    ok(Date.now() - new Date(after.lastEmailedAt).getTime() < 60000, `${tag}: the follow-up clock restarts from the reply`, after.lastEmailedAt);

    // Two opened in quick succession: the reply goes to the one on screen.
    await page.click('#mailList [data-mail="m05"]');
    await page.click('#mailList [data-mail="m07"]');
    ok(await waitText(page, '#mailName', 'Mail Person07'), `${tag}: the last one opened is the one shown`, await text(page, '#mailName'));
    await waitIn(page, () => /Reply 07/.test(document.querySelector('#mailBody').textContent));
    await page.fill('#mailInput', 'When suits you?');
    await page.click('#mailSend');
    await until(() => rec.sent.length >= 2);
    ok(rec.sent.length === 2 && rec.sent[1].to === 'mail.person07@example.com' && rec.sent[1].threadId === 'th-m07', `${tag}: the reply went to the person on screen`, rec.sent.map((x) => x.to));
    await waitIn(page, () => document.querySelector('#mailInput').value === '' && !document.querySelector('#mailSend').disabled);

    // Gmail refuses one: the page says so, what was typed is still there to
    // send again, and nothing counts it as sent (the follow-up clock stays).
    const mailer = require(R('lib/mailer.js'));
    const recording = mailer.sendEmail;
    const clock = byId(await stored(s), 'm07').lastEmailedAt;
    mailer.sendEmail = async () => { throw new Error('Gmail refused this one (test)'); };
    await page.fill('#mailInput', 'This one will not go');
    await page.dispatchEvent('#mailInput', 'input');
    await page.click('#mailSend');
    ok(await waitIn(page, () => [...document.querySelectorAll('.toast')].some((t) => /Gmail refused this one/.test(t.textContent))), `${tag}: a reply Gmail refuses says so`, await texts(page, '.toast'));
    ok(await page.inputValue('#mailInput') === 'This one will not go', `${tag}: and keeps what was typed`, await page.inputValue('#mailInput'));
    ok(await waitIn(page, () => !document.querySelector('#mailSend').disabled), `${tag}: ready to try again`);
    ok(byId(await stored(s), 'm07').lastEmailedAt === clock && rec.sent.length === 2, `${tag}: nothing is counted as sent`, byId(await stored(s), 'm07').lastEmailedAt);
    mailer.sendEmail = recording;
    await page.fill('#mailInput', '');
    await page.dispatchEvent('#mailInput', 'input');

    // A poll that brings a new reply from someone else.
    await s.store.update((d) => {
      const c = d.candidates.find((x) => x.id === 'm40');
      c.replies = [{ id: 'r-40', date: new Date().toISOString(), text: 'Late reply 40', kind: null }];
      c.lastReplyAt = new Date().toISOString(); c.status = 'replied'; c.emailUnread = true;
    });
    await poke(page);
    ok(await waitIn(page, () => document.querySelector('#mailList [data-mail]').dataset.mail === 'm40'), `${tag}: a new reply puts that conversation on top`, (await rows(page)).slice(0, 3));
    ok((await settle(() => unreadRows(page), ['m40', 'm61'])).includes('m40'), `${tag}: unread`, await unreadRows(page));
    ok(same(await settle(() => counts(page), all3('2')), all3('2')), `${tag}: counted alongside m61`, await counts(page));

    // One into the conversation on screen is read as it arrives.
    await page.click('#mailList [data-mail="m05"]');
    await waitText(page, '#mailName', 'Mail Person05');
    await waitIn(page, () => /Reply 05/.test(document.querySelector('#mailBody').textContent));
    rec.threads['th-m05'].push({ dir: 'in', date: new Date().toISOString(), text: 'One more thing 05', subject: 'Re: Quick question 05' });
    await s.store.update((d) => {
      const c = d.candidates.find((x) => x.id === 'm05');
      c.replies.push({ id: 'r-05b', date: new Date().toISOString(), text: 'One more thing 05', kind: null });
      c.lastReplyAt = new Date().toISOString(); c.emailUnread = true;
    });
    await poke(page);
    ok(await waitIn(page, () => /One more thing 05/.test(document.querySelector('#mailBody').textContent)), `${tag}: a reply into the open conversation appears in it`, await msgs(page));
    ok(JSON.stringify(await counts(page)) === JSON.stringify(all3('2')), `${tag}: without lighting a count`, await counts(page));
    ok(await until(async () => byId(await stored(s), 'm05').emailUnread === false), `${tag}: read on the server`);

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
    await page.waitForSelector('#mailList [data-mail]');
    ok(await text(page, '#view-template .group-count[data-count-for="template"]') === '3', `${tag}: the Email switch says 3`, await text(page, '#view-template .group-count[data-count-for="template"]'));
    const top4 = await settle(async () => (await rows(page)).slice(0, 4), ['m01', 'm03', 'm05', 'm07']);
    ok(same(top4, ['m01', 'm03', 'm05', 'm07']), `${tag}: replies newest first`, top4);

    await page.click('#mailList [data-mail="m07"]');
    ok(await waitIn(page, () => document.querySelector('#view-template .messenger').classList.contains('thread-open')), `${tag}: a conversation opens as its own screen`);
    ok(await waitIn(page, () => document.querySelectorAll('#mailBody .msg').length === 2), `${tag}: with its messages from Gmail`, await msgs(page));
    ok(await waitText(page, '#navInboxCount', '2'), `${tag}: the Inbox tab drops to 2`, await text(page, '#navInboxCount'));
    ok(await until(async () => byId(await stored(s), 'm07').emailUnread === false), `${tag}: read on the server`);

    await page.fill('#mailInput', 'Sounds good');
    await page.click('#mailSend');
    await until(() => rec.sent.length >= 1);
    ok(rec.sent.length === 1 && rec.sent[0].to === 'mail.person07@example.com' && rec.sent[0].threadId === 'th-m07', `${tag}: Send replies to that person in their thread`, rec.sent.map((x) => x.to));
    await waitIn(page, () => document.querySelector('#mailInput').value === '' && !document.querySelector('#mailSend').disabled);

    // A double tap on Send, on a slow connection, sends one email. (Every
    // change the page asks for is held back a little, whichever request it
    // is, so the second tap lands while the first is on its way.)
    const slow = async (route) => { if (route.request().method() !== 'GET') await new Promise((r) => setTimeout(r, 500)); await route.continue(); };
    await page.route((u) => u.pathname.startsWith('/api/'), slow);
    await page.fill('#mailInput', 'Just the one email');
    await page.dispatchEvent('#mailInput', 'input');
    await page.dblclick('#mailSend');
    await until(() => rec.sent.length >= 2);
    await waitIn(page, () => document.querySelector('#mailInput').value === '');
    await page.waitForTimeout(800);
    ok(rec.sent.filter((x) => x.text === 'Just the one email').length === 1 && rec.sent.length === 2, `${tag}: a double tap on Send sends one email`, rec.sent.map((x) => x.text));
    await page.unroute((u) => u.pathname.startsWith('/api/'), slow);

    await page.click('#view-template .thread-back');
    ok(await waitIn(page, () => !document.querySelector('#view-template .messenger').classList.contains('thread-open')), `${tag}: Back returns to the list`);
    ok(!(await unreadRows(page)).includes('m07'), `${tag}: where it is no longer unread`);
    ok(await text(page, '#view-template .bell .bell-n') === '2', `${tag}: the bell says 2`, await text(page, '#view-template .bell .bell-n'));

    ok(errors.length === 0, `${tag}: no page errors`, errors);
    await ctx.close();
  }

  ok(rec.outside.length === 0, 'nothing reached outside', rec.outside);
  await browser.close();
  await s.close();
  done();
})().catch(crash);
