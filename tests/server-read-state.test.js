// GET /api/state: what the page reads from it for a crafted team.
//
//  - each candidate's public fields, exactly as stored, and the summaries the
//    Texting, Email and bell views are drawn from (last text, last reply,
//    reply count, bounced, industry), including older stored shapes;
//  - the fields kept on the server (Gmail message ids, sheet rows, other
//    addresses, Calendly event links, the reply and text histories) never
//    leave it;
//  - the counts on the dashboard, the activity feed window, the warning
//    banner, the team, interviews, templates, backups, Sales IQ and
//    onboarding summaries, and the settings with every secret masked or
//    removed.
const { startApp, ok, done, crash } = require('./helpers');
const { guardOutside, stubSenders, getState, ago, daysAgo } = require('./server-read-helpers');

const PUBLIC_FIELDS = [
  'id', 'name', 'firstName', 'lastName', 'email', 'phone',
  'role', 'pastRoles', 'company', 'location', 'notes', 'source',
  'status', 'addedAt',
  'lastEmailedAt', 'openedAt', 'lastReplyAt', 'lastSubject', 'gmailThreadId',
  'emailUnread', 'followUpCount',
  'lastTextedAt', 'textStatus', 'textUnread',
  'textDeliveredAt', 'textReadAt', 'textRepliedAt',
  'bookedAt', 'bookedEvent', 'bookedJoinUrl',
];
const SERVER_ONLY = ['messageId', 'threadId', 'sheetRow', 'city', 'altEmails', 'lastFollowUpAt', 'calendlyEventUri', 'replies', 'textThread', 'textReplies', 'repliedAt'];

