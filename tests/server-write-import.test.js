// Importing a CSV: reading the file (POST /api/import/csv), the dry run
// (POST /api/import/preview) and the import itself (POST /api/import/commit),
// sent the way the Import page sends them.
//
// Intentions pinned here, from the code's own comments:
//   - the dry run's numbers are the numbers the import gets
//   - a new address is added as a new candidate; an address already on the
//     list (in any capitals, or any Gmail spelling) is that person, not a
//     second one; the same address twice in one file is one person
//   - someone already on the list only has blank fields filled in, never a
//     typed one overwritten, and not even that when "update existing" is off
//   - the same person under another address is recognised by phone and name,
//     but two different people sharing a number stay two people
//   - importing the same file again adds nobody
const { ok, done, crash } = require('./helpers');
const W = require('./server-write-helpers');

(async () => {
  const s = await W.start(70);
  await W.seed(s, [
    W.person(2, { status: 'emailed', role: '', company: 'Old Co', location: '', lastEmailedAt: W.ago(3000) }),
    W.person(9, { name: 'Pat Example', firstName: 'Pat', lastName: 'Example', email: 'pat.example@gmail.com', status: 'replied', phone: '' }),
    W.person(6, { phone: '(617) 555-2209', status: 'emailed', lastEmailedAt: W.ago(3000) }),
  ]);
  const file = [
    'First Name,Last Name,Email,Phone,Title,Company,Location',
    'Avery,Quinn,avery.quinn@example.com,(617) 555-2201,Account Executive,Example Payments,"Boston, MA"',
    'Jordan,Blake,JORDAN.BLAKE@EXAMPLE.COM,(617) 555-2202,Sales Manager,Example Co,',
    'Casey,Morgan,casey.morgan@example.com,,SDR,Example Inc,',
    'Casey,Morgan,casey.morgan@example.com,,SDR,Example Inc,',
    'Riley,Parker,not-an-email,,AE,Example LLC,',
    'Pat,Example,patexample+jobs@gmail.com,,Closer,Example Goods,',
    'Morgan,Ellis,morgan.e@example.org,(617) 555-2209,Account Executive,Example Payments,',
    'Taylor,Ellis,taylor.ellis@example.org,(617) 555-2209,Sales Rep,Example Payments,',
  ].join('\n');

  // ---------- reading the file ----------
  let r = await s.json('POST', '/api/import/csv', { text: file, via: 'csv' });
  ok(r.status === 200 && r.body.rows.length === 8 && r.body.headers[2] === 'Email', 'the file is read: a header and eight rows', r.body && { headers: r.body.headers, rows: r.body.rows && r.body.rows.length });
  const m = r.body.mapping;
  ok(m.firstName === 0 && m.lastName === 1 && m.email === 2 && m.phone === 3 && m.role === 4 && m.company === 5 && m.location === 6, 'each column is recognised', m);
  const { rows, lines, headerless } = r.body;
  const sent = { rows, lines, headerless, mapping: m };
  ok(W.same((await W.stored(s)).candidates.length, 3), 'reading a file adds nobody');

  // ---------- the dry run ----------
  const snap = await W.everything(s);
  r = await s.json('POST', '/api/import/preview', sent);
  const p = r.body;
  ok(r.status === 200 && p.total === 8 && p.newCount === 3 && p.existing === 3 && p.duplicate === 1 && p.invalid === 1, 'the dry run sorts the rows: 3 new, 3 already on the list, 1 repeat, 1 without an address', p);
  ok(p.existingByPhone === 1 && p.updatable === 1 && p.newAddresses === 1, 'one found by phone, one with blanks to fill, one bringing a new address', p);
  ok(p.invalidSamples.length === 1 && p.invalidSamples[0].row === 6 && p.invalidSamples[0].name === 'Riley Parker', 'the row without an address is named by its line in the file', p.invalidSamples);
  ok(p.existingSamples.some((e) => e.name === 'Jordan Blake'), 'and who is already on the list', p.existingSamples);
  ok(W.same(await W.everything(s), snap), 'the dry run changes nothing');

  // ---------- the import ----------
  r = await s.json('POST', '/api/import/commit', { ...sent, source: 'csv', updateExisting: true });
  ok(r.status === 200 && r.body.ok && r.body.added === p.newCount && r.body.updated === 2, 'the import adds exactly what the dry run said', r.body);
  ok(['total', 'newCount', 'existing', 'duplicate', 'invalid'].every((k) => r.body[k] === p[k]), 'and reports the same numbers', r.body);
  const db = await W.stored(s);
  const byEmail = (e) => db.candidates.filter((c) => c.email === e);
  ok(db.candidates.length === 6, 'the list grows by three', db.candidates.length);
  const avery = byEmail('avery.quinn@example.com')[0];
  ok(avery && avery.status === 'new' && avery.source === 'csv' && avery.firstName === 'Avery' && avery.lastName === 'Quinn' && avery.name === 'Avery Quinn'
    && avery.phone === '(617) 555-2201' && avery.role === 'Account Executive' && avery.company === 'Example Payments' && avery.location === 'Boston, MA' && avery.addedAt,
  'a new person is added as new, with every column', avery);
  ok(byEmail('casey.morgan@example.com').length === 1, 'the same address twice in one file is one person');
  ok(!db.candidates.some((c) => /riley/i.test(c.name || '')), 'a row without an address is not added');
  const jordan = W.pick(db.candidates, 'p2');
  ok(jordan.email === 'jordan.blake@example.com' && jordan.status === 'emailed' && jordan.role === 'Sales Manager' && jordan.company === 'Old Co',
    'someone already on the list keeps their address and status, gets blanks filled, and keeps what was typed', jordan);
  const pat = W.pick(db.candidates, 'p9');
  ok(pat.email === 'pat.example@gmail.com' && pat.status === 'replied' && !byEmail('patexample+jobs@gmail.com').length, 'a Gmail spelling of an address on the list is that person', pat);
  const morgan = W.pick(db.candidates, 'p6');
  ok(morgan.email === 'morgan.ellis@example.com' && morgan.name === 'Morgan Ellis' && !byEmail('morgan.e@example.org').length, 'the same name on the same number is the same person, under their own address', morgan);
  const taylor = byEmail('taylor.ellis@example.org')[0];
  ok(taylor && taylor.status === 'new' && taylor.phone === '(617) 555-2209', 'a different person on a shared number is added as someone new', taylor);
  r = await s.json('POST', '/api/candidates', { firstName: 'Morgan', lastName: 'Ellis', email: 'morgan.e@example.org' });
  ok(r.status === 400, 'the address the file brought for someone already on the list is now known as theirs', r);
  const st = await W.state(s);
  ok(st.stats.total === 6 && st.stats.new === 3 && W.pick(st.candidates, 'p2').role === 'Sales Manager', 'the page reads the imported list', st.stats);

  // ---------- the same file again ----------
  const again = await W.everything(s);
  r = await s.json('POST', '/api/import/preview', sent);
  ok(r.body.newCount === 0 && r.body.existing === 6 && r.body.duplicate === 1 && r.body.invalid === 1 && r.body.updatable === 0, 'a second dry run of the same file finds everyone already there', r.body);
  r = await s.json('POST', '/api/import/commit', { ...sent, source: 'csv', updateExisting: true });
  ok(r.body.added === 0 && r.body.updated === 0, 'importing the same file again adds and changes nobody', r.body);
  ok(W.same((await W.stored(s)).candidates, again.db.candidates), 'and leaves the list exactly as it was');

  // ---------- "update existing" off ----------
  r = await s.json('POST', '/api/import/csv', { text: 'Email,First Name,Last Name,Location\njordan.blake@example.com,Jordan,Blake,"Chicago, IL"\n', via: 'csv' });
  const small = { rows: r.body.rows, lines: r.body.lines, headerless: r.body.headerless, mapping: r.body.mapping };
  r = await s.json('POST', '/api/import/preview', small);
  ok(r.body.existing === 1 && r.body.updatable === 1, 'the dry run sees a blank it could fill', r.body);
  r = await s.json('POST', '/api/import/commit', { ...small, source: 'csv', updateExisting: false });
  ok(r.body.added === 0 && r.body.updated === 0 && W.pick((await W.stored(s)).candidates, 'p2').location === '', 'with "update existing" off, nobody on the list is changed', r.body);
  r = await s.json('POST', '/api/import/commit', { ...small, source: 'csv' });
  ok(r.body.updated === 1 && W.pick((await W.stored(s)).candidates, 'p2').location === 'Chicago, IL', 'with it on (the default), the blank is filled', r.body);

  // ---------- refusals ----------
  const last = await W.everything(s);
  r = await s.json('POST', '/api/import/commit', { rows: [], mapping: m });
  ok(r.status === 400 && /nothing to import/i.test(r.body.error), 'an empty import is refused', r);
  r = await s.json('POST', '/api/import/csv', { text: '\n\n' });
  ok(r.status === 400 && /empty/i.test(r.body.error), 'an empty file is refused with a reason', r);
  ok(W.same(await W.everything(s), last), 'and neither changes anything');

  ok(s.outsideCalls.length === 0 && s.sentMail.length === 0 && s.pushes.length === 0, 'nothing reached the outside world', s.outsideCalls);
  await s.close();
  done();
})().catch(crash);
