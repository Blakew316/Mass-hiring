// Netlify Function (modern Request/Response format) that serves the whole
// Express API. The static dashboard in public/ is served by Netlify's CDN;
// `config.path` below routes only the dynamic paths here.
//
// The modern format matters: Netlify configures Netlify Blobs automatically
// for it (including the endpoint strong-consistency reads need), whereas the
// legacy exports.handler style does not.
import { gzipSync } from 'node:zlib';
import serverless from 'serverless-http';
import app from '../../app.js';

const lambda = serverless(app);

export default async (request) => {
  const started = Date.now();
  const url = new URL(request.url);
  try {
    return await handle(request, url);
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

async function handle(request, url) {
  const headers = {};
  request.headers.forEach((value, key) => { headers[key] = value; });
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
  if (size > COMPRESS_OVER && /\bgzip\b/i.test(headers['accept-encoding'] || '')
      && !out.has('content-encoding') && /json|text|javascript/i.test(out.get('content-type') || '')) {
    respBody = gzipSync(respBody);
    out.set('content-encoding', 'gzip');
    out.delete('content-length');
    out.append('vary', 'Accept-Encoding');
  }
  // A 304 (the unchanged 30-second poll) or 204 must have no body at all —
  // Response() throws on even an empty string, which turned every unchanged
  // poll into a 500.
  const status = result.statusCode || 200;
  return new Response(NULL_BODY.has(status) ? null : respBody, { status, headers: out });
}

const NULL_BODY = new Set([101, 204, 205, 304]);

const COMPRESS_OVER = 1024;

export const config = {
  path: ['/api/*', '/auth/*', '/webhooks/*'],
};
