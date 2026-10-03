// Settings, on a laptop and on a phone: every editor shows what is saved (the
// email template and its preview, the follow-up, the default text, the
// settings form), a saved template can be picked, unsaved edits survive a
// refresh, and Save writes each of them to the server. The attachment list
// shows a thumbnail for an image attachment — the built-in flyer and one
// added from the page.
const { startApp, launch, ok, done, crash } = require('./helpers');
const { stubEverything, open, text, texts, waitIn, waitText, settle, same, until, poke, person } = require('./views-helpers');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const toastSaid = (page, re) => waitIn(page, (src) => [...document.querySelectorAll('.toast')].some((t) => new RegExp(src).test(t.textContent)), re.source);

(async () => {
  const s = await startApp({ offset: 140 });
  const rec = stubEverything();
  await s.store.update((d) => {
    d.candidates = [person('p1', 'Sam Settings', { role: 'Account Executive', company: 'Example Co' })];
    d.template = { subject: 'Hello {{firstName}} from the test', body: 'Body line one\nBody line two', attachments: d.template.attachments };
    d.followUp = { subject: 'Re: {{originalSubject}} (test)', body: 'Following up from the test' };
    d.textTemplate = { body: 'Hi {{firstName}}, a test text.' };
    d.emailTemplates = [...(d.emailTemplates || []), { id: 'email-extra', name: 'Houston AEs', subject: 'Houston subject', body: 'Houston body', updatedAt: new Date().toISOString() }];
    d.settings.calendlyUrl = 'https://example.com/book';
    d.settings.fromName = 'Test Sender';
  });
  const db = () => s.store.load();

  const browser = await launch();

  // ================= laptop =================
  {
    const tag = 'laptop';
    const { ctx, page, errors } = await open(browser, s, { at: '/#settings' });
    await page.waitForSelector('#view-settings.active');

    // What is saved is what the editors show.
    ok(await settle(() => page.inputValue('#tplSubject'), 'Hello {{firstName}} from the test') === 'Hello {{firstName}} from the test', `${tag}: the email editor shows the saved subject`, await page.inputValue('#tplSubject'));
    ok(await page.inputValue('#tplBody') === 'Body line one\nBody line two', `${tag}: and the saved body`, await page.inputValue('#tplBody'));
    ok(await page.inputValue('#tplName') === 'Main email', `${tag}: under its name`, await page.inputValue('#tplName'));
    const opts = await settle(() => texts(page, '#tplPreset option'), ['Main email — default', 'Houston AEs']);
    ok(same(opts, ['Main email — default', 'Houston AEs']), `${tag}: the saved templates are offered`, opts);
    ok(await waitText(page, '#pvSubject', 'Hello Jordan from the test'), `${tag}: the preview fills in a sample name`, await text(page, '#pvSubject'));
    ok(/Body line one/.test(await text(page, '#pvBody')) && /https:\/\/example\.com\/book/.test(await text(page, '#pvBody')), `${tag}: the preview has the body and the booking link`, await text(page, '#pvBody'));
    ok(await page.inputValue('#fuSubject') === 'Re: {{originalSubject}} (test)' && await page.inputValue('#fuBody') === 'Following up from the test', `${tag}: the follow-up editor shows the saved follow-up`);
    ok(await page.inputValue('#txBody') === 'Hi {{firstName}}, a test text.', `${tag}: the text editor shows the saved text`, await page.inputValue('#txBody'));
    ok(await page.inputValue('#setCalendlyUrl') === 'https://example.com/book' && await page.inputValue('#setFromName') === 'Test Sender', `${tag}: the settings form shows saved settings`);

    // The attachment: the built-in flyer, with its thumbnail.
    ok(same(await settle(() => texts(page, '#attachList .attach-name'), ['Account Executive.png']), ['Account Executive.png']), `${tag}: the attachment is listed`, await texts(page, '#attachList .attach-name'));
    ok(await waitIn(page, () => { const i = document.querySelector('#attachList .attach-thumb img'); return i && i.getAttribute('src').startsWith('data:image/png;base64,'); }), `${tag}: with a thumbnail of the image`);
    ok(/Account Executive\.png/.test(await text(page, '#pvAttachments')), `${tag}: the preview says it goes with the email`, await text(page, '#pvAttachments'));

    // Unsaved edits survive a refresh.
    await page.fill('#tplBody', 'New body from the browser for {{firstName}}');
    ok(/•/.test(await text(page, '#saveTemplateBtn')), `${tag}: an edit marks Save as unsaved`, await text(page, '#saveTemplateBtn'));
    await s.store.update((d) => { d.candidates.push(person('p2', 'Another Person')); });
    await poke(page);
    ok(await page.inputValue('#tplBody') === 'New body from the browser for {{firstName}}', `${tag}: a refresh does not overwrite what is being typed`, await page.inputValue('#tplBody'));
    await page.click('#saveTemplateBtn');
    ok(await toastSaid(page, /“Main email” saved/), `${tag}: Save says it saved`);
    ok(await until(async () => (await db()).template.body === 'New body from the browser for {{firstName}}'), `${tag}: the template the sends use is the new one`, (await db()).template.body);
    ok((await db()).template.subject === 'Hello {{firstName}} from the test', `${tag}: with its subject unchanged`);
    ok(await waitIn(page, () => !/•/.test(document.querySelector('#saveTemplateBtn').textContent)), `${tag}: and Save is no longer marked`);

    // Picking another saved template shows it.
    await page.selectOption('#tplPreset', 'email-extra');
    ok(await waitIn(page, () => document.querySelector('#tplSubject').value === 'Houston subject'), `${tag}: picking a saved template shows its subject`, await page.inputValue('#tplSubject'));
    ok(await page.inputValue('#tplBody') === 'Houston body' && await page.inputValue('#tplName') === 'Houston AEs', `${tag}: its body and name`);
    await page.selectOption('#tplPreset', 'email-main');
    ok(await waitIn(page, () => document.querySelector('#tplBody').value === 'New body from the browser for {{firstName}}'), `${tag}: and back to the default`, await page.inputValue('#tplBody'));

    // The follow-up, the text, and the settings form each save.
    await page.fill('#fuBody', 'A second note from the browser');
    await page.click('#saveFollowUpBtn');
    ok(await toastSaid(page, /Follow-up email saved/), `${tag}: the follow-up saves`);
    ok(await until(async () => (await db()).followUp.body === 'A second note from the browser'), `${tag}: and is stored`, (await db()).followUp.body);
    await page.fill('#txBody', 'Hi {{firstName}}, texting from the browser.');
    await page.click('#txSave');
    ok(await toastSaid(page, /“Main text” saved/), `${tag}: the default text saves`);
    ok(await until(async () => (await db()).textTemplate.body === 'Hi {{firstName}}, texting from the browser.'), `${tag}: and is stored`, (await db()).textTemplate.body);
    await page.fill('#setCalendlyUrl', 'https://example.com/book-again');
    await page.fill('#setFromName', 'Sender From Browser');
    await page.click('#saveSettingsBtn');
    ok(await toastSaid(page, /^Settings saved/), `${tag}: the settings form saves`);
    ok(await until(async () => { const st = (await db()).settings; return st.calendlyUrl === 'https://example.com/book-again' && st.fromName === 'Sender From Browser'; }), `${tag}: and is stored`);

    // Adding an image attachment shows its thumbnail too.
    await page.setInputFiles('#attachFile', { name: 'flyer.png', mimeType: 'image/png', buffer: PNG });
    ok(await waitIn(page, () => document.querySelectorAll('#attachList .attach-item').length === 2), `${tag}: an added image is listed`, await texts(page, '#attachList .attach-name'));
    ok(await waitIn(page, () => [...document.querySelectorAll('#attachList .attach-item')].every((li) => { const i = li.querySelector('.attach-thumb img'); return i && i.src.startsWith('data:image/png;base64,'); })),
      `${tag}: each image has its thumbnail`);
    const stored = (await db()).template.attachments;
    ok(stored.length === 2 && stored[1].name === 'flyer.png' && stored[1].type === 'image/png', `${tag}: stored on the template`, stored.map((a) => a.name));

    ok(errors.length === 0, `${tag}: no page errors`, errors);
    await ctx.close();
  }

  // ================= phone =================
  {
    const tag = 'phone';
    const { ctx, page, errors } = await open(browser, s, { phone: true });
    await page.click('#navMore');
    await page.waitForSelector('#moreSheet:not([hidden])');
    await page.click('#moreSheetButtons [data-more="settings"]');
    await page.waitForSelector('#view-settings.active');
    ok(await settle(() => page.inputValue('#tplBody'), 'New body from the browser for {{firstName}}') === 'New body from the browser for {{firstName}}', `${tag}: the email editor shows what was saved`, await page.inputValue('#tplBody'));
    ok(await page.inputValue('#fuBody') === 'A second note from the browser', `${tag}: the follow-up too`);
    ok(await page.inputValue('#txBody') === 'Hi {{firstName}}, texting from the browser.', `${tag}: and the text`);
    ok(await page.inputValue('#setCalendlyUrl') === 'https://example.com/book-again', `${tag}: and the settings`);
    ok(await waitIn(page, () => document.querySelectorAll('#attachList .attach-thumb img').length === 2), `${tag}: both attachments with thumbnails`);
    await page.fill('#txBody', 'Hi {{firstName}}, from a phone.');
    await page.click('#txSave');
    ok(await until(async () => (await db()).textTemplate.body === 'Hi {{firstName}}, from a phone.'), `${tag}: saving works from a phone`, (await db()).textTemplate.body);
    // Removing one.
    await page.click('#attachList .attach-item:nth-child(2) .attach-remove');
    ok(await waitIn(page, () => document.querySelectorAll('#attachList .attach-item').length === 1), `${tag}: an attachment can be removed`);
    ok(await until(async () => (await db()).template.attachments.length === 1), `${tag}: and is gone from the template`);
    ok(errors.length === 0, `${tag}: no page errors`, errors);
    await ctx.close();
  }

  ok(rec.sent.length === 0 && rec.outside.length === 0, 'nothing was sent and nothing reached outside', { sent: rec.sent.length, outside: rec.outside });
  await browser.close();
  await s.close();
  done();
})().catch(crash);
