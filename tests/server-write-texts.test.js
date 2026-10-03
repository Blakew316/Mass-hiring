// Answering a text from the dashboard (POST /api/texts/reply) and marking
// conversations read (POST /api/texts/seen, POST /api/emails/seen).
//
// Intentions pinned here, from the code's own comments:
//   - a reply goes to the front of the queue, is sent exactly as typed, and
//     ignores quiet hours; the opt-out list still binds
//   - answering a thread is reading it: its unread flag clears, nobody else's
//   - a read mark clears only the conversation named, only on its own channel,
//     and only if nothing newer arrived than what the screen showed
//   - read marks are idempotent: saying it twice changes nothing
const { ok, done, crash, R } = require('./helpers');
const W = require('./server-write-helpers');

(async () => {
  const s = await W.start(45);
  const T = {
    p1: { textIn: W.ago(30), emailIn: W.ago(40) },
    p2: { textIn: W.ago(20), emailIn: W.ago(25) },
  };
  const people = [
    W.person(1, {
      status: 'replied', lastTextedAt: W.ago(60), textStatus: 'replied', textRepliedAt: T.p1.textIn, textUnread: true,
      textThread: [{ dir: 'out', ts: W.ago(60), text: 'Hi Avery, worth a quick call?' }, { dir: 'in', ts: T.p1.textIn, text: 'Sure, call me' }],
      emailUnread: true, gmailThreadId: 'th-p1', lastSubject: 'Quick question', lastEmailedAt: W.ago(300),
      replies: [{ id: 'm1', from: 'Avery Quinn <avery.quinn@example.com>', date: T.p1.emailIn, text: 'Happy to chat', snippet: 'Happy to chat', kind: '' }],
      lastReplyAt: T.p1.emailIn,
    }),
    W.person(2, {
      status: 'replied', lastTextedAt: W.ago(90), textStatus: 'replied', textRepliedAt: T.p2.textIn, textUnread: true,
      textThread: [{ dir: 'out', ts: W.ago(90), text: 'Hi Jordan, worth a quick call?' }, { dir: 'in', ts: T.p2.textIn, text: 'What is the base pay?' }],
      emailUnread: true, gmailThreadId: 'th-p2', lastSubject: 'Quick question', lastEmailedAt: W.ago(300),
      replies: [{ id: 'm2', from: 'Jordan Blake <jordan.blake@example.com>', date: T.p2.emailIn, text: 'Tell me more', snippet: 'Tell me more', kind: '' }],
      lastReplyAt: T.p2.emailIn,
    }),
    W.person(3, { phone: '', status: 'replied', emailUnread: true, gmailThreadId: 'th-p3', lastReplyAt: W.ago(50),
      replies: [{ id: 'm3', from: 'Casey Morgan <casey.morgan@example.com>', date: W.ago(50), text: 'Interested', snippet: 'Interested', kind: '' }] }),
    W.person(4, { status: 'emailed', lastTextedAt: W.ago(200), textStatus: 'delivered' }),
    W.person(5, { status: 'emailed', lastEmailedAt: W.ago(6000) }),
  ];
  await W.seed(s, people);
  // p4 asked to stop at some point.
  await require(R('lib/text-queue.js')).updateQ((q) => { q.optOut.push('+16175552004'); });
  const flags = async () => Object.fromEntries((await W.stored(s)).candidates.map((c) => [c.id, { t: Boolean(c.textUnread), e: Boolean(c.emailUnread) }]));

  // ---------- texts: seen ----------
  let r = await s.json('POST', '/api/texts/seen', { items: [{ id: 'p1', ts: T.p1.textIn }] });
  let f = await flags();
  ok(r.status === 200 && r.body.cleared === 1, 'opening a conversation marks it read', r.body);
  ok(f.p1.t === false && f.p2.t === true, 'only that person\'s text conversation is marked read', f);
  ok(f.p1.e === true, 'reading the texts leaves their email unread', f.p1);
  let st = await W.state(s);
  ok(W.pick(st.candidates, 'p1').textUnread === false && W.pick(st.candidates, 'p2').textUnread === true, 'the page reads the same flags', st.candidates.map((c) => [c.id, c.textUnread]));

  let snap = await W.everything(s);
  r = await s.json('POST', '/api/texts/seen', { items: [{ id: 'p1', ts: T.p1.textIn }] });
  ok(r.status === 200 && r.body.cleared === 0, 'marking it read again clears nothing', r.body);
  ok(W.same(await W.everything(s), snap), 'and changes nothing stored');

  // The screen showed an older message than the newest one: still news.
  r = await s.json('POST', '/api/texts/seen', { items: [{ id: 'p2', ts: W.ago(45) }] });
  ok(r.body.cleared === 0 && (await flags()).p2.t === true, 'a read mark for an older message leaves a newer reply unread', r.body);
  r = await s.json('POST', '/api/texts/seen', { items: [{ id: 'nobody' }, { id: 'p5' }] });
  ok(r.body.cleared === 0 && W.same(await W.everything(s), snap), 'marking unknown or already-read conversations changes nothing', r.body);
  r = await s.json('POST', '/api/texts/seen', { id: 'p2' });
  f = await flags();
  ok(r.body.cleared === 1 && f.p2.t === false && f.p2.e === true, 'one conversation named by id alone is marked read, on its own channel', { body: r.body, f });

  // ---------- email: seen ----------
  r = await s.json('POST', '/api/emails/seen', { items: [{ id: 'p1', ts: T.p1.emailIn }] });
  f = await flags();
  ok(r.status === 200 && r.body.cleared === 1 && f.p1.e === false, 'opening an email conversation marks it read', r.body);
  ok(f.p2.e === true && f.p3.e === true, 'nobody else\'s email is marked read', f);
  snap = await W.everything(s);
  r = await s.json('POST', '/api/emails/seen', { items: [{ id: 'p1', ts: T.p1.emailIn }] });
  ok(r.body.cleared === 0 && W.same(await W.everything(s), snap), 'marking an email read twice changes nothing', r.body);
  r = await s.json('POST', '/api/emails/seen', { items: [{ id: 'p2', ts: W.ago(60) }] });
  ok(r.body.cleared === 0 && (await flags()).p2.e === true, 'an email read mark older than their newest reply leaves it unread', r.body);
  // Set a text unread again so "all" can be shown to stay on its channel.
  await s.store.update((d) => { d.candidates.find((c) => c.id === 'p1').textUnread = true; });
  r = await s.json('POST', '/api/emails/seen', { all: true });
  f = await flags();
  ok(r.body.cleared === 2 && f.p2.e === false && f.p3.e === false, '"all" marks every email conversation read', { body: r.body, f });
  ok(f.p1.t === true, 'and leaves texts alone', f.p1);
  st = await W.state(s);
  ok(st.candidates.every((c) => !c.emailUnread), 'the page reads no unread email', st.candidates.map((c) => [c.id, c.emailUnread]));

  // ---------- texts: reply ----------
  snap = await W.everything(s);
  r = await s.json('POST', '/api/texts/reply', { id: 'p1', body: '   ' });
  ok(r.status === 400 && /type a message/i.test(r.body.error), 'an empty reply is refused', r);
  r = await s.json('POST', '/api/texts/reply', { id: 'nobody', body: 'Hello' });
  ok(r.status === 404, 'a reply to an unknown candidate is not found', r);
  r = await s.json('POST', '/api/texts/reply', { id: 'p3', body: 'Hello' });
  ok(r.status === 409 && /no mobile number/i.test(r.body.error), 'a reply to someone without a number is refused', r);
  r = await s.json('POST', '/api/texts/reply', { id: 'p4', body: 'Hello again' });
  ok(r.status === 409 && /STOP/.test(r.body.error), 'a reply to someone who said STOP is refused', r);
  ok(W.same(await W.everything(s), snap), 'refused replies queue nothing and change nothing');

  // A campaign text is waiting; the reply must still go first.
  r = await s.json('POST', '/api/texts/queue', { ids: ['p5'] });
  ok(r.status === 200 && r.body.added === 1, 'a campaign text is waiting in the queue', r.body);
  await s.store.update((d) => { d.candidates.find((c) => c.id === 'p2').textUnread = true; });
  const typed = 'Great — does 3pm {{tomorrow}} work? Call me at (617) 555-2999';
  r = await s.json('POST', '/api/texts/reply', { id: 'p1', body: `  ${typed}  ` });
  ok(r.status === 200 && r.body.ok && r.body.queued === true, 'a reply is queued', r.body);
  ok(r.body.relayOnline === false, 'and the page is told the Mac is not online yet', r.body);
  f = await flags();
  ok(f.p1.t === false, 'answering a thread marks it read', f);
  ok(f.p2.t === true, 'and only that thread', f);
  let thread = await s.json('GET', '/api/texts/thread?id=p1');
  ok(thread.body.pending.length === 1 && thread.body.pending[0].text === typed, 'the conversation shows the reply as on its way, as typed', thread.body.pending);
  st = await W.state(s);
  ok(st.texting.queue.pending >= 1, 'the texting page shows something waiting', st.texting.queue);

  const token = await W.relayToken(s);
  await W.relay(s, token, 'hello', { host: 'test-mac', version: '9.9.9', bluebubbles: true });
  const claim = await W.relay(s, token, 'claim');
  ok(claim.status === 200 && claim.body.job && claim.body.job.candidateId === 'p1', 'the Mac is handed the reply before any campaign text', claim.body);
  ok(claim.body.job && claim.body.job.body === typed, 'exactly as typed, placeholders and all', claim.body.job && claim.body.job.body);
  ok(claim.body.job && claim.body.job.phone === '+16175552001', 'to their number', claim.body.job && claim.body.job.phone);

  r = await s.json('POST', '/api/texts/reply', { id: 'p2', body: 'Base is $60k plus commission.' });
  ok(r.status === 200 && r.body.relayOnline === true, 'with the Mac checking in, the page is told it is online', r.body);
  ok((await flags()).p2.t === false, 'that reply leaves their thread read');

  ok(s.outsideCalls.length === 0 && s.sentMail.length === 0, 'nothing reached the outside world', s.outsideCalls);
  await s.close();
  done();
})().catch(crash);
