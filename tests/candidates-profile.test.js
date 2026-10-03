// Candidates page on a laptop: a person's profile pop-up. What it shows —
// who they are, their status and badges, the actions that fit them, contact
// details, activity, notes, where they are with Sales IQ and Onboarding docs —
// and what its buttons do: add to Sales IQ / Onboarding docs (stored, nothing
// sent), edit details or add a number, remove (after asking), email, text,
// follow up (the windows open; nothing is sent), and the ways it closes.
const { R, launch, openPage, ok, done, crash } = require('./helpers');
const H = require('./candidates-helpers');

(async () => {
  const s = await H.startCandidates(90);
  const P = s.people;
  const B = s.byId;
  const browser = await launch();
  const { ctx, page, errors } = await openPage(browser, s, { path: '/#candidates' });
  const sendCalls = [];
  for (const path of ['**/api/send', '**/api/queue', '**/api/texts/queue', '**/api/texts/reply', '**/api/emails/reply', '**/api/iq/invite', '**/api/iq/from-pipeline', '**/api/onboarding/send']) {
    await page.route(path, (route) => { sendCalls.push(route.request().url()); route.abort(); });
  }
  await H.openCandidates(page);

  const isOpen = () => page.$eval('#profileModal', (el) => !el.hidden);
  // Bring someone onto the screen by searching for their address, and open them.
  async function open(id) {
    if (await isOpen()) { await page.keyboard.press('Escape'); }
    const q = B[id] ? B[id].email : id;
    // Typing the same search again would redraw the list a beat later (the
    // box waits for typing to stop) — under whatever this test does next.
    if (await page.$eval('#searchInput', (el) => el.value) !== q) await page.fill('#searchInput', q);
    await page.waitForFunction((x) => [...document.querySelectorAll('#candidateRows tr')].some((tr) => tr.dataset.id === x) && document.querySelectorAll('#candidateRows tr').length === 1, id);
    await page.click(`#candidateRows tr[data-id="${id}"] [data-col="company"]`);
    await page.waitForSelector('#profileModal:not([hidden])');
    return read();
  }
  const read = () => page.$eval('#profileModal', (m) => {
    const t = (sel) => (m.querySelector(sel) ? m.querySelector(sel).innerText.replace(/\s+/g, ' ').trim() : null);
    const rows = (sel) => [...m.querySelectorAll(`${sel} .profile-row`)].map((r) => [r.querySelector('dt').innerText.trim(), r.querySelector('dd').innerText.replace(/\s+/g, ' ').trim()]);
    return {
      name: t('#profName'), sub: t('#profSub'),
      status: m.querySelector('#profTags .status-select').selectedOptions[0].textContent,
      badges: [...m.querySelectorAll('#profTags .badge')].map((b) => b.textContent.trim()),
      acts: [...m.querySelectorAll('#profActs .profile-act')].map((b) => b.innerText.replace(/\s+/g, ' ').trim()),
      contact: rows('#profContact'), activity: rows('#profActivity'),
      notes: m.querySelector('#profNotesSec').hidden ? null : t('#profNotes'),
      links: m.querySelector('#profLinksSec').hidden ? null : {
        iq: t('#candIqStatus'), iqActs: [...m.querySelectorAll('#candIqActs button')].map((b) => b.textContent.trim()),
        onb: t('#candOnbStatus'), onbActs: [...m.querySelectorAll('#candOnbActs button')].map((b) => b.textContent.trim()),
      },
      mail: (m.querySelector('#profContact a[href^="mailto:"]') || {}).href || '',
      tel: (m.querySelector('#profContact a[href^="tel:"]') || {}).href || '',
    };
  });
  const date = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const toastTexts = async () => (await H.toasts(page)).map((t) => t.text);

  // ---- someone emailed, followed up, texted ----
  let p = await open('e04');
  const e04 = B.e04;
  ok(p.name === e04.name && p.sub === 'Roofing Sales Rep · Summit Roofing · Boston, MA', 'their name, and role · company · location under it', p);
  ok(p.status === 'Emailed' && p.badges.length === 0, 'their status, and no badges when on neither Sales IQ nor Onboarding docs', p);
  ok(JSON.stringify(p.acts) === JSON.stringify(['Email', 'Text', 'Follow up', 'Sales IQ', 'Onboarding']), 'actions: Email, Text, Follow up (they were emailed), Sales IQ, Onboarding', p.acts);
  ok(JSON.stringify(p.contact) === JSON.stringify([['Email', e04.email], ['Phone', '(617) 555-2043'], ['Role', 'Roofing Sales Rep'], ['Company', 'Summit Roofing'], ['Location', 'Boston, MA']]), 'contact: email, the number written properly, role, company, location', p.contact);
  ok(p.mail === `mailto:${e04.email}` && p.tel === 'tel:+16175552043', 'the email and number are links to mail and call', [p.mail, p.tel]);
  ok(JSON.stringify(p.activity) === JSON.stringify([['Added', date(e04.addedAt)], ['Emailed', '8h ago — Open to a new sales role? · 2 follow-ups'], ['Texted', '1h ago · Read Open texts'], ['Source', 'csv']]), 'activity: added, emailed (subject, follow-ups), texted (how it went), source', p.activity);
  ok(p.notes === null, 'no notes section when there are none');
  ok(JSON.stringify(p.links) === JSON.stringify({ iq: 'Not on the Sales IQ list', iqActs: ['Add to Sales IQ', 'Send questionnaire'], onb: 'Not in Onboarding docs', onbActs: ['Add to Onboarding docs', 'Send packet'] }), 'Sales IQ and Onboarding docs: on neither, with the next steps', p.links);

  // ---- adding them to Sales IQ and Onboarding docs, from here ----
  const siq = require(R('lib/salesiq.js'));
  const onboarding = require(R('lib/onboarding.js'));
  await page.click('#candIqActs [data-link="iq-add"]');
  await H.until(page, async () => (await toastTexts()).includes(`${e04.firstName} is on the Sales IQ list.`));
  ok((await toastTexts()).includes(`${e04.firstName} is on the Sales IQ list.`), '"Add to Sales IQ" says so', await toastTexts());
  const iqRec = (await siq.load()).candidates.find((c) => c.crmId === 'e04');
  ok(iqRec && iqRec.status === 'added' && iqRec.email === e04.email, 'the server put them on the Sales IQ list, not sent');
  await H.until(page, async () => (await read()).links.iq === 'On the list — questionnaire not sent');
  p = await read();
  ok(p.links.iq === 'On the list — questionnaire not sent' && JSON.stringify(p.links.iqActs) === JSON.stringify(['Send questionnaire']), 'the profile now says they are on the list, and offers to send it', p.links);
  ok(JSON.stringify(p.badges) === JSON.stringify(['Sales IQ · not sent']), 'with a badge by their name', p.badges);
  await page.click('#candOnbActs [data-link="onb-add"]');
  await H.until(page, async () => (await toastTexts()).includes(`${e04.firstName} is on the Onboarding docs pipeline.`));
  const onbRec = (await onboarding.load()).candidates.find((c) => c.crmId === 'e04');
  ok(onbRec && onbRec.applicant.email === e04.email && (await onboarding.load()).sends.length === 5, '"Add to Onboarding docs": stored on the pipeline, no packet sent');
  await H.until(page, async () => (await read()).links.onb === 'On the pipeline — packet not sent');
  p = await read();
  ok(p.links.onb === 'On the pipeline — packet not sent' && JSON.stringify(p.links.onbActs) === JSON.stringify(['Open card', 'Send packet']), 'the profile now says they are on the pipeline', p.links);
  ok(JSON.stringify(p.badges) === JSON.stringify(['Sales IQ · not sent', 'Docs · not sent']), 'two badges', p.badges);
  const rowBadges = await H.settle(page, () => page.$eval('#candidateRows tr[data-id="e04"] .cand-iq', (el) => el.textContent.replace(/\s+/g, ' ').trim()), 'Sales IQ · not sent Docs · not sent');
  ok(rowBadges === 'Sales IQ · not sent Docs · not sent', 'and their row carries both', rowBadges);

  // ---- Email, Text and Follow up open their windows (nothing is sent) ----
  await page.click('#profActs [data-act="act-email"]');
  await page.waitForSelector('#composeModal:not([hidden])');
  ok(await isOpen() === false && await H.text(page, '#composeTitle') === `Email ${e04.name}`, 'Email: the profile closes and a letter to them opens', await H.text(page, '#composeTitle'));
  await page.click('#composeModal [data-close]');
  await open('e04');
  await page.click('#profActs [data-act="act-followup"]');
  await page.waitForSelector('#composeModal:not([hidden])');
  ok(await H.text(page, '#composeTitle') === `Follow up with ${e04.name}` && await H.text(page, '#composeSendBtn') === 'Send follow-up', 'Follow up: a reply in their thread', await H.text(page, '#composeTitle'));
  await page.click('#composeModal [data-close]');
  await open('e04');
  await page.click('#profActs [data-act="act-text"]');
  await page.waitForSelector('#textComposeModal:not([hidden])');
  ok(await H.text(page, '#textComposeTitle') === `Text ${e04.name}` && await H.text(page, '#textComposeSendBtn') === 'Send text', 'Text: a text to them', await H.text(page, '#textComposeTitle'));
  await page.click('#textComposeModal [data-close]');

  // ---- someone who replied, by email and by text ----
  p = await open('r03');
  ok(p.status === 'Replied' && JSON.stringify(p.acts) === JSON.stringify(['Email', 'Text', 'Sales IQ', 'Onboarding']), 'replied: no Follow up', p.acts);
  const act = Object.fromEntries(p.activity);
  ok(act.Replied === '2h ago Open conversation' && act.Texted === '5h ago · Replied Open texts', 'activity says they replied, with a way into each conversation', p.activity);
  await page.click('#profActivity [data-act="act-openthread"]');
  await page.waitForFunction(() => document.querySelector('#view-texting.active'));
  ok(await isOpen() === false, '"Open texts" goes to their texts');
  await page.evaluate(() => document.querySelector('.nav-item[data-view="candidates"]').click());
  await H.openCandidates(page);
  await open('r03');
  await page.click('#profActivity [data-act="act-openmail"]');
  await page.waitForFunction(() => document.querySelector('#view-template.active'));
  ok(true, '"Open conversation" goes to their email');
  await page.evaluate(() => document.querySelector('.nav-item[data-view="candidates"]').click());
  await H.openCandidates(page);

  // ---- booked, signed, Sales IQ done ----
  p = await open('b05');
  ok(p.status === 'Booked' && JSON.stringify(p.badges) === JSON.stringify(['Docs signed']), 'booked, and their paperwork is signed', p.badges);
  ok(/^Intro call · [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M · Join link$/.test(Object.fromEntries(p.activity).Interview || ''), 'their interview: what, when, and a join link', Object.fromEntries(p.activity).Interview);
  ok(await page.$eval('#profActivity a[target="_blank"]', (a) => a.href) === 'https://example.com/join/b05', 'the join link opens the meeting');
  ok(p.links.onb === 'Signed and returned their paperwork' && JSON.stringify(p.links.onbActs) === JSON.stringify(['See signed paperwork']), 'Onboarding docs: signed', p.links);
  p = await open('e20');
  ok(JSON.stringify(p.badges) === JSON.stringify(['Sales IQ 92/100']), 'Sales IQ done: their score by their name', p.badges);
  ok(p.links.iq === 'Finished — Sales IQ 92/100' && JSON.stringify(p.links.iqActs) === JSON.stringify(['See result']), 'and "Finished", with a way to see the result', p.links);
  p = await open('e22');
  ok(p.links.iq === 'Questionnaire sent — waiting on their answers' && JSON.stringify(p.links.iqActs) === JSON.stringify(['Send again']) && JSON.stringify(p.badges) === JSON.stringify(['Questionnaire sent']), 'Sales IQ sent: waiting, "Send again"', p.links);
  p = await open('e24');
  ok(p.links.iq === 'Questionnaire sent — waiting on their answers', 'known to Sales IQ by another address, still found by their id', p.links);
  p = await open('n06');
  ok(p.links.iq === 'On the list — questionnaire not sent' && JSON.stringify(p.links.iqActs) === JSON.stringify(['Send questionnaire']), 'Sales IQ added: not sent yet', p.links);
  p = await open('e32');
  ok(p.links.onb === 'Packet sent — waiting on their signature' && JSON.stringify(p.links.onbActs) === JSON.stringify(['Open card', 'Send again']) && p.badges.includes('Docs sent'), 'Onboarding sent: waiting on their signature', p.links);
  p = await open('e34');
  ok(p.links.onb === 'On the pipeline — packet not sent', 'a packet that never went (email not set up) is still "not sent"', p.links);

  // ---- no number, a bad number, notes ----
  p = await open('n01');
  const n01 = B.n01;
  ok(p.status === 'Not contacted' && JSON.stringify(p.acts) === JSON.stringify(['Email', 'Add number', 'Sales IQ', 'Onboarding']), 'no number: "Add number" instead of Text, and no Follow up before any email', p.acts);
  ok(JSON.stringify(p.contact[1]) === JSON.stringify(['Phone', 'Add a number']), 'the Phone line offers to add one', p.contact);
  ok(JSON.stringify(p.activity.slice(0, 2)) === JSON.stringify([['Added', date(n01.addedAt)], ['Emailed', 'not yet']]) && Object.fromEntries(p.activity).Source === 'manual', 'activity: not emailed yet; added by hand', p.activity);
  ok(p.notes === 'Met at the spring job fair', 'their notes', p.notes);
  p = await open('e02');
  ok(p.acts[1] === 'Fix number' && JSON.stringify(p.contact[1]) === JSON.stringify(['Phone', `${B.e02.phone} · can’t be texted`]), 'a number that cannot be texted: "Fix number", and the Phone line says so', p.contact[1]);

  // ---- Add number: through the edit window, and the list follows ----
  p = await open('n01');
  await page.click('#profActs [data-act="act-addnumber"]');
  await page.waitForSelector('#addModal:not([hidden])');
  ok(await isOpen() === false && await H.text(page, '#addModalTitle') === `Edit ${n01.name}` && await H.text(page, '#addSaveBtn') === 'Save changes', 'Add number opens their details to edit', await H.text(page, '#addModalTitle'));
  const fields = await page.$$eval('#addModal input', (is) => Object.fromEntries(is.map((i) => [i.id, i.value])));
  ok(JSON.stringify(fields) === JSON.stringify({ addFirst: n01.firstName, addLast: n01.lastName, addEmail: n01.email, addPhone: '', addRole: n01.role, addCompany: n01.company, addLocation: n01.location, addNotes: n01.notes }), 'filled in with what is on file', fields);
  await H.focused(page, 'addPhone');
  ok(true, 'with the cursor in the number');
  await page.fill('#addPhone', '617 555 2999');
  ok(await H.text(page, '#addPhoneHint') === 'Textable — will be saved as (617) 555-2999.', 'it says, as it is typed, that the number can be texted', await H.text(page, '#addPhoneHint'));
  await page.fill('#addPhone', '617 555 0199');
  ok(/Not a number we can text/.test(await H.text(page, '#addPhoneHint')), 'and when it cannot', await H.text(page, '#addPhoneHint'));
  await page.fill('#addPhone', '617 555 2999');
  await page.click('#addSaveBtn');
  await H.until(page, async () => (await toastTexts()).includes('Saved. (617) 555-2999 is ready to text.'));
  ok((await toastTexts()).includes('Saved. (617) 555-2999 is ready to text.'), 'saved, and ready to text', await toastTexts());
  const saved = (await s.store.load()).candidates.find((c) => c.id === 'n01');
  ok(saved.phone === '617 555 2999' && saved.email === n01.email && saved.name === n01.name && saved.status === 'new', 'the server stores the number; nothing else about them changed', saved);
  await H.until(page, async () => ((await H.pills(page)).find((x) => x.label === 'Needs a number') || {}).n === '53');
  ok(((await H.pills(page)).find((x) => x.label === 'Needs a number') || {}).n === '53', '"Needs a number" goes down by one');
  const pip = await page.$eval('#candidateRows tr[data-id="n01"] [data-col="text"]', (td) => td.innerText.trim());
  ok(pip === '(617) 555-2999', 'their Text column shows the number', pip);

  // ---- Edit details ----
  p = await open('n01');
  await page.click('#profEdit');
  await page.waitForSelector('#addModal:not([hidden])');
  await H.focused(page, 'addFirst');
  await page.fill('#addRole', 'Senior Account Executive');
  await page.click('#addSaveBtn');
  await H.until(page, async () => (await s.store.load()).candidates.find((c) => c.id === 'n01').role === 'Senior Account Executive');
  ok((await s.store.load()).candidates.find((c) => c.id === 'n01').role === 'Senior Account Executive', 'Edit details: a new role is stored');
  await H.until(page, async () => (await page.$eval('#candidateRows tr[data-id="n01"] [data-col="role"]', (td) => td.innerText.trim())) === 'Senior Account Executive');
  ok(await page.$eval('#candidateRows tr[data-id="n01"] [data-col="role"]', (td) => td.innerText.trim()) === 'Senior Account Executive', 'and their row shows it');

  // ---- the team's own people, and someone with no name ----
  p = await open('e40');
  ok(JSON.stringify(p.acts) === JSON.stringify(['Email', 'Text', 'Follow up']) && p.links === null, 'one of the team: no Sales IQ or Onboarding docs anywhere in their profile', p);
  p = await open('n40');
  ok(p.name === 'no.name.n40@example.com', 'someone with no name is titled by their address', p.name);

  // ---- opening and closing ----
  await page.keyboard.press('Escape');
  ok(await isOpen() === false, 'Escape closes it');
  await open('e04');
  await page.click('#profileModal .profile-close');
  ok(await isOpen() === false, 'so does the ×');
  await open('e04');
  await page.mouse.click(5, 5);
  ok(await isOpen() === false, 'and a click outside it');
  await page.press('#candidateRows tr[data-id="e04"]', 'Enter');
  ok(await isOpen() && (await read()).name === e04.name, 'Enter on a row opens it from the keyboard');
  await page.keyboard.press('Escape');
  await page.click('#candidateRows tr[data-id="e04"] .row-check');
  ok(await isOpen() === false, 'ticking the box does not open it');
  await page.click('#candidateRows tr[data-id="e04"] .row-check');
  await page.click('#candidateRows tr[data-id="e04"] .status-select');
  await page.keyboard.press('Escape');
  ok(await isOpen() === false, 'nor does opening the status menu');

  // ---- Remove, only once confirmed ----
  await open('n02');
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
  await page.click('#profRemove');
  await page.waitForTimeout(200);
  ok(asked === `Remove ${B.n02.name} from the list?` && await isOpen(), 'Remove asks first; saying no keeps them, profile still open', asked);
  ok((await s.store.load()).candidates.some((c) => c.id === 'n02'), '  and on the server');
  page.once('dialog', (d) => d.accept());
  await page.click('#profRemove');
  await H.until(page, async () => !(await s.store.load()).candidates.some((c) => c.id === 'n02'));
  const db = await s.store.load();
  ok(!db.candidates.some((c) => c.id === 'n02') && db.candidates.length === 149 && (db.removedCandidates || []).some((r) => r.id === 'n02'), 'saying yes removes them on the server, and remembers that they were removed');
  await page.fill('#searchInput', '');
  await H.until(page, async () => (await H.countText(page)) === '149 candidates');
  ok(await H.countText(page) === '149 candidates' && await isOpen() === false, 'the list says 149, and the profile is closed', await H.countText(page));
  ok(!(await H.rowIds(page)).includes('n02') && P.length === 150, 'they are gone from the rows');

  ok(sendCalls.length === 0, 'nothing was sent from the page', sendCalls);
  ok(errors.length === 0, 'no page errors', errors);
  ok(H.outside.length === 0, 'nothing reached the outside world', H.outside);
  await ctx.close();
  await browser.close();
  await s.close();
  done();
})().catch(crash);
