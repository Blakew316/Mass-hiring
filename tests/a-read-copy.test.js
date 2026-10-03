// The shared read-only copy of a team's document (store.read()) and the held
// document underneath it (lib/storage.js), on local files:
//   - two reads of one stored version are the same object, deep-frozen, and
//     save() refuses it; load() still hands out a private copy every time;
//   - versionOf() names the stored version: the same for read() and load()
//     of one version, different once anything is saved;
//   - a write from anywhere — this process, another process, a file put in
//     place by hand — is what the very next read() and load() see;
//   - one team's copy is never another team's;
//   - nothing stored reads as nothing, never as what was held before;
//   - a conditional write on a stale version is still refused.
// Made-up people only.
const fs = require('fs');
const path = require('path');
const { R, ok, done, crash, wipeData } = require('./helpers');
const { elsewhere } = require('./server-read-helpers');

(async () => {
  process.env.APP_PASSWORD = 'test-password';
  const tenant = require(R('lib/tenant.js'));
  tenant.adopt('maverick');
  wipeData();
  const storage = require(R('lib/storage.js'));
  const store = require(R('lib/store.js'));
  const teams = require(R('lib/teams.js'));
  await teams.all();

  await store.update((d) => {
    d.candidates = [
      { id: 'r1', name: 'Rory Reader', email: 'rory.reader@example.com', phone: '(617) 555-2301', status: 'emailed', textThread: [{ dir: 'out', ts: '2026-09-01T10:00:00.000Z', text: 'Hello Rory' }] },
      { id: 'r2', name: 'Sky Shared', email: 'sky.shared@example.com', status: 'new' },
    ];
  });

  // ---------- one shared, frozen copy per version ----------
  const a = await store.read();
  const b = await store.read();
  ok(a === b, 'two reads of the same version are the same object');
  ok(a.candidates.length === 2 && a.candidates[0].name === 'Rory Reader', 'and it is the stored list');
  ok(Object.isFrozen(a) && Object.isFrozen(a.candidates) && Object.isFrozen(a.candidates[0]) && Object.isFrozen(a.candidates[0].textThread[0]) && Object.isFrozen(a.settings),
    'frozen all the way down');
  let threw = null;
  try { (() => { 'use strict'; a.candidates[0].status = 'replied'; })(); } catch (e) { threw = e; }
  ok(threw instanceof TypeError && a.candidates[0].status === 'emailed', 'a write to it throws (in strict code) and changes nothing', threw && threw.message);
  let refused = null;
  try { await store.save(a); } catch (e) { refused = e; }
  ok(refused && /read-only/.test(refused.message), 'save() refuses it', refused && refused.message);
  const l1 = await store.load();
  const l2 = await store.load();
  ok(l1 !== l2 && l1 !== a && !Object.isFrozen(l1), 'load() hands out a private, changeable copy every time');
  ok(store.versionOf(a) && store.versionOf(a) === store.versionOf(l1) && store.versionOf(l1) === store.versionOf(l2), 'read() and load() of one version share its version', store.versionOf(a));
  ok(store.versionOf({ candidates: [] }) === null, 'a document never stored has no version');

  // ---------- a write here ----------
  await store.update((d) => { d.candidates.find((c) => c.id === 'r2').status = 'emailed'; });
  const c = await store.read();
  ok(c !== a && c.candidates.find((x) => x.id === 'r2').status === 'emailed', 'a write in this process is what the next read() sees');
  ok(store.versionOf(c) !== store.versionOf(a), 'with a new version');
  ok(a.candidates.find((x) => x.id === 'r2').status === 'new', 'the copy handed out before is left as it was');

  // ---------- a write elsewhere ----------
  await elsewhere('maverick', ({ store: other }) => other.update((d) => { d.candidates.push({ id: 'r3', name: 'Elsa Elsewhere', email: 'elsa.elsewhere@example.com', status: 'new' }); }));
  const d1 = await store.read();
  ok(d1.candidates.some((x) => x.id === 'r3'), 'a write by another process is what the next read() sees');
  ok((await store.load()).candidates.some((x) => x.id === 'r3'), 'and the next load()');
  // The file replaced by hand, keeping its size: compared byte for byte, not by size or time.
  const file = R('data/db.json');
  const text = fs.readFileSync(file, 'utf8');
  const swapped = text.replace('Elsa Elsewhere', 'Elsa Elsewherf');
  ok(swapped.length === text.length, 'a same-size edit made by hand');
  fs.writeFileSync(file, swapped);
  const d2 = await store.read();
  ok(d2.candidates.find((x) => x.id === 'r3').name === 'Elsa Elsewherf' && store.versionOf(d2) !== store.versionOf(d1), 'is seen at once, with a new version');
  ok(store.versionOf(await store.read()) === store.versionOf(d2) && (await store.read()) === d2, 'and then shared again');

  // ---------- a stale conditional write is still refused ----------
  const stale = await store.load();
  await store.update((x) => { x.settings.fromName = 'Fresh Sender'; });
  stale.settings.fromName = 'Stale Sender';
  let conflict = null;
  try { await store.save(stale); } catch (e) { conflict = e; }
  ok(conflict && conflict.status === 409, 'a save of a version since replaced is refused (409)', conflict && conflict.message);
  ok((await store.read()).settings.fromName === 'Fresh Sender', 'and the newer change stands');

  // ---------- another team ----------
  const blue = await teams.create({ name: 'Team Cobalt', pin: '4826' }, () => store.seedTeam());
  await tenant.run(blue.id, () => store.update((x) => { x.candidates = [{ id: 'c1', name: 'Cora Cobalt', email: 'cora.cobalt@example.com', status: 'new' }]; }));
  const mine = await store.read();
  const theirs = await tenant.run(blue.id, () => store.read());
  ok(mine.candidates.every((x) => x.id !== 'c1') && theirs.candidates.length === 1 && theirs.candidates[0].id === 'c1', 'each team reads its own list');
  ok(store.versionOf(mine) !== store.versionOf(theirs), 'with its own version');
  ok((await store.read()) === mine && (await tenant.run(blue.id, () => store.read())) === theirs, 'and each keeps its own shared copy');
  // Gone: the team's own files removed.
  await tenant.run(blue.id, () => storage.purgeTeam());
  const after = await tenant.run(blue.id, () => storage.getJson('db'));
  ok(after === null, 'a purged team reads as nothing stored, not what was held', after);
  const blank = await tenant.run(blue.id, () => store.read());
  ok(blank.candidates.length === 0 && store.versionOf(blank) === null, 'and its read copy is a blank document with no version');
  ok((await store.read()).candidates.some((x) => x.id === 'r1'), 'the other team is untouched');

  // ---------- removed ----------
  await storage.del('db');
  ok((await storage.getJson('db')) === null, 'a deleted document reads as nothing, not what was held');
  ok(!fs.existsSync(path.join(R('data'), 'db.json')), 'and its file is gone');
  done();
})().catch(crash);
