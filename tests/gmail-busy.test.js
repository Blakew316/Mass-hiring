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
//   - a token refresh that times out is not "expired"; one Google refuses is.
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

    gmail = (u, n) => (n <= 2 ? busy403 : thread);
    calls.gmail = 0;
    const t = await google.threadMessages(settings, 'th1', 'me@example.com');
    ok(t.messages.length === 1 && calls.gmail === 3, 'busy twice, then read: the conversation comes back', { got: t.messages.length, asked: calls.gmail });

    gmail = () => busy429;
    calls.gmail = 0;
    const t0 = Date.now();
    let e1 = null;
    try { await google.threadMessages(settings, 'th1', 'me@example.com'); } catch (e) { e1 = e; }
    ok(e1 && e1.rateLimited && !e1.scope && /busy/i.test(e1.message) && !/reconnect/i.test(e1.message), 'still busy: said as busy, not as a missing permission', e1 && { rateLimited: e1.rateLimited, scope: e1.scope, message: e1.message });
    ok(calls.gmail >= 3 && Date.now() - t0 < 8000, `still busy: asked ${calls.gmail} times, within the function's time`, { asked: calls.gmail, ms: Date.now() - t0 });

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
    const j2 = await (await realFetch(`${s.base}/api/emails/thread?id=p1`, { headers: { cookie: s.cookie } })).json();
    ok(!j2.busy && j2.messages.length === 1, 'and once Gmail has room, the conversation is read', j2.unavailable);

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
  } finally {
    global.fetch = realFetch;
    await s.close();
  }
  done();
})().catch(crash);
