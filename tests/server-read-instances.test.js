// Several instances, one store. The site is one Netlify Function, and Netlify
// runs as many copies of it as the traffic needs, each answering whoever
// reaches it, all reading and writing the same storage ("a save is visible to
// the very next read, from any device" — lib/storage.js). So what another
// instance saves must be what this one shows on its very next read, and a
// state tag this one handed out must stop answering 304 the moment it is stale
// — however this instance remembers things between requests:
//  - the feed, a warning, interviews, a candidate, Sales IQ, onboarding and a
//    backup written elsewhere show here at once, with a new tag;
//  - a write elsewhere to one team never moves the other team's tag here, nor
//    shows in its state;
//  - a relay token or Sales IQ code regenerated elsewhere is the one this
//    instance's Settings shows, and the replaced Sales IQ code stops working
//    here at once;
//  - the team list is shared too: a team renamed, made, signed out everywhere
//    or deleted on another instance is renamed, listed, signed out or gone
//    here on the very next request;
//  - and reading — every read route, answered 200 or 304 — writes nothing.
// The other instance is a separate Node process on the same data folder
// (server-read-helpers.js elsewhere()).
const { startApp, ok, done, crash } = require('./helpers');
const { guardOutside, stubSenders, addTeam, inTeam, as, getState, elsewhere, dataSnapshot, ago, daysAgo } = require('./server-read-helpers');

