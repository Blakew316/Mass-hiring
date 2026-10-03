// How quick the site is at the live list's size, on a laptop and on a phone.
//   ROOT=<repo copy> PORT=3810 PROFILES=desktop,phone FIXTURE=<dir> node tests/perf/bench.js > result.json
// Every number is milliseconds (or bytes); lower is better. A phone is
// Chromium with the CPU slowed 4x and a 4G connection (9 Mbit/s, 85 ms).
// Compare only runs made the same way on the same machine, interleaved.
const path = require('path');
const { start } = require('./serve');
const { launch } = require('../helpers');
const ROOT = path.resolve(process.env.ROOT || path.join(__dirname, '../..'));
const PORT = Number(process.env.PORT || 3810);
const PROFILES = (process.env.PROFILES || 'desktop,phone').split(',');
const VIEWS = (process.env.VIEWS || 'candidates,texting,template,salesiq,onboarding,settings,import,dashboard').split(',');
const FIXTURE = path.resolve(process.env.FIXTURE || path.join(__dirname, 'fixture-data'));
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const r0 = (n) => (n == null ? null : Math.round(n));

async function serverSide(s) {
  const out = {};
  const times = []; let etag = '';
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    const r = await fetch(s.base + '/api/state', { headers: { cookie: s.cookie, 'accept-encoding': 'gzip' } });
    await r.arrayBuffer();
    times.push(performance.now() - t);
    etag = r.headers.get('etag');
  }
  const plain = await (await fetch(s.base + '/api/state', { headers: { cookie: s.cookie } })).text();
  out.stateMs = r0(med(times)); out.stateRawBytes = Buffer.byteLength(plain);
  const t304 = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); const r = await fetch(s.base + '/api/state', { headers: { cookie: s.cookie, 'if-none-match': etag } }); await r.arrayBuffer(); t304.push(performance.now() - t); out.notModifiedStatus = r.status; }
  out.state304Ms = r0(med(t304));
  // What a page since the compact list asks for instead (a server without it
  // answers the first with the old state and the second with a 404), so both
  // copies go into the browser runs with the answers their pages ask for
  // already made.
  const asked = async (url, headers = {}) => { const t = performance.now(); const r = await fetch(s.base + url, { headers: { cookie: s.cookie, 'accept-encoding': 'gzip', ...headers } }); const b = Buffer.from(await r.arrayBuffer()); return { ms: performance.now() - t, status: r.status, tag: r.headers.get('etag'), bytes: b.length }; };
  const slim = []; let slimTag = '';
  for (let i = 0; i < 5; i++) { const r = await asked('/api/state?v=2'); slim.push(r.ms); slimTag = r.tag; out.slimStateRawBytes = r.bytes; }
  out.slimStateMs = r0(med(slim));
  const slim304 = [];
  for (let i = 0; i < 5; i++) { const r = await asked('/api/state?v=2', { 'if-none-match': slimTag }); slim304.push(r.ms); out.slimNotModifiedStatus = r.status; }
  out.slimState304Ms = r0(med(slim304));
  const list = [];
  for (let i = 0; i < 3; i++) { const r = await asked('/api/candidates?v=2'); list.push(r.ms); out.listStatus = r.status; out.listRawBytes = r.bytes; }
  out.listMs = r0(med(list));
  return out;
}

// Main-thread CPU, from Chromium's own counters (the long-task observer misses
// work done inside a fetch's JSON parse).
async function cpu(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const g = (n) => (metrics.find((m) => m.name === n) || {}).value || 0;
  return { task: g('TaskDuration') * 1000, script: g('ScriptDuration') * 1000, layout: g('LayoutDuration') * 1000, style: g('RecalcStyleDuration') * 1000 };
}
const cpuDelta = (a, b) => ({ cpuMs: Math.round(b.task - a.task), scriptMs: Math.round(b.script - a.script), layoutStyleMs: Math.round(b.layout - a.layout + b.style - a.style) });

