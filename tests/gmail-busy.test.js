// Gmail turning a read away because it is busy (its per-user rate limit:
// 403 rateLimitExceeded / userRateLimitExceeded, or 429 too many at once) is
// not a missing permission. Opening a couple of conversations while a send
// run or the reply check was busy used to say "Reconnect and tick every box",
// which cured nothing. Against a stand-in for Gmail and Google's token
// endpoint (nothing leaves this process):
//   - a read turned away as busy is asked again, and succeeds;
//   - one that stays busy is said as busy (and the conversation route says
//     so, for the page to ask again) — never as "reconnect";
//   - a real permission refusal is still a permission refusal, asked once;
//   - the narrow metadata permission still falls back to headers;
//   - a token refresh that times out is not "expired"; one Google refuses is;
//   - a conversation read once is saved: opened again it comes at once
//     without Gmail, marked stale when something has happened since, and
//     still shown when Gmail is busy;
//   - a time Gmail names to wait until is kept: nothing is asked before it.
const { startApp, R, ok, done, crash } = require('./helpers');

(async () => {
  // Google's own functions, not the stand-ins the other tests use: the stand-in
  // here is Gmail itself (global.fetch below).
  const s = await startApp({ offset: 274, stub: false });
  const storage = require(R('lib/storage.js'));
  const google = require(R('lib/google.js'));
  const realFetch = global.fetch;
  let gmail = () => ({ status: 200, body: {} });
  let token = () => ({ status: 200, body: { access_token: 'fresh', expires_in: 3600 } });
  const calls = { gmail: 0, token: 0 };
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://gmail.googleapis.com/')) {
      calls.gmail += 1;
      const r = gmail(u, calls.gmail);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers || {}) } });
    }
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      calls.token += 1;
      const r = token(calls.token);
      if (r.throws) throw new Error('The operation was aborted due to timeout');
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };
  const busy403 = { status: 403, body: { error: { code: 403, message: 'User-rate limit exceeded.', errors: [{ reason: 'userRateLimitExceeded' }] } } };
  const busy429 = { status: 429, body: { error: { code: 429, message: 'Too many concurrent requests for user.', errors: [{ reason: 'rateLimitExceeded' }] } } };
  const noScope = { status: 403, body: { error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }], status: 'PERMISSION_DENIED' } } };
  const thread = { status: 200, body: { messages: [{ id: 'm1', internalDate: String(Date.now()), snippet: 'Sounds good', payload: { headers: [{ name: 'From', value: 'Pat Madeup <pat.madeup@example.com>' }, { name: 'Subject', value: 'Re: Quick question' }], mimeType: 'text/plain', body: { data: Buffer.from('Sounds good, call me').toString('base64url') } } }] } };
  const settings = {};
  const goodTokens = { access_token: 'tok', refresh_token: 'refresh', expires_at: Date.now() + 3600e3, email: 'me@example.com' };
  try {
    await storage.setJson('tokens', goodTokens);

    gmail = (u, n) => (n <= 1 ? busy403 : thread);
    calls.gmail = 0;
    const t = await google.threadMessages(settings, 'th1', 'me@example.com');
    ok(t.messages.length === 1 && calls.gmail === 2, 'busy for a moment, then read: the conversation comes back', { got: t.messages.length, asked: calls.gmail });

    gmail = () => busy429;
    calls.gmail = 0;
    const t0 = Date.now();
    let e1 = null;
    try { await google.threadMessages(settings, 'th1', 'me@example.com'); } catch (e) { e1 = e; }
    ok(e1 && e1.rateLimited && !e1.scope && /busy/i.test(e1.message) && !/reconnect/i.test(e1.message), 'still busy: said as busy, not as a missing permission', e1 && { rateLimited: e1.rateLimited, scope: e1.scope, message: e1.message });
    ok(calls.gmail === 2 && Date.now() - t0 < 3000, 'still busy: asked once more, not again and again (that itself keeps an account over the limit)', { asked: calls.gmail, ms: Date.now() - t0 });

    gmail = () => noScope;
    calls.gmail = 0;
    let e2 = null;
    try { await google.threadMessages(settings, 'th1', 'me@example.com'); } catch (e) { e2 = e; }
    ok(e2 && e2.scope && !e2.rateLimited && calls.gmail === 1, 'a missing permission is still one, asked once', e2 && { scope: e2.scope, asked: calls.gmail });

    gmail = (u) => (/format=full/.test(u) ? { status: 403, body: { error: { code: 403, message: "Metadata scope doesn't allow format FULL" } } } : thread);
    const t3 = await google.threadMessages(settings, 'th1', 'me@example.com');
    ok(t3.limited === true && t3.messages.length === 1, 'the metadata permission still falls back to headers');

    gmail = (u, n) => (n % 2 ? busy403 : { status: 200, body: { messages: [{ id: 'x', threadId: 'th9' }] } });
    calls.gmail = 0;
    const found = await google.findSentTo(settings, 'pat.madeup@example.com', Date.now() - 60000);
    ok(found && found.threadId === 'th9', 'a search turned away as busy is asked again too');

    // The conversation route, for a made-up person.
    await s.store.update((d) => { d.candidates = [{ id: 'p1', name: 'Pat Madeup', email: 'pat.madeup@example.com', status: 'emailed', gmailThreadId: 'th1', lastSubject: 'Quick question', addedAt: new Date().toISOString() }]; });
    gmail = () => busy403;
    const r = await realFetch(`${s.base}/api/emails/thread?id=p1`, { headers: { cookie: s.cookie } });
    const j = await r.json();
    ok(r.status === 200 && j.busy === true && /busy/i.test(j.unavailable) && !/reconnect/i.test(j.unavailable), 'the conversation route says Gmail is busy (for the page to ask again), not "reconnect"', j.unavailable);
    gmail = () => thread;
    const open = async (q = '') => (await realFetch(`${s.base}/api/emails/thread?id=p1${q}`, { headers: { cookie: s.cookie } })).json();
    const j2 = await open();
    ok(!j2.busy && j2.messages.length === 1, 'and once Gmail has room, the conversation is read', j2.unavailable);

    // The saved copy.
    calls.gmail = 0;
    const j3 = await open();
    ok(j3.messages.length === 1 && !j3.stale && calls.gmail === 0, 'opened again: the saved copy, at once, without asking Gmail', { asked: calls.gmail, stale: j3.stale });
    await s.store.update((d) => { d.candidates[0].lastReplyAt = new Date().toISOString(); d.candidates[0].replies = [{ id: 'r9', from: 'pat.madeup@example.com', date: new Date().toISOString(), text: 'One more thing' }]; });
    calls.gmail = 0;
    const j4 = await open();
    ok(j4.messages.length === 1 && j4.stale === true && calls.gmail === 0, 'a reply since: the saved copy at once, marked stale for the page to ask again', { asked: calls.gmail, stale: j4.stale });
    gmail = () => busy403;
    const j5 = await open('&fresh=1');
    ok(j5.messages.length === 1 && j5.stale && j5.busy, 'asked fresh while Gmail is busy: the saved copy still, said to be busy', { busy: j5.busy, n: j5.messages.length });
    gmail = () => thread;
    calls.gmail = 0;
    const j6 = await open('&fresh=1');
    ok(j6.messages.length === 1 && !j6.stale && calls.gmail === 1, 'and fresh once Gmail has room, saved again');
    const j7 = await open();
    ok(!j7.stale, '(now current)');

    // Never read from Gmail, but replies are stored: those, at once, without
    // Gmail; Gmail busy behind them, they stay, said so with Gmail's words,
    // and sending stands aside for the conversation.
    await s.store.update((d) => {
      d.candidates.push({ id: 'p2', name: 'Robin Madeup', email: 'robin.madeup@example.com', status: 'replied', gmailThreadId: 'th2b', lastSubject: 'Quick question', lastEmailedAt: new Date(Date.now() - 864e5).toISOString(), lastReplyAt: new Date().toISOString(),
        replies: [{ id: 'rr1', from: 'Robin Madeup <robin.madeup@example.com>', date: new Date().toISOString(), text: 'Yes, call me tomorrow', kind: '', textFetched: true }], addedAt: new Date().toISOString() });
    });
    calls.gmail = 0;
    const h1 = await (await realFetch(`${s.base}/api/emails/thread?id=p2`, { headers: { cookie: s.cookie } })).json();
    ok(h1.partial && h1.stale && calls.gmail === 0 && h1.messages.length === 2 && h1.messages[1].text === 'Yes, call me tomorrow' && h1.messages[0].dir === 'out',
      'opened for the first time: the email sent and the reply stored, at once, without asking Gmail', { asked: calls.gmail, n: h1.messages.length });
    gmail = () => ({ status: 403, body: { error: { code: 403, message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user'", errors: [{ reason: 'rateLimitExceeded' }] } } });
    const h2 = await (await realFetch(`${s.base}/api/emails/thread?id=p2&fresh=1`, { headers: { cookie: s.cookie } })).json();
    ok(h2.partial && h2.busy && h2.messages.length === 2 && /Queries per minute per user/.test(h2.detail || ''), 'Gmail busy behind them: they stay, with Gmail\'s own words', { busy: h2.busy, detail: h2.detail });
    const yieldRec = await storage.getJson('gmail-yield');
    ok(yieldRec && Date.parse(yieldRec.until) > Date.now() + 20000, 'and sending is asked to stand aside for half a minute', yieldRec);
    gmail = () => thread;

    // The reply checks that run by themselves (the scheduled one, each open
    // page's every minute) take turns: one a minute between them.
    gmail = () => ({ status: 200, body: { messages: [] } });
    const check = async (b) => (await realFetch(`${s.base}/api/replies/check`, { method: 'POST', headers: { cookie: s.cookie, 'content-type': 'application/json' }, body: JSON.stringify(b) })).json();
    const c1 = await check({ background: true });
    const c2 = await check({ background: true });
    const c3 = await check({});
    ok(!c1.skipped && c2.skipped === true && !c3.skipped, 'a second background reply check within the minute is skipped; one asked for outright is not', { c1: c1.skipped, c2: c2.skipped, c3: c3.skipped });

    // The token refresh.
    await storage.setJson('tokens', { ...goodTokens, expires_at: Date.now() - 1000 });
    token = () => ({ throws: true });
    calls.token = 0;
    const st1 = await google.status(settings);
    ok(st1.connected && !st1.expired && calls.token === 2, 'a token refresh that times out (twice) is not "expired": nobody is told to reconnect', { connected: st1.connected, expired: st1.expired, asked: calls.token });
    token = (n) => (n === 1 ? { throws: true } : { status: 200, body: { access_token: 'fresh', expires_in: 3600 } });
    calls.token = 0;
    const st2 = await google.status(settings);
    ok(st2.connected && !st2.expired && calls.token === 2, 'one that times out once is asked again, and works');
    await storage.setJson('tokens', { ...goodTokens, expires_at: Date.now() - 1000 });
    token = () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } });
    calls.token = 0;
    const st3 = await google.status(settings);
    ok(st3.expired && !st3.connected && calls.token === 1, 'one Google refuses (revoked, expired) is expired: reconnect', { expired: st3.expired, asked: calls.token });

    // Gmail naming a time to wait until: nothing more is asked before it.
    await storage.setJson('tokens', goodTokens);
    const until = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    gmail = () => ({ status: 429, body: { error: { code: 429, message: `User-rate limit exceeded.  Retry after ${until}`, errors: [{ reason: 'rateLimitExceeded' }] } } });
    calls.gmail = 0;
    let e5 = null;
    try { await google.threadMessages(settings, 'th2', 'me@example.com'); } catch (e) { e5 = e; }
    ok(e5 && e5.rateLimited && e5.retryAt === until && calls.gmail === 1, 'told to wait until a time: asked once, and the time is kept', e5 && { retryAt: e5.retryAt, asked: calls.gmail });
    gmail = () => thread;
    calls.gmail = 0;
    let e6 = null;
    try { await google.threadMessages(settings, 'th2', 'me@example.com'); } catch (e) { e6 = e; }
    ok(e6 && e6.rateLimited && calls.gmail === 0, 'and until then, Gmail is not asked at all', { asked: calls.gmail });
  } finally {
    global.fetch = realFetch;
    await s.close();
  }
  done();
})().catch(crash);
