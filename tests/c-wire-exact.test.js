// The compact list gives the page exactly what the old state did. Every
// person decoded from GET /api/candidates?v=2 is, as JSON, the same bytes
// publicCandidate() made for the old /api/state — the same keys in the same
// order, the same values — with either reader (the decoders written per
// shape, and the walker that stands in for them). The texting order put back
// together from the scores on each row, and the follow-up due list, are the
// same as the old state's, including a list whose ids the server's own
// tie-break orders differently from a plain comparison (the order is then
// sent as it is). Each bucket's digest, worked out from what was decoded,
// is the server's; and the state without the list is the old state less the
// list, the order and the due list, and nothing else. Made-up people only;
// nothing is sent.
const { startApp, R, ok, done, crash } = require('./helpers');
const { guardOutside, stubSenders } = require('./server-read-helpers');
const { Wire, people, body, legacy, fullCopy, badBuckets, holdClock, midWindow, J } = require('./c-helpers');

(async () => {
  const refused = guardOutside();
  const s = await startApp({ offset: 218 });
  const sent = stubSenders();
  const W = Wire();
  const textQueue = require(R('lib/text-queue.js'));
  const unhold = holdClock(midWindow());
  try {
    const list = people(2500, { at: Date.now() });
    // Two people on one number (the richer one is ranked), and a duplicate
    // with less on file.
    list[10].phone = list[11].phone = '(617) 555-2911';
    list[11].notes = ''; list[11].role = ''; list[11].company = '';
    await s.store.update((d) => { d.candidates = list; d.events = []; });
    // Two numbers that asked to stop.
    await textQueue.updateQ((q) => { textQueue.addOptOut(q, list[20].phone || '(617) 555-2020'); textQueue.addOptOut(q, '(617) 555-2021'); });

    for (const label of ['a list of 2,500', 'ids the server orders its own way']) {
      if (label !== 'a list of 2,500') {
        // Everybody scores the same, and the ids mix capitals, punctuation
        // and digits: localeCompare and a plain comparison disagree.
        const ids = ['B-1', 'a_2', 'b1', 'A1', 'zz', 'Zz', 'a-1', '10', '9', 'é1', 'e1', 'E2'];
        await s.store.update((d) => {
          for (const c of [...d.candidates]) s.store.removeCandidate(d, c.id);
          ids.forEach((id, i) => d.candidates.push({
            id, name: `Tie Person${i}`, email: `tie.person${i}@example.com`, phone: `(617) 555-23${String(10 + i)}`,
            role: 'Account Executive', company: 'Example Payments', status: 'emailed', lastEmailedAt: new Date(Date.now() - 10 * 864e5).toISOString(),
            addedAt: new Date(Date.now() - 40 * 864e5).toISOString(), source: 'csv',
          }));
        });
      }
      const old = await legacy(s);
      const full = await body(s, 'GET', '/api/candidates?v=2');
      ok(full.status === 200 && full.json && full.json.fmt === 2, `${label}: the whole list comes compact`, full.status);
      ok(full.text.length * 2 < old.text.length, `${label}: in well under half the bytes of the old state`, { compact: full.text.length, old: old.text.length });

      for (const walk of [false, true]) {
        const reader = walk ? 'the walker' : 'the written decoders';
        const { cands, sides } = W.unpack(JSON.parse(full.text), { walk });
        ok(cands.length === old.candidates.length, `${label}, ${reader}: as many people as the old state`, [cands.length, old.candidates.length]);
        const wrongBytes = [];
        const wrongKeys = [];
        for (let i = 0; i < old.candidates.length; i++) {
          if (J(cands[i]) !== J(old.candidates[i])) wrongBytes.push(i);
          if (J(Object.keys(cands[i] || {})) !== J(Object.keys(old.candidates[i]))) wrongKeys.push(i);
        }
        ok(wrongBytes.length === 0, `${label}, ${reader}: every person is the same bytes as the old state's`, wrongBytes.slice(0, 5).map((i) => [J(cands[i]), J(old.candidates[i])]));
        ok(wrongKeys.length === 0, `${label}, ${reader}: with the keys in the same order`, wrongKeys.slice(0, 5));
        ok(sides.length === cands.length, `${label}, ${reader}: with what rides beside each`);
      }

      const copy = await W.fromFull(full.json, 'maverick');
      ok(J(W.priorityOf(copy)) === J(old.priority), `${label}: the texting order, its reasons and who cannot be texted are the old state's, byte for byte`,
        { got: J(W.priorityOf(copy)).slice(0, 300), want: J(old.priority).slice(0, 300) });
      ok(J(W.dueIdsOf(copy)) === J(old.dueIds), `${label}: so is the follow-up due list`, { got: W.dueIdsOf(copy).length, want: old.dueIds.length });
      ok(W.priorityOf(copy).textable === old.priority.textable && old.priority.textable > 0, `${label}: with the same count of people who can be texted`, old.priority.textable);
      const ranked = W.rankOf(copy);
      ok(await W.rankDigest(copy, ranked) === copy.rn, `${label}: the order put together here has the server's digest`);
      if (label === 'ids the server orders its own way') ok(Array.isArray(full.json.ro), 'and when the ids are ordered the server\'s own way, the order is sent as it is', full.json.ro);
      else ok(full.json.ro === undefined, `${label}: an order the page can put together itself is not sent`);
      ok((await badBuckets(copy)).length === 0, `${label}: every bucket, as decoded, comes out at the server's digest`);

      // The state without the list.
      const slim = await body(s, 'GET', '/api/state?v=2');
      const rest = JSON.parse(old.text);
      delete rest.candidates; delete rest.texting.priority; delete rest.followUp.dueIds;
      const got = { ...slim.json }; delete got.cands;
      ok(slim.status === 200 && J(Object.keys(slim.json)) === J(['cands', ...Object.keys(rest)]), `${label}: the slim state has the old keys, the list's place taken by cands`, Object.keys(slim.json || {}));
      ok(J(got) === J(rest), `${label}: and everything else in it is the old state's`);
      ok(J(Object.keys(slim.json.cands)) === J(['v', 'n', 'nb', 'o', 'rh', 'rn', 't', 'fk']) && slim.json.cands.v === copy.v && slim.json.cands.t === 'maverick'
        && slim.json.cands.n === copy.n && slim.json.cands.rh === copy.rh && slim.json.cands.o === copy.o, `${label}: cands names the version the whole list is`, slim.json.cands);
      ok(slim.json.cands.fk === Wire().fieldsKey(copy.f, copy.k), `${label}: and which fields it has`, slim.json.cands.fk);
      ok(slim.text.length < 0.05 * old.text.length || old.candidates.length < 100, `${label}: and is a small part of the old state`, [slim.text.length, old.text.length]);
    }

    // The digests are the server's sha1, the page's way.
    const crypto = require('crypto');
    for (const text of ['', 'abc', 'Zoë 🙂 \ud83d', 'x'.repeat(5000)]) {
      ok(await W.digest(text, 8) === crypto.createHash('sha1').update(text).digest('base64url').slice(0, 8), `the page's digest of ${J(text.slice(0, 12))} is the server's`);
    }
    // Buckets: the same on both sides, and spread.
    const counts = new Array(64).fill(0);
    for (let i = 0; i < 6400; i++) counts[W.bucketOf(`p${i.toString(36)}x${i}`, 64)] += 1;
    ok(Math.min(...counts) > 50 && Math.max(...counts) < 160, 'ids spread over the buckets', [Math.min(...counts), Math.max(...counts)]);
    ok(W.bucketCount(30) === 16 && W.bucketCount(3500) === 256 && W.bucketCount(32667) === 1024, 'a list is cut into about sixteen people a bucket, 16 to 1,024 buckets');
    const again = await fullCopy(s);
    ok(again.v === (await fullCopy(s)).v, 'two answers for one version name the same version');
  } finally {
    unhold();
  }
  ok(sent.email.length + sent.gmail.length === 0, 'nothing was sent');
  ok(refused.length === 0, 'nothing reached outside this machine', refused);
  await s.close();
  done();
})().catch(crash);
