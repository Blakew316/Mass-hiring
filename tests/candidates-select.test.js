// Candidates page on a laptop: ticking people. One box, the page's box, and
// Clear; what the selection bar says (how many, how many can be texted, how
// many can go to Sales IQ / Onboarding docs) and what its buttons do. Ticking
// the page's box takes that page only. Narrowing the list drops whoever falls
// outside it, and says so, so nobody hidden can be emailed or texted.
// Email and Text only open their windows here — nothing is sent: the send
// routes are blocked in the browser and the mailer refuses on the server.
const { R, launch, openPage, ok, done, crash } = require('./helpers');
const H = require('./candidates-helpers');

(async () => {
  const s = await H.startCandidates(86);
  const P = s.people;
  const B = s.byId;
  const page1 = P.slice(0, 50);
  const browser = await launch();
  const { ctx, page, errors } = await openPage(browser, s, { path: '/#candidates' });
  const sendCalls = [];
  for (const path of ['**/api/send', '**/api/queue', '**/api/texts/queue', '**/api/texts/reply', '**/api/emails/reply', '**/api/iq/invite', '**/api/iq/from-pipeline', '**/api/onboarding/send']) {
    await page.route(path, (route) => { sendCalls.push(route.request().url()); route.abort(); });
  }
  await H.openCandidates(page);

  const bar = async () => (await page.$eval('#selectionBar', (el) => el.hidden)) ? null : page.$eval('#selectionBar', (el) => {
    const t = (sel) => el.querySelector(sel).textContent.replace(/\s+/g, ' ').trim();
    const d = (sel) => el.querySelector(sel).disabled;
    return { count: t('#selCount'), email: t('#selEmailBtn'), text: t('#selTextBtn'), textOff: d('#selTextBtn'), bothOff: d('#selBothBtn'),
      iq: t('#selIqBtn'), iqOff: d('#selIqBtn'), onb: t('#selOnbBtn'), onbOff: d('#selOnbBtn'), note: t('#selNote') };
  });
  const tick = (id) => page.click(`#candidateRows tr[data-id="${id}"] .row-check`);
  const checked = () => page.$$eval('#candidateRows tr', (trs) => trs.filter((tr) => tr.querySelector('.row-check').checked).map((tr) => tr.dataset.id));
  const allBox = () => page.$eval('#checkAll', (el) => el.checked);
  const toastTexts = async () => (await H.toasts(page)).map((t) => t.text);
  // The bar once it says `count` selected (null: once it has gone).
  const barAt = (count) => H.settle(page, async () => { const b = await bar(); return b && b.count; }, count).then(() => bar());
  const clear = async () => { if (!(await page.$eval('#selectionBar', (el) => el.hidden))) await page.click('#selClearBtn'); await barAt(null); };

  ok(await bar() === null, 'no selection bar until somebody is ticked');

  // ---- one, two, and the wording ----
  await tick('e34');
  let b = await barAt('1 selected');
  ok(b && b.count === '1 selected' && b.email === 'Email 1' && b.text === 'Text 1' && !b.textOff && !b.bothOff && b.note === '', 'one ticked: "1 selected", Email 1, Text 1', b);
  ok(b.iq === 'Add 1 to Sales IQ' && !b.iqOff && b.onb === 'Add 0 to Onboarding docs' && b.onbOff, 'already in Onboarding docs: only Sales IQ is offered', b);
  await tick('n01');
  b = await barAt('2 selected');
  ok(b.count === '2 selected' && b.email === 'Email 2' && b.text === 'Text 1' && b.note === '1 of them have no number', 'two ticked, one with no number: Text 1, and the note says why', b);
  ok(b.iq === 'Add 2 to Sales IQ' && b.onb === 'Add 1 to Onboarding docs' && !b.onbOff, 'and the Sales IQ / Onboarding counts', b);
  await tick('e34');
  b = await barAt('1 selected');
  ok(b.count === '1 selected' && b.text === 'Text 0' && b.textOff && b.bothOff && b.note === 'None of these have a phone number yet', 'only someone with no number: Text and Email + text are off, and it says why', b);
  await page.click('#selClearBtn');
  ok(await barAt(null) === null && (await checked()).length === 0, 'Clear: the bar goes and every box is empty');

  // ---- the page's box: this page only ----
  await page.check('#checkAll');
  const okN = page1.filter((c) => H.phoneKind(c) === 'ok').length;
  const iqN = page1.filter((c) => !H.IQ_IDS.includes(c.id)).length;
  const onbN = page1.filter((c) => !H.ONB_IDS.includes(c.id)).length;
  b = await barAt('50 selected');
  ok(b.count === '50 selected' && (await checked()).length === 50 && await allBox(), 'the page\'s box ticks the fifty on this page', b.count);
  ok(b.text === `Text ${okN}` && b.note === `${50 - okN} of them have no number`, `Text ${okN} of the 50`, b);
  ok(b.iq === `Add ${iqN} to Sales IQ` && b.onb === `Add ${onbN} to Onboarding docs`, 'Sales IQ / Onboarding count those not already there', b);
  await page.click('#pagerNext');
  await page.waitForFunction(() => document.querySelector('#pagerPage').textContent === 'Page 2 of 3');
  ok((await checked()).length === 0 && !(await allBox()) && (await bar()).count === '50 selected', 'page 2: nothing on it is ticked, and the 50 stay selected');
  // One of the team's own people: never to Sales IQ or Onboarding docs.
  ok(B.e40.email.endsWith('@wholesalepayments.com') && (await H.rowIds(page)).includes('e40'), 'one of the team is on page 2');
  await tick('e40');
  b = await barAt('51 selected');
  ok(b.count === '51 selected' && b.email === 'Email 51' && b.iq === `Add ${iqN} to Sales IQ` && b.onb === `Add ${onbN} to Onboarding docs`, 'ticking them counts for Email, not for Sales IQ or Onboarding docs', b);
  await page.click('#pagerPrev');
  await page.waitForFunction(() => document.querySelector('#pagerPage').textContent === 'Page 1 of 3');
  ok((await checked()).length === 50 && await allBox(), 'back on page 1, its fifty are still ticked');
  await page.uncheck('#checkAll');
  b = await barAt('1 selected');
  ok(b.count === '1 selected' && (await checked()).length === 0, 'unticking the page\'s box lets go of this page only', b.count);
  ok(b.iq === 'Add 0 to Sales IQ' && b.iqOff && b.onb === 'Add 0 to Onboarding docs' && b.onbOff, 'with only the team member left, both are off', b);
  ok(await page.$eval('#selIqBtn', (el) => el.title) === 'Everyone selected is on Sales IQ already (or has no email)', 'and the button says why');
  const direct = await s.json('POST', '/api/iq/add-from-pipeline', { ids: ['e40'] });
  ok(direct.body && direct.body.added.length === 0 && direct.body.refused.length === 1, 'asked directly, the server refuses them too', direct.body);
  await clear();

  // ---- narrowing the list drops whoever falls outside, and says so ----
  await page.check('#checkAll');
  const emailedOnPage1 = page1.filter((c) => c.status === 'emailed').length;
  await page.selectOption('#stageFilter', 'emailed');
  b = await barAt(`${emailedOnPage1} selected`);
  const gone = 50 - emailedOnPage1;
  ok(b.count === `${emailedOnPage1} selected`, `filtering to Emailed keeps the ${emailedOnPage1} still on screen`, b.count);
  ok((await toastTexts()).includes(`${gone} selected people fell outside this filter and are no longer selected.`), 'and says how many fell outside', await toastTexts());
  await page.selectOption('#stageFilter', 'all');
  await H.settle(page, H.countText, '150 candidates');
  ok((await bar()).count === `${emailedOnPage1} selected`, 'widening the list again does not bring them back');
  await clear();
  await tick('e34');
  await barAt('1 selected');
  await tick('n01');
  await barAt('2 selected');
  await page.selectOption('#stageFilter', 'emailed');
  ok((await barAt('1 selected')).count === '1 selected' && (await toastTexts()).includes('1 selected person fell outside this filter and is no longer selected.'), 'one falling outside is said in the singular', await toastTexts());
  await page.selectOption('#stageFilter', 'all');
  await H.settle(page, H.countText, '150 candidates');
  // Other menus narrow the same way.
  await page.selectOption('#textedFilter', 'nonumber');
  ok(await barAt(null) === null, 'a texting filter that hides them lets them go too');
  await page.selectOption('#textedFilter', '');
  await H.settle(page, H.countText, '150 candidates');

  // The order is not a filter: a selection survives it.
  await tick('e34');
  await barAt('1 selected');
  await page.selectOption('#sortBy', 'name');
  await H.settle(page, async () => (await H.rowNames(page))[0], 'Avery Ashdown');
  ok((await bar()).count === '1 selected', 'changing the order keeps the selection');
  await page.selectOption('#sortBy', 'default');
  ok(JSON.stringify(await H.settle(page, checked, ['e34'])) === JSON.stringify(['e34']), 'and their box is still ticked');
  // A pill is a fresh start.
  await page.evaluate(() => [...document.querySelectorAll('#candViews .view-pill')].find((x) => x.firstChild.textContent.trim() === 'Everyone').click());
  ok(await barAt(null) === null, 'picking a pill starts afresh, with nobody selected');

  // ---- Email and Text open their windows, addressed to the selection ----
  await tick('e34');
  await barAt('1 selected');
  await page.click('#selEmailBtn');
  await page.waitForSelector('#composeModal:not([hidden])');
  ok(await H.text(page, '#composeTitle') === `Email ${B.e34.name}` && await H.text(page, '#composeSendBtn') === 'Send', 'Email with one ticked: a letter to them by name', await H.text(page, '#composeTitle'));
  await page.click('#composeModal [data-close]');
  await clear();
  await page.check('#checkAll');
  await barAt('50 selected');
  await page.click('#selEmailBtn');
  await page.waitForSelector('#composeModal:not([hidden])');
  ok(await H.text(page, '#composeTitle') === 'Email 50 candidates personally' && await H.text(page, '#composeSendBtn') === 'Queue 50 emails', 'Email with fifty: queued, each their own letter', [await H.text(page, '#composeTitle'), await H.text(page, '#composeSendBtn')]);
  const chips = await page.$$eval('#composeTo .to-chip', (cs) => cs.length);
  ok(chips === 6 && await H.text(page, '#composeTo .to-more') === '+44 more', 'six names shown, "+44 more"');
  await page.click('#composeModal [data-close]');
  await page.click('#selTextBtn');
  await page.waitForSelector('#textComposeModal:not([hidden])');
  ok(await H.text(page, '#textComposeTitle') === `Text ${okN} people` && await H.text(page, '#textComposeSendBtn') === `Queue ${okN} texts`, `Text: only the ${okN} with a number`, [await H.text(page, '#textComposeTitle'), await H.text(page, '#textComposeSendBtn')]);
  await page.click('#textComposeModal [data-close]');
  await page.click('#selBothBtn');
  await page.waitForSelector('#textComposeModal:not([hidden])');
  ok(await H.text(page, '#textComposeTitle') === `Text ${okN} people` && await page.$eval('#composeModal', (el) => el.hidden), 'Email + text: the text window first', await H.text(page, '#textComposeTitle'));
  await page.click('#textComposeModal [data-close]');
  ok((await bar()).count === '50 selected', 'closing the windows keeps the selection');

  // ---- onto Sales IQ, from the selection ----
  const siq = require(R('lib/salesiq.js'));
  const onboarding = require(R('lib/onboarding.js'));
  const iqBefore = (await siq.load()).candidates.length;
  await page.click('#selIqBtn');
  await H.until(page, async () => (await toastTexts()).some((t) => /added to Sales IQ/.test(t)));
  ok((await toastTexts()).includes(`${iqN} added to Sales IQ.`), `"${iqN} added to Sales IQ."`, await toastTexts());
  const iqDoc = await siq.load();
  const fresh = iqDoc.candidates.slice(0, iqDoc.candidates.length - iqBefore);
  const want = page1.filter((c) => !H.IQ_IDS.includes(c.id));
  ok(iqDoc.candidates.length === iqBefore + iqN && JSON.stringify(fresh.map((c) => c.crmId).sort()) === JSON.stringify(want.map((c) => c.id).sort()), 'the server stored exactly those people on the Sales IQ list', iqDoc.candidates.length);
  ok(fresh.every((c) => c.status === 'added' && c.email === B[c.crmId].email), '  as "not sent yet", under their own address');
  await H.until(page, async () => (await H.options(page, '#iqFilter'))[1] === `On Sales IQ (${13 + iqN})`);
  ok((await H.options(page, '#iqFilter'))[1] === `On Sales IQ (${13 + iqN})`, 'the Sales IQ menu counts them', (await H.options(page, '#iqFilter'))[1]);
  const rowBadges = await page.$$eval('#candidateRows tr', (trs) => trs.map((tr) => [tr.dataset.id, (tr.querySelector('.cand-iq') || {}).textContent || '']));
  ok(want.every((c) => /Sales IQ · not sent/.test(Object.fromEntries(rowBadges)[c.id])), 'each of their rows now says "Sales IQ · not sent"');
  await H.settle(page, async () => (await bar()).iq, 'Add 0 to Sales IQ');
  b = await bar();
  ok(b.count === '50 selected' && b.iq === 'Add 0 to Sales IQ' && b.iqOff, 'the selection stays, and there is nobody left to add', b);

  // ---- onto Onboarding docs, from the selection ----
  const onbBefore = (await onboarding.load()).candidates.length;
  await page.click('#selOnbBtn');
  await H.until(page, async () => (await toastTexts()).some((t) => /added to Onboarding docs/.test(t)));
  ok((await toastTexts()).includes(`${onbN} added to Onboarding docs.`), `"${onbN} added to Onboarding docs."`, await toastTexts());
  const onbDoc = await onboarding.load();
  const onbWant = page1.filter((c) => !H.ONB_IDS.includes(c.id)).map((c) => c.id).sort();
  ok(onbDoc.candidates.length === onbBefore + onbN && JSON.stringify(onbDoc.candidates.slice(0, onbN).map((c) => c.crmId).sort()) === JSON.stringify(onbWant), 'the server stored exactly those people on the Onboarding pipeline', onbDoc.candidates.length);
  ok(onbDoc.sends.length === 5, '  and sent nobody a packet', onbDoc.sends.length);
  await H.until(page, async () => (await H.options(page, '#onbFilter'))[1] === `In Onboarding docs (${9 + onbN})`);
  ok((await H.options(page, '#onbFilter'))[1] === `In Onboarding docs (${9 + onbN})` && (await H.options(page, '#onbFilter'))[3] === `Docs · packet not sent (${4 + onbN})`, 'the Onboarding menu counts them, as "packet not sent"', await H.options(page, '#onbFilter'));
  await H.settle(page, async () => (await bar()).onb, 'Add 0 to Onboarding docs');
  b = await bar();
  ok(b.onb === 'Add 0 to Onboarding docs' && b.onbOff, 'nobody left to add there either', b);
  ok(!(await siq.load()).candidates.some((c) => /wholesalepayments/.test(c.email)) && !(await onboarding.load()).candidates.some((c) => /wholesalepayments/.test(c.applicant.email)), 'nobody from the team went to either');

  ok(sendCalls.length === 0, 'nothing was sent from the page', sendCalls);
  ok(errors.length === 0, 'no page errors', errors);
  ok(H.outside.length === 0, 'nothing reached the outside world', H.outside);
  await ctx.close();
  await browser.close();
  await s.close();
  done();
})().catch(crash);
