// The bell, on a laptop (a popover) and on a phone (a sheet): one count for
// both channels, the unread listed under New (one entry per conversation, a
// person who answered both ways twice), the last week's read ones under
// Earlier (five at most), opening an entry goes to that conversation and
// reads it, and Mark all read reads exactly what was listed — a reply that
// lands meanwhile stays news, lights the bell again and rings it. It does
// not ring when the page opens with unread already waiting.
const { startApp, launch, ok, done, crash, ago } = require('./helpers');
const { stubEverything, open, quiet, text, texts, waitIn, waitText, settle, same, until, poke, stored, byId, person } = require('./views-helpers');

const DAY = 1440;
function people() {
  const out = [
    person('b1', 'Bell Texter', { phone: '(617) 555-0221', lastTextedAt: ago(60), textStatus: 'replied', textUnread: true,
      textThread: [{ dir: 'out', ts: ago(60), text: 'Hi, worth a call?' }, { dir: 'in', ts: ago(5), text: 'Can we talk?' }] }),
    person('b2', 'Bell Emailer', { status: 'replied', lastEmailedAt: ago(2000), gmailThreadId: 'th-b2', lastSubject: 'Quick question', emailUnread: true,
      replies: [{ id: 'r-b2', date: ago(10), text: 'Interested! Tell me more.', kind: null }], lastReplyAt: ago(10) }),
    person('b3', 'Bell Both', { phone: '(617) 555-0223', status: 'replied', lastEmailedAt: ago(3000), gmailThreadId: 'th-b3', lastSubject: 'Quick question',
      lastTextedAt: ago(100), textStatus: 'replied', textUnread: true, emailUnread: true,
      textThread: [{ dir: 'out', ts: ago(100), text: 'Hi, worth a call?' }, { dir: 'in', ts: ago(15), text: 'Text from both' }],
      replies: [{ id: 'r-b3', date: ago(20), text: 'Email from both', kind: null }], lastReplyAt: ago(20) }),
    // Read more than a week ago: not listed at all.
    person('b5', 'Bell Ancient', { status: 'replied', lastEmailedAt: ago(12 * DAY), gmailThreadId: 'th-b5',
      replies: [{ id: 'r-b5', date: ago(10 * DAY), text: 'Old news', kind: null }], lastReplyAt: ago(10 * DAY) }),
  ];
  // Six read this week: only the newest five are listed under Earlier.
  for (let k = 1; k <= 6; k++) {
    out.push(person(`e${k}`, `Earlier Person${k}`, { phone: `(617) 555-023${k}`, lastTextedAt: ago(k * DAY + 60), textStatus: 'replied',
      textThread: [{ dir: 'out', ts: ago(k * DAY + 60), text: 'Hi' }, { dir: 'in', ts: ago(k * DAY), text: `Earlier reply ${k}` }] }));
  }
  return out;
}

// Counts every time a bell starts ringing.
const RING_WATCH = () => {
  window.__rings = 0;
  new MutationObserver((muts) => {
    for (const m of muts) if (m.target.classList && m.target.classList.contains('bell') && m.target.classList.contains('ring') && !(m.oldValue || '').includes('ring')) window.__rings++;
  }).observe(document, { attributes: true, attributeOldValue: true, subtree: true, attributeFilter: ['class'] });
};