async function measureLoad(page, cdp, base) {
  const bytes = { total: 0, byType: {} }; let reqs = 0;
  const types = new Map();
  const onResp = (e) => { types.set(e.requestId, e.type); reqs++; };
  const onFin = (e) => { bytes.total += e.encodedDataLength; const t = types.get(e.requestId) || 'Other'; bytes.byType[t] = (bytes.byType[t] || 0) + e.encodedDataLength; };
  cdp.on('Network.responseReceived', onResp); cdp.on('Network.loadingFinished', onFin);
  const t0 = Date.now();
  await page.goto(base + '/', { waitUntil: 'commit' });
  await cdp.send('Performance.enable').catch(() => {});
  const c0 = await cpu(cdp);
  await page.waitForFunction(() => { const el = document.querySelector('#statTotal'); return el && /\d/.test(el.textContent); }, null, { timeout: 120000, polling: 50 });
  const ready = Date.now() - t0;
  const c1 = await cpu(cdp);
  await page.waitForTimeout(1500);
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const fcp = (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime;
    const lt = (window.__lt || []);
    return { dcl: nav.domContentLoadedEventEnd, fcp, longestTask: Math.max(0, ...lt), heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1e6 : null, nodes: document.getElementsByTagName('*').length };
  });
  cdp.off('Network.responseReceived', onResp); cdp.off('Network.loadingFinished', onFin);
  return { readyMs: ready, ...cpuDelta(c0, c1), dclMs: r0(m.dcl), fcpMs: r0(m.fcp), longestTaskMs: r0(m.longestTask), heapMB: m.heapMB && +m.heapMB.toFixed(1), domNodes: m.nodes, requests: reqs, bytes: Math.round(bytes.total), bytesByType: Object.fromEntries(Object.entries(bytes.byType).map(([k, v]) => [k, Math.round(v)])) };
}

// Click a tab and time it until the next frame has been painted.
async function timeNav(page, view) {
  return page.evaluate(async (v) => {
    const el = document.querySelector(`.nav-item[data-view="${v}"]`);
    if (!el) return null;
    window.__lt = [];
    const t = performance.now();
    el.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const paint = performance.now() - t;
    await new Promise((r) => setTimeout(r, 300));
    return { paintMs: Math.round(paint) };
  }, view);
}

