// The Netlify function wrapper (netlify/src/api.mjs), called the way Netlify
// calls it, on local files:
//   - an answer over 4 MB as sent is reported in the function log with its
//     size — Netlify refuses anything over 6 MB, and the log is the only
//     place that would otherwise say why a page stopped loading;
//   - the same answer gzipped, well under, is not;
//   - the state's tag carries a fingerprint of the code, worked out from the
//     sources when they are there.
// Made-up people only; nothing leaves this machine.
const { pathToFileURL } = require('url');
const { R, ok, done, crash, wipeData } = require('./helpers');

(async () => {
  process.env.APP_PASSWORD = 'function-test-password';
  for (const k of ['NETLIFY', 'NETLIFY_BLOBS_CONTEXT', 'AWS_LAMBDA_FUNCTION_NAME', 'URL', 'BASE_URL']) delete process.env[k];
  wipeData();
  globalThis.fetch = async (u) => { throw new Error(`no network in tests: ${u}`); };
  const google = require(R('lib/google.js'));
  google.status = async () => ({ connected: false, configured: false, email: '' });
  const mod = await import(pathToFileURL(R('netlify/src/api.mjs')).href);
  const handler = mod.default;
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warned.push(a.join(' ')); };
  const call = (method, p, { body, cookie, headers = {} } = {}) => handler(new Request(`https://crm.example.com${p}`, {
    method,
    headers: { 'x-forwarded-proto': 'https', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }), {});
  try {
    const login = await call('POST', '/api/login', { body: { password: process.env.APP_PASSWORD, team: 'maverick' } });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    ok(login.status === 200 && cookie.startsWith('crm_auth='), 'signed in through the function', login.status);

    const tenant = require(R('lib/tenant.js'));
    const store = require(R('lib/store.js'));
    await tenant.run('maverick', () => store.update((d) => {
      d.candidates = Array.from({ length: 9000 }, (_, i) => ({
        id: `fn${i}`, name: `Finley Function ${i}`, email: `finley.function.${i}@example.com`, phone: '', role: 'Account Executive',
        status: 'new', addedAt: '2026-09-01T00:00:00.000Z', source: 'csv', notes: `Made-up note ${i} `.repeat(20),
      }));
    }));

    warned.length = 0;
    const plain = await call('GET', '/api/state', { cookie });
    const size = (await plain.arrayBuffer()).byteLength;
    ok(plain.status === 200 && size > 4 * 1048576, 'an uncompressed state over 4 MB', size);
    const line = warned.find((w) => w.includes('/api/state'));
    ok(line && /GET \/api\/state answered \d+\.\d MB/.test(line) && /6 MB/.test(line), 'is reported in the log with its size', warned);

    warned.length = 0;
    const zipped = await call('GET', '/api/state', { cookie, headers: { 'accept-encoding': 'gzip' } });
    const zsize = (await zipped.arrayBuffer()).byteLength;
    ok(zipped.status === 200 && zipped.headers.get('content-encoding') === 'gzip' && zsize < 4 * 1048576, 'the same state gzipped is well under', zsize);
    ok(!warned.some((w) => w.includes('/api/state')), 'and is not reported', warned);

    const again = await call('GET', '/api/state', { cookie, headers: { 'if-none-match': plain.headers.get('etag') } });
    ok(again.status === 304 && (await again.text()) === '', 'an unchanged poll through the function is a 304 with no body', again.status);

    const { codeVersion } = require(R('lib/code-version.js'));
    ok(/^[0-9a-f]{16}$/.test(codeVersion()), 'the code fingerprint comes from the sources here, not a value of this process\'s own', codeVersion());
  } finally {
    console.warn = realWarn;
  }
  done();
})().catch(crash);
