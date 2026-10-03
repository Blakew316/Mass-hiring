// Writes that change nothing are not made. Every write of the team's
// document rewrites the whole list (20 MB at the live size) and gives a real
// change one more thing to collide with, so:
//   - the reply check writes the list only when something in it changes; who
//     was read when (the rotation) is its own small record, and the rotation
//     still reaches everyone, oldest-read first — stamps left on candidates
//     by an older version included;
//   - the Calendly sync writes the list only when the interviews or the people
//     matched to them change; when it last ran, its error and Sales IQ's claim
//     are a record of their own, shown on the page as before, and the time it
//     ran does not move the state's tag;
//   - a candidate edit, a settings save, a sheet URL, a text reply to a
//     conversation already read, a "test notification" with no warning up and
//     a relay batch of receipts already recorded write nothing; a relay batch
//     that brings news is one write with its feed lines;
//   - those small records go with the team when it is deleted.
// Made-up people only; nothing leaves this machine.
const fs = require('fs');
const path = require('path');
const { R, ok, done, crash } = require('./helpers');
const W = require('./server-write-helpers');

(async () => {
  const s = await W.start(220);
  const storage = require(R('lib/storage.js'));
  const replies = require(R('lib/replies.js'));
  let dbWrites = 0;
  const realWrite = storage.setJsonIfMatch;
  storage.setJsonIfMatch = async (key, ...rest) => { if (key === 'db') dbWrites += 1; return realWrite(key, ...rest); };
  const writesDuring = async (fn) => { const before = dbWrites; const r = await fn(); return { r, writes: dbWrites - before }; };

  const many = Array.from({ length: 26 }, (_, i) => W.person(i + 1, {
    email: `quiet.person.${i + 1}@example.com`, status: 'emailed', gmailThreadId: `th-${i + 1}`, lastEmailedAt: W.ago(6000), lastSubject: 'Quick question',
  }));
  await W.seed(s, many);

  // ---------- the reply check ----------
  let read = [];
  const inbox = {};
  s.google.threadReplies = async (_settings, threadId) => { read.push(threadId); return { limited: false, replies: (inbox[threadId] || []).map((m) => ({ ...m })) }; };
  let r = await writesDuring(() => s.json('POST', '/api/replies/check'));
  ok(r.r.status === 200 && r.r.body.checked === 20 && r.r.body.replies === 0, 'a reply check reads twenty threads and finds nothing new', r.r.body);
  ok(r.writes === 0, 'and writes nothing to the list', r.writes);
  const rec = await storage.getJson('reply-checked');
  ok(rec && Object.keys(rec.at).length === 20 && read.every((t) => rec.at[`p${t.slice(3)}`]), 'who was read is in its own small record', rec && Object.keys(rec.at).length);
  const firstRound = new Set(read);
  read = [];
  r = await writesDuring(() => s.json('POST', '/api/replies/check'));
  const neverRead = many.map((c) => c.gmailThreadId).filter((t) => !firstRound.has(t));
  ok(neverRead.length === 6 && neverRead.every((t) => read.includes(t)), 'the next check reads the six never read first', { neverRead, read });
  ok(r.writes === 0, 'and still writes nothing to the list', r.writes);
  ok(Object.keys((await storage.getJson('reply-checked')).at).length === 26, 'everyone read is recorded');

  inbox['th-3'] = [{ id: 'g3', from: 'Casey Morgan <quiet.person.3@example.com>', date: W.ago(2), subject: 'Re: Quick question', snippet: 'Yes please', text: 'Yes please, call me.', kind: '' }];
  // th-3 was read in the first round; the oldest-read come round again in
  // the third, since everyone has now been read once.
  read = [];
  r = await writesDuring(() => s.json('POST', '/api/replies/check'));
  ok(read.includes('th-3') && r.r.body.replies === 1, 'a reply is found when its thread comes round again', { read: read.length, replies: r.r.body.replies });
  ok(r.writes === 1, 'and that is one write', r.writes);
  const c3 = await W.storedCandidate(s, 'p3');
  ok(c3.status === 'replied' && c3.emailUnread === true && (await W.storedEvents(s, 'replied', 'p3')).length === 1, 'they are replied, unread, and announced once');
  ok(c3.repliesCheckedAt === undefined, 'with no rotation stamp on the candidate any more');
  r = await writesDuring(() => s.json('POST', '/api/replies/check'));
  ok(r.writes === 0 && (await W.storedEvents(s, 'replied', 'p3')).length === 1, 'the next check writes nothing and announces nothing again', r.writes);

  // A stamp an older version left on candidates still orders the rotation
  // until the record has one of its own.
  await storage.del('reply-checked');
  await s.store.update((d) => {
    d.candidates.forEach((c, i) => { c.repliesCheckedAt = new Date(Date.now() - (i === 25 ? 9 : 1) * 3600e3).toISOString(); });
    d.candidates[24].repliesCheckedAt = undefined;
  });
  read = [];
  await replies.checkReplies({ waiting: 2, conversing: 0, backfill: 0, changed: 0 });
  ok(read.length === 2 && read[0] === 'th-25' && read[1] === 'th-26', 'an older version\'s stamps: never read first, then the longest ago', read);

  // ---------- the Calendly sync ----------
  const soon = new Date(Date.now() + 3 * 86400000).toISOString();
  let listing = [{ uri: 'https://api.calendly.com/scheduled_events/ev-1', name: 'Intro call', status: 'active', start: soon, end: soon, joinUrl: 'https://meet.example.com/ev-1',
    invitees: [{ name: 'Avery Quinn', email: 'quiet.person.1@example.com', status: 'active', createdAt: W.ago(30), phone: '', rescheduleUrl: '', cancelUrl: '' }] }];
  let fail = null;
  s.calendly.listInterviews = async () => { if (fail) throw new Error(fail); return { interviews: structuredClone(listing), skipped: [], complete: true, schedulingUrl: '' }; };
  // A document from before the move: its last sync and error are shown until
  // the first sync after it.
  await s.store.update((d) => { d.calendlyLastSyncAt = '2026-09-01T12:00:00.000Z'; d.calendlySyncError = 'An old Calendly error'; });
  let st = await W.state(s);
  ok(st.calendly.lastSyncAt === '2026-09-01T12:00:00.000Z' && st.calendly.error === 'An old Calendly error', 'what an older version recorded is shown until the next sync', st.calendly);
  ok(st.calendly.syncEnabled === false, 'no token yet');
  await s.json('POST', '/api/settings', { calendlyToken: 'cal-test-token' });
  r = await writesDuring(() => s.json('POST', '/api/calendly/sync'));
  ok(r.r.body.ok && r.r.body.newBookings === 1 && r.r.body.changed === true && r.r.body.syncedAt, 'a sync with a new booking says so', r.r.body);
  ok(r.writes === 2, 'it writes the list (the booking, then its line in Candidate updates)', r.writes);
  st = await W.state(s);
  ok(st.calendly.lastSyncAt === r.r.body.syncedAt && st.calendly.error === '', 'the page shows when it ran, and the old error is gone', st.calendly);
  const tag = (await s.call('GET', '/api/state')).headers.get('etag');
  r = await writesDuring(() => s.json('POST', '/api/calendly/sync'));
  ok(r.r.body.ok && r.r.body.newBookings === 0 && r.r.body.changed === false && r.r.body.syncedAt, 'the same listing again changes nothing, and says so', r.r.body);
  ok(r.writes === 0, 'and writes nothing to the list', r.writes);
  const after = await s.call('GET', '/api/state', null, { 'if-none-match': tag });
  ok(after.status === 304, 'the sync\'s time moving on does not change the state\'s tag', after.status);
  ok((await W.state(s)).calendly.lastSyncAt === r.r.body.syncedAt, 'though the state, when fetched, shows it');
  fail = 'Calendly API error (401)';
  r = await writesDuring(() => s.json('POST', '/api/calendly/sync'));
  ok(r.r.body.ok === false && r.r.body.changed === true && r.writes === 0, 'a failure is reported and changes what the page shows, without writing the list', r.r.body);
  const failed = await s.call('GET', '/api/state', null, { 'if-none-match': tag });
  const failedBody = failed.status === 200 ? await failed.json() : null;
  ok(failed.status === 200 && failedBody.calendly.error === 'Calendly API error (401)', 'the error is shown, with a new tag', failed.status);
  r = await writesDuring(() => s.json('POST', '/api/calendly/sync'));
  ok(r.r.body.ok === false && r.r.body.changed === false, 'the same failure again changes nothing the page shows', r.r.body);
  fail = null;
  r = await writesDuring(() => s.json('POST', '/api/calendly/sync'));
  ok(r.r.body.ok && r.r.body.changed === true && r.writes === 0 && (await W.state(s)).calendly.error === '', 'the next good sync clears it (changed), still without writing the list', r.r.body);
  // Sales IQ's claim on a sync is in the same small record.
  await storage.setJson('calendly-sync', { lastSyncAt: W.ago(10), error: '' });
  const iqKey = (await s.json('POST', '/api/salesiq-connection')).body.code;
  const key = JSON.parse(Buffer.from(iqKey.replace(/^WPSIQ1\./, ''), 'base64url').toString()).k;
  const iqSync = async () => (await fetch(`${s.base}/api/salesiq/sync`, { method: 'POST', headers: { authorization: `Bearer ${key}` } })).json();
  r = await writesDuring(iqSync);
  ok(r.r.ran === true && r.writes === 0, 'Sales IQ claims and runs a sync that finds nothing new, writing nothing to the list', r.r);
  const claimed = await storage.getJson('calendly-sync');
  ok(claimed.claimedAt && claimed.lastSyncAt && claimed.lastSyncAt === r.r.syncedAt, 'its claim and the time it ran are in the small record', claimed);
  ok((await iqSync()).ran === false, 'and the next look, a moment later, does not run another');

  // ---------- writes that change nothing ----------
  r = await writesDuring(() => s.json('PATCH', '/api/candidates/p2', { notes: '', role: 'Account Executive' }));
  ok(r.r.status === 200 && r.r.body.candidate.id === 'p2' && r.writes === 0, 'a candidate edit that changes nothing writes nothing', r.writes);
  r = await writesDuring(() => s.json('PATCH', '/api/candidates/p2', { notes: 'Prefers mornings' }));
  ok(r.writes === 1 && (await W.storedCandidate(s, 'p2')).notes === 'Prefers mornings', 'one that changes something writes it', r.writes);
  const cur = (await W.stored(s)).settings;
  r = await writesDuring(() => s.json('POST', '/api/settings', { fromName: cur.fromName, followUpDays: cur.followUpDays, calendlyToken: '••••••••' }));
  ok(r.r.status === 200 && r.writes === 0, 'a settings save that changes nothing writes nothing', r.writes);
  r = await writesDuring(() => s.json('POST', '/api/settings', { fromName: 'Quinn Sender' }));
  ok(r.writes === 1 && r.r.body.settings.fromName === 'Quinn Sender', 'one that changes something writes it', r.writes);
  s.google.fetchSheetRows = async () => ({ rows: [['Name', 'Email'], ['Sheet Person', 'sheet.person@example.com']], via: 'csv' });
  r = await writesDuring(() => s.json('POST', '/api/import/sheet', { url: 'https://docs.google.com/spreadsheets/d/quiet' }));
  ok(r.writes === 1, 'a new sheet address is remembered', r.writes);
  r = await writesDuring(() => s.json('POST', '/api/import/sheet', { url: 'https://docs.google.com/spreadsheets/d/quiet' }));
  ok(r.r.status === 200 && r.writes === 0, 'the same one again writes nothing', r.writes);
  r = await writesDuring(() => s.json('POST', '/api/test-notification'));
  ok(r.r.status === 200 && r.writes === 0, 'a test notification with no warning up writes nothing', r.writes);
  await s.store.addErrorOnce('Phone notification failed: ntfy push failed (500)');
  r = await writesDuring(() => s.json('POST', '/api/test-notification'));
  ok(r.writes === 1 && !(await W.storedEvents(s, 'error')).length, 'with one up, it takes it down', r.writes);

  // ---------- texting ----------
  const token = await W.relayToken(s);
  const relay = (p, body) => W.relay(s, token, p, body);
  await s.store.update((d) => { const c = d.candidates.find((x) => x.id === 'p4'); c.lastTextedAt = W.ago(300); c.textStatus = 'sent'; c.textThread = [{ dir: 'out', ts: W.ago(300), text: 'Hi Riley' }]; });
  const at = new Date().toISOString();
  r = await writesDuring(() => relay('events', { events: [
    { phone: '(617) 555-2004', kind: 'delivered', ts: at }, { phone: '(617) 555-2004', kind: 'read', ts: at },
    { phone: '(617) 555-2004', kind: 'reply', ts: at, text: 'Sounds good — after 5?' },
  ] }));
  ok(r.r.status === 200 && r.r.body.applied === 3 && r.writes === 1, 'a relay batch with news is one write', r.writes);
  const c4 = await W.storedCandidate(s, 'p4');
  ok(c4.textStatus === 'replied' && c4.textUnread === true && c4.textThread.length === 2, 'with the reply in the thread and the bell lit', c4.textStatus);
  ok((await W.storedEvents(s, 'text-replied', 'p4')).length === 1 && s.pushes.some((p) => /Riley Parker replied/.test(p.title)), 'its feed line in the same write, and the phone told once');
  r = await writesDuring(() => relay('events', { events: [
    { phone: '(617) 555-2004', kind: 'delivered', ts: at }, { phone: '(617) 555-2004', kind: 'read', ts: at },
    { phone: '(617) 555-2004', kind: 'reply', ts: at, text: 'Sounds good — after 5?' },
  ] }));
  ok(r.r.status === 200 && r.writes === 0 && (await W.storedEvents(s, 'text-replied', 'p4')).length === 1, 'the same batch reported again writes nothing and announces nothing', r.writes);
  r = await writesDuring(() => s.json('POST', '/api/texts/reply', { id: 'p4', body: 'Perfect, talk at 5:30.' }));
  ok(r.r.status === 200 && r.writes === 1 && (await W.storedCandidate(s, 'p4')).textUnread === false, 'answering a conversation still lit puts the bell out (one write)', r.writes);
  r = await writesDuring(() => s.json('POST', '/api/texts/reply', { id: 'p4', body: 'And bring a resume.' }));
  ok(r.r.status === 200 && r.r.body.queued === true && r.writes === 0, 'answering again, with the bell already out, writes nothing to the list', r.writes);
  ok((await W.textQueue(s)).items.filter((i) => i.id === 'p4').length === 2, 'both answers are waiting for the Mac');

  // ---------- the small records go with the team ----------
  const B = await W.secondTeam(s, 'Quiet Harbor', '4826');
  await B.inTeam(async () => {
    await storage.setJson('reply-checked', { v: 1, at: { x1: 1 } });
    await storage.setJson('calendly-sync', { lastSyncAt: new Date().toISOString(), error: '' });
  });
  const dir = R(`data/t/${B.id}`);
  ok(fs.existsSync(path.join(dir, 'reply-checked.json')) && fs.existsSync(path.join(dir, 'calendly-sync.json')), 'another team has records of its own');
  // The team that predates teams keeps its keys bare, so it is purged by a
  // list of names: delete it (from the other team) and its records must go.
  ok(['reply-checked', 'calendly-sync', 'reply-cursor'].every((k) => fs.existsSync(R(`data/${k}.json`))), 'this team has its records');
  const del = await B.json('POST', '/api/teams/delete', { adminPassword: 'test-password', id: 'maverick', confirm: 'Team Maverick' });
  ok(del.status === 200, 'the older team is deleted', del);
  ok(['db', 'reply-checked', 'calendly-sync', 'reply-cursor'].every((k) => !fs.existsSync(R(`data/${k}.json`))), 'and its list, its reply-check records and its sync record are gone with it',
    fs.readdirSync(R('data')).filter((f) => f.endsWith('.json')));
  ok(fs.existsSync(path.join(dir, 'reply-checked.json')) && fs.existsSync(path.join(dir, 'calendly-sync.json')), 'the other team\'s are untouched');
  const del2 = await B.json('POST', '/api/teams/create', { adminPassword: 'test-password', name: 'Quiet Spare', pin: '5938' });
  ok(del2.status === 200, 'a spare team, so the other can go too', del2.status);
  const gone = await B.json('POST', '/api/teams/delete', { adminPassword: 'test-password', id: B.id, confirm: 'Quiet Harbor' });
  const left = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(json|bin)$/.test(String(f))) : [];
  ok(gone.status === 200 && left.length === 0, 'deleting a newer team takes everything under its folder, records included', left);
  ok(s.outsideCalls.length === 0, 'nothing reached outside this machine', s.outsideCalls);
  await s.close();
  done();
})().catch(crash);