async function profile(browser, s, name) {
  const phone = name === 'phone';
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }
    : { viewport: { width: 1440, height: 900 } });
  const [cn, cv] = s.cookie.split('=');
  await ctx.addCookies([{ name: cn, value: cv, domain: 'localhost', path: '/' }]);
  await ctx.addInitScript(() => {
    window.__lt = [];
    // Room for every request of the run: past the default 250 the browser
    // stops recording, and the polls below are measured from these entries.
    try { performance.setResourceTimingBufferSize(5000); } catch {}
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch {}
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Performance.enable');
  if (phone) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 85, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8 });
  }
  const out = { profile: name };
  out.cold = await measureLoad(page, cdp, s.base);
  out.warm = await measureLoad(page, cdp, s.base);   // HTTP cache + service worker from the first load
  out.nav = {};
  for (const pass of [1, 2]) for (const v of VIEWS) {
    const a = await cpu(cdp);
    const r = await timeNav(page, v);
    const b = await cpu(cdp);
    if (r) out.nav[`${v}${pass === 2 ? '#2' : ''}`] = { ...r, ...cpuDelta(a, b) };
  }
  // Search the candidate list: from the last keystroke to the table changing.
  await timeNav(page, 'candidates');
  out.search = await page.evaluate(async () => {
    const input = document.querySelector('#searchInput'); const tb = document.querySelector('#candidateRows');
    if (!input || !tb) return null;
    let changed = 0; const mo = new MutationObserver(() => { changed = performance.now(); }); mo.observe(tb, { childList: true, subtree: true });
    let t = 0;
    for (const ch of 'smith') { input.value += ch; input.dispatchEvent(new Event('input', { bubbles: true })); t = performance.now(); await new Promise((r) => setTimeout(r, 60)); }
    await new Promise((r) => setTimeout(r, 1500)); mo.disconnect();
    return { lastKeyToRowsMs: changed ? Math.round(changed - t) : null, rows: tb.children.length };
  });
  out.profileOpen = await page.evaluate(async () => {
    const row = document.querySelector('#candidateRows tr[data-id], #candidateRows tr');
    if (!row) return null;
    const t = performance.now(); row.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { paintMs: Math.round(performance.now() - t) };
  });
  await page.keyboard.press('Escape').catch(() => {});
  // A poll that brings nothing new, then one that brings a change (someone
  // who was emailed replies) on the Dashboard: from the poll starting to the
  // Replied count on screen changing (or, for nothing new, to the last
  // answer), with what went over the wire and the main thread's time.
  await timeNav(page, 'dashboard');
  // The page's first reply check goes out about fifteen seconds after it
  // loads, and on the made-up team it changes hundreds of people (no replies
  // are found, so their reply times are cleared). A poll it lands just in
  // front of is timed bringing a third of the list rather than one person,
  // depending on how long the pages above took: let it land, and one poll
  // not timed bring what it changed, first.
  await page.waitForFunction(() => performance.getEntriesByType('resource').some((e) => /\/api\/replies\/check/.test(e.name)), null, { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(phone ? 12000 : 4000);
  // Then the page's own half-minute poll: the two timed below go just after
  // it, so it cannot land in the middle of one and be timed with it (two
  // states fetched and drawn, counted as one poll).
  const states = () => page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\/api\/state/.test(e.name)).length);
  const ticked = await states();
  for (const end = Date.now() + 32000; Date.now() < end && (await states()) === ticked;) await page.waitForTimeout(200);
  await page.waitForTimeout(1500);
  const pollOnce = (waitForChange) => page.evaluate(async (change) => {
    const before = performance.getEntriesByType('resource').length;
    const shown = () => (document.querySelector('#statReplied') || {}).textContent;
    const was = shown();
    const t = performance.now();
    window.dispatchEvent(new Event('online'));
    let doneAt = 0;
    for (let i = 0; i < 1200 && !doneAt; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (change) { if (shown() !== was) doneAt = performance.now(); continue; }
      const got = performance.getEntriesByType('resource').slice(before).filter((e) => /\/api\/(state|candidates)/.test(e.name));
      if (got.length && got.every((e) => e.responseEnd > 0)) doneAt = Math.max(...got.map((e) => e.responseEnd));
    }
    await new Promise((r) => setTimeout(r, 800));
    const all = performance.getEntriesByType('resource').slice(before).filter((e) => /\/api\//.test(e.name));
    return { totalMs: doneAt ? Math.round(doneAt - t) : null, wireBytes: all.reduce((n, e) => n + (e.encodedBodySize || 0), 0), requests: all.map((e) => `${new URL(e.name).pathname}${new URL(e.name).search}`) };
  }, waitForChange);
  const ps0 = await cpu(cdp);
  out.pollSame = await pollOnce(false);
  if (out.pollSame) Object.assign(out.pollSame, cpuDelta(ps0, await cpu(cdp)));
  await s.store.update((d) => { const c = d.candidates.find((x) => x.status === 'emailed'); c.status = 'replied'; c.lastReplyAt = new Date().toISOString(); });
  const pc0 = await cpu(cdp);
  out.pollChange = await pollOnce(true);
  if (out.pollChange) Object.assign(out.pollChange, cpuDelta(pc0, await cpu(cdp)));
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
  out.heapAfterMB = await page.evaluate(() => (performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) : null));
  out.errors = errs.slice(0, 5);
  await ctx.close();
  return out;
}

(async () => {
  const s = await start({ ROOT, PORT, fixture: FIXTURE, blobMs: Number(process.env.BLOB_MS || 0) });
  const result = { root: ROOT, server: await serverSide(s), profiles: [] };
  const browser = await launch();
  for (const p of PROFILES) result.profiles.push(await profile(browser, s, p));
  await browser.close(); s.close();
  console.log(JSON.stringify(result, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