(async () => {
  const s = await startApp({ offset: 135 });
  const rec = stubEverything();
  const seed = async () => {
    await s.store.update((d) => { d.candidates = people(); d.events = []; });
    rec.threads = {
      'th-b2': [{ dir: 'out', date: ago(2000), text: 'Hi Bell, open to a new role?' }, { dir: 'in', date: ago(10), text: 'Interested! Tell me more.' }],
      'th-b3': [{ dir: 'out', date: ago(3000), text: 'Hi Bell, open to a new role?' }, { dir: 'in', date: ago(20), text: 'Email from both' }],
    };
  };
  const panelRows = (page, sec) => page.evaluate((which) => {
    const out = [];
    let cur = '';
    for (const el of document.querySelector('#bellBody').children) {
      if (el.classList.contains('bell-sec')) { cur = el.textContent.trim(); continue; }
      if (cur === which && el.classList.contains('bell-row')) out.push(`${el.querySelector('.bell-name').textContent.trim()} | ${el.querySelector('.bell-text').textContent.trim()} | ${el.querySelector('.act-tag').textContent.trim()}`);
    }
    return out;
  }, sec);
  const bellN = (page) => page.evaluate(() => {
    const b = [...document.querySelectorAll('.bell')].find((x) => x.getClientRects().length);
    const n = b && b.querySelector('.bell-n');
    return n && !n.hidden ? n.textContent : '';
  });
  const openBell = async (page) => {
    await page.evaluate(() => [...document.querySelectorAll('.bell')].find((x) => x.getClientRects().length).click());
    await page.waitForSelector('#bellPanel:not([hidden])');
  };

  const browser = await launch();

  // ================= laptop =================
  await seed();
  {
    const tag = 'laptop';
    const { ctx, page, errors } = await open(browser, s, { init: RING_WATCH });
    ok(await settle(() => bellN(page), '4') === '4', `${tag}: the bell counts unread on both channels`, await bellN(page));
    ok(await page.evaluate(() => document.querySelector('.bell').classList.contains('lit')), `${tag}: and is lit`);
    ok(await page.evaluate(() => window.__rings) === 0, `${tag}: opening the app with unread waiting does not ring it`);

    await openBell(page);
    const NEW = [
      'Bell Texter | Can we talk? | Text', 'Bell Emailer | Interested! Tell me more. | Email',
      'Bell Both | Text from both | Text', 'Bell Both | Email from both | Email',
    ];
    const fresh = await settle(() => panelRows(page, 'New'), NEW);
    ok(same(fresh, NEW), `${tag}: New lists each unread conversation, newest first, one per channel`, fresh);
    const EARLIER = [1, 2, 3, 4, 5].map((k) => `Earlier Person${k} | Earlier reply ${k} | Text`);
    const earlier = await settle(() => panelRows(page, 'Earlier'), EARLIER);
    ok(same(earlier, EARLIER), `${tag}: Earlier: the newest five read this week, nothing older`, earlier);
    ok(!(await page.isHidden('#bellClear')), `${tag}: Mark all read is offered`);

    // Opening an email entry: the Email page, that conversation, read.
    await page.click('#bellBody .bell-row[data-bell-open="b2"][data-bell-ch="email"]');
    ok(await waitIn(page, () => document.querySelector('#bellPanel').hidden), `${tag}: the panel closes`);
    ok(await waitText(page, '#mailName', 'Bell Emailer'), `${tag}: an email entry opens that email conversation`, await text(page, '#mailName'));
    ok(await page.evaluate(() => Boolean(document.querySelector('#view-template.active'))), `${tag}: on the Email page`);
    ok(await waitIn(page, () => /Interested! Tell me more/.test(document.querySelector('#mailBody').textContent)), `${tag}: showing the conversation`);
    ok(await waitIn(page, () => [...document.querySelectorAll('.bell')].find((x) => x.getClientRects().length).querySelector('.bell-n').textContent === '3'), `${tag}: the bell drops to 3`, await bellN(page));
    ok(await until(async () => byId(await stored(s), 'b2').emailUnread === false), `${tag}: read on the server`);

    // And a text entry: Texting, that conversation.
    await openBell(page);
    await page.click('#bellBody .bell-row[data-bell-open="b1"][data-bell-ch="text"]');
    ok(await waitText(page, '#threadName', 'Bell Texter'), `${tag}: a text entry opens that text conversation`, await text(page, '#threadName'));
    ok(await page.evaluate(() => Boolean(document.querySelector('#view-texting.active'))), `${tag}: on the Texting page`);
    ok(await waitIn(page, () => /Can we talk\?/.test(document.querySelector('#threadBody').textContent)), `${tag}: with its messages`);
    ok(await until(async () => (await bellN(page)) === '2'), `${tag}: the bell drops to 2`, await bellN(page));
    ok(await until(async () => byId(await stored(s), 'b1').textUnread === false), `${tag}: read on the server`);

    // Mark all read reads what was listed — not a reply that came in meanwhile.
    await page.evaluate(() => document.querySelector('.nav-item[data-view="dashboard"]').click());
    await openBell(page);
    const left = ['Bell Both | Text from both | Text', 'Bell Both | Email from both | Email'];
    ok(same(await settle(() => panelRows(page, 'New'), left), left), `${tag}: what is left unread`, await panelRows(page, 'New'));
    await s.store.update((d) => {
      const c = d.candidates.find((x) => x.id === 'b3');
      c.textThread.push({ dir: 'in', ts: new Date().toISOString(), text: 'Are you there?' });
      c.textUnread = true;
    });
    await page.click('#bellClear');
    ok(await until(async () => (await bellN(page)) === ''), `${tag}: Mark all read clears the count at once`, await bellN(page));
    ok(await until(async () => byId(await stored(s), 'b3').emailUnread === false), `${tag}: the email is read on the server`);
    // Once the page has finished telling the server, the text that landed
    // after the list was drawn is still unread there.
    ok(await quiet(page), `${tag}: (the page has finished telling the server)`);
    ok(byId(await stored(s), 'b3').textUnread === true, `${tag}: a text that landed after the list was drawn stays unread`);
    await page.keyboard.press('Escape');
    const rings = await page.evaluate(() => window.__rings);
    await poke(page);
    ok(await until(async () => (await bellN(page)) === '1'), `${tag}: and lights the bell again on the next look`, await bellN(page));
    ok(await page.evaluate(() => window.__rings) > rings, `${tag}: ringing it, since it is news`);
    await openBell(page);
    ok(same(await settle(() => panelRows(page, 'New'), ['Bell Both | Are you there? | Text']), ['Bell Both | Are you there? | Text']), `${tag}: listed with the new message`, await panelRows(page, 'New'));
    await page.click('#bellBody .bell-row[data-bell-open="b3"][data-bell-ch="text"]');
    ok(await waitText(page, '#threadName', 'Bell Both'), `${tag}: opening it goes there`);
    ok(await until(async () => (await bellN(page)) === ''), `${tag}: and the bell is dark`, await bellN(page));
    ok(await until(async () => byId(await stored(s), 'b3').textUnread === false), `${tag}: read on the server`);
    const ringsSoFar = await page.evaluate(() => window.__rings);
    await poke(page);
    ok(await page.evaluate(() => window.__rings) === ringsSoFar, `${tag}: nothing new, no ring`);
    await openBell(page);
    ok((await settle(async () => (await panelRows(page, 'New')).length, 0)) === 0 && await page.isHidden('#bellClear'), `${tag}: nothing under New, no Mark all read`, await panelRows(page, 'New'));
    // Clicking elsewhere puts it away.
    await page.click('.view.active .page-head h1');
    ok(await waitIn(page, () => document.querySelector('#bellPanel').hidden), `${tag}: a click elsewhere closes the panel`);

    ok(errors.length === 0, `${tag}: no page errors`, errors);
    await ctx.close();
  }

  // ================= phone =================
  await seed();
  {
    const tag = 'phone';
    const { ctx, page, errors } = await open(browser, s, { phone: true });
    ok(await settle(() => bellN(page), '4') === '4', `${tag}: the bell counts both channels`, await bellN(page));
    ok(await text(page, '#navInboxCount') === '4', `${tag}: and the Inbox tab counts both too`, await text(page, '#navInboxCount'));
    await openBell(page);
    ok(await page.isVisible('#bellBackdrop'), `${tag}: the panel is a sheet over a dimmed page`);
    ok((await settle(async () => (await panelRows(page, 'New')).length, 4)) === 4, `${tag}: listing the four unread`, await panelRows(page, 'New'));
    await page.click('#bellClose');
    ok(await waitIn(page, () => document.querySelector('#bellPanel').hidden && document.querySelector('#bellBackdrop').hidden), `${tag}: the close button puts it away`);

    await openBell(page);
    await page.click('#bellBody .bell-row[data-bell-open="b3"][data-bell-ch="email"]');
    ok(await waitText(page, '#mailName', 'Bell Both'), `${tag}: an entry opens its conversation`, await text(page, '#mailName'));
    ok(await waitIn(page, () => document.querySelector('#view-template .messenger').classList.contains('thread-open')), `${tag}: as its own screen`);
    ok(await until(async () => (await bellN(page)) === '3'), `${tag}: the bell drops to 3`, await bellN(page));
    ok(await until(async () => byId(await stored(s), 'b3').emailUnread === false && byId(await stored(s), 'b3').textUnread === true), `${tag}: only that channel is read`);

    // From inside one conversation, the bell opens another in its place.
    await openBell(page);
    await page.click('#bellBody .bell-row[data-bell-open="b1"][data-bell-ch="text"]');
    ok(await waitText(page, '#threadName', 'Bell Texter'), `${tag}: from a conversation, the bell goes to another`, await text(page, '#threadName'));
    ok(await waitIn(page, () => document.querySelector('#view-texting .messenger').classList.contains('thread-open')), `${tag}: shown as its own screen`);
    await page.click('#view-texting .thread-back');
    ok(await waitIn(page, () => !document.querySelector('#view-texting .messenger').classList.contains('thread-open')), `${tag}: one Back returns to the list`);

    await openBell(page);
    await page.click('#bellClear');
    ok(await until(async () => (await bellN(page)) === ''), `${tag}: Mark all read clears the count`, await bellN(page));
    ok(await until(async () => { const st = await stored(s); return st.candidates.every((c) => !c.textUnread && !c.emailUnread); }), `${tag}: everything is read on the server`);
    ok(await text(page, '#navInboxCount') === '', `${tag}: the Inbox tab has no count`, await text(page, '#navInboxCount'));

    ok(errors.length === 0, `${tag}: no page errors`, errors);
    await ctx.close();
  }

  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await browser.close();
  await s.close();
  done();
})().catch(crash);
