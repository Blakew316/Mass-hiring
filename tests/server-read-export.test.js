// GET /api/candidates/export: the whole list as a spreadsheet of your own.
// The columns and their order, one row per person in list order, names split
// when only a full name is known, cells a spreadsheet would run as a formula
// defused, quotes, commas and line breaks kept intact, accents readable in
// Excel (byte-order mark, CRLF), a file named for the team and the day, never
// cached — and nothing the server keeps for itself.
const { startApp, ok, done, crash } = require('./helpers');
const { guardOutside, stubSenders, as, addTeam, daysAgo } = require('./server-read-helpers');

// A small CSV reader for checking: quoted fields, doubled quotes, CRLF.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

(async () => {
  const refused = guardOutside();
  const s = await startApp({ offset: 6 });
  const sent = stubSenders();
  const me = as(s, s.cookie);

  const added = daysAgo(30);
  const emailed = daysAgo(5);
  const texted = daysAgo(2);
  const replied = daysAgo(1);
  const bookedAt = daysAgo(-3);
  await s.store.update((d) => {
    d.candidates = [
      { id: 'x1', name: 'Ana Lucía Pérez', firstName: 'Ana Lucía', lastName: 'Pérez', email: 'ana.perez@example.com', phone: '(617) 555-3001', location: 'Boston, MA', role: 'Account Executive', company: 'Acme, Inc.',
        status: 'booked', notes: 'Said "yes" twice', source: 'csv', addedAt: added, lastEmailedAt: emailed, lastTextedAt: texted, lastReplyAt: replied, bookedAt,
        messageId: '<server-only@example.com>', sheetRow: 777, altEmails: ['ana.alt.server.only@example.com'], calendlyEventUri: 'https://api.calendly.com/scheduled_events/server-only', city: 'Server-Only-City' },
      { id: 'x2', name: 'Ben Carter Jones', email: 'ben@example.com', phone: '+1 617 555 3002', role: '=HYPERLINK("http://evil.example.com","click")', company: '@Corp', status: 'new', notes: 'line one\nline two', source: 'manual', addedAt: added },
      { id: 'x3', firstName: 'Cleo', email: 'cleo@example.com', status: 'emailed', notes: '-5 points', company: '+Plus Co', source: 'csv', addedAt: added },
      { id: 'x4', name: 'Dov', email: 'dov@example.com', status: 'new', source: 'csv', addedAt: added },
    ];
  });

  // Read as bytes: a text decoder would quietly drop the byte-order mark.
  const bytes = async (res) => Buffer.from(await res.arrayBuffer());
  const r = await me.call('GET', '/api/candidates/export');
  const raw = await bytes(r);
  const text = raw.toString('utf8');
  ok(r.status === 200, 'the export answers', r.status);
  ok(/^text\/csv; ?charset=utf-8$/i.test(r.headers.get('content-type') || ''), 'as a UTF-8 CSV', r.headers.get('content-type'));
  const today = new Date().toISOString().slice(0, 10);
  ok(r.headers.get('content-disposition') === `attachment; filename="Team-Maverick-candidates-${today}.csv"`, 'downloaded as a file named for the team and the day', r.headers.get('content-disposition'));
  ok(/no-store/.test(r.headers.get('cache-control') || ''), 'never cached', r.headers.get('cache-control'));
  ok(raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF, 'starts with a byte-order mark so Excel reads the accents', [...raw.subarray(0, 3)]);
  const outsideQuotes = text.replace(/"(?:[^"]|"")*"/g, '""');
  ok(text.endsWith('\r\n') && !/(^|[^\r])\n/.test(outsideQuotes), 'lines end CRLF, the file too');
  const rows = parseCsv(text.slice(1));
  ok(rows[0].join(',') === 'First Name,Last Name,Email,Phone,Location,Role,Company,Status,Notes,Source,Added,Last emailed,Last texted,Last reply,Booked', 'the columns, in order', rows[0]);
  ok(rows.length === 5, 'one row per person', rows.length);
  ok(JSON.stringify(rows[1]) === JSON.stringify(['Ana Lucía', 'Pérez', 'ana.perez@example.com', '(617) 555-3001', 'Boston, MA', 'Account Executive', 'Acme, Inc.', 'booked', 'Said "yes" twice', 'csv', added, emailed, texted, replied, bookedAt]),
    'every column of a full record, commas and quotes kept intact', rows[1]);
  ok(text.includes('"Boston, MA"') && text.includes('"Said ""yes"" twice"'), 'commas and quotes are quoted the CSV way');
  ok(rows[2][0] === 'Ben' && rows[2][1] === 'Carter Jones', 'a full name with no first/last is split at the first space', rows[2].slice(0, 2));
  ok(rows[2][5] === ' =HYPERLINK("http://evil.example.com","click")' && rows[2][6] === ' @Corp', 'a cell that would run as a formula gets a leading space', [rows[2][5], rows[2][6]]);
  ok(rows[2][3] === ' +1 617 555 3002', 'a number written with + is defused the same way', rows[2][3]);
  ok(rows[2][8] === 'line one\nline two', 'a line break inside a note stays inside its cell', rows[2][8]);
  ok(rows[2].slice(11).every((v) => v === ''), 'dates never set are empty', rows[2].slice(11));
  ok(rows[3][0] === 'Cleo' && rows[3][1] === '' && rows[3][8] === ' -5 points' && rows[3][6] === ' +Plus Co', 'a first name alone leaves the last name empty; - and + cells are defused', rows[3]);
  ok(rows[4][0] === 'Dov' && rows[4][1] === '', 'a single name is a first name', rows[4].slice(0, 2));
  ok(rows.slice(1).map((x) => x[2]).join() === 'ana.perez@example.com,ben@example.com,cleo@example.com,dov@example.com', 'in list order');
  const hidden = ['server-only@example.com', '777', 'ana.alt.server.only@example.com', 'server-only', 'Server-Only-City', 'x1', 'x2'];
  ok(hidden.every((h) => !text.includes(h)), 'nothing the server keeps for itself (message ids, sheet rows, other addresses, Calendly links, internal ids)', hidden.filter((h) => text.includes(h)));

  // Exporting changes nothing.
  const before = JSON.stringify((await s.store.load()).candidates);
  await me.call('GET', '/api/candidates/export').then((x) => x.text());
  ok(JSON.stringify((await s.store.load()).candidates) === before, 'exporting changes nothing');

  // An empty team exports only the header, named for itself.
  const B = await addTeam(s, { name: 'Team Ünïcode & Co', pin: '5937' });
  const rb = await B.call('GET', '/api/candidates/export');
  const tb = (await bytes(rb)).toString('utf8');
  ok(rb.status === 200 && tb === '﻿First Name,Last Name,Email,Phone,Location,Role,Company,Status,Notes,Source,Added,Last emailed,Last texted,Last reply,Booked\r\n', 'an empty list exports just the header', JSON.stringify(tb));
  // How accented letters are spelled in the name is not pinned (today they are
  // dropped: "Team-n-code-Co"); that the name is safe to save is.
  const m = /^attachment; filename="([A-Za-z0-9-]+)-candidates-(\d{4}-\d{2}-\d{2})\.csv"$/.exec(rb.headers.get('content-disposition') || '');
  ok(m && m[2] === today && /^Team-/.test(m[1]) && /-Co$/.test(m[1]), 'a team name with accents and symbols still gives a plain, safe file name for the team and the day', rb.headers.get('content-disposition'));

  ok(sent.count() === 0, 'nothing was sent', sent);
  ok(refused.length === 0, 'nothing reached outside this machine', refused);
  await s.close();
  done();
})().catch(crash);
