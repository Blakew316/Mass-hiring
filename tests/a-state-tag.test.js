// The state's tag and body, now that the answer is built in pieces:
//   - the body is the same shape it always was, key for key and in order, and
//     byte-stable: two answers for one state are the same bytes;
//   - another instance holding nothing of this version answers an unchanged
//     poll 304 without building the candidate list at all;
//   - an instance running different code never answers 304 to a tag from
//     this one, so a deploy that changes the answer is always fetched;
//   - who is due a follow-up and the texting order are drawn against the
//     start of a ten-minute window: they hold still (and the tag with them)
//     within it, catch up at the next one, and are never early — while the
//     order the text queue is actually filled in uses the real time.
// The clock is moved by replacing Date in this process (the server's), as in
// server-read-clock.test.js. Made-up people only.
const { execFile } = require('child_process');
const { startApp, R, ROOT, port, ok, done, crash } = require('./helpers');
const { guardOutside, stubSenders, getState, daysAgo } = require('./server-read-helpers');

const RealDate = Date;
let shiftMs = 0;
class ShiftedDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(RealDate.now() + shiftMs); else super(...args); }
  static now() { return RealDate.now() + shiftMs; }
}
const MIN = 60 * 1000;
const WINDOW = 10 * MIN;

// Another instance: its own process on the same data, asked once.
function otherInstance(offset, { cookie, tag, codeVersion = null }) {
  const src = `
    const path = require('path');
    const R = (p) => path.join(${JSON.stringify(ROOT)}, p);
    process.env.APP_PASSWORD = 'test-password';
    global.fetch = ((real) => async (u, o) => { if (!/^http:\\/\\/localhost:/.test(String(u))) throw new Error('outside call refused'); return real(u, o); })(global.fetch);
    require(path.join(${JSON.stringify(__dirname)}, 'helpers.js')).stubOutside();
    ${codeVersion ? `require(R('lib/code-version.js')).codeVersion = () => ${JSON.stringify(codeVersion)};` : ''}
    const priority = require(R('lib/priority.js'));
    let listed = 0;
    const industry = priority.industry;
    priority.industry = (c) => { listed += 1; return industry(c); };
    const app = require(R('app.js'));
    const server = app.listen(${port(offset)}, async () => {
      const r = await fetch('http://localhost:${port(offset)}/api/state', { headers: { cookie: ${JSON.stringify(cookie)}, 'if-none-match': ${JSON.stringify(tag)} } });
      const text = await r.text();
      process.stdout.write(JSON.stringify({ status: r.status, listed, length: text.length }));
      server.close();
      process.exit(0);
    });
  `;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', src], { env: process.env, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`the other instance failed: ${stderr || err.message}`));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error(`the other instance said: ${stdout} ${stderr}`)); }
    });
  });
}

