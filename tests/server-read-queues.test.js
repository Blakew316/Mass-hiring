// GET /api/state for a small crafted list: who is texted first and why, who
// cannot be texted and why, who is due a follow-up email, and what the email
// and text queues report (counts, pace, pauses, failures, the Mac relay).
const { startApp, R, ok, done, crash } = require('./helpers');
const { guardOutside, stubSenders, getState, ago, daysAgo } = require('./server-read-helpers');

(async () => {
  const refused = guardOutside();
  const s = await startApp({ offset: 1 });
  const sent = stubSenders();
  const storage = require(R('lib/storage.js'));
  const textQueue = require(R('lib/text-queue.js'));

  // ---------- who to text first ----------
  const base = { addedAt: daysAgo(30), source: 'csv' };
  const people = [
    { ...base, id: 'pay', name: 'Avery Payments', email: 'avery@example.com', phone: '(617) 555-2301', role: 'Merchant Services Sales Rep', company: 'Acme Payments', status: 'emailed', lastEmailedAt: daysAgo(10), openedAt: daysAgo(5) },
    { ...base, id: 'bnc', name: 'Blair Bounce', email: 'blair@example.com', phone: '(617) 555-2302', role: 'Solar Consultant', company: 'Sunny Co', status: 'bounced', lastEmailedAt: daysAgo(10) },
    { ...base, id: 'new', name: 'Casey New', email: 'casey@example.com', phone: '(617) 555-2303', role: 'Account Executive', company: 'Widgets Inc', status: 'new' },
    { ...base, id: 'vp', name: 'Drew Boss', email: 'drew@example.com', phone: '(617) 555-2304', role: 'Vice President of Sales', company: 'Widgets Inc', status: 'emailed', lastEmailedAt: daysAgo(10) },
    { ...base, id: 'dec', name: 'Eden Declined', email: 'eden@example.com', phone: '(617) 555-2305', role: 'Account Executive', status: 'declined', lastEmailedAt: daysAgo(10) },
    { ...base, id: 'rep', name: 'Finley Replied', email: 'finley@example.com', phone: '(617) 555-2306', role: 'Account Executive', status: 'replied', lastEmailedAt: daysAgo(10) },
    { ...base, id: 'nop', name: 'Gray Nophone', email: 'gray@example.com', phone: '', role: 'Account Executive', status: 'emailed', lastEmailedAt: daysAgo(10) },
    { ...base, id: 'fic', name: 'Harper Fiction', email: 'harper@example.com', phone: '(617) 555-0123', role: 'Account Executive', status: 'emailed', lastEmailedAt: daysAgo(10) },
    { ...base, id: 'opt', name: 'Indy Optout', email: 'indy@example.com', phone: '(617) 555-2309', role: 'Account Executive', status: 'emailed', lastEmailedAt: daysAgo(10) },
    { ...base, id: 'bkd', name: 'Jules Booked', email: 'jules@example.com', phone: '(617) 555-2310', role: 'Account Executive', status: 'booked', lastEmailedAt: daysAgo(10), bookedAt: daysAgo(1) },
    { ...base, id: 'txt', name: 'Kai Texted', email: 'kai@example.com', phone: '(617) 555-2311', role: 'Account Executive', status: 'emailed', lastEmailedAt: daysAgo(10), lastTextedAt: daysAgo(2) },
    { ...base, id: 'sft', name: 'Lane Softno', email: 'lane@example.com', phone: '(617) 555-2312', role: 'Account Executive', status: 'emailed', lastEmailedAt: daysAgo(10), notes: 'Said not interested on the phone' },
    { ...base, id: 'dup1', name: 'Morgan Twin', email: 'morgan1@example.com', phone: '617-555-2313', role: '', status: 'emailed', lastEmailedAt: daysAgo(10) },
    { ...base, id: 'dup2', name: 'Morgan Twin', email: 'morgan2@example.com', phone: '+1 617 555 2313', role: 'Outside Sales Rep', company: 'Copiers LLC', status: 'emailed', lastEmailedAt: daysAgo(10) },
    { ...base, id: 'nur', name: 'Nico Nurse', email: 'nico@example.com', phone: '(617) 555-2315', role: 'Registered Nurse', company: 'City Hospital', status: 'emailed', lastEmailedAt: daysAgo(10) },
    { ...base, id: 'uk', name: 'Oakley Abroad', email: 'oakley@example.com', phone: '+44 20 7946 0958', role: 'Account Executive', status: 'emailed', lastEmailedAt: daysAgo(10) },
    { ...base, id: 'txr', name: 'Pat Textreply', email: 'pat@example.com', phone: '(617) 555-2317', role: 'Account Executive', status: 'emailed', lastEmailedAt: daysAgo(10), textRepliedAt: daysAgo(1) },
  ];
  await s.store.update((d) => { d.candidates = people; });
  await textQueue.updateQ((q) => { textQueue.addOptOut(q, '(617) 555-2309'); });

  let S = (await getState(s)).body;
  const pr = S.texting.priority;
  const order = Object.entries(pr.order).sort((a, b) => a[1].rank - b[1].rank).map(([id]) => id);
  ok(order.join() === 'pay,bnc,dup2,new,vp', 'the textable are ranked best first', order);
  ok(pr.order.pay.rank === 1 && pr.order.pay.reason === 'opened your email in the last two weeks · in payments now', 'in payments now and opened recently comes first, and says why', pr.order.pay);
  ok(pr.order.bnc.reason === 'email bounced — a text is the only way to reach them · door-to-door closer', 'a bounced address is the strongest reason to text', pr.order.bnc);
  ok(pr.order.new.reason === 'B2B sales · not emailed yet — try the free channel first', 'someone not yet emailed is told to try email first, and ranks below the emailed', pr.order.new);
  ok(pr.order.vp.reason === 'runs a team — unlikely to move', 'a leader ranks last', pr.order.vp);
  ok(pr.order.dup2 && !pr.order.dup1 && !pr.blocked.dup1, 'two rows sharing a number are one person: only the fuller row is ranked', { dup1: pr.order.dup1, dup2: pr.order.dup2 });
  ok(Object.values(pr.order).every((o) => Object.keys(o).sort().join() === 'rank,reason'), 'each ranked person carries a rank and a reason', pr.order);
  const expectBlocked = {
    dec: 'marked not interested',
    rep: 'already replied — read it before texting',
    txr: 'already replied — read it before texting',
    fic: 'that number cannot be texted',
    opt: 'asked to stop',
    bkd: 'already booked in',
    txt: 'already texted',
    sft: 'said no without saying STOP',
    nur: 'no sales background',
    uk: 'outside North America',
  };
  ok(JSON.stringify(Object.keys(pr.blocked).sort()) === JSON.stringify(Object.keys(expectBlocked).sort())
    && Object.entries(expectBlocked).every(([id, why]) => pr.blocked[id] === why),
  'everyone who cannot be texted is listed with the reason (no phone at all is not listed)', pr.blocked);
  ok(S.texting.queue.optOut === 1, 'the opt-out count comes from the text queue', S.texting.queue.optOut);

  // A STOP from someone moves them out of the ranking on the next look.
  await textQueue.updateQ((q) => { textQueue.addOptOut(q, '+16175552301'); });
  S = (await getState(s)).body;
  ok(!S.texting.priority.order.pay && S.texting.priority.blocked.pay === 'asked to stop' && S.texting.priority.order.bnc.rank === 1,
    'once they ask to stop they are blocked and the next person moves up', S.texting.priority);

  // ---------- who is due a follow-up ----------
  const fu = [
    { id: 'f-due', name: 'Due Person', email: 'due@example.com', status: 'emailed', lastEmailedAt: daysAgo(4), followUpCount: 0, addedAt: daysAgo(30) },
    { id: 'f-due1', name: 'Due Once', email: 'due1@example.com', status: 'emailed', lastEmailedAt: daysAgo(8), followUpCount: 1, addedAt: daysAgo(30) },
    { id: 'f-recent', name: 'Recent Person', email: 'recent@example.com', status: 'emailed', lastEmailedAt: daysAgo(1), addedAt: daysAgo(30) },
    { id: 'f-max', name: 'Maxed Person', email: 'maxed@example.com', status: 'emailed', lastEmailedAt: daysAgo(10), followUpCount: 2, addedAt: daysAgo(30) },
    { id: 'f-replied', name: 'Replied Person', email: 'replied@example.com', status: 'replied', lastEmailedAt: daysAgo(10), addedAt: daysAgo(30) },
    { id: 'f-new', name: 'New Person', email: 'newp@example.com', status: 'new', addedAt: daysAgo(30) },
    { id: 'f-nodate', name: 'Nodate Person', email: 'nodate@example.com', status: 'emailed', addedAt: daysAgo(30) },
    { id: 'f-bounced', name: 'Bounced Person', email: 'bounced@example.com', status: 'bounced', lastEmailedAt: daysAgo(10), addedAt: daysAgo(30) },
  ];
  await s.store.update((d) => { d.candidates = [...d.candidates, ...fu]; });
  const fuIds = (st) => st.followUp.dueIds.filter((id) => id.startsWith('f-')).sort().join();
  S = (await getState(s)).body;
  ok(fuIds(S) === 'f-due,f-due1', 'due: emailed, never answered, 3+ days ago, fewer than 2 follow-ups', S.followUp.dueIds);
  ok(S.followUp.days === 3 && S.followUp.max === 2, 'the defaults are 3 days and 2 follow-ups', { days: S.followUp.days, max: S.followUp.max });

  await s.store.update((d) => { d.settings.followUpDays = '7'; });
  S = (await getState(s)).body;
  ok(fuIds(S) === 'f-due1' && S.followUp.days === 7, 'waiting 7 days leaves out the one emailed 4 days ago', { ids: S.followUp.dueIds, days: S.followUp.days });

  await s.store.update((d) => { d.settings.followUpDays = '7'; d.settings.maxFollowUps = '1'; });
  S = (await getState(s)).body;
  ok(fuIds(S) === '' && S.followUp.max === 1, 'one follow-up each leaves out someone already followed up once', { ids: S.followUp.dueIds, max: S.followUp.max });

  await s.store.update((d) => { d.settings.followUpDays = ''; d.settings.maxFollowUps = '0'; });
  S = (await getState(s)).body;
  ok(S.followUp.dueIds.length === 0 && S.followUp.max === 0 && S.followUp.days === 3, 'a deliberate 0 means no follow-ups at all; blank days means the default', S.followUp);

  await s.store.update((d) => { d.settings.followUpDays = '90'; d.settings.maxFollowUps = '9'; });
  S = (await getState(s)).body;
  ok(S.followUp.days === 30 && S.followUp.max === 5, 'out-of-range follow-up settings are honoured within 1-30 days and 0-5 follow-ups', { days: S.followUp.days, max: S.followUp.max });
  await s.store.update((d) => { d.settings.followUpDays = ''; d.settings.maxFollowUps = ''; });

  // ---------- the email queue ----------
  S = (await getState(s)).body;
  ok(S.queue.pending === 0 && S.queue.active === false && S.queue.sentToday === 0 && S.queue.remainingToday === S.queue.dailyLimit && S.queue.pausedUntil === null,
    'an empty email queue is idle', S.queue);
  const soon = new Date(Date.now() + 10 * 60000).toISOString();
  await storage.setJson('queue', {
    items: [{ id: 'e1', t: 'k' }, { id: 'e2', t: 'k' }, { id: 'e3', t: 'k', f: 1 }],
    templates: { k: { subject: 'Hi', body: 'Hello' } },
    failed: [
      { id: 'x1', email: 'fail1@example.com', error: 'Mailbox full', ts: ago(30) },
      { id: 'x2', email: 'fail2@example.com', error: 'Address not found', ts: ago(20) },
    ],
    sentLog: [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, email: `s${i}@example.com`, ts: ago(60 + i) })),
      { id: 'old', email: 'old@example.com', ts: ago(26 * 60) },
    ],
    total: 10, sent: 5, startedAt: ago(90),
    pausedUntil: soon, pauseKind: 'rate', note: 'Gmail asked us to slow down.',
  });
  S = (await getState(s)).body;
  const q = S.queue;
  ok(q.pending === 3 && q.active === true && q.total === 10 && q.sent === 5, 'a running campaign shows pending, total and sent', q);
  ok(q.sentToday === 5 && q.remainingToday === q.dailyLimit - 5, 'sent today counts the last 24 hours only', { sentToday: q.sentToday, remainingToday: q.remainingToday });
  ok(q.failed === 2 && q.failures.length === 2 && q.failures[1].email === 'fail2@example.com' && q.failures[1].error === 'Address not found', 'failures are listed with address and reason', q.failures);
  ok(q.pausedUntil === soon && q.pauseKind === 'rate' && q.note === 'Gmail asked us to slow down.', 'a pause still running is shown with why', q);
  ok(Boolean(q.windowFreesAt), 'when the 24-hour window next frees up is there', q);
  await storage.updateJson('queue', (raw) => ({ ...raw, pausedUntil: ago(1) }));
  S = (await getState(s)).body;
  ok(S.queue.pausedUntil === null && S.queue.pauseKind === '', 'a pause that has run out is not shown', S.queue);

  // ---------- the text queue and the Mac ----------
  S = (await getState(s)).body;
  ok(S.texting.queue.relay.online === false && S.texting.queue.relay.lastSeenAt === null, 'no relay has ever checked in', S.texting.queue.relay);
  await textQueue.updateQ((tq) => {
    tq.items.push({ id: 'bnc', phone: '+16175552302', t: 'tk', at: null }, { id: 'new', phone: '+16175552303', t: 'tk', at: null });
    tq.leases.job1 = { id: 'dup2', phone: '+16175552313', body: 'Hi', t: 'tk', until: new Date(Date.now() + 60000).toISOString(), attempt: 1 };
    tq.templates.tk = { body: 'Hi {{firstName}}' };
    tq.sentLog.push({ id: 'a', phone: '+16175559901', ts: ago(10) }, { id: 'b', phone: '+16175559902', ts: ago(20) }, { id: 'c', phone: '+16175559903', ts: ago(25 * 60) });
    tq.failed.push({ id: 'z', phone: '+16175559904', error: 'Not reachable on iMessage', ts: ago(5) });
    tq.total = 5; tq.sent = 2;
  });
  await storage.setJson('relay', { lastSeenAt: new Date(Date.now() - 10000).toISOString(), host: 'Example-Mac', version: '1.2.3', backend: 'applescript', bluebubbles: false, error: '' });
  S = (await getState(s)).body;
  const tq = S.texting.queue;
  ok(tq.pending === 2 && tq.leased === 1 && tq.active === true && tq.total === 5 && tq.sent === 2, 'the text queue shows waiting, with the Mac, total and sent', tq);
  ok(tq.sentToday === 2 && tq.remainingToday === 58 && tq.dailyLimit === 60, 'sent today counts the last 24 hours against the daily cap', tq);
  ok(tq.failed === 1 && tq.failures[0].phone === '(617) 555-9904' && tq.failures[0].error === 'Not reachable on iMessage', 'a failed text is listed with the number as people write it', tq.failures);
  ok(tq.relay.online === true && tq.relay.host === 'Example-Mac' && tq.relay.bluebubbles === false, 'a relay seen seconds ago is online', tq.relay);
  const lastSeen = new Date(Date.now() - 5 * 60000).toISOString();
  await storage.setJson('relay', { lastSeenAt: lastSeen, host: 'Example-Mac', error: 'Messages is not signed in' });
  S = (await getState(s)).body;
  ok(S.texting.queue.relay.online === false && S.texting.queue.relay.lastSeenAt === lastSeen,
    'a relay silent for minutes is offline, with when it was last seen (the page says "last seen 5m ago")', S.texting.queue.relay);

  ok(sent.count() === 0, 'nothing was sent', sent);
  ok(refused.length === 0, 'nothing reached outside this machine', refused);
  await s.close();
  done();
})().catch(crash);
