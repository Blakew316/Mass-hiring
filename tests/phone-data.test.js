// Phone numbers, from the moment they arrive to the text that goes out:
//   - one number is kept one way (E.164) however it was typed, imported or
//     edited, and shown one way: "(617) 555-2043", "+234 810 986 7552"
//   - what spreadsheets do to numbers is undone where it can be: a dropped
//     "+", a ".0", 00/011 in front; what cannot be read is kept as given, to
//     be fixed, and never texted
//   - importing again fills in a missing number and replaces one that cannot
//     be texted, and never swaps a good number for another
//   - an edit that changes nothing changes nothing, and saving a whole card
//     never rewrites a number into something else
//   - a text queued before a number was corrected goes to the corrected one
//   - the page's own check (the Edit form's "will be saved as") agrees with
//     the server's for every case here
// Made-up people only; nothing is sent.
const { launch, R, ok, done, crash } = require('./helpers');
const W = require('./server-write-helpers');
const { open } = require('./views-helpers');

(async () => {
  const phone = require(R('lib/phone.js'));
  const CASES = [
    ['(617) 555-2043', '+16175552043', '(617) 555-2043'],
    ['617.555.2043 x12', '+16175552043', '(617) 555-2043'],
    ['1-617-555-2043', '+16175552043', '(617) 555-2043'],
    ['6175552043.0', '+16175552043', '(617) 555-2043'],
    ['+2348109867552', '+2348109867552', '+234 810 986 7552'],
    ['2348109867552', '+2348109867552', '+234 810 986 7552'],
    ['00234 810 986 7552', '+2348109867552', '+234 810 986 7552'],
    ['011 44 7911 123456', '+447911123456', '+44 791 112 3456'],
    ['+7 912 345 6789', '+79123456789', '+7 912 345 6789'],
    ['6.17555E+09', '', ''],
    ['08109867552', '', ''],
    ['800-555-1234', '', ''],
    ['+1 617 555 20431', '', ''],
    ['+0123456789', '', ''],
  ];
  for (const [raw, e164, shown] of CASES) {
    ok(phone.normalize(raw) === e164 && phone.display(e164) === shown, `"${raw}" → ${e164 || 'not textable'}${shown ? ` (${shown})` : ''}`, { got: phone.normalize(raw), shown: phone.display(phone.normalize(raw)) });
  }
  ok(phone.tidy('  (617)  555-2043 ') === '+16175552043' && phone.tidy('6.17555E+09') === '6.17555E+09' && phone.tidy('') === '', 'kept: E.164 when textable, otherwise as given (tidied), so it can be fixed');

  const s = await W.start(284);
  const tel = (c) => (c ? c.phone : undefined);
  await W.seed(s, [
    W.person(1, { phone: '6.17555E+09' }),
    W.person(2, { phone: '+16175552002' }),
    W.person(3, { phone: '(617) 555-2003' }),
    W.person(4, { phone: '' }),
  ]);
  const people = (await s.store.load()).candidates;
  const P = Object.fromEntries(people.map((c) => [c.id, c]));

  // ---- importing ----
  const rows = [
    ['New Intl', 'new.intl@example.com', '2348109867552'],
    ['New Local', 'new.local@example.com', '(617) 555-2101'],
    ['New Decimal', 'new.decimal@example.com', '6175552102.0'],
    ['New Unreadable', 'new.unreadable@example.com', '08109867552'],
    [P.p1.name, P.p1.email, '(617) 555-2001'],
    [P.p2.name, P.p2.email, '(617) 555-2999'],
    [P.p3.name, P.p3.email, '617-555-2003'],
    [P.p4.name, P.p4.email, '+44 7911 123456'],
  ];
  const mapping = { name: 0, email: 1, phone: 2 };
  const pre = await s.json('POST', '/api/import/preview', { rows, mapping, headerless: true });
  const imp = await s.json('POST', '/api/import/commit', { rows, mapping, headerless: true, source: 'csv' });
  let db = await s.store.load();
  const by = (email) => db.candidates.find((c) => c.email === email);
  ok(imp.status === 200 && imp.body.added === 4, 'an import adds the four new people', imp.body);
  ok(tel(by('new.intl@example.com')) === '+2348109867552' && tel(by('new.local@example.com')) === '+16175552101' && tel(by('new.decimal@example.com')) === '+16175552102',
    'their numbers are kept one way: a dropped "+" and a ".0" undone', db.candidates.slice(-4).map(tel));
  ok(tel(by('new.unreadable@example.com')) === '08109867552', 'one that cannot be texted is kept as given, to be fixed', tel(by('new.unreadable@example.com')));
  db = await s.store.load();
  const now = Object.fromEntries(db.candidates.map((c) => [c.id, c]));
  ok(now.p1.phone === '+16175552001', 'already on the list with a number that cannot be texted: replaced by the good one from the file', now.p1.phone);
  ok(now.p2.phone === '+16175552002', 'already on the list with a good number: never swapped for a different one', now.p2.phone);
  ok(now.p3.phone === '(617) 555-2003', 'already on the list with the same number written another way: left alone', now.p3.phone);
  ok(now.p4.phone === '+447911123456', 'already on the list with no number: filled in', now.p4.phone);
  ok(imp.body.updated === 2 && pre.body.updatable === 2, 'the dry run and the import agree: two updated (the fix and the fill)', { pre: pre.body.updatable, updated: imp.body.updated });

  // ---- editing ----
  let r = await s.json('PATCH', '/api/candidates/p3', { phone: '617 555 2003 ' });
  db = await s.store.load();
  ok(r.status === 200 && db.candidates.find((c) => c.id === 'p3').phone === '+16175552003', 'an edit keeps the number one way', r.body && r.body.candidate && r.body.candidate.phone);
  const before = JSON.stringify((await s.store.load()).candidates);
  const card = db.candidates.find((c) => c.id === 'p3');
  r = await s.json('PATCH', '/api/candidates/p3', { name: card.name, firstName: card.firstName, lastName: card.lastName, role: card.role, company: card.company, location: card.location, notes: card.notes, phone: '(617) 555-2003', status: card.status });
  ok(r.status === 200 && JSON.stringify((await s.store.load()).candidates) === before, 'saving the whole card as the page shows it (a pretty number) changes nothing');
  r = await s.json('PATCH', `/api/candidates/${by('new.unreadable@example.com').id}`, { name: 'New Unreadable' });
  ok(r.status === 200 && (await s.store.load()).candidates.find((c) => c.email === 'new.unreadable@example.com').phone === '08109867552', 'an edit to something else leaves a number it cannot read exactly as it was');
  r = await s.json('POST', '/api/candidates', { name: 'Added By Hand', firstName: 'Added', lastName: 'Hand', email: 'added.hand@example.com', phone: '+234 810 986 7553' });
  ok(r.status === 200 && r.body.candidate.phone === '+2348109867553', 'someone added by hand: kept one way', r.body.candidate && r.body.candidate.phone);

  // ---- a queued text, then the number is corrected ----
  const textQueue = require(R('lib/text-queue.js'));
  db = await s.store.load();
  const q = await textQueue.loadQ();
  textQueue.enqueue(q, db, ['p2'], { body: 'Hi {{firstName}}' }, { ignoreQuietHours: true });
  ok(q.items.length === 1 && q.items[0].phone === '+16175552002', 'queued to the number they had', q.items);
  await s.json('PATCH', '/api/candidates/p2', { phone: '(617) 555-2088' });
  db = await s.store.load();
  const job = textQueue.claim(q, db, { render: (tpl) => tpl.body }).job;
  ok(job && job.phone === '+16175552088', 'the text goes to the corrected number, never the old one', job);
  textQueue.enqueue(q, db, ['p4'], { body: 'Hi' }, { ignoreQuietHours: true });
  await s.json('PATCH', '/api/candidates/p4', { phone: '' });
  db = await s.store.load();
  const none = textQueue.claim(q, db, { render: (tpl) => tpl.body });
  ok(!none.job && q.items.length === 0, 'and a number taken away leaves nothing to text', none);

  // ---- the page's check agrees with the server's ----
  const browser = await launch();
  try {
    const { ctx, page, errors } = await open(browser, s);
    await page.evaluate(() => document.querySelector('#addCandidateBtn').click());
    await page.waitForSelector('#addModal:not([hidden])');
    // The form puts the cursor in First name a moment after it opens; typing
    // in that moment lands in First name instead (nobody types that fast), so
    // each number is typed again until it is in the phone box.
    const typePhone = async (raw) => {
      for (let i = 0; i < 4; i++) {
        await page.fill('#addPhone', raw);
        if (await page.inputValue('#addPhone') === raw) return;
        await page.waitForTimeout(60);
      }
    };
    const seen = [];
    for (const [raw, e164, shown] of CASES) {
      await typePhone(raw);
      // The form may still be settling from opening: wait for the hint to
      // answer this number (every case here is one or the other).
      await page.waitForFunction(() => /^(Textable|Not a number)/.test(document.querySelector('#addPhoneHint').textContent), null, { timeout: 5000 }).catch(() => {});
      const hint = await page.$eval('#addPhoneHint', (el) => el.textContent);
      const want = e164 ? `Textable — will be saved as ${shown}.` : 'Not a number we can text.';
      if (!hint.startsWith(want)) seen.push({ raw, hint, want });
    }
    ok(seen.length === 0, 'the Edit form calls the same numbers textable, and shows them the same way', seen);
    await page.evaluate(() => document.querySelector('#addModal [data-close]').click());
    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  } finally {
    await browser.close();
    await s.close();
  }
  done();
})().catch(crash);
