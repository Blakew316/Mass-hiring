// Candidates page on a laptop: which rows are shown and in what order, for
// every sort option, fifty to a page, with the pager's wording and buttons.
// The order is what a person works down, so it is pinned row for row.
const { launch, openPage, ok, done, crash } = require('./helpers');
const H = require('./candidates-helpers');

const nameOf = (c) => c.name || `${c.firstName} ${c.lastName}`.trim() || '—';

// Every row, page by page, from wherever the list is now back to page 1.
async function everyPage(page) {
  const seen = [];
  const pagers = [];
  for (let i = 0; i < 10; i++) {
    seen.push(...await H.rowNames(page));
    if (await page.$eval('#candPager', (el) => el.hidden)) { pagers.push(null); break; }
    pagers.push({ range: await H.text(page, '#pagerRange'), page: await H.text(page, '#pagerPage'),
      prev: await page.$eval('#pagerPrev', (b) => b.disabled), next: await page.$eval('#pagerNext', (b) => b.disabled) });
    if (await page.$eval('#pagerNext', (b) => b.disabled)) break;
    const first = (await H.rowIds(page))[0];
    await page.click('#pagerNext');
    await page.waitForFunction((id) => document.querySelector('#candidateRows tr') && document.querySelector('#candidateRows tr').dataset.id !== id, first);
  }
  return { seen, pagers };
}

async function backToFirst(page) {
  while (!(await page.$eval('#pagerPrev', (b) => b.disabled || document.querySelector('#candPager').hidden))) {
    const first = (await H.rowIds(page))[0];
    await page.click('#pagerPrev');
    await page.waitForFunction((id) => document.querySelector('#candidateRows tr').dataset.id !== id, first);
  }
}

// Choose an order, and wait for page 1 to show the fifty it should.
async function sortBy(page, value, firstFifty) {
  await page.selectOption('#sortBy', value);
  if (firstFifty) await H.settle(page, H.rowNames, firstFifty);
}

