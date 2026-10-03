// The compact list through the Netlify function wrapper (netlify/src/api.mjs),
// called the way Netlify calls it. The whole list is compressed once per
// version and kept: brotli for a browser that takes it, gzip for one that
// takes only that, the same bytes each time, and the same list once
// decompressed. A sync answered with the whole list is too. Everything else
// is as it was — the state is still gzipped for a browser offering both —
// and the list's 304 has no body. Made-up people only; nothing leaves this
// machine.
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { R, ok, done, crash, wipeData } = require('./helpers');
const { Wire, people } = require('./c-helpers');

(async () => {
  process.env.APP_PASSWORD = 'function-test-password';
  for (const k of ['NETLIFY', 'NETLIFY_BLOBS_CONTEXT', 'AWS_LAMBDA_FUNCTION_NAME', 'URL', 'BASE_URL']) delete process.env[k];
  wipeData();
  globalThis.fetch = async (u) => { throw new Error(`no network in tests: ${u}`); };
  const google = require(R('lib/google.js'));
  google.status = async () => ({ connected: false, configured: false, email: '' });
  const handler = (await import(pathToFileURL(R('netlify/src/api.mjs')).href)).default;
  const call = (method, p, { body, cookie, headers = {} } = {}) => handler(new Request(`https://crm.example.com${p}`, {
    method,
    headers: { 'x-forwarded-proto': 'https', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }), {});
  const bytes = async (r) => Buffer.from(await r.arrayBuffer());
  const W = Wire();

  const login = await call('POST', '/api/login', { body: { password: process.env.APP_PASSWORD, team: 'maverick' } });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  ok(login.status === 200, 'signed in through the function');
  const tenant = require(R('lib/tenant.js'));
  const store = require(R('lib/store.js'));
  await tenant.run('maverick', () => store.update((d) => { d.candidates = people(3000); }));

  const plain = await call('GET', '/api/candidates?v=2', { cookie });
  const text = (await bytes(plain)).toString('utf8');
  ok(plain.status === 200 && !plain.headers.get('content-encoding') && JSON.parse(text).n === 3000, 'the whole list, asked for without compression, is sent as it is', plain.headers.get('content-encoding'));
  const tag = plain.headers.get('etag');

  const br1 = await call('GET', '/api/candidates?v=2', { cookie, headers: { 'accept-encoding': 'gzip, deflate, br' } });
  const b1 = await bytes(br1);
  ok(br1.headers.get('content-encoding') === 'br' && /Accept-Encoding/i.test(br1.headers.get('vary') || ''), 'to a browser that takes brotli, it is sent as brotli', br1.headers.get('content-encoding'));
  ok(zlib.brotliDecompressSync(b1).toString('utf8') === text, 'and is the same list once decompressed');
  const br2 = await call('GET', '/api/candidates?v=2', { cookie, headers: { 'accept-encoding': 'gzip, deflate, br' } });
  ok(Buffer.compare(b1, await bytes(br2)) === 0, 'asked again, it is the very same bytes (kept, not made again)');
  const gz = await call('GET', '/api/candidates?v=2', { cookie, headers: { 'accept-encoding': 'gzip' } });
  const g = await bytes(gz);
  ok(gz.headers.get('content-encoding') === 'gzip' && zlib.gunzipSync(g).toString('utf8') === text, 'to one that takes only gzip, gzip');
  ok(b1.length < g.length * 0.95, 'brotli is the smaller of the two', [b1.length, g.length]);

  const copy = await W.fromFull(JSON.parse(text), 'maverick');
  const whole = await call('POST', '/api/candidates/sync?v=2', { cookie, body: { ...W.syncBody(copy), t: 'someone-else' }, headers: { 'accept-encoding': 'gzip, deflate, br' } });
  const wb = await bytes(whole);
  ok(whole.headers.get('content-encoding') === 'br' && zlib.brotliDecompressSync(wb).toString('utf8') === text, 'a sync answered with the whole list is the same compressed list');
  const small = await call('POST', '/api/candidates/sync?v=2', { cookie, body: W.syncBody(copy), headers: { 'accept-encoding': 'gzip, deflate, br' } });
  ok(small.status === 200 && JSON.parse((await bytes(small)).toString('utf8')).same === true && !small.headers.get('content-encoding'), 'a sync with nothing to say is a few bytes, sent as they are');

  const notModified = await call('GET', '/api/candidates?v=2', { cookie, headers: { 'if-none-match': tag, 'accept-encoding': 'gzip, deflate, br' } });
  ok(notModified.status === 304 && (await notModified.text()) === '', 'the list\'s tag is a 304 with no body');
  const state = await call('GET', '/api/state', { cookie, headers: { 'accept-encoding': 'gzip, deflate, br' } });
  ok(state.headers.get('content-encoding') === 'gzip', 'the state, offered both, is gzipped as it always was', state.headers.get('content-encoding'));
  const slim = await call('GET', '/api/state?v=2', { cookie, headers: { 'accept-encoding': 'gzip, deflate, br' } });
  ok(['gzip', null].includes(slim.headers.get('content-encoding')), 'and so is the state without the list', slim.headers.get('content-encoding'));
  done();
})().catch(crash);
