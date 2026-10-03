// The Mac relay's token, as each instance remembers it. An instance keeps a
// token it has looked up for half a minute, so the relay polling every few
// seconds does not cost a search each time. That memory used to be trusted
// outright: after "Generate a new token" on one instance, the old token kept
// working for up to 30 seconds on every other instance that had seen it
// recently. A remembered token is now checked against the team's current
// fingerprint, as the Sales IQ key already was:
//   - a token replaced on another instance is refused here at once, and the
//     new one is let in;
//   - a token cleared on another instance is refused here at once;
//   - a wrong token asked about again costs no read at all.
// Made-up data only; nothing leaves this machine.
const { R, ok, done, crash } = require('./helpers');
const W = require('./server-write-helpers');
const { elsewhere } = require('./server-read-helpers');

(async () => {
  const s = await W.start(240);
  const storage = require(R('lib/storage.js'));
  let registryReads = 0;
  const realGet = storage.getJson;
  storage.getJson = async (key, ...rest) => { if (key === 'teams') registryReads += 1; return realGet(key, ...rest); };
  const hello = async (token) => (await W.relay(s, token, 'hello', { host: 'Token-Mac', version: '1.0.0', bluebubbles: true })).status;

  const first = await W.relayToken(s);
  ok(await hello(first) === 200, 'the relay with its token is let in');
  ok(await hello(first) === 200, 'and again (now remembered by this instance)');

  // "Generate a new token", pressed on another instance.
  const second = 'S'.repeat(16) + require('crypto').randomBytes(24).toString('base64url');
  await elsewhere('maverick', async ({ teams, store }, t) => {
    await store.update((d) => { d.settings.relayToken = t; });
    await teams.setRelayToken('maverick', t);
  }, second);
  ok(await hello(first) === 401, 'the token replaced on another instance is refused here at once, not half a minute later');
  ok(await hello(second) === 200, 'and the new one is let in');
  ok(await hello(second) === 200, 'and again');

  // Cleared on another instance (settings and registry both, as a reset would).
  await elsewhere('maverick', async ({ teams, store }) => {
    await store.update((d) => { d.settings.relayToken = ''; });
    await teams.setRelayToken('maverick', '');
  });
  ok(await hello(second) === 401, 'a token cleared on another instance is refused here at once');

  // A new one made there is let in here at once.
  const third = 'T'.repeat(16) + require('crypto').randomBytes(24).toString('base64url');
  await elsewhere('maverick', async ({ teams, store }, t) => {
    await store.update((d) => { d.settings.relayToken = t; });
    await teams.setRelayToken('maverick', t);
  }, third);
  ok(await hello(third) === 200, 'a token made after that on another instance is let in here');
  ok(await hello(second) === 401, 'while the cleared one stays refused');

  // A wrong token: looked up once, then remembered as nobody's.
  const wrong = 'W'.repeat(40);
  ok(await hello(wrong) === 401, 'a wrong token is refused');
  const before = registryReads;
  ok(await hello(wrong) === 401, 'and refused again');
  ok(registryReads === before, 'without reading anything the second time', registryReads - before);
  ok(s.outsideCalls.length === 0, 'nothing reached outside this machine', s.outsideCalls);
  await s.close();
  done();
})().catch(crash);
