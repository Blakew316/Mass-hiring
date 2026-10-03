// A reply sent twice from the keyboard, on a laptop: Enter pressed twice in
// a text conversation, and Cmd/Ctrl-Enter pressed twice in an email one,
// while the first is still on its way (the connection is slow), sends it
// once. The button was disabled while a reply was going, but the keys went
// around it: the box still held the words until the first answer came back.
// A reply that fails can be sent again with the same keys. Nothing leaves
// the machine: texts only reach the queue (there is no relay), and email
// goes to the test's recorder.
const { startApp, launch, ok, done, crash, ago, R } = require('./helpers');
const { stubEverything, open, text, texts, waitIn, waitText, until, person } = require('./views-helpers');

(async () => {
  const s = await startApp({ offset: 200 });
  const rec = stubEverything();
  const textQueue = require(R('lib/text-queue.js'));
  await s.store.update((d) => {
    d.candidates = [
      person('k1', 'Kit Keyboard', { phone: '(617) 555-0231', lastTextedAt: ago(90), textStatus: 'replied',
        textThread: [{ dir: 'out', ts: ago(90), text: 'Hi Kit, worth a call?' }, { dir: 'in', ts: ago(60), text: 'Sure, when?' }] }),
      person('k2', 'Mel Mailbox', { status: 'replied', lastEmailedAt: ago(3000), gmailThreadId: 'th-k2', lastSubject: 'Quick question',
        replies: [{ id: 'r-k2', date: ago(30), text: 'Tell me more', kind: null }], lastReplyAt: ago(30) }),
    ];
    d.events = [];
  });
  await textQueue.updateQ((q) => { Object.assign(q, { items: [], leases: {}, templates: {}, failed: [], attempts: {}, sentLog: [], total: 0, sent: 0, startedAt: null }); });
  rec.threads = { 'th-k2': [{ dir: 'out', date: ago(3000), text: 'Hi Mel, open to a new role?' }, { dir: 'in', date: ago(30), text: 'Tell me more' }] };
  const queued = async () => { const q = await textQueue.loadQ(); return q.items.map((i) => ({ id: i.id, text: (q.templates[i.t] || {}).body })); };

  const browser = await launch();
  const { ctx, page, errors } = await open(browser, s, { at: '/#texting' });
  // Every change the page asks for is held back a little, so the second key
  // press lands while the first reply is still on its way.
  const slow = async (route) => { if (route.request().method() !== 'GET') await new Promise((r) => setTimeout(r, 700)); await route.continue(); };
  await page.route((u) => u.pathname.startsWith('/api/') && !u.pathname.endsWith('/seen'), slow);

  // ---- Texting: Enter, Enter ----
  await page.waitForSelector('#convList [data-conv="k1"]');
  await page.click('#convList [data-conv="k1"]');
  ok(await waitText(page, '#threadName', 'Kit Keyboard'), 'the text conversation is open', await text(page, '#threadName'));
  await waitIn(page, () => /Sure, when\?/.test(document.querySelector('#threadBody').textContent));
  await page.fill('#threadInput', 'Tomorrow at 10?');
  await page.press('#threadInput', 'Enter');
  await page.waitForTimeout(150);
  ok(await page.inputValue('#threadInput') === 'Tomorrow at 10?', '(the first is still on its way: the words are still in the box)');
  await page.press('#threadInput', 'Enter');
  await waitIn(page, () => document.querySelector('#threadInput').value === '');
  await page.waitForTimeout(1200);
  const q = await queued();
  ok(q.filter((i) => i.text === 'Tomorrow at 10?').length === 1 && q.length === 1 && q[0].id === 'k1', 'Enter pressed twice queues the text once', q);
  ok(await waitIn(page, () => [...document.querySelectorAll('#threadBody .msg.pending')].filter((m) => /Tomorrow at 10\?/.test(m.textContent)).length === 1), 'and shows it once, as sending', await texts(page, '#threadBody .msg.pending'));

  // A second message after the first has answered goes, as it should.
  await waitIn(page, () => !document.querySelector('#threadSend').disabled);
  await page.fill('#threadInput', 'Or Thursday?');
  await page.press('#threadInput', 'Enter');
  ok(await until(async () => (await queued()).some((i) => i.text === 'Or Thursday?')), 'a new message after it answered is sent', await queued());

  // ---- Email: Ctrl-Enter, Ctrl-Enter ----
  await page.evaluate(() => document.querySelector('.nav-item[data-view="template"]').click());
  await page.waitForSelector('#mailList [data-mail="k2"]');
  await page.click('#mailList [data-mail="k2"]');
  ok(await waitText(page, '#mailName', 'Mel Mailbox'), 'the email conversation is open', await text(page, '#mailName'));
  await waitIn(page, () => document.querySelectorAll('#mailBody .msg').length === 2);
  await page.fill('#mailInput', 'Happy to explain on a call.');
  await page.press('#mailInput', 'Control+Enter');
  await page.waitForTimeout(150);
  await page.press('#mailInput', 'Control+Enter');
  await page.press('#mailInput', 'Meta+Enter');
  await waitIn(page, () => document.querySelector('#mailInput').value === '');
  await page.waitForTimeout(1200);
  const sent = rec.sent.filter((m) => m.text === 'Happy to explain on a call.');
  ok(sent.length === 1 && rec.sent.length === 1 && sent[0].to === 'mel.mailbox@example.com', 'Ctrl-Enter pressed again while it is on its way sends one email', rec.sent.map((m) => m.text));

  // ---- a reply that fails can be sent again with the keys ----
  const mailer = require(R('lib/mailer.js'));
  const recording = mailer.sendEmail;
  mailer.sendEmail = async () => { throw new Error('Gmail said no (test)'); };
  await waitIn(page, () => !document.querySelector('#mailSend').disabled);
  await page.fill('#mailInput', 'Second try');
  await page.press('#mailInput', 'Control+Enter');
  ok(await waitIn(page, () => [...document.querySelectorAll('.toast')].some((t) => /Gmail said no/.test(t.textContent))), 'a refused reply says so', await texts(page, '.toast'));
  ok(await page.inputValue('#mailInput') === 'Second try', 'and keeps what was typed');
  mailer.sendEmail = recording;
  await page.press('#mailInput', 'Control+Enter');
  ok(await until(() => rec.sent.some((m) => m.text === 'Second try')), 'the same keys send it once it can go', rec.sent.map((m) => m.text));
  await waitIn(page, () => document.querySelector('#mailInput').value === '');
  await page.waitForTimeout(900);
  ok(rec.sent.filter((m) => m.text === 'Second try').length === 1, 'once');

  ok(errors.length === 0, 'no page errors', errors);
  ok(rec.outside.length === 0, 'nothing reached outside', rec.outside);
  await ctx.close();
  await browser.close();
  await s.close();
  done();
})().catch(crash);
