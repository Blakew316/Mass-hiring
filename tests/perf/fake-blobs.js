// A stand-in for Netlify Blobs, in memory, so the app's Blobs path can be
// measured and tested on this machine. It answers the way the real client
// does where lib/storage.js depends on it: an ETag on every read and write, a
// 304 with no body for a read that names the current ETag, a failed
// condition reported as { modified: false }, metadata kept with each entry.
// Every call waits a round trip plus the time the bytes would take to move
// (latencyMs, mbPerSec), which is what a Blobs read costs a deployed
// function. Made-up data only.
//
//   const fake = require('./fake-blobs');
//   const blobs = fake.install(ROOT, { latencyMs: 40, seed: '<dir of .json/.bin files>' });
//   ... require ROOT's modules after this ...
//   blobs.stats  // { calls, notModified, bytesIn, bytesOut, byMethod }
//
// install() must run before anything in ROOT requires lib/storage.js: it sets
// NETLIFY (storage decides at load time whether it is deployed) and puts this
// store where ROOT's require('@netlify/blobs') will find it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function makeStore({ latencyMs = 0, mbPerSec = 100 } = {}) {
  const entries = new Map();          // key -> { body: Buffer, etag, metadata }
  const stats = { calls: 0, notModified: 0, bytesIn: 0, bytesOut: 0, byMethod: {} };
  const wait = (bytes) => new Promise((r) => setTimeout(r, latencyMs + (bytes / (mbPerSec * 1e6)) * 1000));
  const count = (method, bytesOut = 0, bytesIn = 0) => {
    stats.calls += 1;
    stats.byMethod[method] = (stats.byMethod[method] || 0) + 1;
    stats.bytesOut += bytesOut;
    stats.bytesIn += bytesIn;
  };
  const tagOf = (body) => `"${crypto.createHash('md5').update(body).digest('hex')}"`;
  const as = (body, type) => {
    if (type === 'json') return JSON.parse(body.toString('utf8'));
    if (type === 'arrayBuffer') return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    return body.toString('utf8');
  };
  const toBuffer = (data) => (Buffer.isBuffer(data) ? data
    : data instanceof ArrayBuffer ? Buffer.from(data)
      : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : Buffer.from(String(data), 'utf8'));

  const store = {
    stats,
    entries,
    put(key, data, metadata = {}) {
      const body = toBuffer(data);
      const e = { body, etag: tagOf(body), metadata: { ...metadata } };
      entries.set(key, e);
      return e;
    },
    async get(key, { type } = {}) {
      const e = entries.get(key);
      count('get', e ? e.body.length : 0);
      await wait(e ? e.body.length : 0);
      return e ? as(e.body, type) : null;
    },
    async getWithMetadata(key, { type, etag } = {}) {
      const e = entries.get(key);
      if (e && etag && etag === e.etag) {
        count('get', 0);
        stats.notModified += 1;
        await wait(0);
        return { data: null, etag: e.etag, metadata: { ...e.metadata } };
      }
      count('get', e ? e.body.length : 0);
      await wait(e ? e.body.length : 0);
      return e ? { data: as(e.body, type), etag: e.etag, metadata: { ...e.metadata } } : null;
    },
    async getMetadata(key) {
      const e = entries.get(key);
      count('head');
      await wait(0);
      return e ? { etag: e.etag, metadata: { ...e.metadata } } : null;
    },
    async set(key, data, { onlyIfMatch, onlyIfNew, metadata } = {}) {
      const body = toBuffer(data);
      count('put', 0, body.length);
      await wait(body.length);
      const cur = entries.get(key);
      if (onlyIfNew && cur) return { modified: false };
      if (onlyIfMatch && (!cur || cur.etag !== onlyIfMatch)) return { modified: false };
      const e = store.put(key, body, metadata || {});
      return { etag: e.etag, modified: true };
    },
    async setJSON(key, value, opts = {}) {
      return store.set(key, JSON.stringify(value), opts);
    },
    async delete(key) {
      count('delete');
      await wait(0);
      entries.delete(key);
    },
    async list({ prefix = '' } = {}) {
      count('list');
      await wait(0);
      return { blobs: [...entries].filter(([k]) => k.startsWith(prefix)).map(([key, e]) => ({ key, etag: e.etag })), directories: [] };
    },
  };
  return store;
}

// Fill a store from a folder laid out the way lib/storage.js lays out its
// local files (<key>.json, <key>.bin). JSON is stored compact, as the real
// client's setJSON stores it.
function seed(store, dir) {
  const walk = (d, rel) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { walk(path.join(d, ent.name), child); continue; }
      const m = child.match(/^(.*)\.(json|bin)$/);
      if (!m) continue;
      const raw = fs.readFileSync(path.join(d, ent.name));
      store.put(m[1], m[2] === 'json' ? JSON.stringify(JSON.parse(raw.toString('utf8'))) : raw);
    }
  };
  if (dir && fs.existsSync(dir)) walk(dir, '');
}

function install(ROOT, opts = {}) {
  const store = makeStore(opts);
  if (opts.seed) seed(store, opts.seed);
  process.env.NETLIFY = 'true';
  const id = require.resolve('@netlify/blobs', { paths: [path.join(ROOT, 'lib')] });
  require.cache[id] = { id, filename: id, loaded: true, exports: { getStore: () => store } };
  return store;
}

module.exports = { install, makeStore, seed };
