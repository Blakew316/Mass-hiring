// A production-like local server for one repo copy: the API exactly as the
// Netlify function answers it (gzip over 1 KB, as netlify/src/api.mjs does),
// and public/ as Netlify's CDN serves it (brotli, ETag/304, the
// Cache-Control rules in netlify.toml). The team comes from a fixture dir
// made by fixture.js.
//   const { start } = require('./serve'); const s = await start({ ROOT, PORT, fixture });
const fs = require('fs'); const path = require('path'); const http = require('http');
const zlib = require('zlib'); const crypto = require('crypto');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8' };
function cacheControl(p) {
  if (/^\/(icons|splash)\//.test(p) || /^\/assets\/fonts\//.test(p)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=0, must-revalidate';
}
async function start({ ROOT, PORT, fixture = path.join(__dirname, 'fixture-data'), password = 'perf-pw', team = 'maverick', blobMs = 0 }) {
  process.env.APP_PASSWORD = password;
  require(path.join(ROOT, 'lib/tenant.js')).adopt(team);
  fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
  fs.cpSync(fixture, path.join(ROOT, 'data'), { recursive: true });
  // With blobMs the data lives in a stand-in for Netlify Blobs (fake-blobs.js)
  // instead of files: every read and write is a network call that takes a
  // round trip of blobMs plus the transfer, and a read naming the current
  // ETag is a 304 with no body, as the real store answers it. It is put in
  // place before anything in ROOT loads lib/storage.js.
  let blobs = null;
  if (blobMs) blobs = require('./fake-blobs').install(ROOT, { latencyMs: blobMs, seed: fixture });
  const google = require(path.join(ROOT, 'lib/google.js'));
  google.status = async () => ({ connected: true, configured: true, email: 'blake@wholesalepayments.com' });
  google.threadMessages = async () => ({ limited: false, messages: [] });
  google.threadReplies = async () => ({ limited: false, replies: [] });
  google.recentInboundThreads = async () => new Set();
  require(path.join(ROOT, 'lib/mailer.js')).sendStatus = async () => ({ ready: true, from: 'Blake Woodruff <blake@wholesalepayments.com>', via: 'gmail-api', reason: '' });
  const app = require(path.join(ROOT, 'app.js'));
  // The function gzips any text answer over 1 KB for a browser that accepts it.
  const express = require(path.join(ROOT, 'node_modules/express'));
  const api = express();
  api.use((req, res, next) => {
    const send = res.send.bind(res);
    res.send = (body) => {
      const buf = typeof body === 'string' ? Buffer.from(body) : Buffer.isBuffer(body) ? body : null;
      if (buf && buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /json|text|javascript/.test(String(res.get('content-type') || 'application/json'))) {
        if (!res.get('content-type')) res.type('application/json');
        res.set('content-encoding', 'gzip'); res.append('vary', 'Accept-Encoding'); res.removeHeader('content-length');
        return send(zlib.gzipSync(buf));
      }
      return send(body);
    };
    next();
  });
  api.use(app);
  const pub = path.join(ROOT, 'public');
  const staticCache = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (/^\/(api|auth|webhooks)(\/|$)/.test(url.pathname)) return api(req, res);
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.join(pub, p);
    if (!file.startsWith(pub) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
    const st = fs.statSync(file);
    let entry = staticCache.get(file);
    if (!entry || entry.mtime !== st.mtimeMs) {
      const raw = fs.readFileSync(file);
      const ext = path.extname(file);
      const comp = /html|javascript|css|json|manifest|svg|plain/.test(TYPES[ext] || '');
      entry = { mtime: st.mtimeMs, raw, br: comp ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }) : null, type: TYPES[ext] || 'application/octet-stream', etag: `"${crypto.createHash('md5').update(raw).digest('hex')}"` };
      staticCache.set(file, entry);
    }
    res.setHeader('content-type', entry.type);
    res.setHeader('cache-control', cacheControl(url.pathname === '/' ? '/' : p));
    res.setHeader('etag', entry.etag);
    if (url.pathname === '/sw.js') res.setHeader('service-worker-allowed', '/');
    if (req.headers['if-none-match'] === entry.etag) { res.statusCode = 304; return res.end(); }
    if (entry.br && /\bbr\b/.test(req.headers['accept-encoding'] || '')) { res.setHeader('content-encoding', 'br'); res.setHeader('vary', 'Accept-Encoding'); return res.end(entry.br); }
    return res.end(entry.raw);
  });
  await new Promise((r) => server.listen(PORT, r));
  const base = `http://localhost:${PORT}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password, team }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const store = require(path.join(ROOT, 'lib/store.js'));
  return { base, cookie, store, blobs, close: () => server.close(), ROOT };
}
module.exports = { start };