(async () => {
  const s = await H.startCandidates(80);
  const P = s.people;
  const browser = await launch();
  const { ctx, page, errors } = await openPage(browser, s, { path: '/#candidates' });
  await H.openCandidates(page);

  // ---- the list as it opens ----
  ok(await H.countText(page) === '150 candidates', 'the count says how many candidates there are', await H.countText(page));
  ok(await page.$eval('#sortBy', (el) => el.value) === 'default', 'it opens in the order people were added');
  ok(await page.$eval('#rankHead', (el) => el.hidden), 'no ranking column unless the list is in texting order');
  ok(!(await H.visible(page, '#candidatesEmpty')) && !(await H.visible(page, '#candidatesNoMatch')), 'neither empty message shows on a full list');
  ok(await page.$eval('#activeFilters', (el) => el.hidden), 'no filter chips when nothing is filtered');

  // ---- Order added: the stored order, fifty to a page ----
  const def = await everyPage(page);
  ok(JSON.stringify(def.seen) === JSON.stringify(P.map(nameOf)), 'Order added: every row, in the order the list holds them', def.seen.slice(0, 5));
  ok(def.pagers.length === 3, 'three pages of fifty', def.pagers);
  ok(JSON.stringify(def.pagers[0]) === JSON.stringify({ range: '1–50 of 150', page: 'Page 1 of 3', prev: true, next: false }), 'page 1: "1–50 of 150", Previous off, Next on', def.pagers[0]);
  ok(JSON.stringify(def.pagers[1]) === JSON.stringify({ range: '51–100 of 150', page: 'Page 2 of 3', prev: false, next: false }), 'page 2: "51–100 of 150", both on', def.pagers[1]);
  ok(JSON.stringify(def.pagers[2]) === JSON.stringify({ range: '101–150 of 150', page: 'Page 3 of 3', prev: false, next: true }), 'page 3: "101–150 of 150", Next off', def.pagers[2]);
  ok((await H.rowIds(page)).length === 50, 'the last page holds the last fifty');
  // Previous goes back one page at a time.
  await page.click('#pagerPrev');
  await page.waitForFunction(() => document.querySelector('#pagerPage').textContent === 'Page 2 of 3');
  ok(JSON.stringify(await H.rowNames(page)) === JSON.stringify(P.slice(50, 100).map(nameOf)), 'Previous shows page 2 again, the same fifty');
  await backToFirst(page);
  ok(await H.text(page, '#pagerRange') === '1–50 of 150', 'and back to page 1');

  // A row reads the way it should: name, email, text column, role, company, status, last emailed.
  const row = await page.$eval(`#candidateRows tr[data-id="${P[1].id}"]`, (tr) => ({
    name: tr.querySelector('.cand-name').textContent.trim(),
    email: tr.querySelector('[data-col="email"]').textContent.trim(),
    role: tr.querySelector('[data-col="role"]').innerText.trim(),
    company: tr.querySelector('[data-col="company"]').innerText.trim(),
    status: tr.querySelector('.status-select').selectedOptions[0].textContent,
    last: tr.querySelector('[data-col="last"] .d-only').textContent.trim(),
  }));
  const c1 = P[1];
  ok(row.name === c1.name && row.email === c1.email && row.role.startsWith(c1.role) && row.company === c1.company, 'a row shows their name, email, role and company', row);
  ok(row.status === { new: 'Not contacted', emailed: 'Emailed', replied: 'Replied', booked: 'Booked', declined: 'Not interested', bounced: 'Bounced' }[c1.status], 'and their status, in words', row.status);
  ok(c1.lastEmailedAt ? /ago$|^[A-Z][a-z]{2} \d+$/.test(row.last) : row.last === 'never', 'and when they were last emailed', row.last);

  // ---- Newest first ----
  const newest = [...P].sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt))).map(nameOf);
  await sortBy(page, 'newest', newest.slice(0, 50));
  const nw = await everyPage(page);
  ok(JSON.stringify(nw.seen) === JSON.stringify(newest), 'Newest first: every row, most recently added at the top', nw.seen.slice(0, 5));
  ok(await H.countText(page) === '150 candidates', 'sorting does not change the count');
  ok(nw.pagers[0].range === '1–50 of 150' && nw.pagers[2].range === '101–150 of 150', 'and pages the same way');

  // Changing the order starts again at page 1.
  await backToFirst(page);
  await page.click('#pagerNext');
  await page.waitForFunction(() => document.querySelector('#pagerPage').textContent === 'Page 2 of 3');
  const byName = [...P].sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email))).map(nameOf);
  await sortBy(page, 'name', byName.slice(0, 50));
  ok(await H.text(page, '#pagerPage') === 'Page 1 of 3', 'choosing another order goes back to page 1');

  // ---- Name A–Z (someone with no name sorts by their address) ----
  const nm = await everyPage(page);
  ok(JSON.stringify(nm.seen) === JSON.stringify(byName), 'Name A–Z: every row, alphabetical', nm.seen.slice(0, 5));
  ok(nm.seen[0] === 'Avery Ashdown' && nm.seen[149] === 'Oakley Zephyr', 'from Avery Ashdown to Oakley Zephyr', [nm.seen[0], nm.seen[149]]);
  ok(nm.seen.includes('—'), 'someone with no name is listed as —, by their address');

  // ---- Best to text first ----
  await backToFirst(page);
  await sortBy(page, 'texting');
  await page.waitForFunction(() => !document.querySelector('#rankHead').hidden && (document.querySelector('#candidateRows tr [data-col="rank"]') || {}).textContent === '1');
  // Every row across the three pages, as the page numbers and explains them.
  const rows = [];
  for (let i = 0; i < 3; i++) {
    rows.push(...await page.$$eval('#candidateRows tr', (trs) => trs.map((tr) => ({
      id: tr.dataset.id, name: tr.querySelector('.cand-name').textContent.trim(),
      rank: tr.querySelector('[data-col="rank"]').textContent.trim(), muted: tr.classList.contains('row-muted'),
      why: (tr.querySelector('.why-text') || {}).textContent || '', not: (tr.querySelector('.cand-sub.muted') || {}).textContent || '',
    }))));
    if (i < 2) {
      const first = (await H.rowIds(page))[0];
      await page.click('#pagerNext');
      await page.waitForFunction((id) => document.querySelector('#candidateRows tr').dataset.id !== id, first);
    }
  }
  const ranked = rows.filter((r) => r.rank !== '—');
  ok(ranked.length === 60, 'sixty of them can be texted and are ranked', ranked.length);
  ok(ranked.every((r, i) => r.rank === String(i + 1) && !r.muted && r.why) && rows.slice(0, 60).every((r) => r.rank !== '—'), 'they come first, numbered 1 to 60, each saying why it is there', rows.slice(0, 60).map((r) => r.rank).join(','));
  ok(JSON.stringify(ranked.slice(0, 3).map((r) => r.name)) === JSON.stringify(['Jules Ashdown', 'Noel Underhill', 'Morgan Thorne']), 'the three best to text are at the top', ranked.slice(0, 3).map((r) => r.name));
  ok(ranked[0].why === 'email bounced — a text is the only way to reach them · in payments now', 'the reason under the first', ranked[0].why);
  const rankedIds = new Set(ranked.map((r) => r.id));
  const rest = rows.slice(60);
  ok(JSON.stringify(rest.map((r) => r.id)) === JSON.stringify(P.filter((c) => !rankedIds.has(c.id)).map((c) => c.id)), 'then everyone else, in the order the list holds them');
  ok(rest.every((r) => r.rank === '—' && r.muted), 'greyed, with a dash for a rank');
  const notWhy = Object.fromEntries(rest.map((r) => [r.id, r.not]));
  const why = Object.fromEntries(['e10', 'e12', 'e15', 'd03', 'b04', 'r05', 'x02', 'e02', 'n01'].map((id) => [id, notWhy[id]]));
  ok(JSON.stringify(why) === JSON.stringify({ e10: 'not texting: already texted', e12: 'not texting: no iMessage account on that number', e15: 'not texting: said no without saying STOP', d03: 'not texting: marked not interested', b04: 'not texting: already booked in', r05: 'not texting: already replied — read it before texting', x02: 'not texting: no sales background', e02: 'not texting: that number cannot be texted', n01: '' }), 'each says why it is not being texted — except someone with no number, whose Text column says so', why);
  ok(rest.filter((r) => r.not).length === 59, 'fifty-nine have a reason; the thirty-one with no number do not', rest.filter((r) => r.not).length);
  await backToFirst(page);

  // Back to Order added: the rank column goes.
  await sortBy(page, 'default', P.slice(0, 50).map(nameOf));
  await page.waitForFunction(() => document.querySelector('#rankHead').hidden);
  ok(JSON.stringify(await H.rowNames(page)) === JSON.stringify(P.slice(0, 50).map(nameOf)), 'Order added again: the stored order, from page 1');
  ok(!(await page.$('#candidateRows [data-col="rank"]')), 'and no rank cells');

  ok(errors.length === 0, 'no page errors', errors);
  ok(H.outside.length === 0, 'nothing reached the outside world', H.outside);
  await ctx.close();
  await browser.close();
  await s.close();
  done();
})().catch(crash);
