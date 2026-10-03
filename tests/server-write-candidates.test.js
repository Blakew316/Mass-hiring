// Editing a candidate (PATCH /api/candidates/:id) and adding one by hand
// (POST /api/candidates): what is stored, what the page reads back, what is
// refused, and that one team's edits never reach another team's list.
//
// Intentions pinned here, from the code's own comments:
//   - only the editable fields change; ids, history and unread flags do not
//   - an email is stored only if it is one plain, sendable address
//   - marking someone "Not interested" blocks their number at the text queue,
//     including a text already waiting to go out
//   - an edit that changes nothing leaves everything as it was
//   - adding someone already on the list (by any spelling of their mailbox,
//     or an address they are known by) is refused
const { ok, done, crash } = require('./helpers');
const W = require('./server-write-helpers');

(async () => {
  const s = await W.start(40);
  const people = [
    W.person(1, { notes: 'Met at the spring job fair' }),
    W.person(2, { phone: '', status: 'emailed', lastEmailedAt: W.ago(3000), lastSubject: 'Quick question' }),
    W.person(3, { status: 'replied', emailUnread: true, textUnread: true, lastTextedAt: W.ago(900), textStatus: 'delivered' }),
    W.person(4),
    W.person(5, { email: 'jordan.blake@gmail.com', altEmails: ['jb.work@example.org'] }),
  ];
  await W.seed(s, people);
  const before = await W.everything(s);

  // ---------- status ----------
  let r = await s.json('PATCH', '/api/candidates/p1', { status: 'emailed' });
  ok(r.status === 200 && r.body.ok === true, 'a status change is accepted', r);
  let c = await W.storedCandidate(s, 'p1');
  ok(c.status === 'emailed', 'the new status is stored', c.status);
  const { status: _s1, ...restNow } = c;
  const { status: _s0, ...restThen } = W.pick(before.db.candidates, 'p1');
  ok(W.same(restNow, restThen), 'nothing else about them changed', { restNow, restThen });
  let st = await W.state(s);
  ok(W.pick(st.candidates, 'p1').status === 'emailed', 'the page reads the new status');
  ok(st.stats.new === 2 && st.stats.emailed === 2, 'the dashboard counts move with it', st.stats);
  const othersNow = (await W.stored(s)).candidates.filter((x) => x.id !== 'p1');
  ok(W.same(othersNow, before.db.candidates.filter((x) => x.id !== 'p1')), 'nobody else on the list changed');

  // Every status the page's menus offer goes in and comes back as chosen.
  for (const status of ['replied', 'booked', 'bounced', 'new', 'emailed']) {
    r = await s.json('PATCH', '/api/candidates/p1', { status });
    st = await W.state(s);
    ok(r.status === 200 && (await W.storedCandidate(s, 'p1')).status === status && W.pick(st.candidates, 'p1').status === status && st.stats[status] >= 1,
      `status "${status}" is stored and read back`, { status: r.status, stats: st.stats });
  }

  // ---------- notes and the other editable fields ----------
  r = await s.json('PATCH', '/api/candidates/p1', { notes: '  Prefers a call after 5pm  ' });
  c = await W.storedCandidate(s, 'p1');
  ok(r.status === 200 && c.notes === 'Prefers a call after 5pm', 'notes are stored, trimmed', c.notes);
  ok(c.status === 'emailed', 'a notes edit leaves the status alone', c.status);

  // What the edit window sends: every field at once.
  r = await s.json('PATCH', '/api/candidates/p1', {
    firstName: 'Avery', lastName: 'Quinn-Hale', name: 'Avery Quinn-Hale',
    email: 'Avery Quinn <avery.qh@example.com>', phone: '(212) 555-2301',
    role: 'Senior Account Executive', company: 'Example Merchant Services', location: 'New York, NY',
    notes: 'Prefers a call after 5pm',
  });
  c = await W.storedCandidate(s, 'p1');
  ok(r.status === 200, 'the full edit form is accepted', r);
  ok(c.lastName === 'Quinn-Hale' && c.name === 'Avery Quinn-Hale' && c.role === 'Senior Account Executive'
    && c.company === 'Example Merchant Services' && c.location === 'New York, NY' && c.phone === '(212) 555-2301',
  'every editable field is stored as typed', c);
  ok(c.email === 'avery.qh@example.com', 'an address typed with a display name is stored as the bare address', c.email);
  st = await W.state(s);
  const shown = W.pick(st.candidates, 'p1');
  ok(shown.email === 'avery.qh@example.com' && shown.name === 'Avery Quinn-Hale' && shown.phone === '(212) 555-2301', 'the page reads the edited fields', shown);

  // Fields that are not the user's to type are never taken from the body.
  const guarded = await W.storedCandidate(s, 'p3');
  r = await s.json('PATCH', '/api/candidates/p3', {
    id: 'hijacked', addedAt: '2001-01-01T00:00:00.000Z', source: 'forged', lastTextedAt: null,
    emailUnread: false, textUnread: false, textStatus: 'failed', notes: 'Asked about commission',
  });
  c = await W.storedCandidate(s, 'p3');
  ok(r.status === 200 && c.notes === 'Asked about commission', 'an edit with extra fields still saves the editable ones', r.status);
  ok(c.id === 'p3' && c.addedAt === guarded.addedAt && c.source === guarded.source && c.lastTextedAt === guarded.lastTextedAt
    && c.emailUnread === true && c.textUnread === true && c.textStatus === 'delivered',
  'id, history, texting state and unread flags cannot be written through an edit', c);
  ok(!(await W.stored(s)).candidates.some((x) => x.id === 'hijacked'), 'no candidate appears under a forged id');

  // ---------- refusals change nothing ----------
  let snap = await W.everything(s);
  r = await s.json('PATCH', '/api/candidates/p2', { email: 'not-an-address', notes: 'should not save' });
  ok(r.status === 400 && /not a valid email/i.test(r.body.error), 'an invalid email is refused with a reason', r);
  r = await s.json('PATCH', '/api/candidates/p2', { email: '', status: 'replied' });
  ok(r.status === 400, 'a blank email is refused too', r);
  r = await s.json('PATCH', '/api/candidates/p2', { email: 'a@b.com\nBcc: everyone@example.com' });
  ok(r.status === 400, 'an address carrying a header line is refused', r);
  ok(W.same(await W.everything(s), snap), 'a refused edit stores nothing at all, not even its other fields');

  r = await s.json('PATCH', '/api/candidates/nobody-here', { status: 'emailed', notes: 'x' });
  ok(r.status >= 400 && r.status < 500 && /not found/i.test(r.body.error), 'an unknown id is a client error saying the candidate was not found', r);
  ok(W.same(await W.everything(s), snap), 'an edit to an unknown id creates and changes nothing');

  // ---------- an edit that changes nothing ----------
  const p2 = await W.storedCandidate(s, 'p2');
  const stateBefore = await W.state(s);
  snap = await W.everything(s);
  r = await s.json('PATCH', '/api/candidates/p2', {
    firstName: p2.firstName, lastName: p2.lastName, name: p2.name, email: p2.email, phone: p2.phone,
    role: p2.role, company: p2.company, location: p2.location, notes: p2.notes, status: p2.status,
  });
  ok(r.status === 200 && r.body.ok, 'saving an unchanged edit form is accepted', r);
  ok(W.same(await W.everything(s), snap), 'saving an unchanged edit form leaves everything stored as it was');
  ok(W.same(await W.state(s), stateBefore), 'and the page reads exactly the same state');
  r = await s.json('PATCH', '/api/candidates/p2', {});
  ok(r.status === 200 && W.same(await W.everything(s), snap), 'an empty edit changes nothing either');

  // ---------- "Not interested" blocks the number at the queue ----------
  // p4 has a textable number; queue a text for them first.
  r = await s.json('POST', '/api/texts/queue', { ids: ['p4'] });
  ok(r.status === 200 && r.body.added === 1, 'a text for p4 is waiting to go out', r.body);
  r = await s.json('PATCH', '/api/candidates/p4', { status: 'declined' });
  ok(r.status === 200, 'marking someone not interested is accepted', r);
  ok((await W.storedCandidate(s, 'p4')).status === 'declined', 'their status is declined');
  let q = await W.textQueue(s);
  ok(q.optOut.includes('+16175552004'), 'their number is on the opt-out list', q.optOut);
  ok(!q.items.some((i) => i.id === 'p4'), 'the text already waiting for them is taken out of the queue', q.items);
  st = await W.state(s);
  ok(st.texting.queue.optOut === 1 && st.texting.queue.pending === 0, 'the texting page shows one blocked number and nothing waiting', st.texting.queue);
  ok(st.texting.priority.blocked.p4 === 'asked to stop', 'the page is told why they cannot be texted', st.texting.priority.blocked.p4);
  let thread = await s.json('GET', '/api/texts/thread?id=p4');
  ok(thread.body.optedOut === true, 'their conversation shows them as opted out', thread.body);
  r = await s.json('POST', '/api/texts/reply', { id: 'p4', body: 'Just checking in' });
  ok(r.status === 409 && /STOP/.test(r.body.error), 'a reply to them is refused', r);

  // Putting them back by hand does not unblock the number: the list says
  // those numbers "will never be texted again".
  r = await s.json('PATCH', '/api/candidates/p4', { status: 'emailed' });
  ok(r.status === 200 && (await W.storedCandidate(s, 'p4')).status === 'emailed', 'their status can be changed back by hand');
  q = await W.textQueue(s);
  ok(q.optOut.includes('+16175552004'), 'their number stays blocked', q.optOut);

  // Declining someone with no number cannot block anything, and blocks no one else.
  r = await s.json('PATCH', '/api/candidates/p2', { status: 'declined' });
  q = await W.textQueue(s);
  ok(r.status === 200 && (await W.storedCandidate(s, 'p2')).status === 'declined' && q.optOut.length === 1,
    'declining someone without a number stores the status and blocks no other number', q.optOut);

  // ---------- adding someone by hand ----------
  const countBefore = (await W.stored(s)).candidates.length;
  r = await s.json('POST', '/api/candidates', {
    firstName: ' Taylor ', lastName: 'Reese ', name: 'Taylor Reese', email: ' taylor.reese@example.com ',
    phone: '(415) 555-2305', role: 'Sales Rep', company: 'Example Goods', location: 'Oakland, CA', notes: '',
  });
  ok(r.status === 200 && r.body.ok && r.body.candidate && r.body.candidate.id, 'a new candidate is added', r);
  const added = await W.storedCandidate(s, r.body.candidate.id);
  ok(added && added.email === 'taylor.reese@example.com' && added.firstName === 'Taylor' && added.lastName === 'Reese'
    && added.status === 'new' && added.source === 'manual' && added.addedAt,
  'they are stored trimmed, as new, from a manual source', added);
  st = await W.state(s);
  ok(st.stats.total === countBefore + 1 && W.pick(st.candidates, added.id), 'the page lists them', st.stats);

  snap = await W.everything(s);
  const refusals = [
    ['taylor.reese@example.com', 'the same address'],
    ['TAYLOR.REESE@EXAMPLE.COM', 'the same address in capitals'],
    ['Taylor <taylor.reese@example.com>', 'the same address with a display name'],
    ['Jordan.Blake+jobs@gmail.com', 'a Gmail spelling of an address on the list (dots and +tag)'],
    ['jb.work@example.org', 'an address someone on the list is already known by'],
  ];
  for (const [email, what] of refusals) {
    r = await s.json('POST', '/api/candidates', { firstName: 'Dup', lastName: 'Person', email });
    ok(r.status === 400 && /already exists/i.test(r.body.error), `adding ${what} is refused`, r);
  }
  r = await s.json('POST', '/api/candidates', { firstName: 'No', lastName: 'Address', email: 'nobody at example' });
  ok(r.status === 400 && /valid email/i.test(r.body.error), 'adding someone without a valid address is refused', r);
  ok(W.same(await W.everything(s), snap), 'a refused add stores nothing');

  // Only Gmail ignores dots: elsewhere a dotless spelling is a different mailbox.
  r = await s.json('POST', '/api/candidates', { firstName: 'Taylor', lastName: 'Reese', email: 'taylorreese@example.com' });
  ok(r.status === 200, 'outside Gmail, a differently dotted address is a different person', r);

  // ---------- writes that land at the same moment ----------
  // Several devices editing at once, a reply arriving from the Mac and a
  // Settings save: every one of them must be kept, none written over another.
  const token = await W.relayToken(s);
  const ids = (await W.stored(s)).candidates.map((x) => x.id);
  for (let round = 1; round <= 2; round++) {
    const replyText = `Round ${round}: yes, still interested`;
    const answers = await Promise.all([
      ...ids.map((id) => s.json('PATCH', `/api/candidates/${id}`, { notes: `Round ${round} note for ${id}` })),
      W.relay(s, token, 'events', { events: [{ phone: '+16175552003', kind: 'reply', ts: W.ago(10 - round), text: replyText }] }),
      s.json('POST', '/api/settings', { fromName: `Recruiter round ${round}` }),
    ]);
    const db = await W.stored(s);
    ok(answers.every((a) => a.status === 200), `round ${round}: every simultaneous write is accepted`, answers.map((a) => a.status));
    ok(ids.every((id) => W.pick(db.candidates, id).notes === `Round ${round} note for ${id}`), `round ${round}: every simultaneous edit is kept`, db.candidates.map((x) => x.notes));
    ok(W.pick(db.candidates, 'p3').textThread.some((m) => m.text === replyText) && db.settings.fromName === `Recruiter round ${round}`, `round ${round}: the reply and the settings saved alongside them are kept too`);
    ok(db.candidates.length === ids.length, `round ${round}: nobody is lost or doubled`, db.candidates.length);
  }

  // ---------- one team's edits never reach another's ----------
  const b = await W.secondTeam(s, 'Harbor Crew', '4826');
  const aBefore = await W.everything(s);
  r = await b.json('PATCH', '/api/candidates/p1', { status: 'declined', notes: 'from the other team' });
  ok(r.status >= 400 && r.status < 500, 'another team cannot edit this team\'s candidate by id', r);
  r = await b.json('POST', '/api/candidates', { firstName: 'Avery', lastName: 'Quinn', email: 'avery.qh@example.com' });
  ok(r.status === 200, 'another team may add the same person to its own list', r);
  const bState = await W.state(s, b.json);
  ok(bState.candidates.length === 1 && bState.candidates[0].email === 'avery.qh@example.com', 'the other team sees only its own list', bState.candidates.map((x) => x.email));
  ok(W.same(await W.everything(s), aBefore), 'nothing the other team did changed this team\'s data');
  const aState = await W.state(s);
  ok(aState.candidates.length === aBefore.db.candidates.length && W.pick(aState.candidates, 'p1').status === 'emailed', 'this team\'s page is unchanged');

  ok(s.outsideCalls.length === 0 && s.sentMail.length === 0, 'nothing reached the outside world', { outside: s.outsideCalls, mail: s.sentMail.length });
  await s.close();
  done();
})().catch(crash);
