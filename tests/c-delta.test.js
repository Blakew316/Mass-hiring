// The page's copy of the list, kept up to date a bucket at a time. After each
// kind of change — a status, an email opened, a text reply, five people at
// once, someone added, someone taken off, a "not interested", a number that
// asked to stop, the follow-up limit changed, a thousand people imported,
// people put in another order, a ten-minute window that makes someone due —
// a copy brought up to date by POST /api/candidates/sync is the same as a
// whole new copy, and both are what the old state sent: the people, the
// texting order and the due list. A small change costs a bucket, not the
// list. And a delta that has been tampered with, or is another team's, is
// refused, and leaves the copy exactly as it was. Made-up people only;
// nothing is sent.
const { startApp, R, ok, done, crash } = require('./helpers');
const { guardOutside, stubSenders, addTeam, inTeam } = require('./server-read-helpers');
const { Wire, people, body, legacy, fullCopy, syncCopy, asState, sameCopy, badBuckets, holdClock, midWindow, WINDOW, J } = require('./c-helpers');

(async () => {
  const refused = guardOutside();
  const s = await startApp({ offset: 220 });
  const sent = stubSenders();
  const W = Wire();
  const textQueue = require(R('lib/text-queue.js'));
  const t0 = midWindow();
  let unhold = holdClock(t0);
  try {
    await s.store.update((d) => { d.candidates = people(3000, { at: Date.now() }); d.events = []; });
    let copy = await fullCopy(s);
    ok(copy.n === 3000 && copy.nb === 256, 'a whole copy of 3,000 people in 256 buckets', [copy.n, copy.nb]);
    const pick = (n) => copy.cands[n];

    // One change, then one sync: the copy equals a whole new one, and what
    // the old state says.
    async function step(label, change, { kinds = ['delta'], maxBuckets = Infinity } = {}) {
      await change();
      const r = await syncCopy(s, copy);
      const fresh = await fullCopy(s);
      const old = await legacy(s);
      const diffs = sameCopy(r.copy, fresh);
      ok(kinds.includes(r.kind), `${label}: answered as ${kinds.join(' or ')}`, { kind: r.kind, buckets: r.msg.ch && r.msg.ch.length });
      if (r.msg.ch) ok(r.msg.ch.length <= maxBuckets, `${label}: in ${r.msg.ch.length} bucket(s), ${r.bytes} bytes`, { buckets: r.msg.ch.length, bytes: r.bytes });
      ok(diffs.length === 0, `${label}: the copy is the same as a whole new one`, diffs);
      const st = asState(r.copy);
      ok(J(st.candidates) === J(old.candidates) && J(st.priority) === J(old.priority) && J(st.dueIds) === J(old.dueIds), `${label}: and is what the old state sends`);
      copy = r.copy;
      return r;
    }

    const nothing = await syncCopy(s, copy);
    ok(nothing.kind === 'same' && nothing.bytes < 600, 'nothing changed: the answer says so, in a few hundred bytes', { kind: nothing.kind, bytes: nothing.bytes });

    const status = await step('a status picked', async () => {
      const r = await body(s, 'PATCH', `/api/candidates/${pick(10).id}`, { status: 'replied' });
      if (r.status !== 200) throw new Error(`PATCH answered ${r.status}`);
    }, { maxBuckets: 2 });
    ok(status.bytes < 20000, 'a status costs a bucket of the list, not the list', status.bytes);
    await step('an email opened', () => s.store.update((d) => { const c = d.candidates.find((x) => x.id === pick(20).id); c.openedAt = new Date().toISOString(); }), { maxBuckets: 3 });
    await step('a text reply', () => s.store.update((d) => {
      const c = d.candidates.find((x) => x.phone && x.lastTextedAt);
      s.store.addToThread(c, 'in', 'Yes, call me after 5', new Date().toISOString());
      c.textUnread = true; c.textStatus = 'replied'; c.textRepliedAt = new Date().toISOString();
    }), { maxBuckets: 3 });
    await step('five people at once', () => s.store.update((d) => {
      for (const n of [100, 700, 1400, 2100, 2800]) d.candidates[n].notes = `changed ${n}`;
    }), { maxBuckets: 5 });
    await step('someone added', async () => {
      const r = await body(s, 'POST', '/api/candidates', { name: 'Newly Added', email: 'newly.added@example.com', phone: '(617) 555-2999', role: 'Account Executive' });
      if (r.status !== 200) throw new Error(`add answered ${r.status}`);
    }, { kinds: ['delta+places'], maxBuckets: 3 });
    await step('someone taken off', async () => {
      const r = await body(s, 'DELETE', `/api/candidates/${pick(30).id}`);
      if (r.status !== 200) throw new Error(`delete answered ${r.status}`);
    }, { kinds: ['delta+places'], maxBuckets: 3 });
    const ranked = copy.cands.find((c, i) => copy.sides[i] && copy.sides[i].score !== undefined && c.status !== 'declined');
    await step('marked not interested', async () => {
      const r = await body(s, 'PATCH', `/api/candidates/${ranked.id}`, { status: 'declined' });
      if (r.status !== 200) throw new Error(`PATCH answered ${r.status}`);
    }, { maxBuckets: 3 });
    const another = copy.cands.find((c, i) => copy.sides[i] && copy.sides[i].score !== undefined);
    await step('a number asked to stop', () => textQueue.updateQ((q) => { textQueue.addOptOut(q, another.phone); }), { maxBuckets: 4 });
    await step('the follow-up limit changed', async () => {
      const r = await body(s, 'POST', '/api/settings', { maxFollowUps: '1' });
      if (r.status !== 200) throw new Error(`settings answered ${r.status}`);
    }, { kinds: ['delta', 'full'] });
    await step('a thousand people imported', async () => {
      const rows = Array.from({ length: 1000 }, (_, i) => [`Imp${i}`, 'Person', `imp.person${i}@example.com`, `(617) 555-${String(3000 + i)}`, 'Outside Sales', 'Example Co', 'Austin, TX']);
      const r = await body(s, 'POST', '/api/import/commit', { rows, mapping: { firstName: 0, lastName: 1, email: 2, phone: 3, role: 4, company: 5, location: 6 }, source: 'csv', updateExisting: true });
      if (r.status !== 200 || r.json.added !== 1000) throw new Error(`import answered ${r.status} ${r.text.slice(0, 200)}`);
    }, { kinds: ['full', 'delta+places'] });
    ok(copy.n === 4000, 'the copy now holds 4,000 people', copy.n);

    // Two people in one bucket swapped: that bucket's order changed, and it
    // comes with places.
    const byBucket = new Map();
    copy.ids.forEach((id, i) => { const b = copy.bk[i]; if (!byBucket.has(b)) byBucket.set(b, []); byBucket.get(b).push(i); });
    const sameBucket = [...byBucket.values()].find((ix) => ix.length >= 2);
    await step('two people in one bucket put in each other\'s place', () => s.store.update((d) => {
      const [a, b] = sameBucket;
      [d.candidates[a], d.candidates[b]] = [d.candidates[b], d.candidates[a]];
    }), { kinds: ['delta+places'], maxBuckets: 1 });
    // Two in different buckets swapped: no bucket changed, only the order.
    // There is nothing to patch, and the server says so with the whole list.
    const [b1, b2] = [...byBucket.keys()];
    await step('two people in different buckets put in each other\'s place', () => s.store.update((d) => {
      const a = byBucket.get(b1)[0]; const b = byBucket.get(b2)[0];
      [d.candidates[a], d.candidates[b]] = [d.candidates[b], d.candidates[a]];
    }), { kinds: ['full'] });
    // And that, with somebody else changed too: the delta's places cannot
    // say it, the copy's order check refuses it, and a whole copy follows.
    {
      const before = J(asState(copy)) + J(copy.d);
      await s.store.update((d) => {
        const a = byBucket.get(b1)[1]; const b = byBucket.get(b2)[1];
        [d.candidates[a], d.candidates[b]] = [d.candidates[b], d.candidates[a]];
        d.candidates[500].notes = 'changed with a reorder';
      });
      const r = await body(s, 'POST', '/api/candidates/sync?v=2', W.syncBody(copy));
      const err = await W.applyDelta(copy, r.json).then(() => null, (e) => e);
      ok(r.json.ch && r.json.p && err && err.refused, 'people reordered across buckets, with a change: the delta is refused by the order check', err && err.message);
      ok(J(asState(copy)) + J(copy.d) === before, 'and the copy is untouched');
      copy = await fullCopy(s);
    }

    // The ten-minute window: someone emailed three days ago, give or take,
    // becomes due during the next window. Only what rides beside them moves.
    await s.store.update((d) => {
      const c = d.candidates[50];
      const nextWindow = t0 - (t0 % WINDOW) + WINDOW;
      c.status = 'emailed'; c.followUpCount = 0; c.lastEmailedAt = new Date(nextWindow - 3 * 864e5 - 60000).toISOString();
    });
    copy = (await syncCopy(s, copy)).copy;
    ok(!W.dueIdsOf(copy).includes(copy.ids[50]), 'not due in this window');
    unhold();
    unhold = holdClock(t0 + WINDOW + 60000);
    const win = await step('a window later, she is due', async () => {}, { kinds: ['delta'], maxBuckets: 8 });
    ok(W.dueIdsOf(copy).includes(copy.ids[50]), 'and the copy says so', win.msg.ch);

    // A save that changes nothing in the list gives a new version with the
    // same rows: the state's word on it is enough, no sync needed.
    await body(s, 'POST', '/api/settings', { fromName: 'Pretend Sender' });
    const slim = await body(s, 'GET', '/api/state?v=2');
    ok(slim.json.cands.v !== copy.v && W.sameAs(copy, slim.json.cands), 'a save outside the list: a new version, with the same people, order and digests');
    ok((await syncCopy(s, copy)).kind === 'same', 'and a sync says the same');

    // A bucket the page no longer trusts is sent whatever its digest says.
    const distrust = new Set([copy.bk[7]]);
    const asked = await body(s, 'POST', '/api/candidates/sync?v=2', W.syncBody(copy, distrust));
    ok(asked.json.ch && J(asked.json.ch) === J([copy.bk[7]]), 'a bucket sent up as unknown comes back, alone', asked.json.ch);
    ok(J(asState(await W.applyDelta(copy, asked.json))) === J(asState(copy)), 'and lays over the copy as what it already was');

    // ---------- tampered and foreign deltas ----------
    await s.store.update((d) => { d.candidates[60].notes = 'a change to tamper with'; d.candidates[61].notes = 'and another'; });
    const real = (await body(s, 'POST', '/api/candidates/sync?v=2', W.syncBody(copy))).json;
    ok(real.ch && real.r.length > 1, 'a real delta to tamper with', real.ch);
    const snapshot = () => J(asState(copy)) + J(copy.d) + J(copy.sides) + copy.v + copy.o + copy.rh + copy.n;
    const before = snapshot();
    const clone = () => JSON.parse(J(real));
    const tampered = {
      'a value in a row changed': (m) => { const row = m.r[0]; for (let j = row.length - 1; j > 0; j--) if (typeof row[j] === 'string') { row[j] = `${row[j]}!`; break; } },
      'a row taken out': (m) => { m.r.pop(); },
      'a digest changed': (m) => { m.d = `AAAAAAAA${m.d.slice(8)}`; },
      'the digest of the digests changed': (m) => { m.rh = 'AAAAAAAAAAAAAAAA'; },
      'another team named': (m) => { m.t = 'someone-else'; },
      'a bucket that does not hold the row': (m) => { m.ch = m.ch.map((b) => (b + 1) % m.nb); },
      'places that are not places': (m) => { m.p = m.r.map(() => 0); },
      'fields renamed': (m) => { m.f = m.f.map((f) => (f === 'name' ? 'nom' : f)); },
      'cut into other buckets': (m) => { m.nb *= 2; },
      'a shape that is not there': (m) => { m.r[0][0] = 9999; },
      'another format': (m) => { m.fmt = 3; },
    };
    for (const [label, spoil] of Object.entries(tampered)) {
      const m = clone();
      spoil(m);
      const err = await W.applyDelta(copy, m).then(() => null, (e) => e);
      ok(err && err.refused, `tampered (${label}): refused`, err ? err.message : 'applied');
      ok(snapshot() === before, `tampered (${label}): the copy is untouched`);
    }
    ok((await W.applyDelta(copy, clone())).v === real.v, 'the same delta, untampered, applies');

    // Another team's delta, against this team's copy.
    const B = await addTeam(s, { name: 'Team Delta', pin: '6290' });
    await inTeam(B.id, () => s.store.update((d) => { d.candidates = people(300, { prefix: 'q', seed: 3, at: Date.now() }); }));
    const theirs = (await B.json('GET', '/api/candidates?v=2')).body;
    const theirCopy = await W.fromFull(theirs, B.id);
    await inTeam(B.id, () => s.store.update((d) => { d.candidates[3].notes = 'their change'; }));
    const theirDelta = (await B.json('POST', '/api/candidates/sync?v=2', W.syncBody(theirCopy))).body;
    ok(theirDelta.ch && theirDelta.t === B.id, 'the other team has a delta of its own', theirDelta.t);
    const foreign = await W.applyDelta(copy, theirDelta).then(() => null, (e) => e);
    ok(foreign && foreign.refused, 'another team\'s delta is refused', foreign && foreign.message);
    ok(snapshot() === before, 'and the copy is untouched');
    const relabelled = { ...theirDelta, t: 'maverick' };
    const passed = await W.applyDelta(copy, relabelled).then(() => null, (e) => e);
    ok(passed && passed.refused, 'even relabelled as this team\'s', passed && passed.message);
    ok(snapshot() === before, 'and the copy is untouched');
    ok(await W.fromFull(theirs, 'maverick').then(() => false, (e) => Boolean(e.refused)), 'a whole list of another team\'s is refused for this one');

    // Every bucket of the copy, checked as the page checks it now and then.
    copy = (await syncCopy(s, copy)).copy;
    ok((await badBuckets(copy)).length === 0, 'every bucket of the kept copy comes out at the server\'s digest');
  } finally {
    unhold();
  }
  ok(sent.count() === 0, 'nothing was sent', sent);
  ok(refused.length === 0, 'nothing reached outside this machine', refused);
  await s.close();
  done();
})().catch(crash);
