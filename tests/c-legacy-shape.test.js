// The old /api/state — what a page left open across the deploy keeps asking
// for — is the same bytes from this server as from the code this stage
// started from (a git archive of it, run beside this one on a copy of the
// same data), at the same moments: a millisecond before a ten-minute window
// starts, as it starts, a millisecond into it and at its last millisecond.
// The window matters (somebody becomes due a follow-up exactly as it starts,
// and somebody's email open stops counting as recent), so the answers either
// side of it differ, and both servers move at the same instant. The two
// servers tag it differently — different code — so an old page's tag from
// before the deploy fetches the new answer once rather than being told 304.
// Made-up people only; nothing is sent.
const { startApp, R, ROOT, port, ok, done, crash } = require('./helpers');
const { guardOutside, stubSenders } = require('./server-read-helpers');
const { people, baseCopy, serve, WINDOW, RealDate } = require('./c-helpers');

(async () => {
  const refused = guardOutside();
  const s = await startApp({ offset: 222 });
  const sent = stubSenders();
  const textQueue = require(R('lib/text-queue.js'));
  const B = Math.ceil(RealDate.now() / WINDOW) * WINDOW + WINDOW;      // a window that starts in the future
  const iso = (ms) => new RealDate(ms).toISOString();
  const list = people(400, { at: B });
  const plain = { source: 'csv', notes: '', addedAt: iso(B - 60 * 864e5), status: 'emailed', followUpCount: 0, role: 'Account Executive', company: 'Example Payments', location: '' };
  // Due a follow-up (three days after the email) exactly as the window starts.
  list[0] = { ...plain, id: 'due1', name: 'Dee Due', firstName: 'Dee', lastName: 'Due', email: 'dee.due@example.com', phone: '(617) 555-2600', lastEmailedAt: iso(B - 3 * 864e5) };
  // An open that stops counting as "in the last two weeks" as it starts.
  list[1] = { ...plain, id: 'open1', name: 'Oz Open', firstName: 'Oz', lastName: 'Open', email: 'oz.open@example.com', phone: '(617) 555-2601', lastEmailedAt: iso(B - 30 * 864e5), openedAt: iso(B - 14 * 864e5 - 60000) };
  await s.store.update((d) => {
    d.candidates = list;
    d.events = list.slice(0, 30).map((c, i) => ({ id: `e${i}`, ts: iso(B - i * 3600e3), type: i % 3 ? 'opened' : 'text-replied', message: `${c.name} did something`, candidateId: c.id }));
    d.interviews = [{ uri: 'https://example.com/e/1', name: 'Intro call', status: 'active', start: iso(B + 864e5), end: iso(B + 864e5 + 1800e3), invitees: [{ name: list[2].name, email: list[2].email, status: 'active' }] }];
  });
  await textQueue.updateQ((q) => { textQueue.addOptOut(q, '(617) 555-2005'); });

  const base = await serve({ root: baseCopy(), port: port(223), data: R('data'), now: B - 1 });
  const mine = await serve({ root: ROOT, port: port(225), data: R('data'), now: B - 1 });
  const get = async (srv, url, tag) => {
    const r = await fetch(srv.base + url, { headers: { cookie: srv.cookie, ...(tag ? { 'if-none-match': tag } : {}) } });
    return { status: r.status, tag: r.headers.get('etag'), text: await r.text() };
  };
  try {
    const seen = {};
    for (const [label, at] of [['a millisecond before the window', B - 1], ['as the window starts', B], ['a millisecond into it', B + 1], ['at its last millisecond', B + WINDOW - 1]]) {
      await Promise.all([base.clock(at), mine.clock(at)]);
      const a = await get(base, '/api/state');
      const b = await get(mine, '/api/state');
      ok(a.status === 200 && b.status === 200 && a.text.length > 10000, `${label}: both servers answer the old state`, [a.status, b.status, a.text.length]);
      ok(a.text === b.text, `${label}: byte for byte the same`, a.text === b.text ? '' : firstDifference(a.text, b.text));
      const again = await get(mine, '/api/state');
      ok(again.text === b.text && again.tag === b.tag, `${label}: and the same again, with the same tag`);
      ok(a.tag !== b.tag && (await get(mine, '/api/state', a.tag)).status === 200, `${label}: the old server's tag is not this one's, so an old page fetches the new answer once`);
      ok((await get(mine, '/api/state', b.tag)).status === 304, `${label}: after which its own tag is a 304`);
      const slim = await get(mine, '/api/state?v=2');
      seen[label] = { text: b.text, v: JSON.parse(slim.text).cands.v };
      const body = JSON.parse(b.text);
      if (at === B - 1) ok(!body.followUp.dueIds.includes(list[0].id) && /in the last two weeks/.test(body.texting.priority.order[list[1].id].reason), `${label}: not due yet, and the open is recent`);
      else ok(body.followUp.dueIds.includes(list[0].id) && !/in the last two weeks/.test(body.texting.priority.order[list[1].id].reason), `${label}: due, and the open no longer recent`);
    }
    ok(seen['a millisecond before the window'].text !== seen['as the window starts'].text, 'the answers either side of the window differ');
    ok(seen['as the window starts'].text === seen['a millisecond into it'].text && seen['a millisecond into it'].text === seen['at its last millisecond'].text, 'and hold still through it');
    ok(seen['a millisecond before the window'].v !== seen['as the window starts'].v && seen['as the window starts'].v === seen['at its last millisecond'].v, 'the compact list\'s version moves with them, and holds still too');
  } finally {
    await base.close();
    await mine.close();
  }
  ok(sent.count() === 0, 'nothing was sent', sent);
  ok(refused.length === 0, 'nothing reached outside this machine', refused);
  await s.close();
  done();
})().catch(crash);

function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return { at: i, base: a.slice(Math.max(0, i - 80), i + 80), mine: b.slice(Math.max(0, i - 80), i + 80) };
}
