// The Import page, on a laptop and on a phone: rows pasted from a spreadsheet
// are previewed (columns recognised, the first rows shown), counted before
// anything happens (new, already on the list, repeated in the paste, without
// an email — with the row named), and importing adds exactly the new people,
// with their details, says what it did, and leads to them on Candidates.
const { startApp, launch, ok, done, crash } = require('./helpers');
const { stubEverything, open, text, texts, waitIn, waitText, until, go, person } = require('./views-helpers');

const PASTE = [
  'Name,Email,Phone,Title,Company',
  'Ivan Import,ivan.import@example.com,(617) 555-0141,Account Executive,Example One',
  'Jen Import,jen.import@example.com,(617) 555-0142,Sales Rep,Example Two',
  'Ken Import,ken.import@example.com,,SDR,Example Three',
  'Existing Person,existing.person@example.com,(617) 555-0144,AE,Example Co',
  'Jen Import,JEN.IMPORT@example.com,(617) 555-0142,Sales Rep,Example Two',
  'Nobody Mailable,,(617) 555-0143,AE,Example Four',
].join('\n');
const PASTE_PHONE = [
  'Name,Email,Phone,Title,Company',
  'Lia Phone,lia.phone@example.com,(617) 555-0151,Account Executive,Example Five',
  'Max Phone,max.phone@example.com,(617) 555-0152,Closer,Example Six',
  'Ivan Import,ivan.import@example.com,(617) 555-0141,Account Executive,Example One',
].join('\n');

(async () => {
  const s = await startApp({ offset: 145 });
  const rec = stubEverything();
  await s.store.update((d) => {
    d.candidates = [person('x1', 'Existing Person', { phone: '(617) 555-0144', role: 'AE', company: 'Example Co', location: 'Boston, MA' })];
  });
  const names = async () => (await s.store.load()).candidates.map((c) => c.name);

  const browser = await launch();
  for (const phone of [false, true]) {
    const tag = phone ? 'phone' : 'laptop';
    const { ctx, page, errors } = await open(browser, s, { phone });
    if (phone) {
      await page.click('#navMore');
      await page.waitForSelector('#moreSheet:not([hidden])');
      const more = await texts(page, '#moreSheetButtons .more-label');
      ok(more.includes('Import'), `${tag}: Import is under More`, more);
      await page.click('#moreSheetButtons [data-more="import"]');
    } else {
      await page.click('.nav-item[data-view="import"]');
    }
    await page.waitForSelector('#view-import.active');
    await page.click('#view-import .paste-details summary');
    await page.fill('#pasteBox', phone ? PASTE_PHONE : PASTE);
    await page.click('#pasteImportBtn');
    await page.waitForSelector('#mappingCard:not([hidden])');

    const rowsIn = phone ? 3 : 6;
    ok(await text(page, '#previewCount') === `${rowsIn} rows · pasted rows`, `${tag}: the preview counts the pasted rows`, await text(page, '#previewCount'));
    const heads = await texts(page, '#previewTable thead th');
    ok(JSON.stringify(heads) === JSON.stringify(['Name', 'Email', 'Phone', 'Title', 'Company']), `${tag}: with the pasted columns`, heads);
    ok((await texts(page, '#previewTable tbody tr')).length === Math.min(5, rowsIn), `${tag}: and the first rows`);
    const mapped = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.map-select')].map((s) => [s.dataset.key, s.options[s.selectedIndex].textContent])));
    ok(mapped.email === 'Email' && mapped.name === 'Name' && mapped.phone === 'Phone' && mapped.role === 'Title' && mapped.company === 'Company',
      `${tag}: the columns are recognised`, mapped);

    if (!phone) {
      ok(await waitText(page, '#importSummary .summary-line', '6 rows: 3 new · 1 already in your list · 1 repeated in the file · 1 without a usable email'),
        `${tag}: what the import would do, before it does it`, await text(page, '#importSummary'));
      ok(/Row 7 \(Nobody Mailable\): no email address in the row/.test(await text(page, '#importSummary')), `${tag}: naming the row without an email`, await text(page, '#importSummary'));
      ok(await waitText(page, '#commitImportBtn', 'Import 3 candidates'), `${tag}: the button says how many will be added`, await text(page, '#commitImportBtn'));
      ok(JSON.stringify(await names()) === JSON.stringify(['Existing Person']), `${tag}: nothing is added before Import is pressed`);
      await page.click('#commitImportBtn');
      ok(await waitIn(page, () => !document.querySelector('#importResult').hidden), `${tag}: the import reports back`);
      ok(/3 added · 1 already in your list · 1 repeated in the file · 1 without a usable email · your list now has 4 candidates/.test(await text(page, '#importResult')),
        `${tag}: saying what it did`, await text(page, '#importResult'));
      const after = (await s.store.load()).candidates;
      ok(JSON.stringify(after.map((c) => c.name)) === JSON.stringify(['Existing Person', 'Ivan Import', 'Jen Import', 'Ken Import']), `${tag}: exactly the new people were added, once each`, after.map((c) => c.name));
      const ivan = after.find((c) => c.email === 'ivan.import@example.com') || {};
      ok(ivan.status === 'new' && ivan.role === 'Account Executive' && ivan.company === 'Example One' && /555.?0141/.test(ivan.phone || ''), `${tag}: with their details, not contacted`, ivan);
      ok(after.find((c) => c.id === 'x1').location === 'Boston, MA', `${tag}: the person already there is untouched`);
      await page.click('#viewCandidatesBtn');
      await page.waitForSelector('#view-candidates.active');
      ok(await waitText(page, '#candCount', '4 candidates'), `${tag}: View candidates shows the whole list`, await text(page, '#candCount'));
      const first = await page.evaluate(() => [...document.querySelectorAll('#candidateRows tr[data-id]')].slice(0, 3).map((r) => r.querySelector('[data-col="email"]').textContent.trim()).sort());
      ok(JSON.stringify(first) === JSON.stringify(['ivan.import@example.com', 'jen.import@example.com', 'ken.import@example.com']), `${tag}: newest first, the people just imported on top`, first);
      await go(page, 'dashboard');
      ok(await waitText(page, '#statTotal', '4'), `${tag}: the Dashboard count follows`, await text(page, '#statTotal'));
    } else {
      ok(await waitText(page, '#importSummary .summary-line', '3 rows: 2 new · 1 already in your list'), `${tag}: what the import would do`, await text(page, '#importSummary'));
      ok(await waitText(page, '#commitImportBtn', 'Import 2 candidates'), `${tag}: the button says how many`, await text(page, '#commitImportBtn'));
      await page.click('#commitImportBtn');
      ok(await waitIn(page, () => !document.querySelector('#importResult').hidden), `${tag}: the import reports back`);
      ok(/2 added · 1 already in your list · your list now has 6 candidates/.test(await text(page, '#importResult')), `${tag}: saying what it did`, await text(page, '#importResult'));
      ok(await until(async () => (await names()).length === 6), `${tag}: the two were added`, await names());
      ok((await names()).filter((n) => n === 'Ivan Import').length === 1, `${tag}: and nobody twice`);
    }
    ok(errors.length === 0, `${tag}: no page errors`, errors);
    await ctx.close();
  }

  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await browser.close();
  await s.close();
  done();
})().catch(crash);
