// The Mac relay's routes (/api/relay/*): check-in, claiming and reporting a
// text, and the receipts and replies it reads off the Mac.
//
// Intentions pinned here, from the code's own comments:
//   - the relay is let in by its own bearer token only, and only to its team
//   - numbers that are not on the list are ignored (the owner's own iMessages
//     never enter the CRM); a "reply" older than our text, or to someone never
//     texted, is not outreach and is not filed
//   - a later signal never moves a candidate backwards
//   - only a message the thread has never held is news: a repeat changes
//     nothing, adds no feed line, rings no phone and does not re-mark unread
//   - STOP declines them and blocks the number at the queue, once
//   - a tapback or a driving auto-reply is kept in the thread but is not a reply
const { ok, done, crash } = require('./helpers');
const W = require('./server-write-helpers');

(async () => {
  const s = await W.start(50);
  const out = (who) => [{ dir: 'out', ts: W.ago(120), text: `Hi ${who}, worth a quick call?` }];
  await W.seed(s, [
    W.person(1, { status: 'emailed', lastEmailedAt: W.ago(3000), lastTextedAt: W.ago(120), textStatus: 'sent', textThread: out('Avery') }),
    W.person(2, { status: 'new', lastTextedAt: W.ago(120), textStatus: 'sent', textThread: out('Jordan') }),
    W.person(3),
    W.person(4, { status: 'emailed', lastEmailedAt: W.ago(3000), lastTextedAt: W.ago(100), textStatus: 'delivered', textThread: out('Riley') }),
    W.person(5, { status: 'emailed', lastEmailedAt: W.ago(3000), lastTextedAt: W.ago(30), textStatus: 'sent', textThread: out('Taylor') }),
    W.person(6),
  ]);
  const num = (n) => `+1617555${2000 + n}`;
  const ev = (n, kind, ts, text) => ({ phone: num(n), kind, ts, ...(text != null ? { text } : {}) });
  const lines = async (type, id) => W.storedEvents(s, type, id);

  // ---------- who may call ----------
  let r = await W.relay(s, null, 'hello', { host: 'x' });
  ok(r.status === 401 && r.body.relay === true, 'no token, no entry', r);
  let raw = await fetch(`${s.base}/api/relay/hello`, { method: 'POST', headers: { cookie: s.cookie, 'content-type': 'application/json' }, body: '{}' });
  ok(raw.status === 401, 'a signed-in dashboard cookie is not a relay token', raw.status);
  r = await W.relay(s, 'too-short', 'events', { events: [ev(1, 'reply', W.ago(1), 'hi')] });
  ok(r.status === 401, 'a short token is refused', r.status);
  r = await W.relay(s, 'x'.repeat(43), 'events', { events: [ev(1, 'reply', W.ago(1), 'hi')] });
  ok(r.status === 401, 'an unknown token is refused', r.status);
  const token = await W.relayToken(s);
  raw = await fetch(`${s.base}/api/state`, { headers: { authorization: `Bearer ${token}` } });
  ok(raw.status === 401, 'the relay token opens nothing but the relay routes', raw.status);

  // ---------- hello ----------
  r = await W.relay(s, token, 'hello', { host: 'studio-mac', version: '1.4.0', bluebubbles: true, backend: 'bluebubbles' });
  ok(r.status === 200 && r.body.ok && r.body.pollMs > 0 && r.body.helloMs > 0, 'a check-in is answered with how often to poll', r.body);
  ok(r.body.limits && r.body.limits.startHour === 9 && r.body.limits.endHour === 19 && r.body.limits.dailyLimit === 60, 'and the texting hours and daily cap', r.body.limits);
  let st = await W.state(s);
  ok(st.texting.queue.relay.online === true && st.texting.queue.relay.host === 'studio-mac' && st.texting.queue.relay.version === '1.4.0', 'the texting page shows the Mac online', st.texting.queue.relay);
  await s.json('POST', '/api/settings', { textDailyLimit: '40', textStartHour: '10' });
  r = await W.relay(s, token, 'hello', { host: 'studio-mac', version: '1.4.0', bluebubbles: true });
  ok(r.body.limits.dailyLimit === 40 && r.body.limits.startHour === 10, 'the limits it is told follow Settings', r.body.limits);

  // ---------- nothing to do ----------
  r = await W.relay(s, token, 'claim');
  ok(r.status === 200 && r.body.job === null && r.body.reason === 'empty', 'an empty queue hands out nothing', r.body);
  let snap = await W.everything(s);
  r = await W.relay(s, token, 'events', { events: [] });
  ok(r.status === 200 && r.body.applied === 0 && W.same(await W.everything(s), snap), 'an empty batch changes nothing', r.body);
  r = await W.relay(s, token, 'events', { events: [{ phone: '+16465552999', kind: 'reply', ts: W.ago(1), text: 'Who is this?' }, { phone: '+16465552999', kind: 'read', ts: W.ago(1) }] });
  ok(r.status === 200 && r.body.unknown === 2 && r.body.applied === 0, 'messages from numbers not on the list are ignored', r.body);
  ok(W.same(await W.everything(s), snap) && s.pushes.length === 0, 'and nothing of them is stored or announced');

  // ---------- receipts ----------
  const D = W.ago(110);
  r = await W.relay(s, token, 'events', { events: [ev(1, 'delivered', D)] });
  let c = await W.storedCandidate(s, 'p1');
  ok(r.body.applied === 1 && c.textDeliveredAt === D && c.textStatus === 'delivered', 'a delivery receipt is stored', { body: r.body, c });
  ok((await W.stored(s)).events.length === 0, 'a delivery adds no feed line');
  snap = await W.everything(s);
  await W.relay(s, token, 'events', { events: [ev(1, 'delivered', D)] });
  ok(W.same(await W.everything(s), snap), 'the same delivery again changes nothing');

  const RD = W.ago(100);
  r = await W.relay(s, token, 'events', { events: [ev(1, 'read', RD)] });
  c = await W.storedCandidate(s, 'p1');
  ok(c.textReadAt === RD && c.textStatus === 'read', 'a read receipt is stored', c);
  let readLines = await lines('text-read', 'p1');
  ok(readLines.length === 1 && readLines[0].message === 'Avery Quinn read your text.', 'the feed says they read it', readLines);
  st = await W.state(s);
  ok(st.events.some((e) => e.type === 'text-read' && e.candidateId === 'p1'), 'the page shows that line');
  ok(W.pick(st.candidates, 'p1').textStatus === 'read' && W.pick(st.candidates, 'p1').textReadAt === RD, 'the page reads the receipt', W.pick(st.candidates, 'p1'));
  snap = await W.everything(s);
  await W.relay(s, token, 'events', { events: [ev(1, 'read', RD)] });
  await W.relay(s, token, 'events', { events: [ev(1, 'read', W.ago(90))] });
  ok(W.same(await W.everything(s), snap), 'a read receipt reported again changes nothing and adds no line');
  ok(s.pushes.length === 0, 'receipts ring no phone');

  // ---------- a reply ----------
  const said = 'Yes — I am interested. Call me at 3?';
  const RT = W.ago(5);
  r = await W.relay(s, token, 'events', { events: [ev(1, 'reply', RT, said)] });
  c = await W.storedCandidate(s, 'p1');
  const lastIn = c.textThread.filter((m) => m.dir === 'in').pop();
  ok(r.body.applied === 1 && lastIn && lastIn.text === said && lastIn.ts === RT, 'their reply is added to the conversation', c.textThread);
  ok(c.textUnread === true && c.status === 'replied' && c.textStatus === 'replied' && c.textRepliedAt === RT, 'they are marked replied, and unread', c);
  let replyLines = await lines('text-replied', 'p1');
  ok(replyLines.length === 1 && replyLines[0].message.includes(said) && replyLines[0].message.startsWith('Avery Quinn replied'), 'the feed carries one line with what they said', replyLines);
  ok(s.pushes.length === 1 && /Avery Quinn replied/.test(s.pushes[0].title) && s.pushes[0].message.includes(said), 'the phone is told once', s.pushes);
  st = await W.state(s);
  let shown = W.pick(st.candidates, 'p1');
  ok(shown.textUnread === true && shown.textLastIn && shown.textLastIn.text === said && shown.textCount === 2 && shown.status === 'replied', 'the page reads the reply and the unread mark', shown);
  ok(st.stats.replied === 1, 'the dashboard counts them as replied', st.stats);

  snap = await W.everything(s);
  const pushed = s.pushes.length;
  await W.relay(s, token, 'events', { events: [ev(1, 'reply', RT, said)] });
  await W.relay(s, token, 'events', { events: [ev(1, 'reply', new Date(Date.parse(RT) + 1500).toISOString(), said)] });
  ok(W.same(await W.everything(s), snap), 'the same reply reported again (even a moment off) changes nothing');
  ok(s.pushes.length === pushed && (await lines('text-replied', 'p1')).length === 1, 'and neither rings the phone nor adds a line');

  r = await s.json('POST', '/api/texts/seen', { items: [{ id: 'p1', ts: RT }] });
  ok(r.body.cleared === 1, 'reading it clears the unread mark');
  await W.relay(s, token, 'events', { events: [ev(1, 'reply', RT, said)] });
  ok((await W.storedCandidate(s, 'p1')).textUnread === false, 'a repeat of an old reply does not mark it unread again');
  await W.relay(s, token, 'events', { events: [ev(1, 'delivered', W.ago(1)), ev(1, 'read', W.ago(1))] });
  c = await W.storedCandidate(s, 'p1');
  ok(c.textStatus === 'replied' && c.textDeliveredAt === D && c.textReadAt === RD, 'late receipts never move them backwards or move the first times', c);

  // ---------- what is not a reply ----------
  snap = await W.everything(s);
  r = await W.relay(s, token, 'events', { events: [ev(3, 'reply', W.ago(1), 'Hey, who is this?')] });
  ok(r.body.neverTexted === 1 && r.body.applied === 0 && W.same(await W.everything(s), snap), 'a message from someone never texted is not filed', r.body);
  r = await W.relay(s, token, 'events', { events: [ev(4, 'reply', W.ago(300), 'See you Sunday!')] });
  ok(r.body.tooOld === 1 && r.body.applied === 0 && W.same(await W.everything(s), snap), 'a message older than our text is not filed', r.body);

  const tap = 'Liked “Hi Riley, worth a quick call?”';
  const drive = 'I\'m driving with Driving Focus turned on. I\'ll see your message when I get where I\'m going.';
  r = await W.relay(s, token, 'events', { events: [ev(4, 'reply', W.ago(4), tap), ev(4, 'reply', W.ago(3), drive)] });
  c = await W.storedCandidate(s, 'p4');
  const kinds = c.textThread.filter((m) => m.dir === 'in').map((m) => [m.text, m.kind]);
  ok(W.same(kinds, [[tap, 'reaction'], [drive, 'auto']]), 'a tapback and a driving auto-reply are kept in the conversation, marked for what they are', kinds);
  ok(!c.textUnread && c.status === 'emailed' && c.textStatus === 'delivered' && !c.textRepliedAt, 'neither marks them replied or unread', c);
  ok((await lines('text-replied', 'p4')).length === 0 && s.pushes.length === pushed, 'neither adds a feed line or rings the phone');
  shown = W.pick((await W.state(s)).candidates, 'p4');
  ok(shown.textLastIn === null && shown.textLast && shown.textLast.dir === 'out', 'the list preview still shows our text, not the tapback', shown);

  // Two real replies in one batch: two lines, one buzz.
  r = await W.relay(s, token, 'events', { events: [ev(4, 'reply', W.ago(2), 'Hi'), ev(4, 'reply', W.ago(1), 'yes, call me at 3')] });
  c = await W.storedCandidate(s, 'p4');
  ok(c.textUnread === true && c.status === 'replied', 'a real reply after a tapback is a reply', c.status);
  ok((await lines('text-replied', 'p4')).length === 2, 'each message gets its own feed line');
  ok(s.pushes.length === pushed + 1 && /\(\+1 more\)/.test(s.pushes[s.pushes.length - 1].message), 'replies arriving together ring the phone once', s.pushes.slice(pushed));

  // ---------- undelivered ----------
  await W.relay(s, token, 'events', { events: [ev(5, 'undelivered', W.ago(1))] });
  ok((await W.storedCandidate(s, 'p5')).textStatus === 'not-imessage', 'a text the Mac could not deliver marks the number as not on iMessage');
  await W.relay(s, token, 'events', { events: [ev(1, 'undelivered', W.ago(1))] });
  ok((await W.storedCandidate(s, 'p1')).textStatus === 'replied', 'but never undoes a conversation already under way');

  // ---------- STOP ----------
  r = await s.json('POST', '/api/texts/reply', { id: 'p2', body: 'Following up on my text' });
  ok(r.status === 200, 'a reply to Jordan is waiting to go out');
  const pushedBeforeStop = s.pushes.length;
  r = await W.relay(s, token, 'events', { events: [ev(2, 'reply', W.ago(1), 'STOP')] });
  c = await W.storedCandidate(s, 'p2');
  let q = await W.textQueue(s);
  ok(r.body.optOut === 1 && c.status === 'declined', 'STOP declines them', { body: r.body, status: c.status });
  ok(q.optOut.includes(num(2)) && !q.items.some((i) => i.id === 'p2'), 'their number is blocked and the text waiting for them is dropped', q);
  const stopLines = await lines('text-optout', 'p2');
  ok(stopLines.length === 1 && stopLines[0].message === 'Jordan Blake replied STOP — blocked from texting.', 'the feed says they replied STOP', stopLines);
  ok((await lines('text-replied', 'p2')).length === 0, 'and does not read it as an ordinary reply');
  ok(s.pushes.length === pushedBeforeStop + 1 && /STOP/.test(s.pushes[s.pushes.length - 1].title), 'the phone is told it was a STOP', s.pushes.slice(pushedBeforeStop));
  st = await W.state(s);
  ok(st.texting.queue.optOut === 1 && W.pick(st.candidates, 'p2').status === 'declined', 'the page shows them declined and blocked', st.texting.queue.optOut);
  r = await s.json('POST', '/api/texts/reply', { id: 'p2', body: 'Sorry to bother you' });
  ok(r.status === 409, 'nothing more can be sent to them', r);

  snap = await W.everything(s);
  await W.relay(s, token, 'events', { events: [ev(2, 'reply', c.textThread.filter((m) => m.dir === 'in').pop().ts, 'STOP')] });
  ok(W.same(await W.everything(s), snap) && s.pushes.length === pushedBeforeStop + 1, 'the same STOP reported again changes nothing');
  await s.json('PATCH', '/api/candidates/p2', { status: 'emailed' });
  await W.relay(s, token, 'events', { events: [ev(2, 'reply', c.textThread.filter((m) => m.dir === 'in').pop().ts, 'STOP')] });
  ok((await W.storedCandidate(s, 'p2')).status === 'emailed', 'a repeat of an old STOP does not undo putting them back by hand');

  // ---------- claim and report ----------
  r = await s.json('POST', '/api/texts/reply', { id: 'p3', body: 'Hi Casey, this is the hiring team.' });
  const job = (await W.relay(s, token, 'claim')).body.job;
  ok(job && job.candidateId === 'p3' && job.phone === num(3) && job.body === 'Hi Casey, this is the hiring team.', 'the Mac claims the waiting text', job);
  ok((await W.relay(s, token, 'claim')).body.job === null, 'a claimed text is not handed out twice');
  r = await W.relay(s, token, 'report', { jobId: job.jobId, status: 'sent' });
  c = await W.storedCandidate(s, 'p3');
  ok(r.status === 200 && r.body.ok && c.textStatus === 'sent' && c.lastTextedAt, 'a sent report marks them texted', { body: r.body, c });
  ok(c.textThread.length === 1 && c.textThread[0].dir === 'out' && c.textThread[0].text === 'Hi Casey, this is the hiring team.', 'and our message joins their conversation', c.textThread);
  st = await W.state(s);
  ok(st.texting.queue.sentToday === 1 && st.texting.queue.pending === 0, 'the texting page counts it sent today', st.texting.queue);
  const handles = await W.relay(s, token, 'handles');
  ok(handles.body.handles.includes(num(3)) && !handles.body.handles.includes(num(6)), 'the relay is told texted numbers, never the untexted list', handles.body);
  snap = await W.everything(s);
  r = await W.relay(s, token, 'report', { jobId: job.jobId, status: 'sent' });
  ok(r.status === 409 && W.same(await W.everything(s), snap), 'the same report again is refused and changes nothing', r);

  await s.json('POST', '/api/texts/reply', { id: 'p6', body: 'Hi Morgan, quick question.' });
  const job2 = (await W.relay(s, token, 'claim')).body.job;
  r = await W.relay(s, token, 'report', { jobId: job2 && job2.jobId, status: 'failed', error: 'BlueBubbles said no' });
  c = await W.storedCandidate(s, 'p6');
  st = await W.state(s);
  ok(r.status === 200 && c.textStatus === 'failed' && !c.lastTextedAt, 'a failed report marks the text failed, not sent', c);
  ok(st.texting.queue.failed === 1 && st.texting.queue.failures.some((f) => f.error === 'BlueBubbles said no'), 'the texting page lists the failure and why', st.texting.queue.failures);

  await s.store.update((d) => { d.candidates.push(W.person(7)); });
  await s.json('POST', '/api/texts/reply', { id: 'p7', body: 'Hi Jamie, quick question.' });
  const job3 = (await W.relay(s, token, 'claim')).body.job;
  r = await W.relay(s, token, 'report', { jobId: job3 && job3.jobId, status: 'not-imessage' });
  c = await W.storedCandidate(s, 'p7');
  st = await W.state(s);
  ok(r.status === 200 && c.textStatus === 'not-imessage' && !c.lastTextedAt, 'a number with no iMessage is marked so, not sent', c);
  ok(st.texting.priority.blocked.p7 === 'no iMessage account on that number', 'and the texting page says why it cannot be texted', st.texting.priority.blocked.p7);

  // ---------- teams ----------
  const b = await W.secondTeam(s, 'Harbor Crew', '4826');
  await b.json('POST', '/api/candidates', { firstName: 'Peyton', lastName: 'Lowell', email: 'peyton.lowell@example.com', phone: '(617) 555-2401' });
  await b.inTeam(() => s.store.update((d) => { d.candidates[0].lastTextedAt = W.ago(60); }));
  const bToken = (await b.json('POST', '/api/texts/relay-token')).body.token;
  const aBefore = await W.everything(s);
  r = await W.relay(s, bToken, 'hello', { host: 'other-mac', version: '0.1' });
  r = await W.relay(s, bToken, 'events', { events: [ev(1, 'reply', W.ago(1), 'This is for team A'), ev(1, 'read', W.ago(1))] });
  ok(r.status === 200 && r.body.unknown === 2 && r.body.applied === 0, 'another team\'s relay does not know this team\'s people', r.body);
  r = await W.relay(s, token, 'events', { events: [{ phone: '+16175552401', kind: 'reply', ts: W.ago(1), text: 'For team B' }] });
  ok(r.body.unknown === 1, 'and this team\'s relay does not know theirs', r.body);
  const aAfter = await W.everything(s);
  ok(W.same(aAfter.db, aBefore.db) && W.same(aAfter.textQueue, aBefore.textQueue), 'nothing the other team\'s relay sent changed this team');
  ok((await W.state(s)).texting.queue.relay.host === 'studio-mac', 'and this team\'s page still shows its own Mac');
  const bState = await W.state(s, b.json);
  ok(bState.texting.queue.relay.host === 'other-mac' && !bState.candidates[0].textUnread, 'the other team sees its own Mac, and no reply that was not theirs', bState.texting.queue.relay);

  ok(s.outsideCalls.length === 0 && s.sentMail.length === 0, 'nothing reached the outside world', s.outsideCalls);
  await s.close();
  done();
})().catch(crash);
