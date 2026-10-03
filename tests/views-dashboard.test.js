// The Dashboard, for a list made up so every number on it is known: the four
// tiles and what is written under them, the pipeline, both channel funnels,
// the Sales IQ and Onboarding docs trackers, the Candidate updates feed (its
// folding, its channel chips and where its rows lead), the tiles' detail
// lists (who is due a follow-up), and the follow-up counts the Email page
// and Settings show — on a laptop and on a phone. Also: a status changed from
// a tile's list moves every number, one the server refuses moves none, and a
// poll that brings a change (or none) is drawn.
const { startApp, launch, ok, done, crash, ago, R } = require('./helpers');
const { stubEverything, open, text, texts, cells, waitIn, waitText, settle, same, until, poke, go, stored, byId, person } = require('./views-helpers');

const DAY = 1440;
const soon = (days) => new Date(Date.now() + days * 86400000).toISOString();

function list() {
  return [
    person('d01', 'Ava Newman', { phone: '(617) 555-0101' }),
    person('d02', 'Ben Nobody'),
    person('d03', 'Cal Texted', { phone: '(617) 555-0203', textStatus: 'delivered', lastTextedAt: ago(600), textDeliveredAt: ago(590) }),
    // Emailed five days ago, never followed up: due (the default is 3 days, at most 2 follow-ups).
    person('d04', 'Dee Due', { status: 'emailed', lastEmailedAt: ago(5 * DAY), followUpCount: 0, gmailThreadId: 'th-d04', lastSubject: 'Quick question' }),
    // Emailed yesterday: not due yet.
    person('d05', 'Eli Fresh', { status: 'emailed', lastEmailedAt: ago(DAY), openedAt: ago(12 * 60), gmailThreadId: 'th-d05' }),
    // Followed up twice already: never due again.
    person('d06', 'Fay Maxed', { status: 'emailed', lastEmailedAt: ago(10 * DAY), followUpCount: 2, openedAt: ago(9 * DAY), gmailThreadId: 'th-d06' }),
    person('d07', 'Gus Due', { status: 'emailed', lastEmailedAt: ago(4 * DAY), followUpCount: 1, gmailThreadId: 'th-d07' }),
    person('d08', 'Hal Replied', {
      status: 'replied', lastEmailedAt: ago(3 * DAY), openedAt: ago(2 * DAY), gmailThreadId: 'th-d08',
      replies: [{ id: 'r-d08', date: ago(DAY), text: 'Yes, I am interested. Call me Tuesday.', kind: null }], lastReplyAt: ago(DAY), repliedAt: ago(DAY),
    }),
    person('d09', 'Ivy Booked', {
      status: 'booked', lastEmailedAt: ago(6 * DAY), openedAt: ago(5 * DAY), gmailThreadId: 'th-d09',
      replies: [{ id: 'r-d09', date: ago(5 * DAY), text: 'Booked a time.', kind: null }], lastReplyAt: ago(5 * DAY),
      bookedAt: soon(2), bookedEvent: 'Intro call',
    }),
    person('d10', 'Jo Bounced', { status: 'bounced', lastEmailedAt: ago(2 * DAY), gmailThreadId: 'th-d10', replies: [{ id: 'r-d10', date: ago(2 * DAY - 5), text: 'Delivery Status Notification (Failure)', kind: 'bounce' }] }),
    person('d11', 'Kim Declined', {
      status: 'declined', lastEmailedAt: ago(8 * DAY), openedAt: ago(7 * DAY), gmailThreadId: 'th-d11',
      replies: [{ id: 'r-d11', date: ago(7 * DAY), text: 'No thanks.', kind: null }], lastReplyAt: ago(7 * DAY),
    }),
    person('d12', 'Lou Texter', {
      phone: '(617) 555-0212', textStatus: 'replied', lastTextedAt: ago(2 * DAY), textRepliedAt: ago(DAY - 10),
      textThread: [{ dir: 'out', ts: ago(2 * DAY), text: 'Hi Lou, worth a quick call?' }, { dir: 'in', ts: ago(DAY - 10), text: 'Sure, call me' }],
    }),
    person('d13', 'Mo Noimessage', { phone: '(617) 555-0213', textStatus: 'not-imessage', lastTextedAt: ago(3 * DAY) }),
    person('d14', 'Nia Reader', { phone: '(617) 555-0214', textStatus: 'read', lastTextedAt: ago(DAY), textReadAt: ago(DAY - 30) }),
    // Booked from a text: counts as booked, not in the email funnel.
    person('d15', 'Oz Booker', { status: 'booked', bookedAt: soon(3), phone: '(617) 555-0215', textStatus: 'replied', lastTextedAt: ago(4 * DAY), textRepliedAt: ago(3 * DAY) }),
  ];
}

