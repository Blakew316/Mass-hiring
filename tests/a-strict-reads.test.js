// Every route that now reads the shared, frozen copy of the team's document
// (store.read()) instead of a private one, exercised with the whole app in
// strict mode. The app's files are sloppy-mode, where a write to a frozen
// object is silently ignored — so a handler, or a helper it calls, that
// quietly changed the copy it was given would pass any test run the usual
// way and serve the next request a list that is not what is stored. Here
// every file of the app is compiled with "use strict" in front of it, so that
// write throws, the route answers with the error, and its check fails.
// (Node's --use-strict does not reach CommonJS modules, hence the hook.)
//
// Each route is asked for something real (a thread with messages, a preview,
// a booking, a reply, a sync), so its handler walks the list as it does in
// use. The pure reads must also write nothing at all.
// Made-up people only; nothing leaves this machine.
const path = require('path');
const Module = require('module');
const crypto = require('crypto');
const { R, ROOT, ok, done, crash } = require('./helpers');

const strictFiles = [];
const compile = Module.prototype._compile;
const appCode = (file) => file.startsWith(ROOT + path.sep) && !file.includes(`${path.sep}node_modules${path.sep}`) && !file.startsWith(path.join(ROOT, 'tests') + path.sep);
Module.prototype._compile = function strictly(content, filename) {
  if (!appCode(filename)) return compile.call(this, content, filename);
  strictFiles.push(path.relative(ROOT, filename));
  // On the first line, so line numbers in any stack trace stay true.
  return compile.call(this, `'use strict';${content}`, filename);
};

const W = require('./server-write-helpers');
const { dataSnapshot } = require('./server-read-helpers');