(async () => {
  const refused = guardOutside();
  const s = await startApp({ offset: 9 });
  const sent = stubSenders();

  await s.store.update((d) => {
    d.candidates = [
      { id: 'i1', name: 'Ira Instance', firstName: 'Ira', email: 'ira@example.com', phone: '(617) 555-2901', role: 'Account Executive', status: 'emailed', addedAt: daysAgo(10), source: 'csv',
        lastEmailedAt: daysAgo(4), gmailThreadId: 'gthread-i1', lastSubject: 'Hello Ira', lastTextedAt: ago(60), textUnread: true,
        textThread: [{ dir: 'out', ts: ago(60), text: 'Hi Ira, quick question?' }, { dir: 'in', ts: ago(30), text: 'Ira reply' }] },
      { id: 'i2', name: 'Jo Instance', email: 'jo@example.com', phone: '(617) 555-2902', role: 'Solar Rep', status: 'new', addedAt: daysAgo(3), source: 'manual' },
    ];
  });
  const B = await addTeam(s, { name: 'Team Teal', pin: '7392' });
  await inTeam(B.id, () => s.store.update((d) => {
    d.candidates = [{ id: 't1', name: 'Tay Teal', email: 'tay@example.com', phone: '(312) 555-2903', status: 'new', addedAt: daysAgo(2), source: 'manual' }];
  }));

  const a0 = await getState(s);
  const b0 = await getState(B);
  ok(a0.status === 200 && b0.status === 200 && a0.body.candidates.length === 2 && b0.body.candidates.length === 1, 'each team sees its own list', { a: a0.status, b: b0.status });

  // ---------- reading writes nothing ----------
  const before = dataSnapshot();
  const me = as(s, s.cookie);
  const anon = as(s, null);
  const reads = [
    ['GET', '/api/state'],
    ['GET', '/api/texts/thread?id=i1'],
    ['GET', '/api/emails/thread?id=i1'],
    ['GET', '/api/texts/relay-token'],
    ['GET', '/api/salesiq-connection'],
    ['GET', '/api/onboarding/status'],
    ['GET', '/api/onboarding/saved'],
    ['GET', '/api/onboarding/hires'],
    ['GET', '/api/onboarding/packet/documents'],
    ['GET', '/api/backups'],
    ['GET', '/api/candidates/export'],
    ['GET', '/api/template/attachments/builtin-account-executive/preview'],
    ['GET', '/api/auth/status'],
    ['GET', '/api/teams'],
    ['POST', '/api/preview', { candidateId: 'i1' }],
    ['POST', '/api/preview', { candidateId: 'i1', followUp: true }],
    ['POST', '/api/texts/preview', { id: 'i1' }],
    ['POST', '/api/texts/preview', {}],
  ];
  const answered = [];
  for (const [method, url, body] of reads) answered.push(`${url}:${(await me.json(method, url, body)).status}`);
  answered.push(`304:${(await getState(s, a0.tag)).status}`);
  answered.push(`B:${(await getState(B, b0.tag)).status}`);
  answered.push(`B-thread:${(await B.json('GET', '/api/texts/thread?id=i1')).status}`);
  answered.push(`anon-state:${(await anon.json('GET', '/api/state')).status}`);
  answered.push(`anon-auth:${(await anon.json('GET', '/api/auth/status')).status}`);
  ok(answered.slice(0, reads.length).every((x) => /:200$/.test(x)) && answered.slice(reads.length).join() === '304:304,B:304,B-thread:404,anon-state:401,anon-auth:200',
    'every read route answers (200, a 304 for an unchanged state, 404 for the other team\'s id, 401 signed out)', answered);
  ok(dataSnapshot() === before, 'and none of those reads, by either team or by nobody, wrote anything to storage');
  const stored = await s.store.load();
  ok(stored.candidates.find((c) => c.id === 'i1').textUnread === true, 'the unread flag a read might be tempted to clear is still set');

  // ---------- this team's records, written on another instance ----------
  let tagA = a0.tag;
  let tagB = b0.tag;
  async function seenHere(what, fn, arg, check) {
    await elsewhere('maverick', fn, arg);
    const r = await getState(s, tagA);
    ok(r.status === 200 && r.tag && r.tag !== tagA, `${what} on another instance: this instance's next poll is a 200 with a new tag`, r.status);
    ok(r.body && check(r.body), `${what} on another instance: and shows it`);
    ok((await getState(s, r.tag || tagA)).status === 304, `${what} on another instance: then 304 again`);
    ok((await getState(B, tagB)).status === 304, `${what} on another instance: the other team's tag still answers 304`);
    tagA = r.tag || tagA;
  }
  await seenHere('a feed entry', ({ store }) => store.addEvent('replied', 'Ira Instance replied.', 'i1'), null,
    (st) => st.events.some((e) => e.type === 'replied' && e.message === 'Ira Instance replied.' && e.candidateId === 'i1'));
  await seenHere('a warning', ({ store }) => store.addErrorOnce('Gmail refused a send elsewhere.'), null,
    (st) => st.lastError === 'Gmail refused a send elsewhere.' && Boolean(st.lastErrorId));
  await seenHere('an interview booked', ({ store }, at) => store.update((d) => {
    d.interviews = [{ uri: 'https://api.calendly.com/scheduled_events/x1/invitees/y1', inviteeEmail: 'ira@example.com', inviteeName: 'Ira Instance', start: at, name: '15 Minute Intro', status: 'active', candidateId: 'i1' }];
  }), daysAgo(-1), (st) => st.interviews.length === 1 && st.interviews[0].inviteeEmail === 'ira@example.com');
  await seenHere('a candidate marked replied and unread', ({ store }) => store.update((d) => {
    const c = d.candidates.find((x) => x.id === 'i2');
    c.status = 'replied'; c.emailUnread = true;
  }), null, (st) => {
    const c = st.candidates.find((x) => x.id === 'i2');
    return c.status === 'replied' && c.emailUnread === true && st.stats.replied === 1 && st.stats.new === 0;
  });
  await seenHere('a finished Sales IQ questionnaire', ({ salesiq }) => salesiq.update((doc) => {
    doc.candidates.unshift({ id: 'cqx', name: 'Ira Instance', email: 'ira@example.com', status: 'completed', score: 91 });
  }), null, (st) => st.salesiq.byEmail['ira@example.com'] && st.salesiq.byEmail['ira@example.com'].status === 'completed' && st.salesiq.byEmail['ira@example.com'].score === 91);
  await seenHere('a signed onboarding packet', ({ onboarding }, at) => onboarding.update((doc) => {
    doc.hires.unshift({ id: 'hx', email: 'ira@example.com', signedAt: at, reference: 'REF-ELSEWHERE' });
  }), ago(1), (st) => st.onboarding.byEmail['ira@example.com'] && st.onboarding.byEmail['ira@example.com'].reference === 'REF-ELSEWHERE');
  await seenHere('a backup', ({ backups }) => backups.snapshot('manual'), null,
    (st) => st.backups.length === 1 && st.backups[0].reason === 'manual' && st.backups[0].count === 2);
  const aNow = await getState(s);
  ok(!aNow.text.includes('Tay Teal') && aNow.body.team.id === 'maverick', 'this team\'s state never has the other team\'s people');

  // ---------- the other team's records, written on another instance ----------
  await elsewhere(B.id, ({ store }) => store.update((d) => {
    d.candidates.push({ id: 't2', name: 'Toni Teal', email: 'toni@example.com', status: 'new', addedAt: new Date().toISOString(), source: 'manual' });
  }));
  await elsewhere(B.id, ({ store }) => store.addEvent('replied', 'Tay Teal replied.', 't1'));
  const aQuiet = await getState(s, tagA);
  ok(aQuiet.status === 304, 'a change to the other team on another instance leaves this team\'s tag answering 304', aQuiet.status);
  const bLoud = await getState(B, tagB);
  ok(bLoud.status === 200 && bLoud.body.candidates.map((c) => c.id).sort().join() === 't1,t2' && bLoud.body.events.some((e) => e.message === 'Tay Teal replied.'),
    'and the other team\'s next poll shows it', bLoud.body && bLoud.body.candidates.map((c) => c.id));
  ok(!bLoud.text.includes('Ira Instance') && !bLoud.text.includes('REF-ELSEWHERE'), 'with nothing of this team\'s in it');
  tagB = bLoud.tag;

  // ---------- secrets regenerated on another instance ----------
  const relayToken = 'R'.repeat(20) + 'elsewhere-relay-token';
  await elsewhere('maverick', async ({ teams, store }, t) => {
    await teams.setRelayToken('maverick', t);
    await store.update((d) => { d.settings.relayToken = t; });
  }, relayToken);
  const tok = await me.json('GET', '/api/texts/relay-token');
  ok(tok.status === 200 && tok.body.token === relayToken, 'a relay token generated on another instance is the one Settings shows here', tok.body.token && tok.body.token.length);
  const hello = await fetch(`${s.base}/api/relay/hello`, { method: 'POST', headers: { authorization: `Bearer ${relayToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ host: 'Teal-Mac', bluebubbles: true }) });
  ok(hello.status === 200, 'and the Mac holding it is let in here', hello.status);
  const afterTok = await getState(s, tagA);
  ok(afterTok.status === 200 && afterTok.body.texting.tokenSet === true && afterTok.body.texting.queue.relay.online === true && !afterTok.text.includes(relayToken),
    'the state says a token is set and the Mac is online, without the token', afterTok.status);
  tagA = afterTok.tag || tagA;

  const oldIq = (await me.json('POST', '/api/salesiq-connection')).body;
  const keyOf = (code) => { try { return JSON.parse(Buffer.from(String(code).replace(/^WPSIQ1\./, ''), 'base64url').toString('utf8')).k || ''; } catch { return ''; } };
  const bookings = (key) => fetch(`${s.base}/api/salesiq/bookings`, { headers: { authorization: `Bearer ${key}` } });
  ok((await bookings(keyOf(oldIq.code))).status === 200, 'a Sales IQ code made here works here');
  const newIqKey = 'K'.repeat(20) + 'elsewhere-salesiq-key';
  await elsewhere('maverick', async ({ teams, store }, k) => {
    await teams.setSalesiqToken('maverick', k);
    await store.update((d) => { d.settings.salesiqToken = k; });
  }, newIqKey);
  const conn = await me.json('GET', '/api/salesiq-connection');
  ok(conn.status === 200 && conn.body.connected === true && keyOf(conn.body.code) === newIqKey, 'a Sales IQ code regenerated on another instance is the one Settings shows here', conn.body.connected);
  ok((await bookings(keyOf(oldIq.code))).status === 401, 'and the code it replaced stops working here at once');
  ok((await bookings(newIqKey)).status === 200, 'while the new one works');
  tagA = (await getState(s)).tag;

  // ---------- the team list, changed on another instance ----------
  await elsewhere('maverick', ({ teams }) => teams.edit('maverick', (t) => { t.name = 'Team Maverick West'; }));
  const renamed = await getState(s, tagA);
  ok(renamed.status === 200 && renamed.body.team.id === 'maverick' && renamed.body.team.name === 'Team Maverick West', 'a team renamed on another instance: this instance\'s next poll names it so', renamed.body && renamed.body.team);
  tagA = renamed.tag || tagA;
  const listed = await anon.json('GET', '/api/auth/status');
  ok(listed.body.teams.some((t) => t.id === 'maverick' && t.name === 'Team Maverick West'), 'and the sign-in screen lists the new name', listed.body.teams);
  ok((await getState(B, tagB)).status === 304, 'renaming one team does not move the other\'s tag');

  await elsewhere('maverick', ({ teams, store }) => teams.create({ name: 'Team Violet', pin: '8264' }, () => store.seedTeam()));
  const withViolet = await anon.json('GET', '/api/teams');
  ok(withViolet.body.teams.some((t) => t.id === 'team-violet' && t.name === 'Team Violet'), 'a team made on another instance is listed here', withViolet.body.teams);
  const violetCookie = await s.signIn('8264', 'team-violet');
  const violet = await getState(as(s, violetCookie));
  ok(violet.status === 200 && violet.body.team.id === 'team-violet' && violet.body.candidates.length === 0 && violet.body.settings.fromName === '' && !violet.text.includes('Ira Instance') && !violet.text.includes('Tay Teal'),
    'and can sign in here, to a list of its own that is empty', violet.body && violet.body.team);

  // Sign out everywhere, pressed on another instance's page.
  await elsewhere('maverick', ({ teams }) => teams.edit('maverick', (t) => { t.sessionSalt = teams.randHex(32); }));
  const out = await getState(s, tagA);
  ok(out.status === 401, 'signed out everywhere on another instance: this instance refuses the old cookie, even with the current tag (401, not 304)', out.status);
  ok((await me.json('GET', '/api/texts/thread?id=i1')).status === 401 && (await me.json('GET', '/api/candidates/export')).status === 401, 'and on every other read');
  const authOut = await me.json('GET', '/api/auth/status');
  ok(authOut.body.authed === false, 'auth status says it is signed out', authOut.body.authed);
  ok((await getState(B, tagB)).status === 304, 'the other team stays signed in, its tag still answering 304');
  const again = as(s, await s.signIn());
  const back = await getState(again);
  ok(back.status === 200 && back.body.team.id === 'maverick' && back.body.candidates.length === 2, 'signing in again here works', back.status);

  // The other team deleted on another instance.
  await elsewhere('maverick', ({ teams }, id) => teams.remove(id), B.id);
  ok((await getState(B, tagB)).status === 401, 'a team deleted on another instance: its browser is refused here, even with its current tag');
  ok((await B.json('GET', '/api/texts/relay-token')).status === 401, 'on every read');
  const gone = await anon.json('GET', '/api/auth/status');
  ok(!gone.body.teams.some((t) => t.id === B.id), 'and it is no longer listed', gone.body.teams);
  const stillA = await getState(again, back.tag);
  ok(stillA.status === 304, 'this team is untouched: its tag still answers 304', stillA.status);

  ok(sent.count() === 0, 'nothing was sent', sent);
  ok(refused.length === 0, 'nothing reached outside this machine', refused);
  await s.close();
  done();
})().catch(crash);
