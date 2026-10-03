// The read-only routes besides the state, for a crafted team:
//   GET  /api/texts/thread       one text conversation, both halves, plus what is still on its way
//   GET  /api/emails/thread      one email conversation, read live from Gmail (stubbed)
//   POST /api/preview            the personalised email, outreach or follow-up
//   POST /api/texts/preview      the personalised text
//   GET  /api/texts/relay-token  the Mac's token, in full, only here
//   GET  /api/salesiq-connection the Sales IQ connection code, only when it would work
//   GET  /api/onboarding/status  onboarding's view of sending and storage
//   GET  /api/iq/state           the Sales IQ page (bookings folded in, links signed for this team)
// None of them sends anything, and none clears an unread flag: reading a
// conversation here is not the same as the page saying it was seen.
const { startApp, R, ok, done, crash } = require('./helpers');
const { guardOutside, stubSenders, as, getState, ago, daysAgo } = require('./server-read-helpers');

(async () => {
  const refused = guardOutside();
  const s = await startApp({ offset: 5 });
  const sent = stubSenders();
  const me = as(s, s.cookie);   // like s.json, plus the raw text and extra headers
  const google = require(R('lib/google.js'));
  const mailer = require(R('lib/mailer.js'));
  const textQueue = require(R('lib/text-queue.js'));
  const salesiq = require(R('lib/salesiq.js'));
  const teams = require(R('lib/teams.js'));
  const connected = google.status;
  const readySend = mailer.sendStatus;

  const thread = [
    { dir: 'out', ts: ago(120), text: 'Hi Jordan, quick question?' },
    { dir: 'in', ts: ago(110), text: 'Loved “Hi Jordan, quick question?”', kind: 'tapback' },
    { dir: 'in', ts: ago(100), text: 'Sure, what is it?' },
  ];
  const jEmailedAt = daysAgo(4);
  await s.store.update((d) => {
    d.candidates = [
      { id: 'j1', name: 'Jordan Example', firstName: 'Jordan', lastName: 'Example', email: 'jordan@example.com', phone: '617.555.2801', role: 'Account Executive', company: 'Widgets Inc',
        status: 'replied', textStatus: 'replied', textUnread: true, emailUnread: true, lastTextedAt: ago(120), textThread: thread, addedAt: daysAgo(10), source: 'csv',
        lastEmailedAt: jEmailedAt, lastSubject: 'Quick question, Jordan', gmailThreadId: 'gthread-j1', messageId: '<j1@example.com>' },
      { id: 'k1', name: 'Kim Nophone', email: 'kim@example.com', status: 'emailed', addedAt: daysAgo(10), lastEmailedAt: daysAgo(4), source: 'csv' },
      { id: 'n1', name: 'Noor', email: 'noor@example.com', phone: '(312) 555-2802', status: 'new', addedAt: daysAgo(1), source: 'manual' },
    ];
    d.settings.calendlyUrl = 'https://calendly.com/example-recruiter/intro';
    d.template = { ...d.template, subject: 'Hello {{firstName}} — a role at {{company}}', body: 'Hi {{firstName}},\nYour time as a {{role}} stood out.' };
    d.textTemplate = { body: 'Hi {{firstName}}, worth a quick call?' };
  });
  await textQueue.updateQ((q) => {
    q.templates.t1 = { body: 'Queued: are you free Tuesday?' };
    q.templates.t2 = { body: 'Leased: still there?' };
    q.items.push({ id: 'j1', phone: '+16175552801', t: 't1', at: null }, { id: 'j1', phone: '+16175552801', t: 'missing', at: null }, { id: 'n1', phone: '+13125552802', t: 't1', at: null });
    q.leases.job9 = { id: 'j1', phone: '+16175552801', body: 'Leased: still there?', t: 't2', until: new Date(Date.now() + 60000).toISOString(), attempt: 1 };
  });
  const unreadNow = async () => { const c = (await s.store.load()).candidates.find((x) => x.id === 'j1'); return { text: c.textUnread, email: c.emailUnread }; };

  // ---------- one text conversation ----------
  const t = await me.json('GET', '/api/texts/thread?id=j1');
  ok(t.status === 200 && t.body.ok === true && t.body.id === 'j1' && t.body.name === 'Jordan Example' && t.body.role === 'Account Executive' && t.body.company === 'Widgets Inc',
    'a text thread says whose it is', t.body);
  ok(t.body.phone === '(617) 555-2801', 'with their number written the usual way', t.body.phone);
  ok(t.body.status === 'replied' && t.body.textStatus === 'replied' && t.body.optedOut === false, 'with where they stand and whether they asked to stop', t.body);
  ok(JSON.stringify(t.body.thread) === JSON.stringify(thread), 'the whole thread, both halves and the tapback, oldest first', t.body.thread);
  ok(JSON.stringify(t.body.pending) === JSON.stringify([{ text: 'Queued: are you free Tuesday?' }, { text: 'Leased: still there?' }]),
    'what is still on its way to the Mac: queued and handed over, not someone else\'s, not one with no words', t.body.pending);
  await textQueue.updateQ((q) => { textQueue.addOptOut(q, '+1 617 555 2801'); });
  const t2 = await me.json('GET', '/api/texts/thread?id=j1');
  ok(t2.body.optedOut === true, 'after STOP the thread says they opted out', t2.body.optedOut);
  const tk = await me.json('GET', '/api/texts/thread?id=k1');
  ok(tk.status === 200 && tk.body.phone === '' && tk.body.thread.length === 0 && tk.body.pending.length === 0 && tk.body.textStatus === '' && tk.body.optedOut === false, 'someone with no number has an empty thread', tk.body);
  const tx = await me.json('GET', '/api/texts/thread?id=nobody');
  ok(tx.status === 404 && tx.body.error === 'No such candidate.', 'an unknown id is 404', tx.body);
  ok((await me.json('GET', '/api/texts/thread')).status === 404, 'no id is 404');
  ok((await unreadNow()).text === true, 'reading the thread does not mark it read');

  // ---------- one email conversation ----------
  const calls = [];
  google.threadMessages = async (settings, threadId, myEmail) => {
    calls.push({ threadId, myEmail, settings: Boolean(settings) });
    return {
      messages: [
        { id: 'm1', dir: 'out', from: 'Blake <blake@wholesalepayments.com>', date: ago(5000), subject: 'Quick question, Jordan', messageId: '<a@example.com>', snippet: 'Hi Jordan', text: 'Hi Jordan', kind: '' },
        { id: 'm2', dir: 'in', from: 'Jordan <jordan@example.com>', date: ago(100), subject: 'Re: Quick question, Jordan', messageId: '<b@example.com>', snippet: 'Sounds good', text: 'Sounds good', kind: '' },
      ],
      limited: false, lastMessageId: '<b@example.com>', lastSubject: 'Re: Quick question, Jordan',
    };
  };
  const e = await me.json('GET', '/api/emails/thread?id=j1');
  ok(e.status === 200 && e.body.ok === true && e.body.id === 'j1' && e.body.name === 'Jordan Example' && e.body.email === 'jordan@example.com' && e.body.role === 'Account Executive' && e.body.company === 'Widgets Inc' && e.body.status === 'replied',
    'an email thread says whose it is', e.body);
  ok(e.body.subject === 'Quick question, Jordan' && e.body.gmailUrl === 'https://mail.google.com/mail/u/0/#all/gthread-j1', 'with the subject and a link to it in Gmail', { subject: e.body.subject, gmailUrl: e.body.gmailUrl });
  ok(e.body.canReply === true && e.body.messages.length === 2 && e.body.messages[1].text === 'Sounds good' && e.body.lastSubject === 'Re: Quick question, Jordan' && e.body.limited === false,
    'the conversation is read live from Gmail', e.body.messages);
  ok(calls.length === 1 && calls[0].threadId === 'gthread-j1' && calls[0].myEmail === 'blake@wholesalepayments.com', 'from this person\'s Gmail thread, as the connected account', calls);
  ok(!('messageId' in e.body) || e.body.messageId === undefined, 'the stored message id is not handed out');
  const goneErr = Object.assign(new Error('Requested entity was not found.'), { gone: true });
  google.threadMessages = async () => { throw goneErr; };
  const eg = await me.json('GET', '/api/emails/thread?id=j1');
  ok(eg.status === 200 && eg.body.messages.length === 0 && eg.body.unavailable === 'That conversation is no longer in Gmail.' && !eg.body.canReply, 'a thread deleted in Gmail says so', eg.body);
  google.threadMessages = async () => { throw Object.assign(new Error('Insufficient Permission'), { scope: true }); };
  const es = await me.json('GET', '/api/emails/thread?id=j1');
  ok(/needs the extra Gmail permission/.test(es.body.unavailable) && es.body.messages.length === 0, 'a missing Gmail permission says how to fix it', es.body.unavailable);
  google.threadMessages = async () => { throw new Error('Gmail is having a moment'); };
  const eo = await me.json('GET', '/api/emails/thread?id=j1');
  ok(eo.status === 200 && eo.body.unavailable === 'Gmail is having a moment', 'any other Gmail failure is passed on as it was said', eo.body.unavailable);
  const ek = await me.json('GET', '/api/emails/thread?id=k1');
  ok(ek.status === 200 && ek.body.unavailable === 'Nothing has been emailed to this person yet.' && ek.body.gmailUrl === '' && ek.body.messages.length === 0, 'someone never emailed has nothing to read', ek.body);
  google.status = async () => ({ connected: false, configured: false, email: '' });
  calls.length = 0;
  google.threadMessages = async (...a) => { calls.push(a); return { messages: [] }; };
  const en = await me.json('GET', '/api/emails/thread?id=j1');
  ok(en.status === 200 && /^Connect Google in Settings/.test(en.body.unavailable) && en.body.messages.length === 0 && calls.length === 0, 'with Google not connected it says so, and does not try Gmail', en.body.unavailable);
  google.status = connected;
  ok((await me.json('GET', '/api/emails/thread?id=nobody')).status === 404, 'an unknown id is 404');
  ok((await unreadNow()).email === true, 'reading the email thread does not mark it read');

  // ---------- previews ----------
  const p = await me.json('POST', '/api/preview', { candidateId: 'j1' });
  ok(p.status === 200 && p.body.subject === 'Hello Jordan — a role at Widgets Inc', 'the outreach preview fills in the person', p.body.subject);
  ok(/^Hi Jordan,\nYour time as a Account Executive stood out\.\n\nBook a time with me: https:\/\/calendly\.com\/example-recruiter\/intro$/.test(p.body.text), 'the text part ends with the booking link', p.body.text);
  ok(/Book a time with me<\/a>/.test(p.body.html) && /Hi Jordan,<br>Your time/.test(p.body.html) && !/<img/.test(p.body.html), 'the HTML part has the booking button and no tracking pixel', p.body.html);
  ok(p.body.followUp === false && Array.isArray(p.body.attachments) && p.body.attachments.length === 1
    && JSON.stringify(Object.keys(p.body.attachments[0]).sort()) === JSON.stringify(['builtin', 'id', 'name', 'size', 'type'])
    && p.body.attachments[0].name === 'Account Executive.png' && p.body.attachments[0].builtin === true,
  'it lists what will be attached (the flyer)', p.body.attachments);
  const pf = await me.json('POST', '/api/preview', { candidateId: 'j1', followUp: true });
  ok(pf.status === 200 && pf.body.subject === 'Re: Quick question, Jordan' && pf.body.followUp === true && pf.body.attachments.length === 0, 'the follow-up preview replies to the subject they received, with no attachment', pf.body);
  const pfn = await me.json('POST', '/api/preview', { candidateId: 'n1', followUp: true });
  ok(pfn.body.subject === 'Re: Hello Noor — a role at', 'for someone not yet emailed it shows what the outreach subject would be', pfn.body.subject);
  const pc = await me.json('POST', '/api/preview', { candidateId: 'k1', template: { subject: 'Custom for {{fullName}}', body: 'Body for {{firstName}} at {{company}}' } });
  ok(pc.body.subject === 'Custom for Kim Nophone' && /^Body for Kim at \n/.test(pc.body.text), 'a one-off template is previewed as given', pc.body);
  const pu = await me.json('POST', '/api/preview', { candidateId: 'nobody' });
  ok(pu.status === 400 && pu.body.error === 'Candidate not found.', 'an unknown candidate is refused', pu.body);

  const tp = await me.json('POST', '/api/texts/preview', { id: 'j1' });
  ok(tp.status === 200 && tp.body.body === 'Hi Jordan, worth a quick call?\n\nhttps://calendly.com/example-recruiter/intro' && tp.body.chars === tp.body.body.length && tp.body.to === '(617) 555-2801' && tp.body.name === 'Jordan Example',
    'the text preview fills in the person, adds the booking link on its own line, counts characters and shows the number', tp.body);
  const tpn = await me.json('POST', '/api/texts/preview', {});
  ok(tpn.status === 200 && tpn.body.name === 'Jordan Example', 'with nobody picked it previews the first person with a number', tpn.body.name);
  const tpk = await me.json('POST', '/api/texts/preview', { id: 'k1' });
  ok(tpk.body.name === 'Kim Nophone' && tpk.body.to === '', 'someone with no number previews with no number', tpk.body);
  await s.store.update((d) => { for (const c of d.candidates) c.phone = ''; });
  const tps = await me.json('POST', '/api/texts/preview', { id: 'nobody' });
  ok(tps.status === 200 && tps.body.name === 'Sam Rivera' && /^Hi Sam,/.test(tps.body.body), 'with nobody textable it previews a sample person', tps.body);
  await s.store.update((d) => { d.candidates.find((c) => c.id === 'j1').phone = '617.555.2801'; d.candidates.find((c) => c.id === 'n1').phone = '(312) 555-2802'; });

  const after = (await s.store.load()).candidates.find((c) => c.id === 'j1');
  ok(after.lastEmailedAt === jEmailedAt && after.lastSubject === 'Quick question, Jordan' && !after.followUpCount, 'previewing changes nothing about the person');

  // ---------- the relay token ----------
  const r0 = await me.json('GET', '/api/texts/relay-token');
  ok(r0.status === 200 && r0.body.token === '' && r0.body.envOverride === false && typeof r0.body.baseUrl === 'string', 'no relay token yet', r0.body);
  const gen = await me.json('POST', '/api/texts/relay-token');
  const r1 = await me.json('GET', '/api/texts/relay-token');
  ok(r1.body.token === gen.body.token && r1.body.token.length >= 24, 'once generated it is shown here in full, to copy into the Mac', r1.body.token.length);
  const st = await getState(s);
  ok(!st.text.includes(gen.body.token) && st.body.settings.relayToken === '••••••••' && st.body.texting.tokenSet === true, 'and nowhere in the state', st.body.settings.relayToken);

  // ---------- the Sales IQ connection ----------
  const c0 = await s.call('GET', '/api/salesiq-connection');
  const c0b = await c0.json();
  ok(c0.status === 200 && c0b.connected === false && c0b.code === '' && c0b.team.id === 'maverick' && c0b.team.name === 'Team Maverick' && typeof c0b.baseUrl === 'string', 'not connected yet: no code', c0b);
  ok(/no-store/.test(c0.headers.get('cache-control') || ''), 'never cached', c0.headers.get('cache-control'));
  const made = await me.json('POST', '/api/salesiq-connection');
  const c1 = await me.json('GET', '/api/salesiq-connection');
  ok(c1.body.connected === true && c1.body.code === made.body.code && /^WPSIQ1\./.test(c1.body.code), 'connected: the same code every time it is asked for', c1.body);
  const decoded = JSON.parse(Buffer.from(c1.body.code.slice('WPSIQ1.'.length), 'base64url').toString('utf8'));
  ok(decoded.u === c1.body.baseUrl && decoded.t === 'Team Maverick' && decoded.i === 'maverick' && typeof decoded.k === 'string' && decoded.k.length >= 24, 'the code carries the address, the team and its key', { u: decoded.u, t: decoded.t, i: decoded.i });
  const st2 = await getState(s);
  ok(!st2.text.includes(decoded.k) && !st2.text.includes(c1.body.code), 'the key is never in the state');
  await teams.setSalesiqToken('maverick', '');
  const c2 = await me.json('GET', '/api/salesiq-connection');
  ok(c2.body.connected === false && c2.body.code === '', 'a code the bearer check would refuse is not shown', c2.body);

  // ---------- onboarding status ----------
  const o = await s.call('GET', '/api/onboarding/status');
  const ob = await o.json();
  ok(o.status === 200 && ob.emailConfigured === true && ob.email.ready === true && ob.email.via === 'gmail-api' && /blake@wholesalepayments\.com/.test(ob.email.from), 'onboarding sees the team\'s sending mailbox', ob.email);
  ok(ob.storage.backend === 'file' && ob.storage.persistent === true && ob.storage.sharedAcrossDevices === false, 'and the storage it is on', ob.storage);
  ok(ob.company && ob.company.name === 'WPI Inc.' && ob.team.id === 'maverick' && ob.team.name === 'Team Maverick', 'and the company and team', { company: ob.company, team: ob.team });
  ok(decodeURIComponent(o.headers.get('x-team') || '') === 'maverick', 'the answer says whose it is');
  const oWrong = await me.json('GET', '/api/onboarding/status', null, { 'X-Team-Expected': 'someone-else' });
  ok(oWrong.status === 409 && oWrong.body.otherTeam === true, 'a page still showing another team is told this browser moved', oWrong.body);
  const oRight = await me.json('GET', '/api/onboarding/status', null, { 'X-Team-Expected': 'maverick' });
  ok(oRight.status === 200, 'a page showing this team gets its answer', oRight.status);
  mailer.sendStatus = async () => ({ ready: false, via: null, from: null, reason: 'Connect Google or add a Gmail App Password in Settings.' });
  const oOff = await me.json('GET', '/api/onboarding/status');
  ok(oOff.body.emailConfigured === false && oOff.body.email.reason === 'Connect Google or add a Gmail App Password in Settings.' && oOff.body.email.from === '', 'with no mailbox it says why', oOff.body.email);
  mailer.sendStatus = readySend;

  // ---------- the Sales IQ page ----------
  await s.store.update((d) => {
    d.interviews = [
      { uri: 'https://api.calendly.com/scheduled_events/e1/invitees/1', inviteeEmail: 'jordan@example.com', inviteeName: 'Jordan Example', inviteePhone: '(617) 555-2801', start: daysAgo(-2), name: '15 Minute Intro', status: 'active', candidateId: 'j1', bookedAt: ago(60) },
      { uri: 'https://api.calendly.com/scheduled_events/e2/invitees/2', inviteeEmail: 'teammate@wholesalepayments.com', inviteeName: 'A Teammate', start: daysAgo(-1), name: '15 Minute Intro', status: 'active' },
      { uri: 'https://api.calendly.com/scheduled_events/e3/invitees/3', inviteeEmail: 'past@example.com', inviteeName: 'Past Booker', start: daysAgo(5), name: '15 Minute Intro', status: 'active' },
    ];
  });
  await salesiq.update((doc) => {
    doc.settings = { team: 'Team Maverick', managerEmail: 'manager@example.com' };
    doc.candidates.push({ id: 'cdone1', name: 'Done Person', email: 'done@example.com', phone: '(617) 555-2899', status: 'completed', score: 72, added: ago(500), completedAt: ago(100), durationSec: 250, source: 'manual' });
    doc.reports.push({ id: 'r0123456789abcdef01', candidateId: 'cdone1', name: 'Done Person', email: 'done@example.com', phone: '(617) 555-2899', score: 72, tier: 'Strong Potential', tierKey: 'strong', categories: [], durationSec: 250, completedAt: ago(100), answers: [0, 1, 2, 3, 0, 1, 2, 3, 0, 1] });
    doc.removed.push({ id: 'cgone1', name: 'Removed Person', email: 'removed@example.com' });
  });
  const iq = await me.json('GET', '/api/iq/state');
  const I = iq.body;
  ok(iq.status === 200 && I.ok === true && I.company === 'Wholesale Payments' && I.hostTeam.id === 'maverick' && I.previewUrl === '/assessment/?preview=1', 'the Sales IQ page state answers for this team', { company: I.company, host: I.hostTeam });
  ok(Array.isArray(I.teams) && I.teams.length === 6 && I.teams.every((x) => x.name && x.email) && I.tiers.map((x) => x.key).join() === 'elite,strong,develop,notready',
    'with the team picker and the score tiers', { teams: I.teams.length, tiers: I.tiers.map((x) => x.key) });
  ok(I.settings.team === 'Team Maverick' && I.settings.managerEmail === 'manager@example.com', 'and its settings', I.settings);
  ok(I.mail.ready === true && /blake@wholesalepayments\.com/.test(I.mail.from) && I.calendly.syncEnabled === false, 'and whether it can send, and Calendly', { mail: I.mail, calendly: I.calendly });
  const booked = I.candidates.find((x) => x.email === 'jordan@example.com');
  ok(booked && booked.source === 'calendly' && booked.status === 'added' && booked.crmId === 'j1' && booked.interviewEvent === '15 Minute Intro' && booked.phone === '(617) 555-2801',
    'someone who booked is folded in, linked to their candidate', booked);
  ok(!I.candidates.some((x) => x.email === 'teammate@wholesalepayments.com'), 'a teammate who booked is never a candidate');
  ok(!I.candidates.some((x) => x.email === 'past@example.com'), 'an interview already days past is not added');
  ok(!I.candidates.some((x) => x.email === 'removed@example.com'), 'someone taken off the list is not shown');
  ok(I.candidates.every((x) => typeof x.link === 'string' && x.link.includes(`/assessment/?t=${encodeURIComponent(`maverick.${x.id}.`)}`)), 'every questionnaire link is signed for this team and that person', I.candidates.map((x) => x.link));
  const done1 = I.candidates.find((x) => x.id === 'cdone1');
  ok(done1 && done1.status === 'completed' && done1.score === 72 && done1.durationSec === 250, 'a finished questionnaire shows its score', done1);
  ok(I.reports.length === 1 && I.reports[0].id === 'r0123456789abcdef01' && I.reports[0].tier === 'Strong Potential' && !('answers' in I.reports[0]) && !iq.text.includes('"answers"'),
    'reports are listed with their score, never with the raw answers', I.reports[0]);
  const iqAgain = await me.json('GET', '/api/iq/state');
  ok(iqAgain.body.candidates.filter((x) => x.email === 'jordan@example.com').length === 1, 'looking again does not fold the same booking in twice');

  ok(sent.count() === 0, 'nothing was sent', sent);
  ok(refused.length === 0, 'nothing reached outside this machine', refused);
  await s.close();
  done();
})().catch(crash);