(async () => {
  const s = await W.start(210);
  const tracking = require(R('lib/tracking.js'));
  const tenant = require(R('lib/tenant.js'));
  ok(strictFiles.includes('app.js') && strictFiles.includes(path.join('lib', 'store.js')) && strictFiles.includes(path.join('lib', 'replies.js')), 'the app is compiled in strict mode for this test', strictFiles.length);
  let assigned = null;
  try { require(R('lib/presets.js')).normalize(Object.freeze({ templateDefaults: {}, template: {}, textTemplate: {} })); } catch (e) { assigned = e; }
  ok(assigned instanceof TypeError, 'so a write to a frozen object inside the app\'s own code throws', assigned && assigned.message);

  const signingKey = crypto.randomBytes(32).toString('hex');
  const day = 86400000;
  const soon = new Date(Date.now() + 3 * day).toISOString();
  await W.seed(s, [
    W.person(1, { status: 'emailed', lastEmailedAt: W.ago(6000), gmailThreadId: 'th-1', lastSubject: 'Quick question', messageId: '<m1@example.com>',
      replies: [{ id: 'g1', date: W.ago(3000), text: 'Tell me more', snippet: 'Tell me more', kind: '' }], lastReplyAt: W.ago(3000), emailUnread: true,
      lastTextedAt: W.ago(5000), textStatus: 'delivered', textThread: [{ dir: 'out', ts: W.ago(5000), text: 'Hi Avery, quick question?' }, { dir: 'in', ts: W.ago(4000), text: 'Sure, who is this?' }], textUnread: true }),
    W.person(2, { status: 'emailed', lastEmailedAt: W.ago(6000), gmailThreadId: 'th-2', lastSubject: 'Quick question', lastTextedAt: W.ago(5000), textStatus: 'sent',
      textThread: [{ dir: 'out', ts: W.ago(5000), text: 'Hi Jordan' }] }),
    W.person(3, { status: 'new', altEmails: ['casey.alt@example.org'] }),
    W.person(4, { status: 'booked', bookedAt: soon, bookedEvent: 'Intro call', calendlyEventUri: 'https://api.calendly.com/scheduled_events/ev-4' }),
    W.person(5, { status: 'replied', gmailThreadId: 'th-5', lastEmailedAt: W.ago(9000), replies: [{ id: 'g5', date: W.ago(8000), text: 'Out of office', snippet: 'Out of office', kind: 'auto' }] }),
    W.person(6, { status: 'emailed', lastEmailedAt: W.ago(6000), openedAt: W.ago(5500) }),
  ], (d) => {
    d.interviews = [{ uri: 'https://api.calendly.com/scheduled_events/ev-4', name: 'Intro call', status: 'active', start: soon, end: soon, joinUrl: 'https://meet.example.com/ev-4', inviteeName: 'Riley Parker', inviteeEmail: 'riley.parker@example.com', candidateId: 'p4' }];
    d.settings.calendlyToken = 'cal-test-token';
    d.settings.calendlySigningKeys = [signingKey];
    d.settings.calendlySigningKey = signingKey;
    d.settings.googleClientId = 'client.apps.example.com';
    d.settings.googleClientSecret = 'client-secret';
    d.settings.trackingSecret = crypto.randomBytes(32).toString('hex');
    d.settings.apolloApiKey = 'apollo-test-key';
  });
  const token = await W.relayToken(s);
  const relay = (p, body) => W.relay(s, token, p, body);
  const answers = [];
  const expect = (what, r, status = 200, check = null) => {
    const good = r.status === status && (!check || check(r.body));
    answers.push(`${what}:${r.status}`);
    ok(good, `${what} answers ${status}${check ? ' as it should' : ''}`, { status: r.status, body: r.body && JSON.stringify(r.body).slice(0, 300) });
  };

  // ---------- pure reads: nothing written ----------
  const before = dataSnapshot();
  const st = await s.json('GET', '/api/state');
  expect('state', st, 200, (b) => b.candidates.length === 6 && b.texting.priority && Array.isArray(b.followUp.dueIds));
  const tag = st.headers.get('etag');
  const again = await s.call('GET', '/api/state', null, { 'if-none-match': tag });
  ok(again.status === 304, 'state with its tag: 304', again.status);
  expect('texts thread', await s.json('GET', '/api/texts/thread?id=p1'), 200, (b) => b.thread.length === 2);
  expect('emails thread', await s.json('GET', '/api/emails/thread?id=p1'), 200, (b) => b.id === 'p1');
  expect('email preview', await s.json('POST', '/api/preview', { candidateId: 'p1' }), 200, (b) => /Avery/.test(b.html));
  expect('follow-up preview', await s.json('POST', '/api/preview', { candidateId: 'p3', followUp: true }), 200, (b) => b.followUp === true);
  expect('text preview', await s.json('POST', '/api/texts/preview', { id: 'p2' }), 200, (b) => /Jordan/.test(b.body));
  expect('text preview, nobody named', await s.json('POST', '/api/texts/preview', {}), 200);
  expect('relay token', await s.json('GET', '/api/texts/relay-token'), 200, (b) => b.token === token);
  expect('flyer preview', await s.json('GET', '/api/template/attachments/builtin-account-executive/preview'), 200, (b) => /^data:image\/png;base64,/.test(b.dataUrl));
  const exp = await s.call('GET', '/api/candidates/export');
  expect('export', { status: exp.status, body: null });
  ok((await exp.text()).includes('avery.quinn@example.com'), 'the export has the list');
  expect('import preview', await s.json('POST', '/api/import/preview', { rows: [['Avery Quinn', 'avery.quinn@example.com'], ['New Person', 'new.person@example.com']], mapping: { name: 0, email: 1 } }), 200, (b) => b.newCount === 1 && b.existing === 1);
  expect('relay handles', await relay('handles', {}), 200, (b) => b.handles.length === 2);
  expect('salesiq connection', await s.json('GET', '/api/salesiq-connection'));
  expect('google auth url', await s.json('GET', '/api/google/auth-url'), 200, (b) => /accounts\.google\.com/.test(b.url));
  const g = await fetch(`${s.base}/auth/google`, { headers: { cookie: s.cookie }, redirect: 'manual' });
  ok(g.status === 302 && /accounts\.google\.com/.test(g.headers.get('location') || ''), '/auth/google sends the browser to Google', g.status);
  const cb = await fetch(`${s.base}/auth/google/callback?error=access_denied`, { headers: { cookie: s.cookie }, redirect: 'manual' });
  ok(cb.status === 302 && /error=access_denied/.test(cb.headers.get('location') || ''), 'the Google callback reads the list and says what Google said', cb.status);
  expect('onboarding status', await s.json('GET', '/api/onboarding/status'));
  expect('onboarding email test', await s.json('POST', '/api/onboarding/email/test'));
  expect('backups', await s.json('GET', '/api/backups'));
  const pixelOther = await fetch(`${s.base}/webhooks/open/maverick/${'a'.repeat(4)}.${'0'.repeat(24)}.gif`);
  ok(pixelOther.status === 200, 'a pixel nobody signed is answered and changes nothing', pixelOther.status);
  ok(dataSnapshot() === before, 'none of those reads wrote anything');
  const stored0 = await W.stored(s);
  ok(stored0.candidates.find((c) => c.id === 'p1').textUnread === true && stored0.candidates.find((c) => c.id === 'p1').emailUnread === true, 'the unread flags a read might be tempted to clear are still set');

  // ---------- routes that read, then write through their own copy ----------
  expect('relay hello', await relay('hello', { host: 'Strict-Mac', version: '1.0.0', bluebubbles: true }), 200, (b) => b.limits && b.limits.dailyLimit > 0);
  const pixel = await tenant.run('maverick', async () => tracking.pixelPath((await W.stored(s)).settings, 'p6'));
  const opened = await fetch(s.base + pixel);
  ok(opened.status === 200, 'the open pixel', opened.status);
  ok(!!(await W.storedCandidate(s, 'p6')).openedAt === true, 'and the open is recorded');
  const legacyPixel = pixel.replace('/webhooks/open/maverick/', '/webhooks/open/');
  ok((await fetch(s.base + legacyPixel)).status === 200, 'the pixel at its older address');
  expect('settings, a change', await s.json('POST', '/api/settings', { fromName: 'Strict Sender', timeZone: 'America/New_York' }), 200, (b) => b.settings.fromName === 'Strict Sender');
  expect('settings, nothing changed', await s.json('POST', '/api/settings', { fromName: 'Strict Sender' }));
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const added = await s.json('POST', '/api/template/attachments', { name: 'tiny.png', data: Buffer.concat([png, Buffer.alloc(64)]).toString('base64') });
  expect('attachment added', added, 200, (b) => b.attachment && b.attachment.id);
  expect('attachment removed', await s.json('DELETE', `/api/template/attachments/${added.body.attachment.id}`));
  s.google.fetchSheetRows = async () => ({ rows: [['Name', 'Email'], ['Sheet Person', 'sheet.person@example.com']], via: 'csv' });
  expect('sheet import', await s.json('POST', '/api/import/sheet', { url: 'https://docs.google.com/spreadsheets/d/example' }), 200, (b) => b.rows.length === 1);
  expect('the same sheet again', await s.json('POST', '/api/import/sheet', { url: 'https://docs.google.com/spreadsheets/d/example' }));
  s.apollo.search = async () => ({ people: [], total: 0, page: 1 });
  expect('apollo search', await s.json('POST', '/api/apollo/search', { titles: ['Account Executive'] }));
  s.apollo.enrich = async () => ({ credits: 1, matches: [{ id: 'a'.repeat(24), first_name: 'Apollo', last_name: 'Person', name: 'Apollo Person', email: 'apollo.person@example.com', title: 'Account Executive', organization: { name: 'Example Org' } }] });
  expect('apollo import', await s.json('POST', '/api/apollo/import', { ids: ['a'.repeat(24)] }), 200, (b) => b.added === 1);
  expect('relay events', await relay('events', { events: [
    { phone: '(617) 555-2002', kind: 'delivered', ts: new Date().toISOString() },
    { phone: '(617) 555-2002', kind: 'read', ts: new Date().toISOString() },
    { phone: '(617) 555-2002', kind: 'reply', ts: new Date().toISOString(), text: 'Yes, call me tomorrow' },
  ] }), 200, (b) => b.applied === 3);
  expect('relay receipts seen before', await relay('events', { events: [{ phone: '(617) 555-2002', kind: 'delivered', ts: new Date().toISOString() }] }));
  expect('text reply', await s.json('POST', '/api/texts/reply', { id: 'p2', body: 'Great — 10am?' }), 200, (b) => b.queued === true);
  expect('candidate edit, nothing changed', await s.json('PATCH', '/api/candidates/p3', { notes: '' }));
  s.google.threadReplies = async (_settings, threadId) => ({ limited: false, replies: threadId === 'th-2'
    ? [{ id: 'g2', from: 'Jordan Blake <jordan.blake@example.com>', date: W.ago(1), subject: 'Re: Quick question', snippet: 'Interested', text: 'Interested', kind: '' }] : [] });
  expect('reply check', await s.json('POST', '/api/replies/check'), 200, (b) => b.replies === 1);
  expect('reply check, nothing new', await s.json('POST', '/api/replies/check'), 200, (b) => b.replies === 0);
  const listing = [
    { uri: 'https://api.calendly.com/scheduled_events/ev-4', name: 'Intro call', status: 'active', start: soon, end: soon, joinUrl: 'https://meet.example.com/ev-4',
      invitees: [{ name: 'Riley Parker', email: 'riley.parker@example.com', status: 'active', createdAt: W.ago(100), phone: '', rescheduleUrl: '', cancelUrl: '' }] },
    { uri: 'https://api.calendly.com/scheduled_events/ev-3', name: 'Intro call', status: 'active', start: soon, end: soon, joinUrl: 'https://meet.example.com/ev-3',
      invitees: [{ name: 'Casey Morgan', email: 'casey.alt@example.org', status: 'active', createdAt: W.ago(50), phone: '', rescheduleUrl: '', cancelUrl: '' }] },
  ];
  s.calendly.listInterviews = async () => ({ complete: true, skipped: [], schedulingUrl: '', interviews: structuredClone(listing) });
  expect('calendly sync', await s.json('POST', '/api/calendly/sync'), 200, (b) => b.ok && b.newBookings === 1 && b.changed === true);
  expect('calendly sync, nothing new', await s.json('POST', '/api/calendly/sync'), 200, (b) => b.ok && b.newBookings === 0 && b.changed === false);
  const payload = JSON.stringify({ event: 'invitee.created', payload: {
    email: 'drew.hollis@example.com', name: 'Drew Hollis', created_at: W.ago(1),
    scheduled_event: { uri: 'https://api.calendly.com/scheduled_events/ev-8', name: 'Intro call', start_time: soon, end_time: soon, location: { join_url: 'https://meet.example.com/ev-8' } },
  } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', signingKey).update(`${t}.${payload}`).digest('hex');
  const hook = (url) => fetch(`${s.base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'Calendly-Webhook-Signature': `t=${t},v1=${sig}` }, body: payload });
  ok((await hook('/webhooks/calendly/maverick')).status === 200, 'a signed Calendly webhook', null);
  ok((await hook('/webhooks/calendly')).status === 200, 'and at its older address');
  const iq = await s.json('POST', '/api/salesiq-connection');
  expect('salesiq connection made', iq, 200, (b) => b.connected === true);
  const iqKey = JSON.parse(Buffer.from(iq.body.code.replace(/^WPSIQ1\./, ''), 'base64url').toString()).k;
  const bookings = await fetch(`${s.base}/api/salesiq/bookings`, { headers: { authorization: `Bearer ${iqKey}` } });
  const bookingsBody = await bookings.json();
  ok(bookings.status === 200 && bookingsBody.bookings.length >= 2 && bookingsBody.syncedAt, 'Sales IQ reads the bookings, and when they were synced', { status: bookings.status, syncedAt: bookingsBody.syncedAt });
  const iqSync = await fetch(`${s.base}/api/salesiq/sync`, { method: 'POST', headers: { authorization: `Bearer ${iqKey}` } });
  ok(iqSync.status === 200 && (await iqSync.json()).ran === false, 'a Sales IQ sync right after one is not run again', iqSync.status);
  expect('sales iq state', await s.json('GET', '/api/iq/state'), 200, (b) => b.calendly.lastSyncAt);
  expect('sales iq sync', await s.json('POST', '/api/iq/sync'));
  expect('onto Sales IQ from the list', await s.json('POST', '/api/iq/add-from-pipeline', { ids: ['p1', 'p2'] }), 200, (b) => b.added.length === 2);
  expect('onboarding: a saved candidate', await s.json('POST', '/api/onboarding/saved/candidates', { candidate: { id: 'ob1', applicant: { email: 'riley.parker@example.com' } } }));
  expect('onto onboarding from the list', await s.json('POST', '/api/onboarding/from-crm', { ids: ['p1'] }), 200, (b) => b.added.length === 1);
  expect('onto onboarding, one', await s.json('POST', '/api/onboarding/from-crm', { id: 'p2' }));
  expect('a backup', await s.json('POST', '/api/backups'), 200, (b) => b.backup && b.backup.count >= 7);
  expect('restore, dry run', await s.json('POST', '/api/backups/restore', { key: (await s.json('GET', '/api/backups')).body.backups[0].key, dryRun: true }), 200, (b) => b.missing === 0);
  expect('test notification', await s.json('POST', '/api/test-notification'));
  expect('state at the end', await s.json('GET', '/api/state'), 200, (b) => b.candidates.length >= 7 && b.calendly.lastSyncAt);

  ok(answers.every((a) => /:200$/.test(a)), 'every route answered', answers.filter((a) => !/:200$/.test(a)));
  ok(s.outsideCalls.length === 0, 'nothing reached outside this machine', s.outsideCalls);
  ok(s.sentMail.length === 0, 'no email was sent', s.sentMail.length);
  await s.close();
  done();
})().catch(crash);
