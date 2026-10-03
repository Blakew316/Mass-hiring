// The two pages that are not the dashboard — the new-hire paperwork portal
// and the Sales IQ questionnaire — load without a page error or a failed
// request: with a good link (the page for that person), with a bad one (a
// plain "this link isn't valid"), and with none (paperwork) or in preview
// (questionnaire). The questionnaire keeps its own small service worker,
// scoped to itself. Making a paperwork link never sends an email.
const { R, startApp, launch, ok, done, crash } = require('./helpers');
const { QUIET, openShell, until } = require('./shell-helpers');

const OFFSET = 180;
const local = (link) => { const u = new URL(link); return u.pathname + u.search; };

(async () => {
  const s = await startApp({ offset: OFFSET });
  // Whatever happens here, nothing is mailed.
  const mailer = require(R('lib/mailer.js'));
  const mailed = [];
  mailer.sendEmail = async (...args) => { mailed.push(args); throw new Error('the tests never send email'); };

  const browser = await launch({ args: QUIET });

  // ---------- paperwork ----------
  const sent = await s.json('POST', '/api/onboarding/send', {
    hire: { firstName: 'Pat', lastName: 'Example', email: 'pat.example@example.com', phone: '(617) 555-0150' },
    options: { sendEmail: false },
  });
  ok(sent.status === 200 && sent.body && /\/paperwork\/\?t=/.test(sent.body.portalLink || ''), 'a paperwork link can be made without sending anything', sent.body);
  ok(mailed.length === 0, 'and nothing was mailed', mailed.length);
  const docs = (sent.body && sent.body.documents) || [];

  for (const phone of [false, true]) {
    const label = `paperwork, good link, ${phone ? 'phone' : 'laptop'}`;
    const v = await openShell(browser, s.base, { at: local(sent.body.portalLink), phone });
    const seen = await v.page.waitForFunction(() => {
      const f = document.querySelector('#pw-form');
      return f && !f.hidden && document.querySelector('#greet-name').textContent;
    }, null, { timeout: 10000 }).then((h) => h.jsonValue(), () => '');
    ok(seen === 'Pat', `${label}: the form opens for the hire, by name`, seen);
    const shown = await v.page.evaluate(() => ({
      gate: document.querySelector('#gate').hidden,
      docs: document.querySelectorAll('#doc-summary-list li').length,
      email: document.querySelector('#pw-form').email.value,
      title: document.title,
    }));
    ok(shown.gate && shown.docs === docs.length && docs.length > 0 && shown.email === 'pat.example@example.com', `${label}: with their details and the documents to sign`, shown);
    ok(v.errors.length === 0, `${label}: no page errors`, v.errors);
    ok(v.failures.length === 0, `${label}: no failed requests to the site`, v.failures);
    await v.ctx.close();
  }

  {
    const v = await openShell(browser, s.base, { at: '/paperwork/' });
    const gate = await v.page.waitForFunction(() => /missing its access code/.test(document.querySelector('#gate').innerText), null, { timeout: 5000 }).then(() => true, () => false);
    ok(gate && await v.page.evaluate(() => document.querySelector('#pw-form').hidden), 'paperwork with no link: says the access code is missing, shows no form');
    ok(v.errors.length === 0 && v.failures.length === 0, 'paperwork with no link: no page errors or failed requests', v.errors.concat(v.failures));
    await v.ctx.close();
  }
  {
    const v = await openShell(browser, s.base, { at: '/paperwork/?t=not-a-real-link' });
    const gate = await v.page.waitForFunction(() => /isn.t valid/.test(document.querySelector('#gate').innerText), null, { timeout: 5000 }).then(() => true, () => false);
    ok(gate && await v.page.evaluate(() => document.querySelector('#pw-form').hidden), 'paperwork with a bad link: says the link is not valid, shows no form');
    ok(v.errors.length === 0, 'paperwork with a bad link: no page errors', v.errors);
    ok(v.failures.every((f) => /\/api\/paperwork\/session → 401/.test(f)), 'and the only refusal is the link check itself', v.failures);
    await v.ctx.close();
  }

  // ---------- the questionnaire ----------
  {
    const v = await openShell(browser, s.base, { at: '/assessment/?preview=1' });
    const ready = await v.page.waitForFunction(() => {
      const w = document.querySelector('#screen-welcome');
      const b = document.querySelector('#btn-start');
      return w && !w.hidden && b && !b.hidden && !b.disabled;
    }, null, { timeout: 10000 }).then(() => true, () => false);
    ok(ready, 'questionnaire preview: the welcome screen is up and can be started');
    await v.page.click('#btn-start');
    const quiz = await v.page.waitForFunction(() => { const q = document.querySelector('[data-screen="quiz"]'); return q && !q.hidden && q.innerText.trim().length > 20; }, null, { timeout: 5000 }).then(() => true, () => false);
    ok(quiz, 'questionnaire preview: starting it shows the first question');
    ok(v.errors.length === 0 && v.failures.length === 0, 'questionnaire preview: no page errors or failed requests', v.errors.concat(v.failures));
    await v.ctx.close();
  }

  const added = await s.json('POST', '/api/iq/candidates', { name: 'Quinn Example', email: 'quinn.example@example.com', phone: '(617) 555-0151' });
  const iq = await s.json('GET', '/api/iq/state');
  const cand = iq.body && (iq.body.candidates || []).find((c) => c.id === (added.body && added.body.id));
  ok(cand && /\/assessment\/\?t=/.test(cand.link || ''), 'a questionnaire link can be made', cand);
  {
    const v = await openShell(browser, s.base, { at: local(cand.link) });
    const ready = await v.page.waitForFunction(() => {
      const b = document.querySelector('#btn-start');
      return b && !b.hidden && !b.disabled;
    }, null, { timeout: 10000 }).then(() => true, () => false);
    ok(ready, 'questionnaire, good link: it can be started');
    // Asked from node until it is there: waitForFunction would take the
    // promise an async check returns as an answer and not wait at all.
    const reg = await until(() => v.page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return r && r.active ? { scope: r.scope, script: r.active.scriptURL } : null;
    }).catch(() => null), { timeout: 10000 });
    ok(reg && reg.scope === `${s.base}/assessment/` && reg.script === `${s.base}/assessment/sw.js`, 'questionnaire, good link: its own worker, scoped to the questionnaire', reg);
    ok(v.errors.length === 0 && v.failures.length === 0, 'questionnaire, good link: no page errors or failed requests', v.errors.concat(v.failures));
    await v.ctx.close();
  }
  {
    const v = await openShell(browser, s.base, { at: '/assessment/?t=not-a-real-link' });
    const refused = await v.page.waitForFunction(() => /isn.t valid/.test(document.querySelector('#screen-welcome .lede').textContent), null, { timeout: 10000 }).then(() => true, () => false);
    ok(refused && await v.page.evaluate(() => document.querySelector('#btn-start').hidden), 'questionnaire, bad link: says the link is not valid, and cannot be started');
    ok(v.errors.length === 0, 'questionnaire, bad link: no page errors', v.errors);
    ok(v.failures.every((f) => /\/api\/assessment\/session\?t=[^ ]* → 404/.test(f)), 'and the only refusal is the link check itself', v.failures);
    await v.ctx.close();
  }

  ok(mailed.length === 0, 'nothing was mailed at any point', mailed.length);
  await browser.close();
  await s.close();
  done();
})().catch(crash);