(async () => {
  const refused = guardOutside();
  const s = await startApp({ offset: 230 });
  const sent = stubSenders();
  const textQueue = require(R('lib/text-queue.js'));

  // ---------- the body: same shape, byte-stable ----------
  await s.store.update((d) => {
    d.candidates = Array.from({ length: 30 }, (_, i) => ({
      id: `k${i}`, name: `Kit Shape ${i}`, email: `kit.shape.${i}@example.com`, phone: `(617) 555-23${String(i).padStart(2, '0')}`,
      role: ['Account Executive', 'Solar Consultant', 'Store Manager'][i % 3], status: ['new', 'emailed', 'replied'][i % 3],
      lastEmailedAt: i % 3 ? daysAgo(5 + i) : null, addedAt: daysAgo(40), source: 'csv',
      ...(i % 5 === 0 ? { textThread: [{ dir: 'out', ts: daysAgo(3), text: `Hi Kit ${i}` }, { dir: 'in', ts: daysAgo(2), text: 'Who is this?' }], lastTextedAt: daysAgo(3) } : {}),
    }));
  });
  const a = await getState(s);
  const b = await getState(s);
  ok(a.status === 200 && b.status === 200 && a.text === b.text && a.tag === b.tag, 'two answers for one state are the same bytes, with the same tag');
  ok(JSON.stringify(JSON.parse(a.text)) === a.text, 'the body is plain JSON, as JSON.stringify writes it');
  const keys = Object.keys(a.body);
  const want = ['candidates', 'industries', 'events', 'lastError', 'lastErrorId', 'template', 'templates', 'templateEdited', 'followUp', 'settings', 'google', 'sending', 'stats', 'baseUrl', 'storage', 'backups', 'auth', 'team', 'queue', 'maxImmediate', 'interviews', 'apollo', 'texting', 'calendly', 'salesiq', 'onboarding'];
  ok(JSON.stringify(keys) === JSON.stringify(want), 'its keys are the ones it always had, in the same order', keys);
  ok(JSON.stringify(Object.keys(a.body.followUp)) === '["template","dueIds","days","max"]' && JSON.stringify(Object.keys(a.body.texting)) === '["template","withPhone","priority","queue","tokenSet"]'
    && JSON.stringify(Object.keys(a.body.calendly)) === '["syncEnabled","webhook","lastSyncAt","error"]', 'and so are the parts that are put in later', { followUp: Object.keys(a.body.followUp), texting: Object.keys(a.body.texting) });
  ok(a.body.candidates.length === 30 && Array.isArray(a.body.followUp.dueIds) && a.body.texting.priority.order && a.body.texting.priority.blocked && a.body.stats.total === 30, 'with the list, the due list and the texting order in their places');
  ok(!a.text.includes('@@'), 'and nothing of how it was put together');

  // ---------- another instance ----------
  const fresh = await otherInstance(231, { cookie: s.cookie, tag: a.tag });
  ok(fresh.status === 304 && fresh.length === 0, 'another instance answers this state\'s tag 304', fresh);
  ok(fresh.listed === 0, 'without building the candidate list to do it', fresh.listed);
  const stale = await otherInstance(232, { cookie: s.cookie, tag: 'W/"not-the-tag"' });
  ok(stale.status === 200 && stale.listed > 0 && stale.length === a.text.length, 'asked without the tag, it builds the same answer', stale);
  const other = await otherInstance(233, { cookie: s.cookie, tag: a.tag, codeVersion: 'another-build' });
  ok(other.status === 200 && other.length === a.text.length, 'an instance running different code never answers this tag 304', other);

  // ---------- the ten-minute window ----------
  const start = Math.ceil(RealDate.now() / WINDOW) * WINDOW + WINDOW;   // a window that starts in the future
  const T = (offsetMs) => { shiftMs = start + offsetMs - RealDate.now(); global.Date = ShiftedDate; };
  const iso = (ms) => new RealDate(ms).toISOString();
  const base = { role: 'Account Executive', company: 'Example Payments', status: 'emailed', followUpCount: 0, source: 'csv', notes: '', addedAt: iso(start - 40 * 86400000) };
  await s.store.update((d) => {
    d.events = [];
    // The list starts again with just these three (taken off on purpose, so
    // the store's guard against losing people lets it through).
    for (const c of [...d.candidates]) s.store.removeCandidate(d, c.id);
    d.candidates.push(
      // Due a follow-up (three days after the email) five minutes into the window.
      { ...base, id: 'f1', name: 'Fay Due', email: 'fay.due@example.com', lastEmailedAt: iso(start + 5 * MIN - 3 * 86400000) },
      // Opened two weeks and two minutes before eight minutes into the window:
      // "in the last two weeks" at the window's start, no longer at that moment.
      { ...base, id: 'q2', name: 'Quin Later', email: 'quin.later@example.com', phone: '(617) 555-2381', lastEmailedAt: iso(start - 30 * 86400000), openedAt: iso(start + 8 * MIN - 14 * 86400000 - 2 * MIN) },
      { ...base, id: 'q1', name: 'Quin Earlier', email: 'quin.earlier@example.com', phone: '(617) 555-2382', lastEmailedAt: iso(start - 30 * 86400000), openedAt: iso(start - 20 * 86400000) },
    );
  });
  try {
    T(1 * MIN);
    const w1 = await getState(s);
    ok(w1.status === 200 && !w1.body.followUp.dueIds.includes('f1'), 'a minute into the window, she is not due yet', w1.body.followUp.dueIds);
    const p1 = w1.body.texting.priority.order;
    ok(p1.q2.rank === 1 && p1.q1.rank === 2 && /in the last two weeks/.test(p1.q2.reason), 'and the one who opened recently ranks first for texting', p1);
    T(8 * MIN);
    const w2 = await getState(s, w1.tag);
    ok(w2.status === 304, 'eight minutes in — she is due now, and the open is more than two weeks old — the state holds still: 304', w2.status);
    const shown = await getState(s);
    ok(!shown.body.followUp.dueIds.includes('f1') && shown.body.texting.priority.order.q2.rank === 1, 'the page goes on showing the window\'s start: never early, at most ten minutes late');
    // What is actually queued is ranked on the real time: the two are now
    // level, and the queue takes them in id order.
    const q = await s.json('POST', '/api/texts/queue', { ids: ['q2', 'q1'] });
    ok(q.status === 200 && q.body.added === 2, 'both are queued', q.body);
    const items = (await textQueue.loadQ()).items.map((i) => i.id);
    ok(JSON.stringify(items) === '["q1","q2"]', 'in the order the real time gives, not the window\'s', items);
    T(11 * MIN);
    const w3 = await getState(s, w2.tag || w1.tag);
    ok(w3.status === 200 && w3.tag !== w1.tag, 'into the next window the state moves on', w3.status);
    ok(w3.body.followUp.dueIds.includes('f1'), 'she is due', w3.body.followUp.dueIds);
    ok(!/in the last two weeks/.test(w3.body.texting.priority.order.q2.reason), 'and the open is no longer called recent', w3.body.texting.priority.order.q2);
    const w4 = await getState(s, w3.tag);
    ok(w4.status === 304, 'and then holds still again', w4.status);
  } finally {
    global.Date = RealDate;
    shiftMs = 0;
  }

  ok(sent.count() === 0, 'nothing was sent', sent);
  ok(refused.length === 0, 'nothing reached outside this machine', refused);
  await s.close();
  done();
})().catch((e) => { global.Date = RealDate; crash(e); });
