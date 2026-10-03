// Two teams on one app: every read route answers for the team signed in and
// for nobody else.
//
//  - a new team (made the way the app makes one: the admin password, a name
//    and a PIN) starts with nothing of the first team's: no candidates, no
//    sender name, no flyer, no text that introduces somebody else, no Google
//    connection;
//  - the secrets configured for the whole process (SMTP login, relay token,
//    phone topic) belong to the team that predates teams, never to a new one;
//  - one team's ids, attachments, tokens, Sales IQ list, onboarding records,
//    backups and export are unreachable from the other.
//
// Google is "connected" here the way the app really decides it — a stored
// token record for that team that has not expired — so nothing is stubbed in
// that decision and nothing leaves the machine.
const { startApp, R, ok, done, crash } = require('./helpers');
const { guardOutside, stubSenders, addTeam, inTeam, getState, ago, daysAgo } = require('./server-read-helpers');

(async () => {
  const refused = guardOutside();
  // The process-wide secrets the first team was set up with.
  process.env.SMTP_USER = 'env.sender@example.com';
  process.env.SMTP_PASS = 'ENV-SMTP-PASSWORD';
  process.env.RELAY_TOKEN = 'ENV-RELAY-TOKEN-abcdefghijklmnopqrstuvwxyz';
  process.env.NTFY_TOPIC = 'env-topic';
  const s = await startApp({ offset: 3, stub: false });
  const sent = stubSenders();
  const google = require(R('lib/google.js'));
  google.threadMessages = async (_settings, threadId) => ({ limited: false, messages: [{ id: 'g1', dir: 'in', from: 'x@example.com', date: ago(5), subject: 'Re: hi', messageId: '<g1@example.com>', snippet: `thread ${threadId}`, text: `thread ${threadId}`, kind: '' }], lastMessageId: '<g1@example.com>', lastSubject: 'Re: hi' });
  google.threadReplies = async () => ({ limited: false, replies: [] });
  google.recentInboundThreads = async () => new Set();
  const storage = require(R('lib/storage.js'));
  const salesiq = require(R('lib/salesiq.js'));
  const onboarding = require(R('lib/onboarding.js'));
  const backups = require(R('lib/backups.js'));
  const textQueue = require(R('lib/text-queue.js'));

  // ---------- the first team: a list, a Google connection, history ----------
  await storage.setJson('tokens', { access_token: 'test-access-token', expires_at: Date.now() + 3600 * 1000, email: 'maverick.sender@example.com', signature: '<b>Maverick Signature</b>' });
  await s.store.update((d) => {
    d.candidates = [
      { id: 'ma1', name: 'Alex Maverick', firstName: 'Alex', email: 'alex.maverick@example.com', phone: '(617) 555-2501', role: 'Account Executive', status: 'emailed', addedAt: daysAgo(10), lastEmailedAt: daysAgo(4), gmailThreadId: 'gthread-ma1', lastSubject: 'Hello Alex', source: 'csv',
        textThread: [{ dir: 'out', ts: ago(60), text: 'Hi Alex from Maverick' }, { dir: 'in', ts: ago(50), text: 'Maverick reply' }], textUnread: true, lastTextedAt: ago(60) },
      { id: 'ma2', name: 'Blake Maverick', email: 'blake.maverick@example.com', phone: '(617) 555-2502', role: 'Solar Rep', status: 'new', addedAt: daysAgo(3), source: 'manual' },
    ];
    d.events = [{ id: 'mev', ts: ago(5), type: 'replied', message: 'Alex Maverick replied.', candidateId: 'ma1' }];
    d.interviews = [{ uri: 'https://api.calendly.com/scheduled_events/m/invitees/1', inviteeEmail: 'alex.maverick@example.com', inviteeName: 'Alex Maverick', start: daysAgo(-1), status: 'active', name: 'Intro', candidateId: 'ma1' }];
    d.settings.calendlyUrl = 'https://calendly.com/maverick-example/intro';
  });
  await textQueue.updateQ((q) => { q.items.push({ id: 'ma2', phone: '+16175552502', t: 'tk', at: null }); q.templates.tk = { body: 'Maverick queued text' }; });
  await onboarding.update((doc) => { doc.hires.unshift({ id: 'mh', email: 'alex.maverick@example.com', signedAt: ago(10), reference: 'MAV-REF' }); });
  await backups.snapshot('manual');
  const maverickToken = (await s.json('POST', '/api/texts/relay-token')).body.token;
  const maverickIq = (await s.json('POST', '/api/salesiq-connection')).body;

  // ---------- a second team, made from Settings ----------
  const B = await addTeam(s, { name: 'Team Blue', pin: '4826' });
  ok(B.id === 'team-blue' && B.made.signedIn === false && B.made.team.usesAppPassword === false, 'a team made from Settings gets its own id and PIN, and does not move this browser into it', B.made);

  // ---------- what the new team starts with ----------
  const b0 = await getState(B);
  const S = b0.body;
  ok(b0.status === 200 && S.team.id === 'team-blue' && S.team.name === 'Team Blue' && S.team.usesAppPassword === false, 'the new team\'s state names it', S.team);
  ok(S.candidates.length === 0 && S.stats.total === 0 && S.events.length === 0 && S.interviews.length === 0 && S.backups.length === 0, 'it starts with no candidates, feed, interviews or backups', { c: S.candidates.length, e: S.events.length });
  ok(S.settings.fromName === '' && S.settings.calendlyUrl === '', 'it is not handed the first team\'s sender name or booking link', { fromName: S.settings.fromName, calendlyUrl: S.settings.calendlyUrl });
  ok(Array.isArray(S.template.attachments) && S.template.attachments.length === 0, 'it is not handed the first team\'s flyer', S.template.attachments);
  ok(!/Blake|Wholesale Payments/.test(S.texting.template.body) && /\{\{firstName\}\}/.test(S.texting.template.body), 'its first text does not introduce somebody else', S.texting.template.body);
  ok(S.templateEdited === false, 'its setup checklist still asks it to write its own letter');
  ok(S.google.connected === false && S.google.email === '' && S.sending.ready === false && !S.sending.from, 'it is not connected to the first team\'s Google account, nor sending from the process-wide login', { google: S.google.connected, sending: S.sending });
  ok(S.texting.tokenSet === false && S.texting.queue.pending === 0, 'it has no relay token and no texts waiting', { tokenSet: S.texting.tokenSet, pending: S.texting.queue.pending });
  ok(Object.keys(S.salesiq.byEmail).length === 0 && Object.keys(S.onboarding.byEmail).length === 0, 'its Sales IQ and onboarding summaries are empty');
  ok(!/maverick\.sender|alex\.maverick|blake\.maverick|Maverick reply|MAV-REF|maverick-example|env\.sender|ENV-|env-topic/.test(b0.text), 'nothing of the first team\'s appears anywhere in its state');

  // The first team, for contrast.
  const A = (await getState(s)).body;
  ok(A.google.connected === true && A.google.email === 'maverick.sender@example.com' && A.sending.ready === true && A.sending.from === 'maverick.sender@example.com', 'the first team is connected to its own Google account', { google: A.google.email, sending: A.sending });
  ok(A.texting.tokenSet === true && A.texting.queue.pending === 1 && A.candidates.length === 2, 'and has its own token, queue and list');

  // ---------- one team's ids are nothing to the other ----------
  const tThread = await B.json('GET', '/api/texts/thread?id=ma1');
  ok(tThread.status === 404 && !tThread.text.includes('Maverick'), 'the other team cannot open this team\'s text thread by id', tThread.status);
  const eThread = await B.json('GET', '/api/emails/thread?id=ma1');
  ok(eThread.status === 404 && !eThread.text.includes('Maverick'), 'nor its email conversation', eThread.status);
  const prev = await B.json('POST', '/api/preview', { candidateId: 'ma1' });
  ok(prev.status === 400 && prev.body.error === 'Candidate not found.', 'nor preview an email to one of its candidates', prev.body);
  const tprev = await B.json('POST', '/api/texts/preview', { id: 'ma1' });
  ok(tprev.status === 200 && !/Alex|Maverick|555-2501/.test(tprev.text), 'a text preview never shows the other team\'s person', tprev.body);
  const att = await B.json('GET', '/api/template/attachments/builtin-account-executive/preview');
  ok(att.status === 400 && att.body.error === 'Attachment not found.', 'nor its flyer', att.body);
  const attA = await s.json('GET', '/api/template/attachments/builtin-account-executive/preview');
  ok(attA.status === 200 && /^data:image\/png;base64,/.test(attA.body.dataUrl), 'which its own team can preview', attA.status);
  const exp = await B.call('GET', '/api/candidates/export');
  const expText = await exp.text();
  ok(exp.status === 200 && expText.trim().split(/\r\n/).length === 1 && !/Maverick/.test(expText), 'the other team\'s export is its own (empty) list', expText.slice(0, 200));
  ok(/filename="Team-Blue-candidates-/.test(exp.headers.get('content-disposition') || ''), 'named for its own team', exp.headers.get('content-disposition'));
  const tok = await B.json('GET', '/api/texts/relay-token');
  ok(tok.status === 200 && tok.body.token === '' && tok.body.envOverride === false && !tok.text.includes(maverickToken) && !tok.text.includes('ENV-RELAY-TOKEN'),
    'the relay token page shows no token for the other team — not this team\'s, not the process-wide one', tok.body);
  const tokA = await s.json('GET', '/api/texts/relay-token');
  ok(tokA.body.token === maverickToken && tokA.body.envOverride === true, 'the first team sees its own token, and that the process-wide one applies to it', { envOverride: tokA.body.envOverride });
  const conn = await B.json('GET', '/api/salesiq-connection');
  ok(conn.status === 200 && conn.body.connected === false && conn.body.code === '' && conn.body.team.id === 'team-blue' && !conn.text.includes(maverickIq.code), 'the other team\'s Sales IQ connection is its own (not connected)', conn.body);
  const onb = await B.call('GET', '/api/onboarding/status');
  const onbBody = await onb.json();
  ok(onb.status === 200 && onbBody.team.id === 'team-blue' && onbBody.emailConfigured === false && decodeURIComponent(onb.headers.get('x-team') || '') === 'team-blue', 'onboarding status answers for the other team, which has no email set up', onbBody);
  const saved = await B.json('GET', '/api/onboarding/saved');
  ok(saved.status === 200 && saved.body.hires.length === 0 && !saved.text.includes('MAV-REF'), 'and its onboarding records are its own', saved.body.hires);
  const iqB = await B.json('GET', '/api/iq/state');
  ok(iqB.status === 200 && iqB.body.hostTeam.id === 'team-blue' && iqB.body.candidates.length === 0 && iqB.body.mail.ready === false, 'its Sales IQ page is its own: no candidates, no mail', { host: iqB.body.hostTeam, n: iqB.body.candidates.length });
  const bk = await B.json('GET', '/api/backups');
  ok(bk.status === 200 && bk.body.backups.length === 0, 'its backups are its own', bk.body.backups);
  const authB = await B.json('GET', '/api/auth/status');
  ok(authB.body.authed === true && authB.body.team.id === 'team-blue', 'the other browser is signed in to the other team', authB.body.team);

  // ---------- the other team's own data stays with it ----------
  await inTeam(B.id, () => s.store.update((d) => {
    d.candidates = [{ id: 'bb1', name: 'Casey Blue', firstName: 'Casey', email: 'casey.blue@example.com', phone: '(312) 555-2601', role: 'Account Executive', status: 'emailed', addedAt: daysAgo(5), lastEmailedAt: daysAgo(4), source: 'csv', gmailThreadId: 'gthread-bb1',
      textThread: [{ dir: 'in', ts: ago(30), text: 'Blue reply' }], lastTextedAt: ago(40) }];
  }));
  const tB = await B.json('GET', '/api/texts/thread?id=bb1');
  ok(tB.status === 200 && tB.body.thread.length === 1 && tB.body.thread[0].text === 'Blue reply' && tB.body.pending.length === 0, 'the other team reads its own thread, with nothing of this team\'s queue in it', tB.body);
  const tA = await s.json('GET', '/api/texts/thread?id=bb1');
  ok(tA.status === 404, 'and this team cannot read it', tA.status);
  const eB = await B.json('GET', '/api/emails/thread?id=bb1');
  ok(eB.status === 200 && eB.body.messages.length === 0 && /Connect Google/.test(eB.body.unavailable), 'the other team, with no Google connection, is told to connect — not shown this team\'s mailbox', eB.body);
  const eA = await s.json('GET', '/api/emails/thread?id=ma1');
  ok(eA.status === 200 && eA.body.canReply === true && eA.body.messages[0].text === 'thread gthread-ma1', 'this team reads its own conversation through its own connection', eA.body);
  const bState = (await getState(B)).body;
  const aState = (await getState(s)).body;
  ok(bState.candidates.length === 1 && bState.candidates[0].id === 'bb1' && aState.candidates.every((c) => c.id !== 'bb1'), 'each state lists only its own team\'s people');
  ok(aState.candidates.find((c) => c.id === 'ma1').textUnread === true, 'reading a thread from the other team changed nothing here');

  ok(sent.count() === 0, 'nothing was sent', sent);
  ok(refused.length === 0, 'nothing reached outside this machine', refused);
  await s.close();
  done();
})().catch(crash);
