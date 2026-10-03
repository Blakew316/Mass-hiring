// The Hiring pages, on a laptop and on a phone, for lists made up for the
// test: Sales IQ draws its candidates (status and score), its tiles count
// them, its filters narrow the list, its reports are listed, and a person
// added on the server appears when the page looks again; Onboarding docs
// draws its pipeline grouped by how people came, with where each packet is,
// its tiles, and the signed list. On a phone both are reached from the Hiring
// tab and its switch.
const { startApp, launch, ok, done, crash, ago, R } = require('./helpers');
const { stubEverything, open, text, texts, cells, waitIn, poke, person } = require('./views-helpers');

const DAY = 1440;
const hire = (id, name, email, label, crmId) => ({
  id, local: true, appliedDate: '2026-09-20', startDate: '',
  applicant: { firstName: name.split(' ')[0], lastName: name.split(' ')[1], email, phoneNumber: '(617) 555-0160' },
  job: { title: { label: 'Account Executive' } }, status: { id: 'local', label }, ...(crmId ? { crmId } : {}),
});

(async () => {
  const s = await startApp({ offset: 150 });
  const rec = stubEverything();
  const salesiq = require(R('lib/salesiq.js'));
  const onboarding = require(R('lib/onboarding.js'));
  await s.store.update((d) => {
    d.candidates = [person('h1', 'Vic Pipeline'), person('h2', 'Wes Sent'), person('h3', 'Xan Signed')];
  });
  const seedIq = () => salesiq.update((doc) => {
    doc.candidates = [
      { id: 'cq1', name: 'Quinn Added', email: 'quinn.added@example.com', phone: '(617) 555-0171', status: 'added', added: ago(DAY), source: 'manual' },
      { id: 'cq2', name: 'Rae Added', email: 'rae.added@example.com', status: 'added', added: ago(2 * DAY), source: 'manual' },
      { id: 'cq3', name: 'Sol Invited', email: 'sol.invited@example.com', status: 'invited', invitedAt: ago(DAY), added: ago(3 * DAY), source: 'manual' },
      { id: 'cq4', name: 'Tia Done', email: 'tia.done@example.com', status: 'completed', score: 88, completedAt: ago(600), added: ago(4 * DAY), source: 'manual' },
      { id: 'cq5', name: 'Uma Done', email: 'uma.done@example.com', status: 'completed', score: 55, completedAt: ago(900), added: ago(5 * DAY), source: 'manual' },
    ];
    doc.reports = [
      { id: 'r0000000000000000a1', candidateId: 'cq4', name: 'Tia Done', email: 'tia.done@example.com', score: 88, tier: 'Elite Talent', tierKey: 'elite', categories: [], durationSec: 640, completedAt: ago(600) },
      { id: 'r0000000000000000a2', candidateId: 'cq5', name: 'Uma Done', email: 'uma.done@example.com', score: 55, tier: 'Developing', tierKey: 'develop', categories: [], durationSec: 720, completedAt: ago(900) },
    ];
    doc.settings = { team: '', managerEmail: 'manager@example.com' };
  });
  await seedIq();
  await onboarding.update((doc) => {
    doc.candidates = [
      hire('hire-1', 'Vic Pipeline', 'vic.pipeline@example.com', 'Added', 'h1'),
      hire('hire-2', 'Wes Sent', 'wes.sent@example.com', 'Added', 'h2'),
      hire('hire-3', 'Xan Signed', 'xan.signed@example.com', 'Added', 'h3'),
      hire('hire-4', 'Yul Uploaded', 'yul.uploaded@example.com', 'Uploaded'),
    ];
    doc.sends = [{ id: 'wes.sent@example.com', email: 'wes.sent@example.com', sentAt: ago(DAY) }];
    doc.hires = [{ id: 'WPI-H1', reference: 'WPI-H1', email: 'xan.signed@example.com', firstName: 'Xan', lastName: 'Signed', signedAt: ago(300), signedDate: '2026-10-02', files: [] }];
  });

  const roster = (page) => page.evaluate(() => [...document.querySelectorAll('#siq-roster-list .cand-row')].map((r) => `${r.querySelector('.row-name').textContent.trim()} | ${r.querySelector('.status-chip').textContent.trim()}`));
  const iqStats = (page) => page.evaluate(() => ['upcoming', 'added', 'invited', 'completed'].map((k) => document.querySelector(`#siq-stat-${k}`).textContent.trim()).join(' '));

  const browser = await launch();
  for (const phone of [false, true]) {
    const tag = phone ? 'phone' : 'laptop';
    await seedIq();
    const { ctx, page, errors } = await open(browser, s, { phone });

    // ---- Sales IQ ----
    if (phone) {
      await page.click('.nav-group[data-group="hiring"]');
    } else {
      await page.click('.nav-item[data-view="salesiq"]');
    }
    await page.waitForSelector('#view-salesiq.active');
    ok(await waitIn(page, () => document.querySelectorAll('#siq-roster-list .cand-row').length === 5), `${tag}: Sales IQ draws its list`, await roster(page));
    ok(JSON.stringify(await roster(page)) === JSON.stringify([
      'Quinn Added | Not sent', 'Rae Added | Not sent', 'Sol Invited | Sent', 'Tia Done | Completed · 88/100', 'Uma Done | Completed · 55/100',
    ]), `${tag}: each with where they are and their score`, await roster(page));
    ok(await iqStats(page) === '0 2 1 2', `${tag}: the tiles count upcoming, not sent, sent and completed`, await iqStats(page));
    ok(await text(page, '#siq-cand-count') === '5', `${tag}: and the list says 5`, await text(page, '#siq-cand-count'));
    const reports = await page.evaluate(() => [...document.querySelectorAll('#siq-report-list .row-name')].map((n) => n.textContent.trim()));
    ok(JSON.stringify(reports) === JSON.stringify(['Tia Done', 'Uma Done']), `${tag}: the reports are listed`, reports);
    await page.click('#siq-cand-filter [data-filter="completed"]');
    ok(JSON.stringify(await roster(page)) === JSON.stringify(['Tia Done | Completed · 88/100', 'Uma Done | Completed · 55/100']), `${tag}: Done shows only those who finished`, await roster(page));
    await page.click('#siq-stats [data-stat="added"]');
    ok(JSON.stringify(await roster(page)) === JSON.stringify(['Quinn Added | Not sent', 'Rae Added | Not sent']), `${tag}: the Not sent tile filters to them`, await roster(page));
    await page.click('#siq-cand-filter [data-filter="all"]');
    ok((await roster(page)).length === 5, `${tag}: All shows everyone again`);

    // Somebody added elsewhere appears when the page looks again.
    await salesiq.update((doc) => { doc.candidates.unshift({ id: 'cq6', name: 'Zed Newcomer', email: 'zed.newcomer@example.com', status: 'added', added: new Date().toISOString(), source: 'manual' }); });
    await poke(page);
    ok(await waitIn(page, () => document.querySelectorAll('#siq-roster-list .cand-row').length === 6), `${tag}: a person added elsewhere appears on the next look`, await roster(page));
    ok((await roster(page))[0] === 'Zed Newcomer | Not sent', `${tag}: at the top`, (await roster(page))[0]);
    ok(await iqStats(page) === '0 3 1 2', `${tag}: and is counted`, await iqStats(page));

    // ---- Onboarding docs ----
    if (phone) {
      ok(await page.isVisible('#view-salesiq .group-tab[data-goto="onboarding"]'), `${tag}: the Hiring page switches between Sales IQ and Onboarding docs`);
      await page.click('#view-salesiq .group-tab[data-goto="onboarding"]');
    } else {
      await page.click('.nav-item[data-view="onboarding"]');
    }
    await page.waitForSelector('#view-onboarding.active');
    ok(await waitIn(page, () => document.querySelectorAll('#wh-pipeline-board .candidate-card').length === 4), `${tag}: Onboarding docs draws its pipeline`, await texts(page, '#wh-pipeline-board .candidate-name'));
    const stages = await page.evaluate(() => [...document.querySelectorAll('#wh-pipeline-board .stage')].map((st) =>
      `${st.querySelector('.stage-name').textContent.trim()} ${st.querySelector('.stage-count').textContent.trim()}: ${[...st.querySelectorAll('.candidate-name')].map((n) => n.textContent.trim()).join(', ')}`));
    ok(JSON.stringify(stages) === JSON.stringify(['Added 3: Vic Pipeline, Wes Sent, Xan Signed', 'Uploaded 1: Yul Uploaded']), `${tag}: grouped by how they came, added from Candidates first`, stages);
    const meta = (id) => page.evaluate((x) => document.querySelector(`#wh-pipeline-board .candidate-card[data-id="${x}"] .candidate-meta`).textContent.replace(/\s+/g, ' ').trim(), id);
    ok(/Packet sent .* awaiting signature/.test(await meta('hire-2')), `${tag}: a sent packet says it is awaiting signature`, await meta('hire-2'));
    ok(/Paperwork signed/.test(await meta('hire-3')), `${tag}: a signed one says so`, await meta('hire-3'));
    ok(!/Packet sent|Paperwork signed/.test(await meta('hire-1')), `${tag}: one not sent says neither`, await meta('hire-1'));
    const stats = await page.evaluate(() => [...document.querySelectorAll('#wh-pipeline-stats .stat')].map((st) => `${st.querySelector('.wh-stat-value').textContent.trim()} ${st.querySelector('.label-full').textContent.trim()}`));
    ok(JSON.stringify(stats) === JSON.stringify(['4 Candidates', '2 Packets sent', '1 Awaiting signature', '1 Signed & complete']), `${tag}: its tiles count them`, stats);
    const signed = await texts(page, '#wh-signed-list .signed-name');
    ok(JSON.stringify(signed) === JSON.stringify(['Xan Signed']), `${tag}: the signed list has the one who signed`, signed);

    // The Dashboard's trackers agree with both pages.
    await page.evaluate(() => document.querySelector('.nav-item[data-view="dashboard"]').click());
    await page.waitForSelector('#view-dashboard.active');
    const iq = await cells(page, '#iqTrackerGrid .today-cell');
    ok(JSON.stringify(iq) === JSON.stringify(['6 On Sales IQ', '3 Not sent', '1 Awaiting results', '2 Completed']), `${tag}: the Dashboard's Sales IQ tracker agrees`, iq);
    const onb = await cells(page, '#onbTrackerGrid .today-cell');
    ok(JSON.stringify(onb) === JSON.stringify(['4 On the pipeline', '2 Packet not sent', '1 Awaiting signature', '1 Signed']), `${tag}: and the Onboarding docs one`, onb);

    // The Hiring tab goes back to the one of the two last open.
    if (phone) {
      await page.click('.nav-group[data-group="hiring"]');
      ok(await waitIn(page, () => Boolean(document.querySelector('#view-onboarding.active'))), `${tag}: the Hiring tab returns to Onboarding docs, the last one open`);
    }

    ok(errors.length === 0, `${tag}: no page errors`, errors);
    await ctx.close();
  }

  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await browser.close();
  await s.close();
  done();
})().catch(crash);
