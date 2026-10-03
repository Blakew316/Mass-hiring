// The state's tag. An unchanged poll is answered 304 with no body; anything
// the page draws changing gives a 200 with a new tag; the Mac relay checking
// in every 30 seconds does not by itself defeat the 304; and a tag from one
// team never answers 304 for another — nor does a change in one team move the
// other's tag or show in its state. The Sales IQ page's state is tagged the
// same way.
const { startApp, R, ok, done, crash } = require('./helpers');
const { guardOutside, stubSenders, addTeam, inTeam, getState, ago, daysAgo } = require('./server-read-helpers');

(async () => {
  const refused = guardOutside();
  // Google's status is the app's own, from a stored token record that has not
  // expired (so nothing leaves the machine): connecting and disconnecting are
  // then real changes to what is stored, as they are in use.
  const s = await startApp({ offset: 2, stub: false });
  const sent = stubSenders();
  const storage = require(R('lib/storage.js'));
  const textQueue = require(R('lib/text-queue.js'));
  const salesiq = require(R('lib/salesiq.js'));
  const onboarding = require(R('lib/onboarding.js'));
  const backups = require(R('lib/backups.js'));

  const tokens = { access_token: 'test-access-token', expires_at: Date.now() + 3600 * 1000, email: 'maverick.sender@example.com', signature: '' };
  await storage.setJson('tokens', tokens);
  await s.store.update((d) => {
    d.candidates = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`, name: `Maverick Person ${i}`, email: `maverick.${i}@example.com`, phone: `(617) 555-24${String(i).padStart(2, '0')}`,
      role: 'Account Executive', status: ['new', 'emailed', 'replied'][i % 3], addedAt: daysAgo(30 + i), lastEmailedAt: i % 3 ? daysAgo(10) : null, source: 'csv',
    }));
  });

  // ---------- unchanged: 304 ----------
  const a1 = await getState(s);
  ok(a1.status === 200 && a1.tag && a1.body && a1.body.candidates.length === 12, 'the first look is a 200 with a tag', { status: a1.status, tag: a1.tag });
  ok(/no-cache/.test(a1.cache) && /private/.test(a1.cache), 'the state is never served from a cache without asking, and never from a shared one', a1.cache);
  const a2 = await getState(s, a1.tag);
  ok(a2.status === 304 && a2.text === '', 'asking again with that tag, nothing changed: 304 and no body', a2.status);
  ok(a2.tag === a1.tag, 'the 304 carries the same tag', a2.tag);
  const a3 = await getState(s, a1.tag);
  ok(a3.status === 304, 'and again', a3.status);
  const plain = await getState(s);
  ok(plain.status === 200 && plain.tag === a1.tag, 'with no tag, the same state gives the same tag', plain.tag);
  const junk = await getState(s, 'W/"not-the-tag"');
  ok(junk.status === 200 && junk.tag === a1.tag, 'a tag that is not current gets the state', junk.status);

  // ---------- each kind of change gives a 200 with a new tag ----------
  // One change at a time: the old tag must stop matching, the new state must
  // show the change, and the new tag must then answer 304.
  let tag = a1.tag;
  async function changed(what, change, check) {
    await change();
    const r = await getState(s, tag);
    const fresh = r.status === 200 && r.tag && r.tag !== tag;
    ok(fresh, `${what}: 200 with a new tag`, { status: r.status, same: r.tag === tag });
    if (check) ok(r.body && check(r.body), `${what}: the new state shows it`);
    const again = await getState(s, r.tag || tag);
    ok(again.status === 304, `${what}: then the new tag answers 304`, again.status);
    tag = r.tag || tag;
  }

  await changed('a candidate added through the app', async () => {
    const r = await s.json('POST', '/api/candidates', { name: 'Quinn Added', email: 'quinn.added@example.com', phone: '(617) 555-2499', role: 'Account Executive' });
    if (r.status !== 200) throw new Error(`add failed ${r.status}`);
  }, (b) => b.candidates.some((c) => c.email === 'quinn.added@example.com') && b.stats.total === 13);
  await changed('a candidate edited through the app', async () => {
    const r = await s.json('PATCH', '/api/candidates/m1', { notes: 'Prefers mornings' });
    if (r.status !== 200) throw new Error(`patch failed ${r.status}`);
  }, (b) => b.candidates.find((c) => c.id === 'm1').notes === 'Prefers mornings');
  await changed('an unread flag set on the server', () => s.store.update((d) => { d.candidates.find((c) => c.id === 'm2').emailUnread = true; }),
    (b) => b.candidates.find((c) => c.id === 'm2').emailUnread === true);
  await changed('a feed entry', () => s.store.addEvent('opened', 'Maverick Person 1 opened your email.', 'm1'),
    (b) => b.events.some((e) => e.type === 'opened' && e.candidateId === 'm1'));
  await changed('a warning', () => s.store.addErrorOnce('Something needs a look.'), (b) => b.lastError === 'Something needs a look.');
  await changed('a setting', () => s.store.update((d) => { d.settings.fromName = 'Morgan Sender'; }), (b) => b.settings.fromName === 'Morgan Sender');
  await changed('an interview', () => s.store.update((d) => { d.interviews = [{ uri: 'https://api.calendly.com/scheduled_events/e1/invitees/i1', inviteeEmail: 'maverick.0@example.com', inviteeName: 'Maverick Person 0', start: daysAgo(-1), status: 'active', name: 'Intro' }]; }),
    (b) => b.interviews.length === 1);
  await changed('the email template', async () => {
    const r = await s.json('POST', '/api/template', { subject: 'A new subject for {{firstName}}', body: 'Hello {{firstName}}' });
    if (r.status !== 200) throw new Error(`template failed ${r.status}`);
  }, (b) => b.template.subject === 'A new subject for {{firstName}}');
  await changed('the email queue', () => storage.setJson('queue', { items: [{ id: 'm0', t: 'k' }], templates: { k: { subject: 'x', body: 'y' } }, total: 1, sent: 0 }),
    (b) => b.queue.pending === 1 && b.queue.active === true);
  await changed('an opt-out in the text queue', () => textQueue.updateQ((q) => { textQueue.addOptOut(q, '(617) 555-2401'); }),
    (b) => b.texting.queue.optOut === 1 && b.texting.priority.blocked.m1 === 'asked to stop');
  await changed('the Sales IQ list', () => salesiq.update((doc) => { doc.candidates.unshift({ id: 'cq1', name: 'Maverick Person 3', email: 'maverick.3@example.com', status: 'invited' }); }),
    (b) => b.salesiq.byEmail['maverick.3@example.com'] && b.salesiq.byEmail['maverick.3@example.com'].status === 'invited');
  await changed('the onboarding pipeline', () => onboarding.update((doc) => { doc.hires.unshift({ id: 'h1', email: 'maverick.4@example.com', signedAt: ago(1), reference: 'R1' }); }),
    (b) => b.onboarding.byEmail['maverick.4@example.com'] && b.onboarding.byEmail['maverick.4@example.com'].signedAt);
  await changed('a backup', () => backups.snapshot('manual'), (b) => b.backups.length === 1);
  ok(a1.body.google.connected === true && a1.body.sending.from === 'maverick.sender@example.com', 'Google starts connected', a1.body.google);
  await changed('Google disconnected from Settings', async () => {
    const r = await s.json('POST', '/auth/google/disconnect');
    if (r.status !== 200) throw new Error(`disconnect failed ${r.status}`);
  }, (b) => b.google.connected === false && b.sending.ready === false);
  await changed('Google connected again', () => storage.setJson('tokens', { ...tokens, email: 'maverick.other@example.com' }),
    (b) => b.google.connected === true && b.google.email === 'maverick.other@example.com' && b.sending.from === 'maverick.other@example.com');
  await changed('a candidate removed through the app', async () => {
    const r = await s.json('DELETE', '/api/candidates/m11');
    if (r.status !== 200) throw new Error(`delete failed ${r.status}`);
  }, (b) => !b.candidates.some((c) => c.id === 'm11'));

  // ---------- the Mac relay checking in ----------
  await changed('a relay token generated', async () => {
    const r = await s.json('POST', '/api/texts/relay-token');
    if (r.status !== 200 || !r.body.token) throw new Error(`token failed ${r.status}`);
    s.relayToken = r.body.token;
  }, (b) => b.texting.tokenSet === true);
  const relay = (path, body) => fetch(`${s.base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${s.relayToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const hello = (bluebubbles = true) => relay('/api/relay/hello', { host: 'Example-Mac', version: '1.0.0', backend: 'applescript', bluebubbles });
  await changed('the relay coming online', async () => {
    const r = await hello();
    if (r.status !== 200) throw new Error(`hello failed ${r.status}`);
  }, (b) => b.texting.queue.relay.online === true && b.texting.queue.relay.host === 'Example-Mac');
  // Its next check-ins only move the time it was last seen.
  await new Promise((r) => setTimeout(r, 20));   // enough for a later timestamp
  const h2 = await hello();
  const afterHello = await getState(s, tag);
  ok(h2.status === 200 && afterHello.status === 304, 'the relay saying hello again while online does not change the tag', afterHello.status);
  const seen1 = (await storage.getJson('relay')).lastSeenAt;
  await new Promise((r) => setTimeout(r, 20));   // enough for a later timestamp
  await hello();
  const seen2 = (await storage.getJson('relay')).lastSeenAt;
  const afterHello2 = await getState(s, tag);
  ok(seen2 !== seen1 && afterHello2.status === 304, 'nor does the next one, though its last-seen time moved', { seen1, seen2, status: afterHello2.status });
  // What the Texting page's chip says about the Mac ("Example-Mac online ·
  // Messages not answering") does change the tag.
  await changed('the relay reporting Messages not answering', async () => {
    const r = await hello(false);
    if (r.status !== 200) throw new Error(`hello failed ${r.status}`);
  }, (b) => b.texting.queue.relay.online === true && b.texting.queue.relay.bluebubbles === false);
  await changed('the relay going quiet', () => storage.updateJson('relay', (cur) => ({ ...cur, lastSeenAt: new Date(Date.now() - 5 * 60000).toISOString() })),
    (b) => b.texting.queue.relay.online === false && Boolean(b.texting.queue.relay.lastSeenAt));

  // ---------- two teams ----------
  const B = await addTeam(s, { name: 'Team Blue', pin: '4826' });
  await inTeam(B.id, () => s.store.update((d) => {
    d.candidates = [{ id: 'b1', name: 'Blue Person', email: 'blue.person@example.com', phone: '(312) 555-2601', status: 'new', addedAt: daysAgo(3), source: 'manual' }];
  }));
  const aNow = await getState(s, tag);
  ok(aNow.status === 304, 'making another team does not change this team\'s tag', aNow.status);
  const b1 = await getState(B);
  ok(b1.status === 200 && b1.body.team.id === B.id && b1.body.candidates.length === 1 && b1.body.candidates[0].id === 'b1', 'the other team sees its own state', b1.body && b1.body.team);
  ok(b1.tag && b1.tag !== tag, 'with its own tag', b1.tag);
  const bWithA = await getState(B, tag);
  ok(bWithA.status === 200 && bWithA.body.team.id === B.id, 'this team\'s tag never answers 304 for the other team', bWithA.status);
  const aWithB = await getState(s, b1.tag);
  ok(aWithB.status === 200 && aWithB.body.team.id === 'maverick', 'nor the other\'s for this one', aWithB.status);
  ok(!b1.text.includes('maverick.0@example.com') && !b1.text.includes('Maverick Person'), 'nothing of this team\'s list is in the other team\'s state');

  // A change in one team moves only that team's tag.
  await s.json('POST', '/api/candidates', { name: 'Only Maverick', email: 'only.maverick@example.com' });
  const bAfterA = await getState(B, b1.tag);
  ok(bAfterA.status === 304, 'a change in this team leaves the other team\'s tag answering 304', bAfterA.status);
  const aAfterA = await getState(s, tag);
  ok(aAfterA.status === 200 && aAfterA.body.candidates.some((c) => c.email === 'only.maverick@example.com'), 'and gives this team a 200', aAfterA.status);
  tag = aAfterA.tag;
  const bAdd = await B.json('POST', '/api/candidates', { name: 'Only Blue', email: 'only.blue@example.com' });
  ok(bAdd.status === 200, 'the other team adds someone', bAdd.status);
  const aAfterB = await getState(s, tag);
  ok(aAfterB.status === 304, 'a change in the other team leaves this team\'s tag answering 304', aAfterB.status);
  const bAfterB = await getState(B, b1.tag);
  ok(bAfterB.status === 200 && bAfterB.body.candidates.some((c) => c.email === 'only.blue@example.com') && !bAfterB.body.candidates.some((c) => c.email === 'only.maverick@example.com'),
    'the other team sees its own addition and not this team\'s', bAfterB.body && bAfterB.body.candidates.map((c) => c.email));
  const aFull = await getState(s);
  ok(!aFull.body.candidates.some((c) => c.email === 'only.blue@example.com'), 'this team never sees the other team\'s addition');
  // Same feed, settings and queue changes in the other team stay there.
  await inTeam(B.id, () => s.store.addEvent('opened', 'Blue Person opened your email.', 'b1'));
  await inTeam(B.id, () => textQueue.updateQ((q) => { textQueue.addOptOut(q, '(617) 555-2402'); }));
  await inTeam(B.id, () => s.store.update((d) => { d.settings.fromName = 'Blue Sender'; }));
  const aQuiet = await getState(s, tag);
  ok(aQuiet.status === 304, 'the other team\'s feed, opt-outs and settings do not move this team\'s tag', aQuiet.status);
  const bLoud = await getState(B);
  ok(bLoud.body.events.some((e) => e.message === 'Blue Person opened your email.') && bLoud.body.settings.fromName === 'Blue Sender' && bLoud.body.texting.queue.optOut === 1,
    'they show in the other team\'s state', { fromName: bLoud.body.settings.fromName, optOut: bLoud.body.texting.queue.optOut });
  ok(!aQuiet.text && aFull.body.events.every((e) => e.message !== 'Blue Person opened your email.') && aFull.body.settings.fromName === 'Morgan Sender', 'and not in this one\'s');

  // ---------- the Sales IQ page's state ----------
  const iq1 = await s.call('GET', '/api/iq/state');
  const iqTag = iq1.headers.get('etag');
  const iqBody = await iq1.json();
  ok(iq1.status === 200 && iqTag && iqBody.ok === true && /no-cache/.test(iq1.headers.get('cache-control') || ''), 'the Sales IQ state is tagged too', iq1.status);
  const iq2 = await s.call('GET', '/api/iq/state', null, { 'If-None-Match': iqTag });
  ok(iq2.status === 304, 'unchanged, it answers 304', iq2.status);
  await salesiq.update((doc) => { doc.candidates.unshift({ id: 'cq2', name: 'Maverick Person 5', email: 'maverick.5@example.com', status: 'added', added: ago(1), source: 'manual' }); });
  const iq3 = await s.call('GET', '/api/iq/state', null, { 'If-None-Match': iqTag });
  const iq3Body = iq3.status === 200 ? await iq3.json() : null;
  ok(iq3.status === 200 && iq3.headers.get('etag') !== iqTag && iq3Body.candidates.some((c) => c.id === 'cq2'), 'after a change it answers 200 with a new tag', iq3.status);
  const iqB = await B.call('GET', '/api/iq/state', null, { 'If-None-Match': iq3.headers.get('etag') });
  const iqBBody = iqB.status === 200 ? await iqB.json() : null;
  ok(iqB.status === 200 && iqBBody.hostTeam.id === B.id && !iqBBody.candidates.some((c) => c.id === 'cq2'), 'one team\'s Sales IQ tag never answers 304 for another', iqB.status);

  ok(sent.count() === 0, 'nothing was sent', sent);
  ok(refused.length === 0, 'nothing reached outside this machine', refused);
  await s.close();
  done();
})().catch(crash);
