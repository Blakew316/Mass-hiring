// Saving a template changes every email from then on, including the ones
// already waiting in the queue:
//   - people queued with the default template get its words as they are when
//     their email goes out — edited and saved after they were queued, the
//     new words
//   - a send window left open on the old words (another tab, a phone) still
//     means the template: the saved words go
//   - a saved template picked in the send window is followed the same way
//   - only words written in the send window for that one batch are sent
//     exactly as written
//   - a queue from before this change gets the template as saved now; a send
//     whose outcome was unknown is sent again only as it was
//   - follow-ups likewise follow the saved follow-up email
//   - after Save, the send window opens with what was just saved
// Made-up people only; nothing is sent (the mailer is a stand-in).
const { startApp, launch, R, ok, done, crash } = require('./helpers');
const { open } = require('./views-helpers');

(async () => {
  const s = await startApp({ offset: 286 });
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
  const person = (id, first, extra = {}) => ({ id, name: `${first} Sample`, firstName: first, lastName: 'Sample', email: `${first.toLowerCase()}.${id}@example.com`, status: 'new', addedAt: new Date().toISOString(), source: 'csv', ...extra });
  const sentTo = (id) => sent.filter((m) => String(m.to).includes(`.${id}@example.com`));
  const run = () => queue.processQueue({ budgetMs: 15000 });
  try {
    await s.store.update((d) => {
      d.candidates = [
        person('a1', 'Ada'), person('a2', 'Bo'), person('a3', 'Cy'), person('a4', 'Dee'), person('a5', 'Eli'),
        person('a6', 'Fay'), person('a7', 'Gus'), person('a8', 'Hal'),
        person('f1', 'Ivy', { status: 'emailed', lastEmailedAt: new Date(Date.now() - 5 * 86400000).toISOString(), lastSubject: 'Hello' }),
      ];
    });
    const db0 = await s.store.load();
    const defId = db0.templateDefaults.email;
    const OLD = { subject: db0.template.subject, body: db0.template.body };

    // ---- queued with the default, then the template is edited and saved ----
    let r = await s.json('POST', '/api/queue', { candidateIds: ['a1', 'a2'], template: OLD });
    ok(r.status === 200 && r.body.added === 2, 'two people queued with the template as the send window showed it', r.body);
    const NEW = { subject: 'A new subject, {{firstName}}', body: 'Hi {{firstName}},\n\nThe new letter.' };
    r = await s.json('PATCH', `/api/templates/email/${defId}`, { name: 'Main email', ...NEW });
    ok(r.status === 200 && r.body.template.subject === NEW.subject, 'the template is saved (and the answer carries it)', r.body.template);
    // A send window opened before the save, still showing the old words.
    r = await s.json('POST', '/api/queue', { candidateIds: ['a3'], template: OLD });
    await run();
    ok(sentTo('a1').length === 1 && sentTo('a2').length === 1 && [...sentTo('a1'), ...sentTo('a2')].every((m) => m.subject.startsWith('A new subject') && /The new letter/.test(m.text)),
      'people queued before the save get the saved words', sent.map((m) => m.subject));
    ok(sentTo('a3').length === 1 && /The new letter/.test(sentTo('a3')[0].text), 'and so does someone queued from a window still showing the old words', sentTo('a3').map((m) => m.subject));

    // ---- a saved template picked in the send window; and words written for one batch ----
    r = await s.json('POST', '/api/templates/email', { name: 'Second letter', subject: 'Second, {{firstName}}', body: 'Second letter, first draft.' });
    const second = r.body.preset;
    await s.json('POST', '/api/queue', { candidateIds: ['a4'], template: { subject: second.subject, body: second.body } });
    await s.json('POST', '/api/queue', { candidateIds: ['a5'], template: { subject: 'Just for this batch', body: 'Written in the send window.' } });
    await s.json('PATCH', `/api/templates/email/${second.id}`, { name: 'Second letter', subject: second.subject, body: 'Second letter, as saved.' });
    await s.json('PATCH', `/api/templates/email/${defId}`, { name: 'Main email', subject: 'Third subject', body: 'The third letter.' });
    await run();
    ok(sentTo('a4').length === 1 && /as saved/.test(sentTo('a4')[0].text), 'a saved template picked in the send window: its words as saved when it goes', sentTo('a4').map((m) => m.text));
    ok(sentTo('a5').length === 1 && sentTo('a5')[0].subject === 'Just for this batch' && /Written in the send window/.test(sentTo('a5')[0].text), 'words written for one batch: sent as written', sentTo('a5').map((m) => m.subject));

    // ---- a queue from before this change ----
    await storage.setJson('queue', {
      items: [{ id: 'a6', t: 'oldkey000001' }, { id: 'a7', t: 'oldkey000002' }],
      templates: { oldkey000001: { subject: 'Stale subject', body: 'Stale words.' }, oldkey000002: { subject: 'Maybe sent', body: 'The words that may have gone.' } },
      unverified: { a7: { email: 'gus.a7@example.com', since: new Date(Date.now() - 60000).toISOString() } },
      failed: [], attempts: {}, sentLog: [], pendingPatches: [], total: 2, sent: 0,
    });
    await run();
    ok(sentTo('a6').length === 1 && sentTo('a6')[0].subject === 'Third subject', 'queued before this change: the template as saved now, not the stale copy', sentTo('a6').map((m) => m.subject));
    ok(sentTo('a7').length === 1 && sentTo('a7')[0].subject === 'Maybe sent', 'a send whose outcome was unknown goes again only as it was', sentTo('a7').map((m) => m.subject));

    // ---- sending straight from the window (a few people) ----
    r = await s.json('POST', '/api/send', { candidateIds: ['a8'], template: OLD });
    ok(r.status === 200 && sentTo('a8').length === 1 && sentTo('a8')[0].subject === 'Third subject', 'sent from a window still showing an old version: the template as saved', sentTo('a8').map((m) => m.subject));

    // ---- follow-ups ----
    const FU_OLD = (await s.store.load()).followUp;
    await s.json('POST', '/api/queue', { candidateIds: ['f1'], template: { subject: FU_OLD.subject, body: FU_OLD.body }, followUp: true });
    await s.json('POST', '/api/followup', { subject: 'Re: {{originalSubject}}', body: 'The new follow-up.' });
    await run();
    ok(sentTo('f1').length === 1 && /The new follow-up/.test(sentTo('f1')[0].text), 'a queued follow-up gets the follow-up email as saved', sentTo('f1').map((m) => m.text));

    // ---- the page: after Save, the send window opens with what was saved ----
    const browser = await launch();
    try {
      const { ctx, page, errors } = await open(browser, s, { at: '/#settings' });
      await page.waitForSelector('#view-settings.active');
      await page.fill('#tplSubject', 'Saved in the page');
      await page.fill('#tplBody', 'Hi {{firstName}}, saved in the page.');
      await page.evaluate(() => document.querySelector('#saveTemplateBtn').click());
      // At once — before the page's next look at the server.
      await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /saved/.test(t.textContent)));
      await page.evaluate(() => { location.hash = '#candidates'; });
      await page.waitForSelector('#view-candidates.active');
      await page.waitForSelector('#candidateRows tr.cand-row');
      await page.click('#candidateRows tr.cand-row [data-col="company"]');
      await page.waitForSelector('#profileModal:not([hidden])');
      await page.click('#profActs [data-act="act-email"]');
      await page.waitForSelector('#composeModal:not([hidden])');
      const words = await page.evaluate(() => ({ subject: document.querySelector('#composeSubject').value, body: document.querySelector('#composeBody').value }));
      ok(words.subject === 'Saved in the page' && words.body === 'Hi {{firstName}}, saved in the page.', 'after Save, the send window opens with what was just saved', words);
      const stored = (await s.store.load()).template;
      ok(stored.subject === 'Saved in the page', 'and it is what the server keeps', stored.subject);
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
