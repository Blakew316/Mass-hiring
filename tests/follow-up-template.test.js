// A saved email as the follow-up email:
//   - a team that has never chosen gets its saved email named "Follow-Up
//     Email" as its follow-up, the words it had before remembered
//   - every follow-up goes out as that one and only that one: queued, sent
//     straight away, or from a window still showing the old words
//   - editing it under Email templates, or in Settings' follow-up editor,
//     changes both; it cannot be deleted or made the first email's template
//     while it is the follow-up
//   - "Written here" puts the follow-up back in Settings for good (it is not
//     chosen again by its name), and choosing it again works
//   - Settings shows which one follow-ups use
// Made-up people only; nothing is sent (the mailer is a stand-in).
const { startApp, launch, R, ok, done, crash } = require('./helpers');
const { open } = require('./views-helpers');

(async () => {
  const s = await startApp({ offset: 290 });
  const storage = require(R('lib/storage.js'));
  const queue = require(R('lib/queue.js'));
  const mailer = require(R('lib/mailer.js'));
  const google = require(R('lib/google.js'));
  google.findSentTo = async () => null;
  const sent = [];
  mailer.sendEmail = async (_settings, msg) => {
    sent.push({ to: msg.to, subject: msg.subject, text: msg.text });
    const n = sent.length;
    return { id: `m${n}`, threadId: `t${n}`, messageId: `<m${n}@example.com>` };
  };
  const emailed = (id, first) => ({
    id, name: `${first} Sample`, firstName: first, lastName: 'Sample', email: `${first.toLowerCase()}.${id}@example.com`,
    status: 'emailed', source: 'csv', addedAt: new Date(Date.now() - 9 * 864e5).toISOString(),
    lastEmailedAt: new Date(Date.now() - 6 * 864e5).toISOString(), lastSubject: 'Quick question', messageId: `<orig-${id}@example.com>`, gmailThreadId: `th-${id}`,
  });
  const sentTo = (id) => sent.filter((m) => String(m.to).includes(`.${id}@example.com`));
  const run = () => queue.processQueue({ budgetMs: 15000 });
  const FU = { name: 'Follow-Up Email', subject: 'Re: {{originalSubject}}', body: 'Hi {{firstName}},\n\nJust bumping this back to the top of your inbox. Grab a time below.' };
  try {
    await s.store.update((d) => { d.candidates = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map((id, i) => emailed(id, ['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fay'][i])); });
    const OLD = (await s.store.load()).followUp;

    // ---- a team that has never chosen, with a saved "Follow-Up Email" ----
    const made = await s.json('POST', '/api/templates/email', FU);
    const fuId = made.body.preset.id;
    const raw = JSON.parse((await storage.getTextWithEtag('db')).bytes.toString('utf8'));
    delete raw.templateDefaults.followUp;
    await storage.setJson('db', raw);
    let db = await s.store.load();
    ok(db.templateDefaults.followUp === fuId && db.followUp.body === FU.body && db.followUp.subject === FU.subject, 'never chosen: the saved "Follow-Up Email" is the follow-up', db.templateDefaults);

    // ---- queued with the old words (a window opened before), then sent ----
    let r = await s.json('POST', '/api/queue', { candidateIds: ['f1'], template: { subject: OLD.subject, body: OLD.body }, followUp: true });
    ok(r.status === 200 && r.body.added === 1, 'a follow-up queued from a window still showing the old follow-up', r.body);
    await run();
    ok(sentTo('f1').length === 1 && /bumping this back/.test(sentTo('f1')[0].text) && sentTo('f1')[0].subject === 'Re: Quick question', 'it goes out as "Follow-Up Email", in the same thread', sentTo('f1').map((m) => [m.subject, m.text.slice(0, 60)]));

    // ---- edited under Email templates ----
    r = await s.json('PATCH', `/api/templates/email/${fuId}`, { name: 'Follow-Up Email', subject: FU.subject, body: 'Hi {{firstName}},\n\nSecond draft of the nudge.' });
    ok(r.status === 200 && r.body.followUp.body.includes('Second draft'), 'edited under Email templates: the follow-up changes with it (and the answer says so)', r.body.followUp);
    await s.json('POST', '/api/queue', { candidateIds: ['f2'], template: { subject: FU.subject, body: FU.body }, followUp: true });
    await run();
    ok(sentTo('f2').length === 1 && /Second draft/.test(sentTo('f2')[0].text), 'a follow-up queued with its earlier words goes out as it is now', sentTo('f2').map((m) => m.text.slice(0, 60)));

    // ---- edited in Settings' follow-up editor ----
    r = await s.json('POST', '/api/followup', { subject: FU.subject, body: 'Hi {{firstName}},\n\nThird draft, from Settings.' });
    db = await s.store.load();
    const saved = db.emailTemplates.find((p) => p.id === fuId);
    ok(r.status === 200 && saved.body.includes('Third draft') && db.followUp.body.includes('Third draft'), 'edited in Settings: the saved "Follow-Up Email" changes with it', saved.body);

    // ---- sent straight away, from a window showing an old version ----
    r = await s.json('POST', '/api/send', { candidateIds: ['f3'], template: { subject: OLD.subject, body: OLD.body }, followUp: true });
    ok(r.status === 200 && sentTo('f3').length === 1 && /Third draft/.test(sentTo('f3')[0].text), 'sent straight away from an old window: "Follow-Up Email" as saved', sentTo('f3').map((m) => m.text.slice(0, 60)));

    // ---- it stays what it is ----
    r = await s.json('DELETE', `/api/templates/email/${fuId}`);
    ok(r.status >= 400 && /follow-up/i.test(r.body.error) && (await s.store.load()).emailTemplates.some((p) => p.id === fuId), 'it cannot be deleted while follow-ups use it', r.body);
    r = await s.json('POST', `/api/templates/email/${fuId}/default`);
    ok(r.status >= 400 && /follow-up/i.test(r.body.error), 'nor made the first email\'s template', r.body);
    const first = (await s.store.load()).templateDefaults.email;
    r = await s.json('POST', '/api/followup/use', { id: first });
    ok(r.status >= 400 && (await s.store.load()).templateDefaults.followUp === fuId, 'and the first email\'s template cannot be made the follow-up', r.body);

    // ---- written here, then chosen again ----
    r = await s.json('POST', '/api/followup/use', { id: '' });
    db = await s.store.load();
    ok(r.status === 200 && db.templateDefaults.followUp === '' && db.followUp.body.includes('Third draft'), '"Written here": the follow-up is Settings\' own again, with the words it had', db.templateDefaults);
    await s.store.update((d) => { d.settings.fromName = d.settings.fromName || 'Blake'; });
    ok((await s.store.load()).templateDefaults.followUp === '', 'and is not chosen again by its name');
    await s.json('POST', '/api/followup', { subject: 'Re: {{originalSubject}}', body: 'Written in Settings only.' });
    ok(!(await s.store.load()).emailTemplates.find((p) => p.id === fuId).body.includes('Written in Settings only'), 'editing Settings\' own follow-up leaves the saved email alone');
    r = await s.json('POST', '/api/followup/use', { id: fuId });
    db = await s.store.load();
    ok(r.status === 200 && db.templateDefaults.followUp === fuId && db.followUp.body.includes('Third draft') && r.body.preset.name === 'Follow-Up Email', 'chosen again: follow-ups go out as "Follow-Up Email"', db.followUp);
    await s.json('POST', '/api/queue', { candidateIds: ['f4'], template: { subject: 'Re: {{originalSubject}}', body: 'Written in Settings only.' }, followUp: true });
    await run();
    ok(sentTo('f4').length === 1 && /Third draft/.test(sentTo('f4')[0].text), 'even one queued from a window showing the words written here before', sentTo('f4').map((m) => m.text.slice(0, 60)));

    // ---- Settings shows it ----
    const browser = await launch();
    try {
      const { ctx, page, errors } = await open(browser, s, { at: '/#settings' });
      await page.waitForSelector('#view-settings.active');
      await page.waitForFunction((id) => document.querySelector('#fuPreset') && document.querySelector('#fuPreset').value === id, fuId, { timeout: 15000 });
      const shown = await page.evaluate(() => ({
        chosen: document.querySelector('#fuPreset').selectedOptions[0].textContent,
        options: [...document.querySelectorAll('#fuPreset option')].map((o) => o.textContent),
        body: document.querySelector('#fuBody').value,
        hint: document.querySelector('#fuPresetHint').textContent,
        labelled: [...document.querySelectorAll('#tplPreset option')].map((o) => o.textContent),
      }));
      ok(shown.chosen === 'Follow-Up Email' && shown.body.includes('Third draft') && /only that/.test(shown.hint), 'Settings: the follow-up is "Follow-Up Email", its words in the editor', shown);
      ok(shown.options[0] === 'Written here' && shown.labelled.some((t) => t === 'Follow-Up Email — follow-ups'), 'with "Written here" to go back to, and the saved list marking which one follow-ups use', shown);
      await page.selectOption('#fuPreset', '');
      await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /written here/.test(t.textContent)));
      ok((await s.store.load()).templateDefaults.followUp === '', 'choosing "Written here" in Settings is saved');
      await page.selectOption('#fuPreset', fuId);
      await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Follow-Up Email/.test(t.textContent)));
      ok((await s.store.load()).templateDefaults.followUp === fuId, 'and choosing "Follow-Up Email" again');
      ok(errors.length === 0, 'no page errors', errors);
      await ctx.close();
    } finally {
      await browser.close();
    }
  } finally {
    await s.close();
  }
  done();
})().catch(crash);
