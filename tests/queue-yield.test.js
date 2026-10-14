// The email line: people imported with "Email these first" go to its front.
// Sending stands aside while someone is waiting on a conversation Gmail
// turned away as busy (the 'gmail-yield' record app.js writes): a run sends
// nothing until that time and then carries on; one whose whole budget falls
// inside it sends nothing and leaves everyone queued. And Emails per minute
// is capped at 45, leaving Gmail room to read email while a send runs.
// Made-up people only; nothing is sent (the mailer is a stand-in).
const { startApp, R, ok, done, crash } = require('./helpers');

(async () => {
  const s = await startApp({ offset: 276 });
  const storage = require(R('lib/storage.js'));
  const queue = require(R('lib/queue.js'));
  const mailer = require(R('lib/mailer.js'));
  const sent = [];
  mailer.sendEmail = async (_settings, msg) => {
    sent.push({ to: msg.to, at: Date.now() });
    const n = sent.length;
    return { id: `m${n}`, threadId: `t${n}`, messageId: `<m${n}@example.com>` };
  };
  const person = (id, name) => ({ id, name, firstName: name.split(' ')[0], lastName: name.split(' ')[1], email: `${name.toLowerCase().replace(' ', '.')}@example.com`, status: 'new', addedAt: new Date().toISOString(), source: 'csv' });
  try {
    ok(queue.MAX_PER_MINUTE === 45 && queue.limits({ perMinute: 60 }, 'me@wholesalepayments.com').perMinute === 45, 'Emails per minute is capped at 45 (a saved 60 reads as 45)');

    await s.store.update((d) => { d.candidates = [person('a', 'Ada Sample'), person('b', 'Bo Example'), person('c', 'Cy Madeup')]; });
    const enqueue = async (ids) => {
      const db = await s.store.load();
      await queue.updateQ((q) => { queue.enqueue(q, db, ids, { subject: 'Quick question', body: 'Hi {{firstName}}' }); });
    };

    // A yield that ends within the run: nothing goes out before it, then all of it.
    await enqueue(['a', 'b', 'c']);
    const until = Date.now() + 3000;
    await storage.setJson('gmail-yield', { until: new Date(until).toISOString() });
    const r1 = await queue.processQueue({ budgetMs: 20000 });
    ok(sent.length === 3, 'a yield that ends within the run: everyone is sent', { sent: sent.length, r1 });
    ok(sent.every((x) => x.at >= until - 50), 'and nothing went out before it ended', sent.map((x) => x.at - until));

    // A yield longer than the whole run: nothing is sent, and nobody is lost.
    await s.store.update((d) => { d.candidates.push(person('d', 'Dee Fixture'), person('e', 'Eli Pretend')); });
    await enqueue(['d', 'e']);
    await storage.setJson('gmail-yield', { until: new Date(Date.now() + 60000).toISOString() });
    const before = sent.length;
    const r2 = await queue.processQueue({ budgetMs: 12000 });
    ok(sent.length === before && r2.remaining === 2, 'a yield longer than the run: nothing is sent, both stay queued', { sent: sent.length - before, remaining: r2.remaining });

    await storage.setJson('gmail-yield', { until: new Date(Date.now() - 1000).toISOString() });
    const r3 = await queue.processQueue({ budgetMs: 20000 });
    ok(sent.length === before + 2 && r3.remaining === 0, 'once it has passed, they are sent', { sent: sent.length - before, remaining: r3.remaining });

    // The front of the line: people put first go ahead of everyone already
    // waiting, in their own order, after anyone put first before them; one
    // already waiting further back is moved up, not queued twice.
    await queue.updateQ((q) => { queue.clearQueue(q); });
    await s.store.update((d) => {
      d.candidates.push(...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => person(`n${id}`, `${['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus'][i]} Front`)));
    });
    const db2 = await s.store.load();
    await queue.updateQ((q) => { queue.enqueue(q, db2, ['na', 'nb', 'nc'], null); });
    await queue.updateQ((q) => { queue.enqueue(q, db2, ['nd', 'ne'], null, { front: true }); });
    let order = (await queue.loadQ()).items.map((it) => it.id.slice(1)).join('');
    ok(order === 'deabc', 'put first: ahead of everyone already waiting, in their own order', order);
    let moved = 0;
    await queue.updateQ((q) => { moved = queue.enqueue(q, db2, ['nf', 'nb'], null, { front: true }); });
    const q2 = await queue.loadQ();
    order = q2.items.map((it) => it.id.slice(1)).join('');
    ok(order === 'defbac' && moved === 2 && q2.items.length === 6, 'put first again: after those put first before, and someone waiting further back moved up rather than queued twice', { order, moved });

    // From the import: "Email these first".
    await queue.updateQ((q) => { queue.clearQueue(q); });
    await queue.updateQ((q) => { queue.enqueue(q, db2, ['na', 'nb'], null); });
    const imp = await s.json('POST', '/api/import/commit', {
      rows: [['New One', 'new.one@example.com'], ['New Two', 'new.two@example.com'], ['Cy Front', 'cy.front@example.com']],
      mapping: { name: 0, email: 1 }, headerless: true, source: 'csv', first: true,
    });
    const after = await s.store.load();
    const idOf = (email) => (after.candidates.find((c) => c.email === email) || {}).id;
    order = (await queue.loadQ()).items.map((it) => it.id);
    ok(imp.status === 200 && imp.body.added === 2 && imp.body.first === 3, 'an import with "Email these first": the two new people and the one already listed (never emailed) are put first', imp.body);
    ok(order.join(',') === [idOf('new.one@example.com'), idOf('new.two@example.com'), 'nc', 'na', 'nb'].join(','), 'at the front of the line, in the file\'s order, ahead of those already waiting', order);
    const plain = await s.json('POST', '/api/import/commit', { rows: [['New Three', 'new.three@example.com']], mapping: { name: 0, email: 1 }, headerless: true, source: 'csv' });
    ok(plain.status === 200 && !plain.body.first && (await queue.loadQ()).items.length === 5, 'an import without it leaves the line as it was');
  } finally {
    await s.close();
  }
  done();
})().catch(crash);
