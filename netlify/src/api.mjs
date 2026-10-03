// Netlify Function (modern Request/Response format) that serves the whole
// Express API. The static dashboard in public/ is served by Netlify's CDN;
// `config.path` below routes only the dynamic paths here.
//
// The modern format matters: Netlify configures Netlify Blobs automatically
// for it (including the endpoint strong-consistency reads need), whereas the
// legacy exports.handler style does not.
import zlib, { gzipSync, brotliCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import serverless from 'serverless-http';
import app from '../../app.js';
import code from '../../lib/code-version.js';

// Deployed, this file is the bundle that holds all of the server's code, and
// lib/ is not there to be read: name it, so the state's tag can carry a
// fingerprint of the code that built the answer (lib/code-version.js).
code.useFile(fileURLToPath(import.meta.url));

// PDFs (the onboarding documents and signed copies) come back as bytes; every
// other response is text, exactly as before.
const lambda = serverless(app, { binary: ['application/pdf'] });

export default async (request, context) => {
  const started = Date.now();
  const url = new URL(request.url);
  try {
    return await handle(request, url, context);
  } catch (err) {
    // Never let an unexpected failure surface as Netlify's bare 502 page:
    // log it (visible under Logs → Functions → api) and answer with the message.
    console.error(`[api] ${request.method} ${url.pathname} crashed after ${Date.now() - started}ms:`, err && err.stack ? err.stack : err);
    const message = `Server error: ${err && err.message ? err.message : String(err)}`;
    if (url.pathname.startsWith('/auth/')) {
      return Response.redirect(new URL(`/#settings?error=${encodeURIComponent(message)}`, url.origin), 302);
    }
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } finally {
    console.log(`[api] ${request.method} ${url.pathname} handled in ${Date.now() - started}ms`);
  }
};

async function handle(request, url, context) {
  const headers = {};
  request.headers.forEach((value, key) => { headers[key] = value; });
  // Where the connection came from, as Netlify's edge placed it — recorded on
  // a signed onboarding packet beside the IP address. Only ever this value:
  // whatever a browser sent under the same name is thrown away first.
  delete headers['x-wpo-geo'];
  const geo = context && context.geo;
  if (geo && (geo.city || (geo.country && geo.country.name))) {
    headers['x-wpo-geo'] = JSON.stringify({
      city: geo.city || '',
      subdivision: geo.subdivision ? { code: geo.subdivision.code || '', name: geo.subdivision.name || '' } : null,
      country: geo.country ? { code: geo.country.code || '', name: geo.country.name || '' } : null,
    });
  }
  const query = {};
  url.searchParams.forEach((value, key) => { query[key] = value; });
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();

  const event = {
    // Netlify routes by config.path in production; the CLI's functions-only
    // dev server mounts at /.netlify/functions/api, so strip that prefix.
    path: url.pathname.replace(/^\/\.netlify\/functions\/api(?=\/|$)/, '') || '/',
    httpMethod: request.method,
    headers,
    queryStringParameters: query,
    body,
    isBase64Encoded: false,
    requestContext: { identity: { sourceIp: headers['x-nf-client-connection-ip'] || '' } },
  };
  const result = await lambda(event, {});

  // serverless-http puts multi-valued headers (Set-Cookie) in multiValueHeaders
  // and single ones in headers; merge without duplicating.
  const out = new Headers();
  const multi = result.multiValueHeaders || {};
  for (const [key, values] of Object.entries(multi)) for (const v of values) out.append(key, v);
  for (const [key, value] of Object.entries(result.headers || {})) {
    if (!(key in multi)) out.append(key, value);
  }
  let respBody = result.isBase64Encoded
    ? Buffer.from(result.body || '', 'base64')
    : (result.body ?? '');
  // Netlify refuses a function response over 6 MB, and a team with ten
  // thousand candidates has a /api/state bigger than that. JSON shrinks
  // about eightfold under gzip, and every browser asks for it.
  const size = typeof respBody === 'string' ? Buffer.byteLength(respBody) : respBody.length;
  let sent = size;
  const accepts = headers['accept-encoding'] || '';
  const tag = result.statusCode === 200 ? out.get('etag') : null;
  const list = Boolean(tag && LIST_TAG.test(tag));
  const encoding = list && /\bbr\b/i.test(accepts) ? 'br' : /\bgzip\b/i.test(accepts) ? 'gzip' : null;
  if (size > COMPRESS_OVER && encoding
      && !out.has('content-encoding') && /json|text|javascript/i.test(out.get('content-type') || '')) {
    respBody = compress(respBody, size, list ? tag : null, encoding);
    sent = respBody.length;
    out.set('content-encoding', encoding);
    out.delete('content-length');
    out.append('vary', 'Accept-Encoding');
  }
  // An answer nearing that limit is said so in the function log, with its
  // size, while there is still room: past 6 MB it would simply fail.
  if (sent > WARN_OVER) {
    console.warn(`[api] ${request.method} ${url.pathname} answered ${mb(sent)}${sent !== size ? ` (${mb(size)} before compression)` : ''}; Netlify refuses an answer over 6 MB`);
  }
  // A 304 (the unchanged 30-second poll) or 204 must have no body at all —
  // Response() throws on even an empty string, which turned every unchanged
  // poll into a 500.
  const status = result.statusCode || 200;
  return new Response(NULL_BODY.has(status) ? null : respBody, { status, headers: out });
}

const NULL_BODY = new Set([101, 204, 205, 304]);

// The whole compact list (GET /api/candidates?v=2, or a sync answered with
// all of it) is the same bytes for every page that asks for one version of
// it, and compressing its 6 MB took ~150 ms of every such answer. Its tag
// names the team and the version (app.js fullListTag), so the last couple
// are kept compressed under it — checked against the size too, so a tag
// could only ever reuse a body of the same length it was made from. Being
// made once per version, it is worth making smaller: brotli, for a browser
// that takes it (every one this app runs in, over https), is some 15% under
// gzip — 2.0 MB rather than 2.3 for 33,000 people, a third of a second on a
// phone's connection — for about the same time to make. Everything else
// is gzipped as it always was.
const LIST_TAG = /^W\/"c2-/;
const zipped = new Map();          // encoding and tag -> { size, body }
function compress(text, size, tag, encoding) {
  const key = tag ? `${encoding} ${tag}` : null;
  const hit = key ? zipped.get(key) : null;
  if (hit && hit.size === size) return hit.body;
  const body = encoding === 'br'
    ? brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size } })
    : gzipSync(text);
  if (key) {
    zipped.delete(key);
    zipped.set(key, { size, body });
    while (zipped.size > 2) zipped.delete(zipped.keys().next().value);
  }
  return body;
}

const COMPRESS_OVER = 1024;

const WARN_OVER = 4 * 1024 * 1024;
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

export const config = {
  path: ['/api/*', '/auth/*', '/webhooks/*'],
};