const ev = (id, type, message, candidateId, minutesAgo) => ({ id, type, message, candidateId, ts: ago(minutesAgo) });
function events() {
  return [
    ev('e1', 'replied', 'Hal Replied replied: “Yes, I am interested. Call me Tuesday.”', 'd08', DAY),
    ev('e2', 'text-replied', 'Lou Texter replied to your text: “Sure, call me”', 'd12', DAY - 10),
    ev('e3', 'booked', 'Ivy Booked booked an interview.', 'd09', 120),
    ev('e4', 'opened', 'Eli Fresh opened your email.', 'd05', 30),
    ev('e5', 'opened', 'Fay Maxed opened your email.', 'd06', 31),
    ev('e6', 'opened', 'Kim Declined opened your email.', 'd11', 32),
    ev('e7', 'text-read', 'Nia Reader read your text.', 'd14', 20 * 60),
  ];
}

const funnelRows = (page, sel) => page.evaluate((q) => [...document.querySelectorAll(`${q} .funnel-row`)].map((r) =>
  [r.querySelector('.funnel-label').textContent.trim(), r.querySelector('.funnel-n').textContent.trim(), r.querySelector('.funnel-pct').textContent.trim()].join(' ').trim()), sel);

(async () => {
  const s = await startApp({ offset: 120 });
  const rec = stubEverything();
  await s.store.update((d) => { d.candidates = list(); d.events = events(); });
  const salesiq = require(R('lib/salesiq.js'));
  const onboarding = require(R('lib/onboarding.js'));
  await salesiq.update((doc) => {
    doc.candidates = [
      { id: 'cq1', name: 'Hal Replied', email: 'hal.replied@example.com', status: 'completed', score: 91, added: ago(3 * DAY) },
      { id: 'cq2', name: 'Ivy Booked', email: 'ivy.booked@example.com', status: 'completed', score: 72, added: ago(3 * DAY) },
      { id: 'cq3', name: 'Eli Fresh', email: 'eli.fresh@example.com', status: 'invited', added: ago(2 * DAY) },
      { id: 'cq4', name: 'Dee Due', email: 'dee.due@example.com', status: 'added', added: ago(DAY) },
      { id: 'cq5', name: 'Gus Due', email: 'gus.due@example.com', status: 'added', added: ago(DAY) },
    ];
  });
  const hire = (id, name, email, crmId) => ({ id, local: true, appliedDate: '2026-09-01', startDate: '', applicant: { firstName: name.split(' ')[0], lastName: name.split(' ')[1], email, phoneNumber: '' }, job: { title: { label: 'Account Executive' } }, status: { id: 'local', label: 'Added' }, crmId });
  await onboarding.update((doc) => {
    doc.candidates = [hire('hire-1', 'Ivy Booked', 'ivy.booked@example.com', 'd09'), hire('hire-2', 'Oz Booker', 'oz.booker@example.com', 'd15'), hire('hire-3', 'Hal Replied', 'hal.replied@example.com', 'd08')];
    doc.sends = [{ id: 'oz.booker@example.com', email: 'oz.booker@example.com', sentAt: ago(DAY) }, { id: 'ivy.booked@example.com', email: 'ivy.booked@example.com', sentAt: ago(2 * DAY) }];
    doc.hires = [{ id: 'WPI-T1', reference: 'WPI-T1', email: 'ivy.booked@example.com', firstName: 'Ivy', lastName: 'Booked', signedAt: ago(600), signedDate: '2026-10-02', files: [] }];
  });

  const browser = await launch();
  for (const phone of [false, true]) {
    const tag = phone ? 'phone' : 'laptop';
    await s.store.update((d) => { d.candidates = list(); d.events = events(); });
    const { ctx, page, errors } = await open(browser, s, { phone });

    // Each number is read once the page shows it (or after 5 s, to report
    // what it shows instead), so a page that draws a moment later still passes.
    const see = async (sel, want, msg) => { const got = await settle(() => text(page, sel), want); ok(got === want, `${tag}: ${msg} (${sel} reads "${want}")`, got); return got; };
    const seeAll = async (get, want, msg) => { const got = await settle(get, want); ok(same(got, want), `${tag}: ${msg}`, got); return got; };

    // ---- the four tiles ----
    await see('#statTotal', '15', 'Candidates tile counts everyone');
    await see('#statEmailed', '13', 'Contacted counts anyone emailed or texted');
    await see('#statContactedSplit', '8 emailed · 5 texted', 'Contacted splits into emailed and texted');
    await see('#statReplied', '5', 'Replied counts a real reply on either channel (a bounce is not one)');
    await see('#statRepliedSplit', '2 by text', 'Replied says how many by text');
    await see('#statBooked', '2', 'Interviews booked without Calendly is everyone marked Booked');
    await see('#statBookedSplit', '', 'and says nothing under it');

    // ---- pipeline ----
    await seeAll(() => texts(page, '#pipeline .pipe-row'), ['Not contacted 6', 'Emailed 4', 'Replied 1', 'Booked 2', 'Not interested 1', 'Bounced 1'], 'pipeline counts each status');

    // ---- channels: every row a subset of the one above, as a share of Sent ----
    await seeAll(() => funnelRows(page, '#emailFunnel'), ['Sent 8', 'Opened 5 63%', 'Replied 3 38%', 'Booked 1 13%', 'Bounced 1 13%'],
      'email funnel (booked counts only the emailed booking)');
    await seeAll(() => funnelRows(page, '#textFunnel'), ['Sent 5', 'Delivered 4 80%', 'Read 3 60%', 'Replied 2 40%', 'No iMessage 1 20%'],
      'texting funnel (No iMessage counts inside Sent)');
    await see('#chTextRelay', 'Mac offline', 'the relay chip says the Mac is offline');
    const today = await settle(async () => { const c = await cells(page, '#textToday .today-cell'); return [c.length, c[2], c[3]]; }, [4, '0 Waiting in the queue', '2 Replied to a text']);
    ok(same(today, [4, '0 Waiting in the queue', '2 Replied to a text']), `${tag}: Texting today`, today);
    ok(/offline/.test(await text(page, '#textTodayNote')), `${tag}: Texting today says nothing sends while the Mac is offline`, await text(page, '#textTodayNote'));

    // ---- trackers ----
    await seeAll(() => cells(page, '#iqTrackerGrid .today-cell'), ['5 On Sales IQ', '2 Not sent', '1 Awaiting results', '2 Completed'], 'Sales IQ tracker');
    await seeAll(() => texts(page, '#iqTrackerTiers .tier-pill'), ['Elite 1', 'Strong 1'], 'Sales IQ tiers list only the tiers someone is in');
    await seeAll(() => cells(page, '#onbTrackerGrid .today-cell'), ['3 On the pipeline', '1 Packet not sent', '1 Awaiting signature', '1 Signed'], 'Onboarding docs tracker (signed is not also awaiting)');

    // ---- Candidate updates ----
    const FEED = [
      'Eli Fresh and 2 others opened your email.',
      'Ivy Booked booked an interview.',
      'Nia Reader read your text.',
      'Lou Texter replied to your text: “Sure, call me”',
      'Hal Replied replied: “Yes, I am interested. Call me Tuesday.”',
    ];
    const feedNow = () => texts(page, '#activityList .act-msg');
    await seeAll(feedNow, FEED, 'the feed is newest first and a run of opens is one line');
    await seeAll(() => texts(page, '#feedFilters .feed-chip'), ['All7', 'Email4', 'Texting2'], "feed chips count each channel's own updates");
    await page.click('#feedFilters [data-feed="text"]');
    await seeAll(feedNow, ['Ivy Booked booked an interview.', 'Nia Reader read your text.', 'Lou Texter replied to your text: “Sure, call me”'],
      'the Texting chip shows texting news and bookings');
    await page.click('#feedFilters [data-feed="email"]');
    await seeAll(feedNow, [FEED[0], FEED[1], FEED[4]], 'the Email chip shows email news and bookings');
    await page.click('#feedFilters [data-feed="all"]');
    await seeAll(feedNow, FEED, 'All shows everything again');

    // A reply in the feed opens that conversation.
    await page.click('#activityList [data-feed-to="email"]');
    ok(await waitText(page, '#mailName', 'Hal Replied'), `${tag}: an email reply in the feed opens that email conversation`, await text(page, '#mailName'));
    ok(await page.evaluate(() => Boolean(document.querySelector('#view-template.active'))), `${tag}: on the Email page`);
    await go(page, 'dashboard');
    await page.click('#activityList [data-feed-to="text"][data-feed-open="d12"]');
    ok(await waitText(page, '#threadName', 'Lou Texter'), `${tag}: a text reply in the feed opens that text conversation`, await text(page, '#threadName'));
    ok(await waitText(page, '#threadBody', /Sure, call me/), `${tag}: with its messages`, await text(page, '#threadBody'));
    await go(page, 'dashboard');

    // ---- the tiles open their lists ----
    await page.click('.stat-card[data-tile="emailed"]');
    await page.waitForSelector('#tileModal:not([hidden])');
    ok(await waitText(page, '#tileTitle', 'Emailed · awaiting a reply (4)'), `${tag}: Contacted opens everyone emailed and waiting`, await text(page, '#tileTitle'));
    await seeAll(() => texts(page, '#tileList .tile-name'), ['Eli Fresh', 'Gus Due', 'Dee Due', 'Fay Maxed'], 'most recently emailed first');
    const dueRows = await page.evaluate(() => [...document.querySelectorAll('#tileList .tile-row')].filter((r) => r.querySelector('.due-tag')).map((r) => r.querySelector('.tile-name').textContent.trim()));
    ok(JSON.stringify(dueRows) === JSON.stringify(['Gus Due', 'Dee Due']), `${tag}: due a follow-up: emailed 3+ days ago and under the limit`, dueRows);
    ok(/Follow up with 2/.test(await text(page, '#tileActions')), `${tag}: and offers to follow up with exactly them`, await text(page, '#tileActions'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#tileModal', { state: 'hidden' });

    await page.click('.stat-card[data-tile="replied"]');
    await page.waitForSelector('#tileModal:not([hidden])');
    ok(await waitText(page, '#tileTitle', 'Replied (1)'), `${tag}: Replied opens the people at Replied`, await text(page, '#tileTitle'));
    ok(await text(page, '#tileList .reply-quote') === 'Yes, I am interested. Call me Tuesday.', `${tag}: with what they wrote`, await text(page, '#tileList .reply-quote'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#tileModal', { state: 'hidden' });

    await page.click('.stat-card[data-tile="booked"]');
    await page.waitForSelector('#tileModal:not([hidden])');
    ok(await waitText(page, '#tileTitle', 'Interviews booked (2)'), `${tag}: Interviews booked opens everyone booked`, await text(page, '#tileTitle'));
    await seeAll(() => texts(page, '#tileList .tile-name'), ['Ivy Booked', 'Oz Booker'], 'both of them');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#tileModal', { state: 'hidden' });

    // Checked before any tracker is used: today a tracker's Sales IQ or
    // Onboarding filter is still applied when the Candidates tile is pressed
    // afterwards ("1 of 15") — reported, not pinned.
    await page.click('.stat-card[data-tile="all"]');
    ok(await waitText(page, '#candCount', '15 candidates'), `${tag}: the Candidates tile opens the whole list`, await text(page, '#candCount'));
    await go(page, 'dashboard');

    // A tracker number opens Candidates filtered to exactly those people.
    const listed = () => page.evaluate(() => [...document.querySelectorAll('#candidateRows tr[data-id]')].map((r) => r.dataset.id).sort());
    await page.click('#iqTrackerGrid .tracker-cell:nth-child(4)');
    ok(await waitText(page, '#candCount', '2 of 15'), `${tag}: Sales IQ Completed opens Candidates filtered to them`, await text(page, '#candCount'));
    await seeAll(listed, ['d08', 'd09'], 'Hal and Ivy');
    await go(page, 'dashboard');
    await page.click('#onbTrackerGrid .tracker-cell:nth-child(3)');
    ok(await waitText(page, '#candCount', '1 of 15'), `${tag}: Onboarding Awaiting signature opens Candidates filtered`, await text(page, '#candCount'));
    await seeAll(listed, ['d15'], 'just Oz');

    // ---- the follow-up and send buttons elsewhere ----
    await go(page, 'template');
    await see('#emailFollowUpBtn', 'Follow up with 2', 'Email page offers the 2 follow-ups');
    await see('#emailAllBtn', 'Email all 6 not contacted', 'and the 6 never contacted');
    await go(page, 'settings');
    await see('#followUpDueBadge', '2 due', 'Settings says 2 are due');
    await go(page, 'dashboard');

    // ---- a status changed from a tile's list moves every number ----
    await page.click('.stat-card[data-tile="emailed"]');
    await page.waitForSelector('#tileModal:not([hidden])');
    await page.selectOption('#tileList .tile-status[data-id="d04"]', 'replied');
    ok(await until(async () => byId(await stored(s), 'd04').status === 'replied'), `${tag}: changing a status in the list saves it on the server`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#tileModal', { state: 'hidden' });
    ok(await waitText(page, '#statReplied', '6'), `${tag}: Replied goes up`, await text(page, '#statReplied'));
    await seeAll(() => texts(page, '#pipeline .pipe-row'), ['Not contacted 6', 'Emailed 3', 'Replied 2', 'Booked 2', 'Not interested 1', 'Bounced 1'], 'the pipeline moves: one from Emailed to Replied');
    await go(page, 'template');
    ok(await waitText(page, '#emailFollowUpBtn', 'Follow up with 1'), `${tag}: and someone who replied is no longer due a follow-up`, await text(page, '#emailFollowUpBtn'));
    await go(page, 'dashboard');

    // ---- a poll that brings a booking ----
    await s.store.update((d) => {
      const c = d.candidates.find((x) => x.id === 'd01');
      c.status = 'booked'; c.bookedAt = soon(1);
      d.events.unshift({ id: 'e9', type: 'booked', message: 'Ava Newman booked an interview.', candidateId: 'd01', ts: new Date().toISOString() });
    });
    await poke(page);
    ok(await waitText(page, '#statBooked', '3'), `${tag}: a booking that arrives shows on the next look`, await text(page, '#statBooked'));
    ok(await waitIn(page, () => (document.querySelector('#activityList .act-msg') || {}).textContent === 'Ava Newman booked an interview.'), `${tag}: at the top of the feed`, (await texts(page, '#activityList .act-msg'))[0]);
    await seeAll(() => texts(page, '#pipeline .pipe-row'), ['Not contacted 5', 'Emailed 3', 'Replied 2', 'Booked 3', 'Not interested 1', 'Bounced 1'], 'and out of Not contacted into Booked');

    // ---- a poll that brings nothing new leaves everything as it was ----
    const before = { tiles: await texts(page, '.stat-card .stat-value'), pipe: await texts(page, '#pipeline .pipe-row'), feed: await feedNow() };
    await poke(page);
    await poke(page, 'visibilitychange');
    const after = { tiles: await texts(page, '.stat-card .stat-value'), pipe: await texts(page, '#pipeline .pipe-row'), feed: await feedNow() };
    ok(before.tiles.length === 4 && same(before, after), `${tag}: a look that finds nothing new leaves every number and the feed on screen`, { before, after });
    ok(!(await texts(page, '.toast')).some((t) => /Couldn|fail/i.test(t)), `${tag}: and says nothing went wrong`, await texts(page, '.toast'));

    // ---- a status change the server refuses moves nothing ----
    // Gus was removed on another device a moment ago; this page still lists
    // him. Marking him Replied cannot be saved, the page says so, and the
    // Replied tile does not count him.
    await page.click('.stat-card[data-tile="emailed"]');
    await page.waitForSelector('#tileModal:not([hidden])');
    await s.store.update((d) => { s.store.removeCandidate(d, 'd07'); });
    await page.selectOption('#tileList .tile-status[data-id="d07"]', 'replied');
    ok(await waitIn(page, () => [...document.querySelectorAll('.toast')].some((t) => /not found/i.test(t.textContent))), `${tag}: a change the server refuses says so`, await texts(page, '.toast'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#tileModal', { state: 'hidden' });
    await page.waitForTimeout(300);
    ok(await text(page, '#statReplied') === '6', `${tag}: and does not count as a reply`, await text(page, '#statReplied'));
    ok(!(await stored(s)).candidates.some((c) => c.id === 'd07'), `${tag}: nor bring him back on the server`);
    // ...and the next look takes him off every number.
    await poke(page);
    ok(await waitText(page, '#statTotal', '14'), `${tag}: someone removed elsewhere leaves the Candidates count on the next look`, await text(page, '#statTotal'));
    await seeAll(() => texts(page, '#pipeline .pipe-row'), ['Not contacted 5', 'Emailed 2', 'Replied 2', 'Booked 3', 'Not interested 1', 'Bounced 1'], 'and the pipeline');
    await go(page, 'template');
    ok(await waitText(page, '#emailFollowUpBtn', 'No follow-ups due') && await page.isDisabled('#emailFollowUpBtn'), `${tag}: and nobody is left due a follow-up`, await text(page, '#emailFollowUpBtn'));
    await go(page, 'settings');
    await see('#followUpDueBadge', 'nobody due', 'Settings says nobody is due');
    await go(page, 'dashboard');

    ok(errors.length === 0, `${tag}: no page errors`, errors);
    await ctx.close();
  }

  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await browser.close();
  await s.close();
  done();
})().catch(crash);
