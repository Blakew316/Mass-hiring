// Saving the text template changes every text from then on, including the
// ones already waiting in the queue:
//   - people queued with the default text get its words as they are when
//     their text goes out — edited and saved after they were queued, the new
//     words; so do people queued from a window still showing the old words
//   - a saved text picked in the window is followed the same way
//   - only words written in the window for that one batch, and replies typed
//     into a conversation, are sent exactly as written
//   - a queue from before this change gets the text as saved now, and a
//     reply waiting in it keeps its words
// Made-up people only; nothing is sent (texts are only claimed, as the Mac
// relay would, never delivered).
const { startApp, R, ok, done, crash } = require('./helpers');

(async () => {
  const s = await startApp({ offset: 292 });
  const storage = require(R('lib/storage.js'));
  const textQueue = require(R('lib/text-queue.js'));
  const { renderText } = require(R('lib/template.js'));
  const person = (id, first, n) => ({
    id, name: `${first} Sample`, firstName: first, lastName: 'Sample', email: `${first.toLowerCase()}.${id}@example.com`,
    phone: `(617) 555-24${String(n).padStart(2, '0')}`, status: 'emailed', source: 'csv',
    addedAt: new Date(Date.now() - 9 * 864e5).toISOString(), lastEmailedAt: new Date(Date.now() - 5 * 864e5).toISOString(),
  });
  const queueTexts = (ids, body) => s.json('POST', '/api/texts/queue', { ids, template: { body }, ignoreQuietHours: true });
  // Everything waiting, claimed as the relay claims it: id -> the text it got.
  const claimAll = async () => {
    const got = {};
    for (let i = 0; i < 20; i++) {
      const db = await s.store.load();
      let job = null;
      await textQueue.updateQ((q) => { job = textQueue.claim(q, db, { render: (tpl, c) => renderText(tpl || db.textTemplate, c, db.settings) }).job; });
      if (!job) break;
      got[job.candidateId] = job.body;
    }
    return got;
  };
  try {
    await s.store.update((d) => { d.candidates = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'].map((id, i) => person(id, ['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal'][i], i + 10)); });
    const A = 'Hi {{firstName}}, first version of the text. Reply STOP to opt out.';
    let r = await s.json('POST', '/api/texts/template', { body: A });
    ok(r.status === 200 && r.body.textTemplate.body === A, 'the text is saved');

    // ---- queued with the default, then the text is edited and saved ----
    r = await queueTexts(['t1', 't2'], A);
    ok(r.status === 200 && r.body.added === 2, 'two people queued with the text as the window showed it', r.body);
    const B = 'Hi {{firstName}}, the new text. Reply STOP to opt out.';
    await s.json('POST', '/api/texts/template', { body: B });
    await queueTexts(['t3'], A);   // a window opened before the save
    let got = await claimAll();
    ok(got.t1 === 'Hi Ada, the new text. Reply STOP to opt out.' && /the new text/.test(got.t2 || ''), 'people queued before the save get the saved words', got);
    ok(/the new text/.test(got.t3 || ''), 'and so does someone queued from a window still showing the old words', got.t3);

    // ---- a saved text picked in the window; words written for one batch ----
    r = await s.json('POST', '/api/templates/text', { name: 'Second text', body: 'Hey {{firstName}}, second text, first draft.' });
    const second = r.body.preset;
    await queueTexts(['t4'], second.body);
    await queueTexts(['t5'], 'Just for this batch, {{firstName}}.');
    await s.json('PATCH', `/api/templates/text/${second.id}`, { name: 'Second text', body: 'Hey {{firstName}}, second text, as saved.' });
    await s.json('POST', '/api/texts/template', { body: 'Hi {{firstName}}, third version.' });
    got = await claimAll();
    ok(got.t4 === 'Hey Dee, second text, as saved.', 'a saved text picked in the window: its words as saved when it goes', got.t4);
    ok(got.t5 === 'Just for this batch, Eli.', 'words written for one batch: sent as written', got.t5);

    // ---- a reply typed into the conversation ----
    await textQueue.updateQ((q) => { textQueue.enqueueReply(q, person('t6', 'Fay', 15), 'Sure — {{firstName}} is fine, call me at 3'); });
    got = await claimAll();
    ok(got.t6 === 'Sure — {{firstName}} is fine, call me at 3', 'a reply goes out literally as typed', got.t6);

    // ---- a queue from before this change ----
    const q0 = await textQueue.loadQ();
    await storage.setJson('text-queue', {
      ...q0,
      tplv: undefined, legacy: undefined,
      items: [{ id: 't7', phone: '+16175552416', t: 'oldtext00001', at: null, now: 1 }, { id: 't8', phone: '+16175552417', t: 'oldreply0001', at: null, now: 1, reply: 1 }],
      templates: { oldtext00001: { body: 'Stale campaign text.' }, oldreply0001: { body: 'A reply typed before the change.' } },
      leases: {},
    });
    got = await claimAll();
    ok(got.t7 === 'Hi Gus, third version.', 'queued before this change: the text as saved now, not the stale copy', got.t7);
    ok(got.t8 === 'A reply typed before the change.', 'a reply waiting from before keeps its words', got.t8);
  } finally {
    await s.close();
  }
  done();
})().catch(crash);
