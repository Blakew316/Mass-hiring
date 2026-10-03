// The deploy build. `npm run build` — what Netlify runs — succeeds, leaves the
// committed service worker as it is (its stamp is already current), and
// writes the API function with its chunks and the send worker. The built API
// function, imported and called with a Request the way Netlify calls it,
// answers as the API: signed out it refuses, it signs in with a Secure cookie,
// and signed in it saves a change and answers /api/state with it — gzipped
// when the browser asks, 304 with no body when nothing changed — keeping its
// data under /tmp/crm-data (NETLIFY=true with CRM_ALLOW_EPHEMERAL_STORAGE=1).
//
// The build runs in a temporary copy of the repo, so this checkout is never
// rewritten. /tmp/crm-data is fixed by lib/storage.js, so only one of these
// may run at a time on a machine: a lock directory makes the others wait, and
// the folder is emptied before and after.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { ROOT, R, ok, done, crash } = require('./helpers');

const DATA = '/tmp/crm-data';
const LOCK = '/tmp/crm-data.test-lock';
const PASSWORD = 'bundle-test-password';
const ORIGIN = 'https://crm.example.com';

let copy = null;
let locked = false;
function cleanUp() {
  if (locked) { fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(LOCK, { recursive: true, force: true }); locked = false; }
  if (copy) { fs.rmSync(copy, { recursive: true, force: true }); copy = null; }
}
process.on('exit', cleanUp);

