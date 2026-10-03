// How long the server takes over the routes the page and the Mac relay use
// most, at the live list's size, with nothing in the way (no browser).
//   ROOT=<repo copy> PORT=3820 FIXTURE=<dir> [BLOB_MS=40] [RUNS=7] node tests/perf/routes.js > routes.json
// BLOB_MS puts the data in a stand-in for Netlify Blobs with that round trip
// (see fake-blobs.js); without it the data is local files. Every number is
// the median in milliseconds, plus what the run wrote to storage (writes,
// bytes) where that is the point. Wipes ROOT/data. Compare only runs made the
// same way on the same machine, interleaved.
const path = require('path');
const { start } = require('./serve');
const ROOT = path.resolve(process.env.ROOT || path.join(__dirname, '../..'));
const PORT = Number(process.env.PORT || 3820);
const FIXTURE = path.resolve(process.env.FIXTURE || path.join(__dirname, 'fixture-data'));
const BLOB_MS = Number(process.env.BLOB_MS || 0);
const RUNS = Number(process.env.RUNS || 7);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor(s.length / 2)]) : null; };

(async () => {
  const s = await start({ ROOT, PORT, fixture: FIXTURE, blobMs: BLOB_MS });
  const R = (p) => require(path.join(ROOT, p));
  // Calendly answers with the interviews the fixture already holds; nothing
  // here reaches the outside world.
  const calendly = R('lib/calendly.js');
  const first = await s.store.load();
  const listing = structuredClone(first.interviews || []).filter((i) => Array.isArray(i.invitees));
  calendly.listInterviews = async () => ({ interviews: structuredClone(listing), skipped: [], complete: true, schedulingUrl: '' });
  await s.store.update((d) => { d.settings.calendlyToken = 'perf-calendly-token'; });

  const call = async (method, url, body, extra = {}) => {
    const t = performance.now();
    const r = await fetch(s.base + url, {
      method,
      headers: { cookie: s.cookie, 'accept-encoding': 'gzip', ...(body ? { 'content-type': 'application/json' } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
    await r.arrayBuffer();
    return { ms: performance.now() - t, status: r.status, etag: r.headers.get('etag') };
  };
  const token = await (await fetch(`${s.base}/api/texts/relay-token`, { method: 'POST', headers: { cookie: s.cookie } })).json();
  const relay = (url, body) => call('POST', url, body, { authorization: `Bearer ${token.token}`, cookie: '' });

  const db = await s.store.load();
  const texted = db.candidates.filter((c) => c.lastTextedAt && c.phone && c.textThread && c.textThread.length).slice(0, 12);
  const emailed = db.candidates.find((c) => c.gmailThreadId);
  const someone = texted[0];
  const writes = () => (s.blobs ? s.blobs.stats.byMethod.put || 0 : null);

  const out = { root: ROOT, blobMs: BLOB_MS, runs: RUNS, routes: {} };
  async function time(name, fn, { warm = 1 } = {}) {
    for (let i = 0; i < warm; i++) await fn(-1 - i);
    const w0 = writes();
    const ms = [];
    const statuses = new Set();
    for (let i = 0; i < RUNS; i++) { const r = await fn(i); ms.push(r.ms); statuses.add(r.status); }
    out.routes[name] = { ms: med(ms), status: [...statuses].join(','), ...(w0 === null ? {} : { writesPerCall: +((writes() - w0) / RUNS).toFixed(2) }) };
  }

  let tag = (await call('GET', '/api/state')).etag;
  await time('state 200, same version, no tag', () => call('GET', '/api/state'));
  await time('state 304', () => call('GET', '/api/state', null, { 'if-none-match': tag }));
  // A poll that brings a change: one candidate edited, then the old tag.
  await time('state 200 after a change', async (i) => {
    await s.store.update((d) => { d.candidates[200].notes = `perf change ${i} ${Date.now()}`; });
    const r = await call('GET', '/api/state', null, { 'if-none-match': tag });
    tag = r.etag || tag;
    return r;
  });
  tag = (await call('GET', '/api/state')).etag;
  await time('texts thread', () => call('GET', `/api/texts/thread?id=${someone.id}`));
  await time('emails thread', () => call('GET', `/api/emails/thread?id=${emailed.id}`));
  await time('email preview', () => call('POST', '/api/preview', { candidateId: emailed.id }));
  await time('text reply', (i) => call('POST', '/api/texts/reply', { id: someone.id, body: `Thanks — talk soon (${i})` }));
  await time('candidate edit, nothing changed', () => call('PATCH', `/api/candidates/${someone.id}`, { notes: someone.notes || '', role: someone.role || '' }));
  await time('relay hello', () => relay('/api/relay/hello', { host: 'Perf-Mac', version: '1.0.0', backend: 'applescript', bluebubbles: true }));
  await time('relay claim', () => relay('/api/relay/claim', {}));
  // A batch from the Mac: delivery and read receipts for a dozen people (seen
  // before after the first run) and three new replies.
  await time('relay events batch', (i) => {
    const at = new Date().toISOString();
    const events = [];
    for (const c of texted) events.push({ phone: c.phone, kind: 'delivered', ts: at }, { phone: c.phone, kind: 'read', ts: at });
    for (const c of texted.slice(0, 3)) events.push({ phone: c.phone, kind: 'reply', ts: at, text: `Sounds good, call me after ${i + 3}` });
    return relay('/api/relay/events', { events });
  });
  await time('relay receipts already recorded', () => {
    const events = [];
    for (const c of texted) events.push({ phone: c.phone, kind: 'delivered', ts: new Date().toISOString() });
    return relay('/api/relay/events', { events });
  });
  await time('reply check, nothing new', () => call('POST', '/api/replies/check'));
  await time('calendly sync, nothing new', () => call('POST', '/api/calendly/sync'));
  await time('settings saved unchanged', () => call('POST', '/api/settings', { fromName: 'Blake Woodruff', followUpDays: '' }));
  tag = (await call('GET', '/api/state')).etag;
  await time('state 304 at the end', () => call('GET', '/api/state', null, { 'if-none-match': tag }), { warm: 0 });
  if (s.blobs) out.blobs = { calls: s.blobs.stats.calls, notModified: s.blobs.stats.notModified, mbIn: +(s.blobs.stats.bytesIn / 1e6).toFixed(1), mbOut: +(s.blobs.stats.bytesOut / 1e6).toFixed(1) };
  console.log(JSON.stringify(out, null, 1));
  s.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