(async () => {
  const refused = guardOutside();
  const s = await startApp({ offset: 0 });
  const sent = stubSenders();
  const storage = require(require('./helpers').R('lib/storage.js'));
  const backups = require(require('./helpers').R('lib/backups.js'));

  // ---------- a crafted list ----------
  const long = 'L'.repeat(300);
  const t0 = ago(600); const t1 = ago(500); const t2 = ago(400); const t3 = ago(300);
  const full = {
    id: 'full', name: 'Riley Example', firstName: 'Riley', lastName: 'Example',
    email: 'riley@example.com', phone: '(617) 555-2401',
    role: 'Account Executive', pastRoles: 'Solar consultant at Sunny Co', company: 'Widgets Inc', location: 'Boston, MA',
    notes: 'Met at a job fair', source: 'csv', status: 'replied', addedAt: daysAgo(20),
    lastEmailedAt: daysAgo(6), openedAt: daysAgo(5), lastReplyAt: t3, lastSubject: 'Quick question, Riley', gmailThreadId: 'gthread-full',
    emailUnread: true, followUpCount: 1,
    lastTextedAt: t0, textStatus: 'replied', textUnread: true,
    textDeliveredAt: t0, textReadAt: t1, textRepliedAt: t1,
    bookedAt: daysAgo(1), bookedEvent: '15 Minute Intro', bookedJoinUrl: 'https://meet.example.com/riley',
    // kept on the server only
    messageId: '<server-only-message-id@example.com>', threadId: 'server-only-thread-id', sheetRow: 4242,
    city: 'Server-Only-City', altEmails: ['server.only.alt@example.com'], lastFollowUpAt: daysAgo(3),
    calendlyEventUri: 'https://api.calendly.com/scheduled_events/server-only-event', repliedAt: t1,
    replies: [
      { date: t2, text: 'Sounds good, call me.', snippet: 'Sounds good' },
      { kind: 'bounce', date: t3, text: 'Delivery Status Notification (Failure)' },
      { snippet: long },              // a reply with no date of its own
    ],
    textThread: [
      { dir: 'out', ts: t0, text: 'Hi Riley, quick question?' },
      { dir: 'in', ts: t1, text: `Yes please ${long}` },
      { dir: 'in', ts: t2, text: 'Liked “Hi Riley, quick question?”', kind: 'tapback' },
    ],
  };
  const tapOnly = {
    id: 'tap', name: 'Sam Tapback', email: 'sam@example.com', phone: '(617) 555-2402', status: 'emailed', addedAt: daysAgo(20),
    lastTextedAt: t0,
    textThread: [{ dir: 'out', ts: t0, text: 'Hello Sam' }, { dir: 'in', ts: t1, text: 'Loved “Hello Sam”', kind: 'tapback' }],
  };
  const tapLast = {
    id: 'taponly', name: 'Tess Only', email: 'tess@example.com', status: 'emailed', addedAt: daysAgo(20),
    textThread: [{ dir: 'in', ts: t1, text: 'Emphasized a message', kind: 'tapback' }],
  };
  const bare = { id: 'bare', name: 'Bo Bare', email: 'bo@example.com', status: 'new', addedAt: daysAgo(2), source: 'manual' };
  // Stored before texting kept both halves: only their replies, as textReplies.
  const legacy = { id: 'legacy', name: 'Lee Legacy', email: 'lee@example.com', phone: '(617) 555-2403', status: 'replied', addedAt: daysAgo(40), textReplies: [{ ts: t2, text: 'old reply' }] };
  const bounced = { id: 'bnc', name: 'Bea Bounce', email: 'bea@example.com', status: 'bounced', addedAt: daysAgo(9), lastEmailedAt: daysAgo(8), replies: [{ kind: 'bounce', date: t3, text: 'Address not found' }] };
  const others = [
    { id: 'e1', name: 'Em One', email: 'em1@example.com', status: 'emailed', addedAt: daysAgo(9), lastEmailedAt: daysAgo(1) },
    { id: 'e2', name: 'Em Two', email: 'em2@example.com', status: 'emailed', addedAt: daysAgo(9), lastEmailedAt: daysAgo(1) },
    { id: 'bk', name: 'Bree Booked', email: 'bree@example.com', status: 'booked', addedAt: daysAgo(9), bookedAt: daysAgo(1) },
    { id: 'dc', name: 'Dee Declined', email: 'dee@example.com', status: 'declined', addedAt: daysAgo(9) },
    { id: 'odd', name: 'Ozzy Odd', email: 'ozzy@example.com', status: 'someday', addedAt: daysAgo(9) },
  ];

  // The feed: a morning of opens on top of the few things people actually did.
  const ev = [];
  for (let i = 1; i <= 70; i++) ev.push({ id: `op${i}`, ts: ago(i), type: 'opened', message: `Person ${i} opened your email.`, candidateId: null });
  ev.push({ id: 'txr', ts: ago(200), type: 'text-replied', message: 'Riley replied to your text.', candidateId: 'full' });
  ev.push({ id: 'rep', ts: ago(300), type: 'replied', message: 'Riley replied.', candidateId: 'full' });
  ev.push({ id: 'ass', ts: ago(400), type: 'assessed', message: 'Riley finished Sales IQ.', candidateId: 'full' });
  ev.push({ id: 'sig', ts: ago(450), type: 'signed', message: 'Riley signed the packet.', candidateId: 'full' });
  ev.push({ id: 'bkd', ts: ago(500), type: 'booked', message: 'Bree booked.', candidateId: 'bk' });
  for (let i = 1; i <= 30; i++) ev.push({ id: `tx${i}`, ts: ago(600 + i), type: 'texted', message: `Texted person ${i}.`, candidateId: null });
  ev.push({ id: 'imp', ts: ago(5), type: 'import', message: 'Imported 12 people.', candidateId: null });
  ev.push({ id: 'err-new', ts: ago(10), type: 'error', message: 'Gmail refused a send just now.', candidateId: null });
  ev.push({ id: 'err-old', ts: daysAgo(2), type: 'error', message: 'An old problem.', candidateId: null });
  ev.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  const interviews = [{ uri: 'https://api.calendly.com/scheduled_events/i1/invitees/x', inviteeName: 'Bree Booked', inviteeEmail: 'bree@example.com', start: daysAgo(-2), name: '15 Minute Intro', status: 'active', candidateId: 'bk' }];

  await s.store.update((d) => {
    d.candidates = [full, tapOnly, tapLast, bare, legacy, bounced, ...others];
    d.events = ev;
    d.interviews = interviews;
    d.settings.calendlyUrl = 'https://calendly.com/example-recruiter/intro';
    d.settings.fromName = 'Robin Recruiter';
    d.settings.timeZone = 'America/New_York';
    d.settings.lastSheetUrl = 'https://docs.google.com/spreadsheets/d/example';
    d.settings.smtpUser = 'robin@example.com';
    d.settings.googleClientId = 'client-id-is-not-secret';
    d.settings.ntfyTopic = 'example-topic';
    d.settings.smtpPass = 'SECRET-smtp-pass-123';
    d.settings.googleClientSecret = 'SECRET-google-client-456';
    d.settings.calendlySigningKey = 'SECRET-calendly-key-789';
    d.settings.calendlySigningKeys = ['SECRET-calendly-key-789', 'SECRET-calendly-older-000'];
    d.settings.calendlyToken = 'SECRET-calendly-token-abc';
    d.settings.apolloApiKey = 'SECRET-apollo-key-def';
    d.settings.relayToken = 'SECRET-relay-token-0123456789abcdef';
    d.settings.trackingSecret = 'SECRET-tracking-secret-ghi';
    d.settings.salesiqToken = 'SECRET-salesiq-token-jkl';
    d.settings.dailyLimit = '5000';
    d.settings.perMinute = '500';
    d.settings.textDailyLimit = '400';
    d.settings.textMinGap = '5';
    d.settings.textStartHour = '30';
    d.settings.gmailSignature = false;
  });
  await storage.setJson('salesiq', {
    v: 1,
    candidates: [
      { id: 'cq1', name: 'Riley Example', email: 'Riley@Example.com', status: 'completed', score: 88 },
      { id: 'cq2', name: 'Riley Again', email: 'riley@example.com', status: 'invited' },
      { id: 'cq3', name: 'Bree Booked', email: 'bree@example.com', status: 'invited', crmId: 'bk' },
    ],
    reports: [], settings: {}, seen: {}, removed: [],
  });
  await storage.setJson('onboarding', {
    v: 1,
    candidates: [{ id: 'ob1', applicant: { email: 'Bree@example.com', name: 'Bree Booked' }, crmId: 'bk' }],
    overrides: [],
    sends: [{ id: 'bree@example.com', email: 'bree@example.com', sentAt: daysAgo(1) }, { id: 'sim@example.com', email: 'sim@example.com', sentAt: daysAgo(1), simulated: true }],
    hires: [{ id: 'h1', email: 'bree@example.com', signedAt: ago(30), reference: 'REF-1' }],
    links: {},
  });
  const snap = await backups.snapshot('manual');

  const st = await getState(s);
  const S = st.body;
  ok(st.status === 200 && S, 'signed in, the state answers', st.status);
  const byId = Object.fromEntries((S.candidates || []).map((c) => [c.id, c]));

  // ---------- candidates ----------
  ok(S.candidates.length === 11 && ['full', 'tap', 'taponly', 'bare', 'legacy', 'bnc', 'e1', 'e2', 'bk', 'dc', 'odd'].every((id) => byId[id]), 'every candidate on the list is in the state', S.candidates.map((c) => c.id));
  const c = byId.full;
  const wrong = PUBLIC_FIELDS.filter((k) => JSON.stringify(c[k]) !== JSON.stringify(full[k]));
  ok(wrong.length === 0, 'every public field the page reads comes through exactly as stored', wrong);
  const leaked = SERVER_ONLY.filter((k) => k in c);
  ok(leaked.length === 0, 'server-only fields stay on the server', leaked);
  const strings = ['server-only-message-id', 'server-only-thread-id', 'Server-Only-City', 'server.only.alt@example.com', 'server-only-event', '4242'];
  ok(strings.every((x) => !st.text.includes(x)), 'their values appear nowhere in the response', strings.filter((x) => st.text.includes(x)));
  ok(Object.values(byId).every((x) => SERVER_ONLY.every((k) => !(k in x))), 'no candidate carries a server-only field');

  ok(c.industry === 'b2b', 'industry is worked out from the job (Account Executive → General B2B sales)', c.industry);
  ok(S.industries && S.industries.b2b === 'General B2B sales' && S.industries.other === 'Other' && S.industries.payments === 'Merchant services & payments', 'industry labels ride along for the filter', S.industries);
  ok(c.textCount === 3, 'textCount counts the whole thread, tapbacks included', c.textCount);
  ok(c.textLast && c.textLast.dir === 'in' && c.textLast.ts === t1 && c.textLast.text === `Yes please ${long}`.slice(0, 120),
    'textLast is the last real message (a tapback is skipped), cut to 120 characters', c.textLast);
  ok(c.textLastIn && c.textLastIn.ts === t1 && c.textLastIn.text.length === 120 && !('dir' in c.textLastIn), 'textLastIn is the newest thing they wrote, cut to 120', c.textLastIn);
  ok(c.emailReplies === 2, 'emailReplies counts real replies, not a bounce', c.emailReplies);
  ok(c.emailBounced === true, 'emailBounced is set when any reply was a bounce');
  ok(c.emailLast && c.emailLast.ts === t3 && c.emailLast.text === long.slice(0, 160),
    'emailLast is the last real reply: its time falls back to lastReplyAt, its text to the snippet, cut to 160', c.emailLast);

  const tp = byId.tap;
  ok(tp.textCount === 2 && tp.textLast && tp.textLast.dir === 'out' && tp.textLast.text === 'Hello Sam' && tp.textLastIn === null,
    'a tapback on our message is not what the conversation was last about, and is not something they wrote', { textLast: tp.textLast, textLastIn: tp.textLastIn });
  const to = byId.taponly;
  ok(to.textCount === 1 && to.textLast && to.textLast.text === 'Emphasized a message' && to.textLastIn === null,
    'with nothing but a tapback, textLast falls back to it', { textLast: to.textLast, textLastIn: to.textLastIn });
  const b = byId.bare;
  ok(b.textCount === 0 && b.textLast === null && b.textLastIn === null && b.emailReplies === 0 && b.emailBounced === false && b.emailLast === null && b.industry === 'other',
    'someone never contacted has empty summaries', b);
  const lg = byId.legacy;
  ok(lg.textCount === 1 && lg.textLastIn && lg.textLastIn.text === 'old reply' && lg.textLast && lg.textLast.dir === 'in',
    'replies stored in the older textReplies shape still show as a conversation', lg);
  const bn = byId.bnc;
  ok(bn.emailBounced === true && bn.emailReplies === 0 && bn.emailLast === null, 'a bounce alone is bounced, with no reply to show', bn);

  // ---------- stats ----------
  ok(JSON.stringify(S.stats) === JSON.stringify({ total: 11, new: 1, emailed: 4, replied: 2, booked: 1, declined: 1, bounced: 1 }),
    'stats count each status, and an unknown status only in the total', S.stats);

  // ---------- the feed ----------
  const ids = S.events.map((e) => e.id);
  const sorted = S.events.every((e, i) => i === 0 || String(S.events[i - 1].ts) >= String(e.ts));
  ok(sorted, 'the feed is newest first');
  ok(ids.slice(0, 60).join() === Array.from({ length: 60 }, (_, i) => `op${i + 1}`).join(), 'the 60 newest entries are there');
  ok(!ids.includes('op61') && !ids.includes('op70'), 'older opens fall out of the window');
  ok(['txr', 'rep', 'ass', 'sig', 'bkd'].every((x) => ids.includes(x)), 'a text reply, an email reply, a questionnaire, a signature and a booking are never pushed out by opens', ids.filter((x) => !/^op|^tx/.test(x)));
  const texted = ids.filter((x) => /^tx\d+$/.test(x));
  ok(texted.length === 24 && texted.includes('tx1') && texted.includes('tx24') && !texted.includes('tx25'),
    'the newest texting entries are kept on top of the window (25 texting entries in all)', texted.length);
  ok(S.events.length === 89, 'nothing else is in the feed', S.events.length);
  ok(!ids.includes('imp') && !ids.includes('err-new') && !ids.includes('err-old'), 'an import line or a warning is not a candidate update');
  const one = S.events.find((e) => e.id === 'txr');
  ok(one && one.ts === ev.find((e) => e.id === 'txr').ts && one.type === 'text-replied' && one.message === 'Riley replied to your text.' && one.candidateId === 'full', 'a feed entry carries its time, type, words and candidate', one);
  ok(S.lastError === 'Gmail refused a send just now.' && S.lastErrorId === 'err-new', 'the newest warning of the last day is the banner, with its id', { lastError: S.lastError, lastErrorId: S.lastErrorId });

  // ---------- settings: shown, masked, or kept back ----------
  const set = S.settings;
  const MASK = '••••••••';
  ok(set.smtpPass === MASK && set.googleClientSecret === MASK && set.calendlySigningKey === MASK && set.calendlyToken === MASK && set.apolloApiKey === MASK && set.relayToken === MASK,
    'every stored secret is masked', set);
  ok(!('trackingSecret' in set) && !('salesiqToken' in set) && !('calendlySigningKeys' in set), 'the tracking key, the Sales IQ token and the Calendly key ring are not sent at all');
  const secrets = ['SECRET-smtp-pass-123', 'SECRET-google-client-456', 'SECRET-calendly-key-789', 'SECRET-calendly-older-000', 'SECRET-calendly-token-abc', 'SECRET-apollo-key-def', 'SECRET-relay-token', 'SECRET-tracking-secret-ghi', 'SECRET-salesiq-token-jkl'];
  ok(secrets.every((x) => !st.text.includes(x)), 'no secret appears anywhere in the response', secrets.filter((x) => st.text.includes(x)));
  ok(set.calendlyUrl === 'https://calendly.com/example-recruiter/intro' && set.fromName === 'Robin Recruiter' && set.timeZone === 'America/New_York'
    && set.lastSheetUrl === 'https://docs.google.com/spreadsheets/d/example' && set.smtpUser === 'robin@example.com'
    && set.googleClientId === 'client-id-is-not-secret' && set.ntfyTopic === 'example-topic' && set.gmailSignature === false,
    'the settings the form shows come through as typed', set);
  ok(set.dailyLimit === '2000' && set.perMinute === '60', 'the email pace is shown already clamped to what the queue will do', { dailyLimit: set.dailyLimit, perMinute: set.perMinute });
  ok(set.textDailyLimit === '100' && set.textMinGap === '20' && set.textStartHour === '23', 'the texting pace is shown already clamped', { textDailyLimit: set.textDailyLimit, textMinGap: set.textMinGap, textStartHour: set.textStartHour });
  ok(S.queue.dailyLimit === 2000 && S.queue.dailyMax === 2000 && S.queue.perMinute === 60, 'the email queue reports the same pace', S.queue);
  ok(S.texting.queue.dailyLimit === 100 && S.texting.queue.minGap === 20 && S.texting.queue.startHour === 23, 'the text queue reports the same pace', S.texting.queue);
  ok(S.apollo.configured === true && S.calendly.syncEnabled === true && S.calendly.webhook === true && S.texting.tokenSet === true,
    'what is connected is said without saying the secret', { apollo: S.apollo, calendly: S.calendly, tokenSet: S.texting.tokenSet });

  // ---------- the rest the page reads ----------
  ok(S.team && S.team.id === 'maverick' && S.team.name === 'Team Maverick' && S.team.usesAppPassword === true, 'the team it is signed in to', S.team);
  ok(S.auth && S.auth.required === true, 'sign-in is required');
  ok(JSON.stringify(S.interviews) === JSON.stringify(interviews), 'interviews come through as stored', S.interviews);
  ok(S.templateEdited === true, 'a team that predates the starter-letter flag is not told to personalise its letter');
  ok(S.template && typeof S.template.subject === 'string' && typeof S.template.body === 'string' && Array.isArray(S.template.attachments), 'the outreach template is there', S.template);
  ok(S.followUp && S.followUp.template && /\{\{\s*originalSubject\s*\}\}/.test(S.followUp.template.subject), 'the follow-up template is there', S.followUp);
  ok(S.texting.template && /\{\{firstName\}\}/.test(S.texting.template.body), 'the text template is there');
  ok(S.templates && Array.isArray(S.templates.email) && Array.isArray(S.templates.text) && S.templates.defaults, 'the saved templates are there', S.templates);
  ok(S.storage && S.storage.persistent === true && S.storage.deployed === false, 'storage is reported as permanent (and not a public deploy)', S.storage);
  ok(Array.isArray(S.backups) && S.backups.length === 1 && S.backups[0].key === snap.key && S.backups[0].reason === 'manual' && S.backups[0].count === 11 && S.backups[0].at === snap.at,
    'backups are listed with when, why and how many', S.backups);
  ok(S.google && S.google.connected === true && S.sending && S.sending.ready === true, 'Google and sending status are there', { google: S.google, sending: S.sending });
  ok(S.maxImmediate === 8, 'the immediate-send batch size is there', S.maxImmediate);
  ok(typeof S.baseUrl === 'string' && S.baseUrl.startsWith('http'), 'the site address is there', S.baseUrl);
  ok(S.apollo.maxPerPull > 0 && S.apollo.batch > 0, 'Apollo limits are there', S.apollo);

  // Sales IQ and onboarding, by address.
  const iq = S.salesiq.byEmail;
  ok(iq['riley@example.com'] && iq['riley@example.com'].status === 'completed' && iq['riley@example.com'].score === 88
    && iq['riley@example.com'].tier === 'Elite Talent' && iq['riley@example.com'].tierKey === 'elite',
    'Sales IQ by address: someone listed twice counts at the furthest step, with score and tier', iq);
  ok(iq['bree@example.com'] && iq['bree@example.com'].status === 'invited' && !('score' in iq['bree@example.com']), 'an invited person has no score yet', iq['bree@example.com']);
  ok(S.salesiq.byCrm && S.salesiq.byCrm.bk === 'bree@example.com' && S.salesiq.total === 3, 'Sales IQ by candidate id, and the count', S.salesiq);
  const ob = S.onboarding.byEmail;
  ok(ob['bree@example.com'] && ob['bree@example.com'].onPipeline === true && ob['bree@example.com'].sentAt && ob['bree@example.com'].signedAt && ob['bree@example.com'].reference === 'REF-1',
    'onboarding by address: on the pipeline, packet sent, signed', ob);
  ok(!ob['sim@example.com'], 'a packet that was only simulated does not count as sent');
  ok(S.onboarding.byCrm && S.onboarding.byCrm.bk === 'bree@example.com', 'onboarding by candidate id', S.onboarding.byCrm);

  // ---------- a warning more than a day old is not a banner ----------
  await s.store.update((d) => { d.events = d.events.filter((e) => e.id !== 'err-new'); });
  const st2 = await getState(s);
  ok(st2.body.lastError === '' && st2.body.lastErrorId === '', 'a warning older than a day is not shown', { lastError: st2.body.lastError });

  // ---------- reading changes nothing ----------
  const before = JSON.stringify((await s.store.load()).candidates);
  await getState(s); await getState(s);
  ok(JSON.stringify((await s.store.load()).candidates) === before, 'reading the state never changes the stored list (unread flags included)');

  ok(sent.count() === 0, 'nothing was sent', sent);
  ok(refused.length === 0, 'nothing reached outside this machine', refused);
  await s.close();
  done();
})().catch(crash);
