// What the page shows after a write: the poll that follows every save
// (public/app.js refresh(), which asks "anything newer than the tag I have?"
// and keeps what it shows on a 304), and a second instance of the app reading
// and writing the same storage, as two instances of the deployed function —
// or the scheduled worker and the dashboard — do.
//
// Intentions pinned here, from the code's own comments:
//   - every save is followed by a refresh, and the refresh must show it: a 304
//     after a write would leave the change off the screen until something
//     else changed (refresh(): "an import that never appeared")
//   - that holds for every record the page is drawn from, not just the
//     candidate list: the text queue (opt-outs, waiting replies, sent today),
//     the Mac's check-in, the email queue's pause
//   - storage is strongly consistent: "a save is visible to the very next
//     read, from any device" (lib/storage.js) — so a reply the relay or the
//     scheduled worker files on another instance is on this one's next poll,
//     and an edit made here keeps it
//   - unread marks "agree with themselves across devices"; an opt-out filed
//     anywhere blocks the number everywhere; a reply is announced once
//     however many callers see it (lib/replies.js)
const { ok, done, crash, R } = require('./helpers');
const W = require('./server-write-helpers');

(async () => {
  const s = await W.start(73);
  const out = (who, minutes) => [{ dir: 'out', ts: W.ago(minutes), text: `Hi ${who}, worth a quick call?` }];
  await W.seed(s, [
    W.person(1, { status: 'emailed', gmailThreadId: 'th-1', lastEmailedAt: W.ago(600), lastSubject: 'Quick question' }),
    W.person(2, { status: 'emailed', lastEmailedAt: W.ago(3000), lastTextedAt: W.ago(120), textStatus: 'sent', textThread: out('Jordan', 120) }),
    W.person(3, { status: 'replied', gmailThreadId: 'th-3', emailUnread: true, lastReplyAt: W.ago(50),
      replies: [{ id: 'm3', from: 'Casey Morgan <casey.morgan@example.com>', date: W.ago(50), text: 'Interested', snippet: 'Interested', kind: '' }] }),
    W.person(4),
    W.person(5, { status: 'emailed', lastEmailedAt: W.ago(3000) }),
    W.person(6, { status: 'emailed', lastEmailedAt: W.ago(3000), lastTextedAt: W.ago(90), textStatus: 'delivered', textThread: out('Morgan', 90) }),
    W.person(7, { status: 'new', lastTextedAt: W.ago(80), textStatus: 'sent', textThread: out('Jamie', 80) }),
    W.person(8, { status: 'emailed', gmailThreadId: 'th-8', lastEmailedAt: W.ago(700), lastSubject: 'Quick question' }),
    W.person(9),
  ]);
  const num = (n) => `+1617555${2000 + n}`;
  const c = (st, id) => W.pick(st.candidates, id) || {};
  // Gmail, as this instance's reply check reads it.
  const threads = {};
  const changed = new Set();
  s.google.threadReplies = async (_settings, threadId) => ({ limited: false, replies: (threads[threadId] || []).map((m) => ({ ...m })) });
  s.google.recentInboundThreads = async () => { const set = new Set(changed); set.complete = true; return set; };
  const gmailMsg = (id, from, text, minutesAgo) => ({ id, from, date: W.ago(minutesAgo), subject: 'Re: Quick question', snippet: text.slice(0, 100), text, kind: '' });

  // =================== the page's poll after each kind of write ===================
  const poll = W.pagePoller(s);
  let shown = (await poll()).state;
  ok(shown.candidates.length === 9, 'the page loads the list', shown.candidates.length);
  ok(W.same((await poll()).state, shown), 'with nothing written, the next poll shows the same thing');

  const after = async (what, write, check, detail = (st) => undefined) => {
    await write();
    const { state: st } = await poll();
    let good = false;
    try { good = Boolean(check(st)); } catch { good = false; }
    ok(good, `after ${what}, the page's next poll shows it`, (() => { try { return detail(st); } catch { return undefined; } })());
    shown = st;
    return st;
  };

  await after('an edit to their notes',
    () => s.json('PATCH', '/api/candidates/p1', { notes: 'Prefers a call after 5pm' }),
    (st) => c(st, 'p1').notes === 'Prefers a call after 5pm', (st) => c(st, 'p1'));
  await after('marking someone not interested',
    () => s.json('PATCH', '/api/candidates/p4', { status: 'declined' }),
    (st) => c(st, 'p4').status === 'declined' && st.texting.queue.optOut === 1 && st.texting.priority.blocked.p4 === 'asked to stop',
    (st) => ({ status: c(st, 'p4').status, optOut: st.texting.queue.optOut, blocked: st.texting.priority.blocked }));
  await after('adding someone by hand',
    () => s.json('POST', '/api/candidates', { firstName: 'Peyton', lastName: 'Lowell', name: 'Peyton Lowell', email: 'peyton.lowell@example.com' }),
    (st) => st.stats.total === 10 && st.candidates.some((x) => x.email === 'peyton.lowell@example.com'), (st) => st.stats);
  let token = '';
  await after('making a relay token',
    async () => { token = await W.relayToken(s); },
    (st) => st.texting.tokenSet === true, (st) => st.texting.tokenSet);
  await after('the Mac checking in',
    () => W.relay(s, token, 'hello', { host: 'studio-mac', version: '1.4.0', bluebubbles: true }),
    (st) => st.texting.queue.relay.online === true && st.texting.queue.relay.host === 'studio-mac', (st) => st.texting.queue.relay);
  const said = 'Yes, still looking. Call me after 3?';
  const saidAt = W.ago(1);
  await after('a text reply arriving from the Mac',
    () => W.relay(s, token, 'events', { events: [{ phone: num(2), kind: 'reply', ts: saidAt, text: said }] }),
    (st) => c(st, 'p2').textUnread === true && c(st, 'p2').textLastIn.text === said && c(st, 'p2').status === 'replied'
      && st.events.some((e) => e.type === 'text-replied' && e.candidateId === 'p2'),
    (st) => c(st, 'p2'));
  await after('opening that conversation',
    () => s.json('POST', '/api/texts/seen', { items: [{ id: 'p2', ts: saidAt }] }),
    (st) => c(st, 'p2').textUnread === false, (st) => c(st, 'p2').textUnread);
  const readOnce = shown;
  await s.json('POST', '/api/texts/seen', { items: [{ id: 'p2', ts: saidAt }] });
  ok(W.same((await poll()).state, readOnce), 'after the same read mark again, the page\'s next poll shows nothing new');
  await after('answering it',
    () => s.json('POST', '/api/texts/reply', { id: 'p2', body: 'Great, I will call at 3.' }),
    (st) => st.texting.queue.pending === 1, (st) => st.texting.queue);
  await after('the Mac sending that answer',
    async () => { const job = (await W.relay(s, token, 'claim')).body.job; await W.relay(s, token, 'report', { jobId: job && job.jobId, status: 'sent' }); },
    (st) => st.texting.queue.sentToday === 1 && st.texting.queue.pending === 0 && c(st, 'p2').textCount === 3 && c(st, 'p2').textLast.dir === 'out',
    (st) => ({ queue: st.texting.queue, p2: c(st, 'p2') }));
  await after('opening an email conversation',
    () => s.json('POST', '/api/emails/seen', { items: [{ id: 'p3' }] }),
    (st) => c(st, 'p3').emailUnread === false, (st) => c(st, 'p3').emailUnread);
  await after('the reply check finding an email reply',
    async () => {
      threads['th-1'] = [gmailMsg('g1', 'Avery Quinn <avery.quinn@example.com>', 'Thursday works for a call.', 2)];
      changed.add('th-1');
      await s.json('POST', '/api/replies/check');
    },
    (st) => c(st, 'p1').status === 'replied' && c(st, 'p1').emailUnread === true && c(st, 'p1').emailReplies === 1
      && st.events.some((e) => e.type === 'replied' && e.candidateId === 'p1'),
    (st) => c(st, 'p1'));
  await after('saving Settings',
    () => s.json('POST', '/api/settings', { fromName: 'Pat Example', textDailyLimit: '40' }),
    (st) => st.settings.fromName === 'Pat Example' && st.texting.queue.dailyLimit === 40, (st) => st.settings.fromName);
  const emailQueue = require(R('lib/queue.js'));
  await after('the email queue pausing at its daily limit',
    () => emailQueue.updateQ((q) => { q.pausedUntil = new Date(Date.now() + 6 * 3600000).toISOString(); q.pauseKind = 'daily'; q.note = 'paused (daily)'; }),
    (st) => st.queue.pauseKind === 'daily', (st) => st.queue);
  await after('a save that lifts that pause',
    () => s.json('POST', '/api/settings', { dailyLimit: '400' }),
    (st) => st.queue.pauseKind === '' && !st.queue.pausedUntil, (st) => st.queue);
  const start = new Date(Date.now() + 3 * 86400000);
  start.setUTCHours(15, 0, 0, 0);
  s.calendly.listInterviews = async () => ({
    complete: true, skipped: [], schedulingUrl: '',
    interviews: [{ uri: 'https://api.calendly.com/scheduled_events/ev-sync', name: 'Intro call', status: 'active', start: start.toISOString(),
      end: new Date(start.getTime() + 1800000).toISOString(), joinUrl: 'https://meet.example.com/ev-sync', locationType: 'zoom',
      invitees: [{ name: 'Taylor Reese', email: 'taylor.reese@example.com', status: 'active', createdAt: W.ago(5), phone: '', rescheduleUrl: '', cancelUrl: '' }] }],
  });
  await after('connecting Calendly and syncing a booking',
    async () => { await s.json('POST', '/api/settings', { calendlyToken: 'cal-test-token' }); await s.json('POST', '/api/calendly/sync'); },
    (st) => c(st, 'p5').status === 'booked' && st.interviews.some((i) => i.candidateId === 'p5') && st.calendly.syncEnabled && Boolean(st.calendly.lastSyncAt)
      && st.events.some((e) => e.type === 'booked' && e.candidateId === 'p5'),
    (st) => ({ p5: c(st, 'p5').status, interviews: st.interviews }));
  await after('an import',
    async () => {
      const read = (await s.json('POST', '/api/import/csv', { text: 'First Name,Last Name,Email,Phone\nKendall,Brooks,kendall.brooks@example.com,(617) 555-2310\n', via: 'csv' })).body;
      await s.json('POST', '/api/import/commit', { rows: read.rows, lines: read.lines, headerless: read.headerless, mapping: read.mapping, source: 'csv' });
    },
    (st) => st.stats.total === 11 && st.candidates.some((x) => x.email === 'kendall.brooks@example.com' && x.status === 'new'), (st) => st.stats);
  // Time passing, not a write: the Mac's last check-in, as stored, is now two
  // minutes old. The page must stop calling it online.
  const storage = require(R('lib/storage.js'));
  await after('the Mac not checking in for two minutes',
    () => storage.updateJson('relay', (cur) => ({ ...(cur || {}), lastSeenAt: W.ago(2) })),
    (st) => st.texting.queue.relay.online === false, (st) => st.texting.queue.relay);

  // =================== a second instance on the same storage ===================
  const B = await W.secondInstance(74);
  const onB = async (method, url, body) => {
    const r = await fetch(B.base + url, { method, headers: { cookie: s.cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const relayB = (path, body) => W.relay({ base: B.base }, token, path, body);
  const pollB = W.pagePoller(s, { base: B.base });
  let seenB = (await pollB()).state;
  let seenA = (await poll()).state;
  ok(W.same(seenB.candidates, seenA.candidates) && seenB.stats.total === 11, 'the other instance shows the same list to the same signed-in page', seenB.stats);

  let r = await relayB('hello', { host: 'second-mac', version: '1.4.1', bluebubbles: true });
  seenA = (await poll()).state;
  ok(r.status === 200 && seenA.texting.queue.relay.online === true && seenA.texting.queue.relay.host === 'second-mac',
    'the Mac checking in on the other instance shows as online on this one', seenA.texting.queue.relay);

  const said6 = 'Sounds good, what is the pay range?';
  const said6At = W.ago(1);
  r = await relayB('events', { events: [{ phone: num(6), kind: 'reply', ts: said6At, text: said6 }] });
  seenA = (await poll()).state;
  ok(r.body && r.body.applied === 1 && c(seenA, 'p6').textUnread === true && c(seenA, 'p6').textLastIn && c(seenA, 'p6').textLastIn.text === said6
    && seenA.events.some((e) => e.type === 'text-replied' && e.candidateId === 'p6'),
  'a text reply filed on the other instance is on this one\'s next poll', c(seenA, 'p6'));

  r = await s.json('PATCH', '/api/candidates/p6', { notes: 'Asked about pay' });
  const p6 = await W.storedCandidate(s, 'p6');
  ok(r.status === 200 && p6.notes === 'Asked about pay' && p6.textUnread === true && p6.textThread.some((m) => m.text === said6),
    'an edit made here right after keeps the reply the other instance filed', p6);
  seenB = (await pollB()).state;
  ok(c(seenB, 'p6').notes === 'Asked about pay' && c(seenB, 'p6').textUnread === true, 'and the other instance shows the edit', c(seenB, 'p6'));

  await s.json('POST', '/api/texts/seen', { items: [{ id: 'p6', ts: said6At }] });
  seenB = (await pollB()).state;
  ok(c(seenB, 'p6').textUnread === false, 'a conversation read here shows as read on the other instance', c(seenB, 'p6').textUnread);

  r = await relayB('events', { events: [{ phone: num(7), kind: 'reply', ts: W.ago(1), text: 'STOP' }] });
  const refused = await s.json('POST', '/api/texts/reply', { id: 'p7', body: 'Sorry to bother you' });
  ok(r.body && r.body.optOut === 1 && refused.status === 409 && /STOP/.test(refused.body.error), 'a STOP filed on the other instance blocks a reply sent from this one', { relay: r.body, reply: refused });
  seenA = (await poll()).state;
  ok(c(seenA, 'p7').status === 'declined' && seenA.texting.queue.optOut === 2 && seenA.texting.priority.blocked.p7 === 'asked to stop',
    'and this one shows them declined and blocked', { status: c(seenA, 'p7').status, optOut: seenA.texting.queue.optOut });

  await s.json('POST', '/api/settings', { fromName: 'Pat Q. Example', textDailyLimit: '30', textStartHour: '10' });
  seenB = (await pollB()).state;
  ok(seenB.settings.fromName === 'Pat Q. Example' && seenB.texting.queue.dailyLimit === 30 && seenB.texting.queue.startHour === 10,
    'Settings saved here are what the other instance shows, and the texting limits it works to', { fromName: seenB.settings.fromName, daily: seenB.texting.queue.dailyLimit, start: seenB.texting.queue.startHour });

  // The scheduled worker's reply check runs on its own instance.
  const reply8 = gmailMsg('g8', 'Drew Hollis <drew.hollis@example.com>', 'Happy to talk next week.', 2);
  await B.ask({ cmd: 'gmail', threads: { 'th-8': [reply8] }, changed: ['th-8'] });
  r = await onB('POST', '/api/replies/check');
  seenA = (await poll()).state;
  ok(r.body && r.body.replies === 1 && c(seenA, 'p8').status === 'replied' && c(seenA, 'p8').emailUnread === true && c(seenA, 'p8').emailReplies === 1
    && seenA.events.some((e) => e.type === 'replied' && e.candidateId === 'p8'),
  'an email reply found by the other instance is on this one\'s next poll', { check: r.body, p8: c(seenA, 'p8') });
  threads['th-8'] = [reply8];
  changed.add('th-8');
  const pushesHere = s.pushes.length;
  r = await s.json('POST', '/api/replies/check');
  const lines8 = await W.storedEvents(s, 'replied', 'p8');
  const pushedB = (await B.ask({ cmd: 'report' })).pushes || [];
  ok(r.body.replies === 0 && lines8.length === 1 && s.pushes.length === pushesHere && pushedB.filter((p) => /Drew Hollis/.test(p.title)).length === 1,
    'this instance seeing the same reply later announces it nowhere a second time', { check: r.body, lines: lines8.length, pushedHere: s.pushes.length - pushesHere });

  // Edits taking turns between the instances: each keeps the one before.
  await s.json('PATCH', '/api/candidates/p9', { status: 'emailed' });
  await onB('PATCH', '/api/candidates/p9', { notes: 'Referred by Avery' });
  await s.json('PATCH', '/api/candidates/p9', { role: 'Sales Director' });
  await onB('PATCH', '/api/candidates/p9', { company: 'Example Holdings' });
  const p9 = await W.storedCandidate(s, 'p9');
  seenA = (await poll()).state;
  seenB = (await pollB()).state;
  const all4 = (x) => x.status === 'emailed' && x.notes === 'Referred by Avery' && x.role === 'Sales Director' && x.company === 'Example Holdings';
  ok(all4(p9) && all4(c(seenA, 'p9')) && all4(c(seenB, 'p9')), 'edits taking turns between instances are all kept, and both show all of them', p9);

  const reportB = await B.ask({ cmd: 'report' });
  ok((reportB.outside || []).length === 0 && reportB.mail === 0, 'the other instance reached nothing outside', reportB.outside);
  await B.stop();

  ok(s.outsideCalls.length === 0 && s.sentMail.length === 0, 'nothing reached the outside world', s.outsideCalls);
  await s.close();
  done();
})().catch(crash);