async function takeLock() {
  const end = Date.now() + 5 * 60000;
  for (;;) {
    try { fs.mkdirSync(LOCK); locked = true; return true; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Left behind by a run that died: a run takes well under ten minutes.
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 10 * 60000) { fs.rmSync(LOCK, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

(async () => {
  // ---------- build, in a copy ----------
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-bundle-'));
  const skip = new Set(['.git', 'node_modules', 'data', '.env', '.netlify']);
  fs.cpSync(ROOT, copy, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      return !skip.has(top) && !rel.startsWith(path.join('netlify', 'functions'));
    },
  });
  fs.symlinkSync(fs.realpathSync(R('node_modules')), path.join(copy, 'node_modules'));
  const built = spawnSync('npm', ['run', 'build'], { cwd: copy, encoding: 'utf8', timeout: 5 * 60000 });
  ok(built.status === 0, 'npm run build succeeds', `${built.stdout}${built.stderr}`.slice(-1500));
  ok(fs.readFileSync(path.join(copy, 'public/sw.js'), 'utf8') === fs.readFileSync(R('public/sw.js'), 'utf8'), 'the build leaves the committed service worker exactly as it is');
  const fnDir = path.join(copy, 'netlify/functions');
  const entry = path.join(fnDir, 'api/api.mjs');
  const chunks = fs.existsSync(path.join(fnDir, 'api/chunks')) ? fs.readdirSync(path.join(fnDir, 'api/chunks')).filter((f) => f.endsWith('.mjs')) : [];
  ok(fs.existsSync(entry) && !fs.existsSync(path.join(fnDir, 'api.mjs')), 'the API function is built as netlify/functions/api/api.mjs (one function named api)');
  ok(chunks.length > 0, 'with its lazily loaded chunks beside it', chunks);
  ok(fs.existsSync(path.join(fnDir, 'send-queue.mjs')), 'and the scheduled send worker as one file');
  const sizeMb = fs.statSync(entry).size / 1e6;
  ok(sizeMb > 0.1 && sizeMb < 20, 'the entry bundle has a sane size', `${sizeMb.toFixed(2)} MB`);

  // ---------- call it as Netlify does ----------
  ok(await takeLock(), 'no other run is using /tmp/crm-data');
  fs.rmSync(DATA, { recursive: true, force: true });
  process.env.NETLIFY = 'true';
  process.env.CRM_ALLOW_EPHEMERAL_STORAGE = '1';
  process.env.APP_PASSWORD = PASSWORD;
  delete process.env.NETLIFY_BLOBS_CONTEXT;
  delete process.env.URL;
  delete process.env.BASE_URL;
  // The function must not reach out to anything to answer these.
  const outside = [];
  globalThis.fetch = async (u) => { outside.push(String(u && u.url ? u.url : u)); throw new Error('no network in tests'); };
  process.chdir(copy);   // where it would look for a .env, and there is none
  const mod = await import(pathToFileURL(entry).href);
  const handler = mod.default;
  ok(typeof handler === 'function', 'the built module exports the handler');
  ok(JSON.stringify(mod.config && mod.config.path) === JSON.stringify(['/api/*', '/auth/*', '/webhooks/*']), 'it routes /api, /auth and /webhooks, and nothing else', mod.config);

  const call = (method, p, { body, cookie, headers = {} } = {}) => handler(new Request(ORIGIN + p, {
    method,
    headers: {
      'x-forwarded-proto': 'https', 'x-nf-client-connection-ip': '203.0.113.7',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  }), { geo: { city: 'Testville', country: { code: 'US', name: 'United States' } } });

  const status = await call('GET', '/api/auth/status');
  const st = await status.json().catch(() => null);
  ok(status.status === 200 && st && st.required === true && st.authed === false && !st.setupRequired, 'signed out, the auth status says a sign-in is needed', st);
  const viaPath = await call('GET', '/.netlify/functions/api/api/auth/status');
  ok(viaPath.status === 200 && (await viaPath.json().catch(() => ({}))).required === true, 'the functions-only path works too');
  const anon = await call('GET', '/api/state');
  ok(anon.status === 401, 'signed out, /api/state is refused', anon.status);

  const login = await call('POST', '/api/login', { body: { password: PASSWORD, team: 'maverick' } });
  const setCookie = login.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  ok(login.status === 200 && /^crm_auth=/.test(cookie), 'it signs in', login.status);
  ok(/HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), 'with an HttpOnly, Secure, SameSite cookie', setCookie.replace(/=[^;]+/, '=…'));

  const people = ['ada', 'grace', 'linus'];
  const added = [];
  for (const [i, n] of people.entries()) {
    const r = await call('POST', '/api/candidates', { cookie, body: { firstName: n, lastName: 'Example', email: `${n}.bundle@example.com`, phone: `(617) 555-01${60 + i}` } });
    added.push(r.status);
  }
  ok(added.every((x) => x === 200), 'signed in, it saves new candidates', added);

  const plain = await call('GET', '/api/state', { cookie });
  const plainBody = plain.status === 200 ? await plain.json().catch(() => null) : null;
  ok(plain.status === 200 && /json/.test(plain.headers.get('content-type') || '') && plainBody, 'signed in, /api/state answers JSON', plain.status);
  ok(plainBody && plainBody.stats && plainBody.stats.total === 3 && (plainBody.candidates || []).length === 3, 'with the candidates just saved', plainBody && plainBody.stats);
  ok(plainBody && plainBody.team && plainBody.team.id === 'maverick' && plainBody.auth && plainBody.auth.required === true, 'for the team signed in to', plainBody && plainBody.team);

  const zipped = await call('GET', '/api/state', { cookie, headers: { 'accept-encoding': 'gzip, deflate, br' } });
  const raw = Buffer.from(await zipped.arrayBuffer());
  let unzipped = null;
  try { unzipped = JSON.parse((zipped.headers.get('content-encoding') === 'gzip' ? zlib.gunzipSync(raw) : raw).toString('utf8')); } catch { unzipped = null; }
  ok(zipped.status === 200 && zipped.headers.get('content-encoding') === 'gzip', 'asked for gzip, it answers gzipped', zipped.headers.get('content-encoding'));
  ok(unzipped && unzipped.stats && unzipped.stats.total === 3, 'and the gzipped body is the same state');

  const tag = plain.headers.get('etag');
  if (tag) {
    const again = await call('GET', '/api/state', { cookie, headers: { 'if-none-match': tag } });
    ok(again.status === 304 && (await again.text()) === '', 'an unchanged poll is a 304 with no body, not a 500', again.status);
  } else {
    ok(true, '(no ETag on /api/state, so no conditional poll to check)');
  }

  // Where it kept it.
  const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
  const files = walk(DATA);
  const holding = files.filter((f) => /ada\.bundle@example\.com/.test(fs.readFileSync(f, 'utf8')));
  ok(holding.length > 0, 'the data is kept under /tmp/crm-data', files.map((f) => path.relative(DATA, f)));
  const inRepo = walk(R('data')).concat(walk(path.join(copy, 'data'))).filter((f) => /bundle@example\.com/.test(fs.readFileSync(f, 'utf8')));
  ok(inRepo.length === 0, 'and not in a data folder of the repo', inRepo);
  ok(outside.length === 0, 'nothing reached outside the machine', outside);

  cleanUp();
  done();
})().catch((e) => { cleanUp(); crash(e); });
