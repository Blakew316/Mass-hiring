// The Calendly sync (POST /api/calendly/sync), with Calendly's listing
// answered by the test.
//
// Intentions pinned here, from the code's own comments:
//   - a booking is matched to a candidate by address, then by a unique full
//     name (people book with another address); the address is learned
//   - a booking is announced once in Candidate updates, however many syncs see
//     it, and whichever of the sync and the webhook sees it first; the sync
//     itself never pushes to the phone
//   - a cancellation un-books them (back to replied or emailed) once
//   - a status set by hand (declined) is not overridden by a booking
//   - a Calendly failure is shown, and cleared by the next good sync
const crypto = require('crypto');
const { ok, done, crash } = require('./helpers');
const W = require('./server-write-helpers');

(async () => {
  const s = await W.start(65);
  let listing = [];
  let failWith = null;
  s.calendly.listInterviews = async () => {
    if (failWith) throw new Error(failWith);
    return { interviews: structuredClone(listing), skipped: [], complete: true, schedulingUrl: 'https://calendly.com/pat-example' };
  };
  const day = 86400000;
  const at = (days, hour) => { const d = new Date(Date.now() + days * day); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
  const event = (n, invitee, { status = 'active', name = 'Intro call', start = at(2 + n, 15) } = {}) => ({
    uri: `https://api.calendly.com/scheduled_events/ev-${n}`, name, status, start,
    end: new Date(Date.parse(start) + 30 * 60000).toISOString(), joinUrl: `https://meet.example.com/ev-${n}`, locationType: 'zoom',
    invitees: [{ name: invitee.name, email: invitee.email, status: status === 'active' ? 'active' : 'canceled', createdAt: W.ago(10 + n), phone: '', rescheduleUrl: '', cancelUrl: '' }],
  });

  await W.seed(s, [
    W.person(1, { status: 'emailed', lastEmailedAt: W.ago(3000) }),
    W.person(2, { status: 'replied', lastEmailedAt: W.ago(3000), replies: [{ id: 'm2', date: W.ago(2000), text: 'Sounds good', snippet: 'Sounds good', kind: '' }], lastReplyAt: W.ago(2000) }),
    W.person(3, { status: 'declined' }),
    W.person(4, { status: 'emailed', lastEmailedAt: W.ago(3000) }),
  ]);
  const lines = async (type, id) => W.storedEvents(s, type, id);

  // ---------- not set up ----------
  let snap = await W.everything(s);
  let r = await s.json('POST', '/api/calendly/sync');
  ok(r.status === 200 && r.body.ok && /Calendly token/.test(r.body.unavailable || ''), 'without a Calendly token the sync says what is missing', r.body);
  ok(W.same(await W.everything(s), snap), 'and changes nothing');

  await s.json('POST', '/api/settings', { calendlyToken: 'cal-test-token', timeZone: 'America/New_York' });
  r = await s.json('POST', '/api/calendly/sync');
  let st = await W.state(s);
  ok(r.body.ok && r.body.interviews === 0 && r.body.newBookings === 0, 'an empty calendar finds nothing', r.body);
  ok(st.calendly.syncEnabled === true && st.calendly.lastSyncAt && st.calendly.error === '' && st.events.length === 0, 'the page shows the sync ran, with nothing announced', st.calendly);

  // ---------- a booking, by address ----------
  const ev1 = event(1, { name: 'Avery Quinn', email: 'Avery.Quinn@Example.com' });
  listing = [ev1];
  r = await s.json('POST', '/api/calendly/sync');
  let c = await W.storedCandidate(s, 'p1');
  ok(r.body.ok && r.body.interviews === 1 && r.body.newBookings === 1, 'a booking is found', r.body);
  ok(c.status === 'booked' && c.bookedAt === ev1.start && c.bookedEvent === 'Intro call' && c.bookedJoinUrl === ev1.joinUrl, 'it is matched to them by address and books them', c);
  let booked = await lines('booked', 'p1');
  ok(booked.length === 1 && booked[0].message.startsWith('Avery Quinn booked "Intro call" — '), 'Candidate updates says so', booked);
  st = await W.state(s);
  const iv = st.interviews.find((i) => i.uri === ev1.uri);
  ok(iv && iv.candidateId === 'p1' && iv.status === 'active' && iv.start === ev1.start, 'the interview is listed against them', iv);
  ok(W.pick(st.candidates, 'p1').status === 'booked' && W.pick(st.candidates, 'p1').bookedEvent === 'Intro call' && st.stats.booked === 1, 'the page reads them booked', st.stats);

  r = await s.json('POST', '/api/calendly/sync');
  ok(r.body.newBookings === 0 && (await lines('booked', 'p1')).length === 1, 'the same booking seen again is not announced again', r.body);

  // ---------- by name, from another address ----------
  const ev2 = event(2, { name: 'Jordan Blake', email: 'jb.personal@example.org' });
  listing = [ev1, ev2];
  r = await s.json('POST', '/api/calendly/sync');
  c = await W.storedCandidate(s, 'p2');
  ok(r.body.newBookings === 1 && c.status === 'booked' && (await lines('booked', 'p2')).length === 1, 'a booking under another address is matched by their full name', r.body);
  r = await s.json('POST', '/api/candidates', { firstName: 'Jordan', lastName: 'Blake', email: 'jb.personal@example.org' });
  ok(r.status === 400, 'the address they booked with is now known as theirs', r);

  // ---------- a status set by hand, and a stranger ----------
  const ev3 = event(3, { name: 'Casey Morgan', email: 'casey.morgan@example.com' });
  const ev4 = event(4, { name: 'Pat Unknown', email: 'pat.unknown@example.net' });
  listing = [ev1, ev2, ev3, ev4];
  const before = await W.stored(s);
  r = await s.json('POST', '/api/calendly/sync');
  c = await W.storedCandidate(s, 'p3');
  ok(c.status === 'declined', 'a booking does not undo "Not interested" set by hand', c.status);
  ok((await lines('booked', 'p3')).length === 1, 'though the booking is still announced');
  st = await W.state(s);
  const stranger = st.interviews.find((i) => i.uri === ev4.uri);
  ok(stranger && stranger.candidateId === null && stranger.inviteeEmail === 'pat.unknown@example.net', 'a booking by someone not on the list is listed unmatched', stranger);
  ok((await W.stored(s)).events.length === before.events.length + 1, 'and announces nothing for them');
  ok((await W.stored(s)).candidates.length === before.candidates.length, 'and adds nobody to the list');

  // ---------- cancellations ----------
  listing = [event(1, { name: 'Avery Quinn', email: 'avery.quinn@example.com' }, { status: 'canceled', start: ev1.start }), { ...ev2, status: 'canceled', invitees: ev2.invitees.map((i) => ({ ...i, status: 'canceled' })) }, ev3, ev4];
  r = await s.json('POST', '/api/calendly/sync');
  c = await W.storedCandidate(s, 'p1');
  ok(c.status === 'emailed' && !c.bookedAt && c.bookedEvent === '' && c.bookedJoinUrl === '', 'a cancellation un-books them, back to emailed', c);
  ok((await W.storedCandidate(s, 'p2')).status === 'replied', 'someone who had replied goes back to replied', (await W.storedCandidate(s, 'p2')).status);
  let canceled = await lines('canceled', 'p1');
  ok(canceled.length === 1 && canceled[0].message === 'Avery Quinn canceled "Intro call".', 'Candidate updates says they canceled', canceled);
  st = await W.state(s);
  ok(st.interviews.find((i) => i.uri === ev1.uri).status === 'canceled' && st.stats.booked === 0, 'the page shows the interview canceled and nobody booked', st.stats);
  r = await s.json('POST', '/api/calendly/sync');
  ok((await lines('canceled', 'p1')).length === 1 && (await lines('canceled', 'p2')).length === 1, 'a cancellation seen again is not announced again');
  ok(s.pushes.length === 0, 'the sync never pushes to the phone', s.pushes);

  // ---------- a failure ----------
  failWith = 'Calendly API error (401)';
  const quiet = await W.stored(s);
  r = await s.json('POST', '/api/calendly/sync');
  st = await W.state(s);
  ok(r.body.ok === false && r.body.error === 'Calendly API error (401)', 'a Calendly failure is reported', r.body);
  ok(st.calendly.error === 'Calendly API error (401)', 'and shown on the page', st.calendly);
  ok(W.same((await W.stored(s)).candidates, quiet.candidates) && W.same((await W.stored(s)).interviews, quiet.interviews), 'and nobody\'s booking changes because of it');
  failWith = null;
  r = await s.json('POST', '/api/calendly/sync');
  ok(r.body.ok && (await W.state(s)).calendly.error === '' && r.body.newBookings === 0, 'the next good sync clears it, with nothing new to announce', r.body);

  // ---------- the webhook got there first ----------
  const key = crypto.randomBytes(32).toString('hex');
  await s.store.update((d) => { d.settings.calendlySigningKeys = [key]; d.settings.calendlySigningKey = key; });
  const ev5 = event(5, { name: 'Riley Parker', email: 'riley.parker@example.com' });
  const payload = JSON.stringify({ event: 'invitee.created', payload: {
    email: 'riley.parker@example.com', name: 'Riley Parker', created_at: W.ago(2),
    scheduled_event: { uri: ev5.uri, name: 'Intro call', start_time: ev5.start, end_time: ev5.end, location: { join_url: ev5.joinUrl } },
  } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', key).update(`${t}.${payload}`).digest('hex');
  const hook = await fetch(`${s.base}/webhooks/calendly/maverick`, { method: 'POST', headers: { 'content-type': 'application/json', 'Calendly-Webhook-Signature': `t=${t},v1=${sig}` }, body: payload });
  ok(hook.status === 200 && (await W.storedCandidate(s, 'p4')).status === 'booked', 'a signed webhook books them', hook.status);
  ok((await lines('booked', 'p4')).length === 1 && s.pushes.length === 1, 'and announces it once, with a push', s.pushes);
  listing = [...listing, ev5];
  r = await s.json('POST', '/api/calendly/sync');
  ok(r.body.newBookings === 0 && (await lines('booked', 'p4')).length === 1 && s.pushes.length === 1, 'the sync that lists it next does not announce it again', r.body);

  ok(s.outsideCalls.length === 0 && s.sentMail.length === 0, 'nothing reached the outside world', s.outsideCalls);
  await s.close();
  done();
})().catch(crash);
