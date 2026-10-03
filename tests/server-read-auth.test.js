// Who may read what.
//
//  - signed out, every read route answers 401 and nothing of the team's data
//    (a remembered state tag included: it gets a 401, never a 304), however
//    the path is spelled;
//  - a cookie that is forged, expired, re-labelled for another team, or for a
//    team since deleted, is signed out;
//  - /api/auth/status and /api/teams, the two reads open to anyone, give team
//    names and nothing else (no PIN, salt, token fingerprint, or which team
//    signs in with the admin password);
//  - the Mac relay and Sales IQ each read with their own token and nothing
//    else: not a dashboard cookie, not each other's token.
const crypto = require('crypto');
const { startApp, R, ok, done, crash } = require('./helpers');
const { guardOutside, stubSenders, addTeam, as, getState, ago, daysAgo } = require('./server-read-helpers');

(async () => {
  const refused = guardOutside();
  const s = await startApp({ offset: 4 });
  const sent = stubSenders();
  const teams = require(R('lib/teams.js'));

  await s.store.update((d) => {
    d.candidates = [
      { id: 'c1', name: 'Secret Person', firstName: 'Secret', email: 'secret.person@example.com', phone: '(617) 555-2701', role: 'Account Executive', status: 'emailed', addedAt: daysAgo(5), lastEmailedAt: daysAgo(4), gmailThreadId: 'gthread-c1', source: 'csv',
        textThread: [{ dir: 'in', ts: ago(30), text: 'Secret reply' }], lastTextedAt: ago(40) },
    ];
    d.interviews = [{ uri: 'https://api.calendly.com/scheduled_events/a/invitees/1', inviteeEmail: 'secret.person@example.com', inviteeName: 'Secret Person', inviteePhone: '(617) 555-2701', start: daysAgo(-1), status: 'active', name: 'Intro', candidateId: 'c1' }];
  });
  const signedIn = await getState(s);
  ok(signedIn.status === 200 && signedIn.tag, 'signed in, the state answers', signedIn.status);

  // ---------- signed out: 401 everywhere ----------
  const anon = as(s, null);
  const reads = [
    ['GET', '/api/state'],
    ['GET', '/api/texts/thread?id=c1'],
    ['GET', '/api/emails/thread?id=c1'],
    ['GET', '/api/texts/relay-token'],
    ['GET', '/api/salesiq-connection'],
    ['GET', '/api/onboarding/status'],
    ['GET', '/api/onboarding/saved'],
    ['GET', '/api/onboarding/hires'],
    ['GET', '/api/onboarding/hires/REF-1/files/offer-letter'],
    ['GET', '/api/onboarding/packet/documents'],
    ['GET', '/api/iq/state'],
    ['GET', '/api/candidates/export'],
    ['GET', '/api/backups'],
    ['GET', '/api/template/attachments/builtin-account-executive/preview'],
    ['GET', '/api/google/auth-url'],
    ['POST', '/api/preview', { candidateId: 'c1' }],
    ['POST', '/api/texts/preview', { id: 'c1' }],
    ['POST', '/api/import/preview', { text: 'name,email\nA,a@example.com' }],
    ['POST', '/api/onboarding/packet/preview', {}],
  ];
  const leak = /Secret|secret\.person|555-2701|gthread/;
  for (const [method, url, body] of reads) {
    const r = await anon.json(method, url, body);
    ok(r.status === 401 && !leak.test(r.text), `signed out: ${method} ${url} is 401 and says nothing`, { status: r.status, text: r.text.slice(0, 120) });
  }
  const tagged = await getState(anon, signedIn.tag);
  ok(tagged.status === 401, 'signed out with the current state tag: 401, not 304', tagged.status);
  const head = await anon.call('HEAD', '/api/state');
  ok(head.status === 401 && head.headers.get('etag') !== signedIn.tag, 'signed out, asking only for the headers is 401 too, and never hands out the state\'s tag', head.status);
  for (const url of ['/API/state', '/Api/State', '/api//state', '/api/state/', '/api/state//']) {
    const r = await anon.json('GET', url);
    ok(r.status !== 200 && r.status !== 304 && !leak.test(r.text), `signed out: ${url} gives nothing`, { status: r.status });
    ok(r.status === 401, `signed out: ${url} is 401`, r.status);
  }
  const g = await fetch(`${s.base}/auth/google`, { redirect: 'manual' });
  ok(g.status === 302 && g.headers.get('location') === '/#login', 'signed out, the Google sign-in path sends you to the login', { status: g.status, location: g.headers.get('location') });

  // ---------- the two open reads ----------
  const B = await addTeam(s, { name: 'Team Green', pin: '3971' });
  const st0 = await anon.json('GET', '/api/auth/status');
  ok(st0.status === 200 && st0.body.authed === false && st0.body.team === null && st0.body.required === true && st0.body.setupRequired === false, 'signed out, auth status says so', st0.body);
  ok(JSON.stringify(st0.body.teams) === JSON.stringify([{ id: 'maverick', name: 'Team Maverick' }, { id: B.id, name: 'Team Green' }]), 'and lists the teams by id and name only', st0.body.teams);
  ok(st0.body.numericPins === false, 'not every team has a PIN yet (one still signs in with the admin password), so no number pad', st0.body.numericPins);
  const secretWords = /sessionSalt|salt|hash|pin"|relayToken|salesiqToken|usesAppPassword|createdAt/i;
  ok(!secretWords.test(st0.text), 'nothing about PINs, salts, tokens or the admin password is in it', st0.text);
  const tl = await anon.json('GET', '/api/teams');
  ok(tl.status === 200 && JSON.stringify(tl.body.teams) === JSON.stringify(st0.body.teams) && !secretWords.test(tl.text), 'the sign-in screen\'s team list is the same names and nothing else', tl.body);
  const stA = await s.json('GET', '/api/auth/status');
  ok(stA.body.authed === true && stA.body.team.id === 'maverick' && stA.body.team.name === 'Team Maverick' && !secretWords.test(JSON.stringify(stA.body)), 'signed in, it names the team', stA.body.team);
  const stB = await B.json('GET', '/api/auth/status');
  ok(stB.body.authed === true && stB.body.team.id === B.id, 'the other browser is in the other team', stB.body.team);

  // ---------- cookies that are not what they claim ----------
  const t = await teams.byId('maverick');
  const cookieFor = (teamId, exp, salt) => `crm_auth=${teamId}.${exp}.${crypto.createHmac('sha256', Buffer.from(salt, 'hex')).update(`session:${teamId}:${exp}`).digest('hex')}`;
  const good = as(s, cookieFor('maverick', Date.now() + 3600e3, t.sessionSalt));
  ok((await getState(good)).status === 200, 'a correctly signed, unexpired cookie is in (the control)');
  const expired = as(s, cookieFor('maverick', Date.now() - 1000, t.sessionSalt));
  ok((await getState(expired)).status === 401, 'an expired cookie is out');
  const [, exp, sig] = s.cookie.split('=')[1].split('.');
  const relabelled = as(s, `crm_auth=${B.id}.${exp}.${sig}`);
  ok((await getState(relabelled)).status === 401, 'this team\'s cookie re-labelled for the other team is out');
  const forged = as(s, `crm_auth=maverick.${Date.now() + 3600e3}.${'0'.repeat(64)}`);
  ok((await getState(forged)).status === 401, 'a made-up signature is out');
  for (const junk of ['crm_auth=', 'crm_auth=maverick', 'crm_auth=maverick.notanumber.abc', 'crm_auth=../../etc.1.2', 'other=1']) {
    ok((await getState(as(s, junk))).status === 401, `a malformed cookie (${junk}) is out`);
  }

  // ---------- the relay and Sales IQ: their own tokens only ----------
  const relayToken = (await s.json('POST', '/api/texts/relay-token')).body.token;
  const iqConn = (await s.json('POST', '/api/salesiq-connection')).body;
  const iqToken = JSON.parse(Buffer.from(iqConn.code.replace(/^WPSIQ1\./, ''), 'base64url').toString('utf8')).k;
  const bearer = (token) => (token ? { authorization: `Bearer ${token}` } : {});
  const relayRead = (token, cookie) => fetch(`${s.base}/api/relay/handles`, { method: 'POST', headers: { ...bearer(token), ...(cookie ? { cookie } : {}) } });
  const iqRead = (token, cookie) => fetch(`${s.base}/api/salesiq/bookings`, { headers: { ...bearer(token), ...(cookie ? { cookie } : {}) } });
  ok((await relayRead(null, s.cookie)).status === 401, 'the relay\'s routes do not take a dashboard cookie');
  ok((await relayRead(iqToken)).status === 401, 'nor the Sales IQ token');
  const rh = await relayRead(relayToken);
  const rhBody = await rh.json();
  ok(rh.status === 200 && Array.isArray(rhBody.handles) && rhBody.handles.includes('+16175552701'), 'the relay token reads the numbers already texted', rhBody);
  const noTok = await iqRead(null);
  ok(noTok.status === 401 && noTok.headers.get('access-control-allow-origin') === '*', 'Sales IQ with no token: 401, still readable from its own site', noTok.status);
  ok((await iqRead(null, s.cookie)).status === 401, 'Sales IQ does not take a dashboard cookie');
  ok((await iqRead(relayToken)).status === 401, 'nor the relay token');
  ok((await iqRead('x'.repeat(43))).status === 401, 'nor a made-up token');
  const pre = await fetch(`${s.base}/api/salesiq/bookings`, { method: 'OPTIONS' });
  ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*', 'its preflight is answered without a token', pre.status);
  const bk = await iqRead(iqToken);
  const bkBody = await bk.json();
  ok(bk.status === 200 && bkBody.team.id === 'maverick' && bkBody.bookings.length === 1 && bkBody.bookings[0].email === 'secret.person@example.com', 'the Sales IQ token reads its own team\'s bookings', bkBody);
  ok(!('crmId' in bkBody.bookings[0]) && !JSON.stringify(bkBody).includes('"c1"'), 'never with the pipeline candidate\'s id', bkBody.bookings[0]);
  const bTok = (await B.json('POST', '/api/salesiq-connection')).body;
  const bIq = JSON.parse(Buffer.from(bTok.code.replace(/^WPSIQ1\./, ''), 'base64url').toString('utf8')).k;
  const bk2 = await iqRead(bIq);
  const bk2Body = await bk2.json();
  ok(bk2.status === 200 && bk2Body.team.id === B.id && bk2Body.bookings.length === 0, 'the other team\'s token reads only the other team\'s (empty) bookings', bk2Body);

  // ---------- a deleted team is signed out ----------
  const del = await s.json('POST', '/api/teams/delete', { adminPassword: 'test-password', id: B.id, confirm: 'Team Green' });
  ok(del.status === 200 && del.body.ok === true && del.body.signedOut === false, 'the other team is deleted from this one', del.body);
  ok((await getState(B)).status === 401, 'its browser is signed out of the state');
  ok((await B.json('GET', '/api/texts/relay-token')).status === 401, 'and of every other read');
  const gone = await B.json('GET', '/api/auth/status');
  ok(gone.body.authed === false && gone.body.team === null && !gone.body.teams.some((x) => x.id === B.id), 'auth status says it is signed out, and the team is no longer listed', gone.body);
  ok((await iqRead(bIq)).status === 401, 'its Sales IQ token no longer reads anything');
  ok((await getState(s)).status === 200, 'this team is still in');

  // ---------- a PIN for every team: the number pad ----------
  await teams.edit('maverick', (tm) => { tm.pin = teams.pinRecord('3971'); });
  const st1 = await anon.json('GET', '/api/auth/status');
  ok(st1.body.numericPins === true, 'once every team has its own PIN, the sign-in screen is told to show a number pad', st1.body.numericPins);
  ok((await getState(s)).status === 200, 'setting a PIN directly does not sign the existing browser out');

  ok(sent.count() === 0, 'nothing was sent', sent);
  ok(refused.length === 0, 'nothing reached outside this machine', refused);
  await s.close();
  done();
})().catch(crash);
