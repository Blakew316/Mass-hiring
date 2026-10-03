// The held team document on Netlify Blobs (lib/storage.js), against an
// in-memory stand-in for the store that answers as the real one does
// (tests/perf/fake-blobs.js):
//   - every read asks the store; one that names the current ETag is answered
//     304 with no body, and the text held is used — the same list;
//   - a write keeps what it wrote under the ETag the store gave it, so the
//     next read costs no download either;
//   - a write by anyone else (another instance) is what the next read gets,
//     and a document gone from the store reads as nothing;
//   - a body-less answer with nothing held is a storage error, never an
//     empty list;
//   - a stale conditional write is still refused, and two teams' documents
//     never cross;
//   - store.read() shares one frozen copy per version on top of it.
// Made-up people only. No network: the store is in this process.
const { R, ROOT, ok, done, crash } = require('./helpers');

(async () => {
  process.env.APP_PASSWORD = 'test-password';
  for (const k of ['NETLIFY_BLOBS_CONTEXT', 'AWS_LAMBDA_FUNCTION_NAME', 'CRM_ALLOW_EPHEMERAL_STORAGE']) delete process.env[k];
  const blobs = require('./perf/fake-blobs').install(ROOT, { latencyMs: 0 });
  const tenant = require(R('lib/tenant.js'));
  tenant.adopt('maverick');
  const storage = require(R('lib/storage.js'));
  const store = require(R('lib/store.js'));
  const teams = require(R('lib/teams.js'));
  ok(storage.onNetlify && (await storage.backend()).kind === 'netlify-blobs', 'the storage layer is on (stand-in) Netlify Blobs');
  await teams.all();
  const gets = () => blobs.stats.byMethod.get || 0;
  const downloaded = () => blobs.stats.bytesOut;

  await store.update((d) => {
    d.candidates = Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, name: `Blair Blob ${i}`, email: `blair.blob.${i}@example.com`, status: 'new', notes: 'x'.repeat(200) }));
  });
  ok(blobs.entries.has('db') && JSON.parse(blobs.entries.get('db').body.toString()).candidates.length === 40, 'the document is stored, compact, under the team\'s key');

  // ---------- reads ask, and an unchanged document costs no download ----------
  let g0 = gets(); let n0 = blobs.stats.notModified; let b0 = downloaded();
  const first = await store.read();
  ok(gets() === g0 + 1, 'a read asks the store', gets() - g0);
  ok(blobs.stats.notModified === n0 + 1 && downloaded() === b0, 'right after this instance wrote it, the answer is 304 with no body', { notModified: blobs.stats.notModified - n0, bytes: downloaded() - b0 });
  ok(first.candidates.length === 40 && Object.isFrozen(first), 'and the read is the list as written');
  g0 = gets(); n0 = blobs.stats.notModified; b0 = downloaded();
  const again = await store.read();
  const loaded = await store.load();
  ok(gets() === g0 + 2 && blobs.stats.notModified === n0 + 2 && downloaded() === b0, 'every later read asks again, and is answered 304', { gets: gets() - g0, notModified: blobs.stats.notModified - n0 });
  ok(again === first && loaded.candidates.length === 40 && loaded !== first, 'read() shares its copy; load() parses its own from the text held');
  ok(store.versionOf(loaded) === blobs.entries.get('db').etag, 'the version is the store\'s ETag');

  // ---------- another instance writes ----------
  const doc = JSON.parse(blobs.entries.get('db').body.toString());
  doc.candidates.push({ id: 'b-new', name: 'Nico Newer', email: 'nico.newer@example.com', status: 'new' });
  blobs.put('db', JSON.stringify(doc), { w: 'someone-else' });
  b0 = downloaded();
  const seen = await store.read();
  ok(seen.candidates.some((c) => c.id === 'b-new') && downloaded() > b0, 'a write by another instance is downloaded and read at once', downloaded() - b0);
  ok(store.versionOf(seen) === blobs.entries.get('db').etag && store.versionOf(seen) !== store.versionOf(first), 'with its new version');
  b0 = downloaded();
  await store.read();
  ok(downloaded() === b0, 'and is then held in turn');

  // ---------- conditional writes ----------
  const stale = await store.load();
  await store.update((d) => { d.settings.fromName = 'Morgan Fresh'; });
  stale.settings.fromName = 'Morgan Stale';
  let conflict = null;
  try { await store.save(stale); } catch (e) { conflict = e; }
  ok(conflict && conflict.status === 409, 'a save on a version since replaced is refused', conflict && conflict.message);
  // A write drops what is held before it is made, refused or not, so the
  // next read fetches the document afresh.
  b0 = downloaded();
  const fresh = await store.read();
  ok(fresh.settings.fromName === 'Morgan Fresh' && downloaded() > b0, 'the newer write stands, fetched afresh after the refused one', downloaded() - b0);
  ok(JSON.parse(blobs.entries.get('db').body.toString()).settings.fromName === 'Morgan Fresh', 'and is what the store holds');
  await store.update((d) => { d.settings.fromName = 'Morgan Held'; });
  b0 = downloaded();
  ok((await store.read()).settings.fromName === 'Morgan Held' && downloaded() === b0, 'a write that lands is held by the instance that made it');

  // ---------- two teams ----------
  const team = await teams.create({ name: 'Team Azure', pin: '7392' }, () => store.seedTeam());
  await tenant.run(team.id, () => store.update((d) => { d.candidates = [{ id: 'az1', name: 'Ari Azure', email: 'ari.azure@example.com', status: 'new' }]; }));
  for (let i = 0; i < 3; i++) {
    const m = await store.read();
    const t = await tenant.run(team.id, () => store.read());
    ok(m.candidates.length === 41 && !m.candidates.some((c) => c.id === 'az1') && t.candidates.length === 1 && t.candidates[0].id === 'az1', `read ${i + 1}: each team gets its own list, alternating`);
  }
  ok(blobs.entries.has(`t/${team.id}/db`), 'the other team\'s document is under its own key');

  // ---------- gone, and faults ----------
  blobs.entries.delete(`t/${team.id}/db`);
  ok((await tenant.run(team.id, () => storage.getJson('db'))) === null, 'a document gone from the store reads as nothing, not as what was held');
  await tenant.run(team.id, () => store.update((d) => { d.candidates = [{ id: 'az2', name: 'Ari Again', email: 'ari.again@example.com', status: 'new' }]; }));
  await tenant.run(team.id, () => storage.purgeTeam());
  ok(!blobs.entries.has(`t/${team.id}/db`) && (await tenant.run(team.id, () => storage.getJson('db'))) === null, 'a purged team reads as nothing');

  const real = blobs.getWithMetadata;
  blobs.getWithMetadata = async () => ({ data: null, etag: '"made-up"', metadata: {} });
  let fault = null;
  try { await tenant.run(team.id, () => storage.getJson('db')); } catch (e) { fault = e; }
  ok(fault && fault.storage === true, 'a body-less answer with nothing held is a storage error', fault && fault.message);
  let fault2 = null;
  try { await tenant.run(team.id, () => store.read()); } catch (e) { fault2 = e; }
  ok(fault2 && fault2.storage === true, 'for read() too — never an empty list', fault2 && fault2.message);
  blobs.getWithMetadata = async (...a) => { const r = await real(...a); if (r && r.data !== null) r.data = '{"candidates": [nonsense'; return r; };
  blobs.put('db', JSON.stringify({ ...doc, candidates: [] }));
  let fault3 = null;
  try { await store.read(); } catch (e) { fault3 = e; }
  ok(fault3 && fault3.storage === true, 'a stored document that does not parse is a storage error, not an empty list', fault3 && fault3.message);
  blobs.getWithMetadata = real;
  ok((await store.read()).candidates.length === 0, 'and once the store answers properly again, it is read');

  // ---------- the store's answers ----------
  ok(blobs.stats.byMethod.put > 0 && !Object.keys(blobs.stats.byMethod).some((m) => !['get', 'head', 'put', 'delete', 'list'].includes(m)), 'only the calls the real store has were made', blobs.stats.byMethod);
  done();
})().catch(crash);
