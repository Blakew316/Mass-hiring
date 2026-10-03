// The email reply check (POST /api/replies/check, lib/replies.js), with
// Gmail answered by the test.
//
// Intentions pinned here, from the code's own comments:
//   - a new reply is stored, moves them to replied, lights the bell (unread)
//     and is announced once in Candidate updates, with a phone push
//   - a reply seen again is never announced again, and never re-lights a bell
//     that was put out by reading it
//   - a bounce is recorded as a bounce (status bounced), not as a reply
//   - an auto-reply is not a reply
//   - someone who already booked can still write back, and that is a reply,
//     without undoing the booking
//   - with Google not connected nothing is read and nothing changes
//   - two checks at once (the scheduled worker and the dashboard) announce a
//     reply once between them
const { ok, done, crash } = require('./helpers');
const W = require('./server-write-helpers');

(async () => {
  const s = await W.start(60);
  const g = s.google;
  const threads = {};      // threadId -> Gmail messages (as the module reads them)
  const changed = new Set();
  let slow = 0;           // ms Gmail takes to answer, to make two checks overlap
  g.threadReplies = async (_settings, threadId) => {
    if (slow) await new Promise((res) => setTimeout(res, slow));
    return { limited: false, replies: (threads[threadId] || []).map((m) => ({ ...m })) };
  };
  g.recentInboundThreads = async () => { const set = new Set(changed); set.complete = true; return set; };
  // What Gmail's module would say each message is, decided by its own rules.
  const msg = (id, from, subject, text, minutesAgo, headers = {}) => {
    const m = { id, from, date: W.ago(minutesAgo), subject, snippet: text.slice(0, 100), text };
    return { ...m, kind: g.classifyReply({ ...m, headers }) };
  };

  await W.seed(s, [
    W.person(1, { status: 'emailed', gmailThreadId: 'th-1', lastEmailedAt: W.ago(600), lastSubject: 'Quick question' }),
    W.person(2, { status: 'emailed', gmailThreadId: 'th-2', lastEmailedAt: W.ago(600), lastSubject: 'Quick question' }),
    W.person(3, { status: 'emailed', gmailThreadId: 'th-3', lastEmailedAt: W.ago(600), lastSubject: 'Quick question' }),
    W.person(4, { status: 'emailed', gmailThreadId: 'th-4', lastEmailedAt: W.ago(600), lastSubject: 'Quick question' }),
    W.person(5, { status: 'booked', gmailThreadId: 'th-5', lastEmailedAt: W.ago(900), bookedAt: new Date(Date.now() + 86400000).toISOString(), bookedEvent: 'Intro call' }),
    W.person(6),
  ]);
  const replyLines = async (id) => W.storedEvents(s, 'replied', id);

  // ---------- nothing new ----------
  const seenBefore = (await W.state(s)).candidates;
  let r = await s.json('POST', '/api/replies/check');
  ok(r.status === 200 && r.body.ok && r.body.replies === 0, 'with no replies in Gmail, none are found', r.body);
  const now = await W.state(s);
  ok(W.same(now.candidates, seenBefore) && now.events.length === 0 && s.pushes.length === 0, 'and nobody changes on the page, and nothing is announced');

  // ---------- a reply ----------
  const said = 'Yes, I am interested. Thursday afternoon works for a call.';
  threads['th-1'] = [msg('g1', 'Avery Quinn <avery.quinn@example.com>', 'Re: Quick question', said, 3)];
  changed.add('th-1');
  r = await s.json('POST', '/api/replies/check');
  ok(r.body.replies === 1, 'a new reply is found', r.body);
  let c = await W.storedCandidate(s, 'p1');
  ok(c.status === 'replied' && c.emailUnread === true && c.lastReplyAt === threads['th-1'][0].date, 'they are marked replied, unread, with the time of their reply', c);
  ok((c.replies || []).some((x) => x.id === 'g1' && x.text === said), 'their reply is stored', c.replies);
  let lines = await replyLines('p1');
  ok(lines.length === 1 && lines[0].message === `Avery Quinn replied: “${said}”` && lines[0].ts === threads['th-1'][0].date, 'Candidate updates says so once, dated when they wrote', lines);
  ok(s.pushes.length === 1 && /Avery Quinn replied/.test(s.pushes[0].title) && s.pushes[0].message.includes('Thursday'), 'the phone is told', s.pushes);
  let st = await W.state(s);
  let shown = W.pick(st.candidates, 'p1');
  ok(shown.status === 'replied' && shown.emailUnread === true && shown.emailReplies === 1 && shown.emailLast && shown.emailLast.text === said, 'the page reads the reply, unread', shown);
  ok(st.events.some((e) => e.type === 'replied' && e.candidateId === 'p1'), 'and shows the line');
  ok(st.stats.replied === 1 && st.stats.emailed === 3, 'the dashboard counts them as replied', st.stats);

  // ---------- the same reply again ----------
  r = await s.json('POST', '/api/replies/check');
  ok(r.body.replies === 0 && (await replyLines('p1')).length === 1 && s.pushes.length === 1, 'the same reply seen again is not announced again', r.body);
  ok((await W.storedCandidate(s, 'p1')).emailUnread === true, 'and is still unread until it is opened');
  await s.json('POST', '/api/emails/seen', { items: [{ id: 'p1', ts: threads['th-1'][0].date }] });
  r = await s.json('POST', '/api/replies/check');
  c = await W.storedCandidate(s, 'p1');
  ok(c.emailUnread === false && c.status === 'replied', 'once read, seeing the same reply again does not light the bell', c.emailUnread);

  // A second message from them is news again.
  threads['th-1'].push(msg('g2', 'Avery Quinn <avery.quinn@example.com>', 'Re: Quick question', 'Actually, Friday is better.', 1));
  r = await s.json('POST', '/api/replies/check');
  c = await W.storedCandidate(s, 'p1');
  lines = await replyLines('p1');
  ok(r.body.replies === 1 && c.emailUnread === true && lines.length === 2 && lines.some((l) => l.message.includes('Friday is better')), 'a second message is announced and lights the bell again', { body: r.body, lines });
  ok(s.pushes.length === 2, 'with one more push', s.pushes.length);
  shown = W.pick((await W.state(s)).candidates, 'p1');
  ok(shown.emailReplies === 2 && shown.emailLast.text === 'Actually, Friday is better.', 'the page reads the newest reply', shown.emailLast);

  // ---------- a bounce ----------
  threads['th-3'] = [msg('b1', 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'Delivery Status Notification (Failure)',
    'Address not found. Your message wasn\'t delivered to casey.morgan@example.com because the address couldn\'t be found.', 2)];
  ok(threads['th-3'][0].kind === 'bounce', '(Gmail\'s own rules call it a bounce)');
  changed.add('th-3');
  const pushesBefore = s.pushes.length;
  r = await s.json('POST', '/api/replies/check');
  c = await W.storedCandidate(s, 'p3');
  ok(r.body.replies === 0 && c.status === 'bounced', 'a bounce marks them bounced', { body: r.body, status: c.status });
  ok(!c.emailUnread && (await replyLines('p3')).length === 0 && s.pushes.length === pushesBefore, 'and is not a reply: no bell, no line, no push', c.emailUnread);
  st = await W.state(s);
  shown = W.pick(st.candidates, 'p3');
  ok(shown.emailBounced === true && shown.emailReplies === 0 && shown.status === 'bounced' && st.stats.bounced === 1, 'the page reads it as a bounce', shown);
  r = await s.json('POST', '/api/replies/check');
  ok((await W.storedCandidate(s, 'p3')).status === 'bounced' && (await replyLines('p3')).length === 0, 'and keeps it a bounce on the next check');

  // ---------- an auto-reply ----------
  threads['th-4'] = [msg('a1', 'Riley Parker <riley.parker@example.com>', 'Automatic reply: Quick question', 'I am out of the office until Monday.', 2, { 'auto-submitted': 'auto-replied' })];
  changed.add('th-4');
  r = await s.json('POST', '/api/replies/check');
  c = await W.storedCandidate(s, 'p4');
  ok(r.body.replies === 0 && c.status === 'emailed' && !c.emailUnread && (await replyLines('p4')).length === 0, 'an out-of-office is not a reply', c);
  ok(W.pick((await W.state(s)).candidates, 'p4').emailReplies === 0, 'the page counts no replies from them');

  // ---------- someone already booked writes back ----------
  threads['th-5'] = [msg('k1', 'Taylor Reese <taylor.reese@example.com>', 'Re: Quick question', 'Looking forward to Thursday!', 1)];
  changed.add('th-5');
  r = await s.json('POST', '/api/replies/check');
  c = await W.storedCandidate(s, 'p5');
  ok(r.body.replies === 1 && c.emailUnread === true && (await replyLines('p5')).length === 1, 'a reply from someone already booked is still a reply', r.body);
  ok(c.status === 'booked' && c.bookedEvent === 'Intro call', 'and leaves them booked', c.status);

  // ---------- two checks at once ----------
  // The scheduled worker checks every minute and an open dashboard checks too,
  // so two can be reading Gmail at the same moment. Which replies are new is
  // decided when they are stored, so the reply is announced once between them.
  await s.store.update((d) => { d.candidates.push(W.person(7, { status: 'emailed', gmailThreadId: 'th-7', lastEmailedAt: W.ago(600), lastSubject: 'Quick question' })); });
  threads['th-7'] = [msg('d1', 'Jamie Rowan <jamie.rowan@example.com>', 'Re: Quick question', 'Yes please, send me the details.', 1)];
  changed.add('th-7');
  const pushesBoth = s.pushes.length;
  slow = 60;
  const both = await Promise.all([1, 2].map(() => s.json('POST', '/api/replies/check')));
  slow = 0;
  c = await W.storedCandidate(s, 'p7');
  ok(both.every((x) => x.status === 200) && both[0].body.replies + both[1].body.replies === 1, 'two checks running at once find the reply once between them', both.map((x) => x.body));
  ok((await replyLines('p7')).length === 1 && s.pushes.length === pushesBoth + 1 && c.status === 'replied' && c.emailUnread === true,
    'with one line and one push', { lines: (await replyLines('p7')).length, pushes: s.pushes.length - pushesBoth });

  // ---------- Google not connected ----------
  threads['th-2'] = [msg('j1', 'Jordan Blake <jordan.blake@example.com>', 'Re: Quick question', 'Tell me more', 1)];
  changed.add('th-2');
  const connected = g.status;
  g.status = async () => ({ connected: false, configured: false, email: '' });
  const snap = await W.everything(s);
  r = await s.json('POST', '/api/replies/check');
  ok(r.status === 200 && r.body.unavailable && r.body.replies === 0, 'with Google disconnected the check says so', r.body);
  ok(W.same(await W.everything(s), snap), 'and reads and changes nothing');
  g.status = connected;
  r = await s.json('POST', '/api/replies/check');
  ok(r.body.replies === 1 && (await W.storedCandidate(s, 'p2')).status === 'replied', 'reconnected, the waiting reply is found', r.body);

  ok(s.outsideCalls.length === 0 && s.sentMail.length === 0, 'nothing reached the outside world', s.outsideCalls);
  await s.close();
  done();
})().catch(crash);
