// Time passing, with nothing written, still changes what the page must show —
// and so the state's tag. A poll answered 304 means "what you have is what you
// would be shown now", not "nothing was saved since":
//   - the Mac relay that stops checking in goes offline after a minute and a half;
//   - a queue pause runs out;
//   - an emailed person becomes due a follow-up once enough days pass;
//   - yesterday's sends leave the 24-hour count (email and text);
//   - a warning banner is put away after a day.
//
// The clock is moved by replacing the global Date with one running ahead of
// the real one, in this process (which is also the server's); nothing is
// stored while it is moved.
const { startApp, R, ok, done, crash } = require('./helpers');
const { guardOutside, stubSenders, getState, ago, daysAgo } = require('./server-read-helpers');

const RealDate = Date;
let shiftMs = 0;
class ShiftedDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(RealDate.now() + shiftMs); else super(...args); }
  static now() { return RealDate.now() + shiftMs; }
}
const advance = (ms) => { shiftMs += ms; global.Date = ShiftedDate; };
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

(async () => {
  const refused = guardOutside();
  const s = await startApp({ offset: 8 });
  const sent = stubSenders();
  const storage = require(R('lib/storage.js'));
  const textQueue = require(R('lib/text-queue.js'));
  const fs = require('fs');
  const path = require('path');

  await s.store.update((d) => {
    d.candidates = [
      // Emailed 2 days and 22 hours ago: due a follow-up in two hours (default 3 days).
      { id: 'f1', name: 'Fran Followup', email: 'fran@example.com', status: 'emailed', lastEmailedAt: new Date(Date.now() - (3 * 24 - 2) * HOUR).toISOString(), addedAt: daysAgo(10), source: 'csv' },
      { id: 'f2', name: 'Gus Recent', email: 'gus@example.com', status: 'emailed', lastEmailedAt: daysAgo(1), addedAt: daysAgo(10), source: 'csv' },
    ];
    // A warning from 23 hours ago: a banner for one more hour.
    d.events = [{ id: 'warn1', ts: new Date(Date.now() - 23 * HOUR).toISOString(), type: 'error', message: 'Gmail refused a send yesterday.', candidateId: null }];
  });
  // Email sends 23 hours ago, and a pause until 30 minutes from now.
  await storage.setJson('queue', {
    items: [{ id: 'f2', t: 'k' }], templates: { k: { subject: 'x', body: 'y' } },
    sentLog: [{ id: 'f1', email: 'fran@example.com', ts: new Date(Date.now() - 23 * HOUR).toISOString() }],
    total: 2, sent: 1, pausedUntil: new Date(Date.now() + 30 * MIN).toISOString(), pauseKind: 'rate', note: 'Gmail asked us to slow down.',
  });
  // A text 23 hours ago, and a relay that checked in just now.
  await textQueue.updateQ((q) => { q.sentLog.push({ id: 'x', phone: '+16175559911', ts: new Date(Date.now() - 23 * HOUR).toISOString() }); });
  await storage.setJson('relay', { lastSeenAt: new Date().toISOString(), host: 'Example-Mac', version: '1.0.0', backend: 'applescript', bluebubbles: false, error: '' });

  const dataDir = R('data');
  const snapshot = () => fs.readdirSync(dataDir, { recursive: true }).filter((f) => f.endsWith('.json')).sort()
    .map((f) => `${f}:${fs.statSync(path.join(dataDir, f)).mtimeMs}`).join('|');

  const t0 = await getState(s);
  const S0 = t0.body;
  ok(S0.texting.queue.relay.online === true, 'the relay that just checked in is online');
  ok(S0.queue.pausedUntil && S0.queue.pauseKind === 'rate', 'the email queue is paused');
  ok(!S0.followUp.dueIds.includes('f1'), 'nobody is due a follow-up yet', S0.followUp.dueIds);
  ok(S0.queue.sentToday === 1 && S0.texting.queue.sentToday === 1, 'one email and one text in the last 24 hours');
  ok(S0.lastError === 'Gmail refused a send yesterday.', 'the warning is up');
  ok((await getState(s, t0.tag)).status === 304, 'unchanged a moment later: 304');
  const stored = snapshot();

  try {
    // Each step: did the tag move with nothing saved, and does the state (read
    // afresh if the tag did not move) show what time has changed?
    let tag = t0.tag;
    const step = async (what) => {
      const r = await getState(s, tag);
      ok(r.status === 200 && r.tag && r.tag !== tag, `${what}: with nothing saved, the tag has moved`, r.status);
      tag = r.tag || tag;
      return r.body || (await getState(s)).body;
    };

    // Two minutes on: the relay has missed its check-ins.
    advance(2 * MIN);
    const b1 = await step('two minutes later');
    ok(b1.texting.queue.relay.online === false, 'the relay that stopped checking in shows offline', b1.texting.queue.relay);
    ok(b1.queue.pausedUntil && b1.texting.queue.relay.lastSeenAt, 'the pause is still on, and when the relay was last seen is shown');
    ok((await getState(s, tag)).status === 304, 'and then it holds still');

    // Thirty-one minutes on: the pause has run out.
    advance(29 * MIN);
    const b2 = await step('half an hour later');
    ok(b2.queue.pausedUntil === null && b2.queue.pauseKind === '', 'a pause that ran out is no longer shown', b2.queue);

    // Over an hour on: yesterday's sends leave the day, the banner goes away.
    advance(40 * MIN);
    const b3 = await step('an hour later');
    ok(b3.queue.sentToday === 0 && b3.queue.remainingToday === b3.queue.dailyLimit, 'the email sent 24 hours ago no longer counts today', b3.queue);
    ok(b3.texting.queue.sentToday === 0 && b3.texting.queue.remainingToday === b3.texting.queue.dailyLimit, 'nor the text', b3.texting.queue);
    ok(b3.lastError === '' && b3.lastErrorId === '', 'a warning more than a day old is put away', b3.lastError);

    // Over two hours on: Fran is due a follow-up.
    advance(60 * MIN);
    const b4 = await step('two hours later');
    ok(b4.followUp.dueIds.includes('f1') && !b4.followUp.dueIds.includes('f2'), 'once three days have passed she is due a follow-up', b4.followUp.dueIds);
    ok((await getState(s, tag)).status === 304, 'and then it holds still');
  } finally {
    global.Date = RealDate;
    shiftMs = 0;
  }
  ok(stored.includes('db.json') && stored.includes('queue.json') && snapshot() === stored, 'none of it wrote anything', stored);

  ok(sent.count() === 0, 'nothing was sent', sent);
  ok(refused.length === 0, 'nothing reached outside this machine', refused);
  await s.close();
  done();
})().catch((e) => { global.Date = RealDate; crash(e); });
