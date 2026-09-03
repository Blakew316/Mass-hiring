// Netlify Function (modern Request/Response format) that serves the whole
// Express API. The static dashboard in public/ is served by Netlify's CDN;
// `config.path` below routes only the dynamic paths here.
//
// The modern format matters: Netlify configures Netlify Blobs automatically
// for it (including the endpoint strong-consistency reads need), whereas the
// legacy exports.handler style does not.
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
  const respBody = result.isBase64Encoded
    ? Buffer.from(result.body || '', 'base64')
    : (result.body ?? '');
  return new Response(respBody, { status: result.statusCode || 200, headers: out });
}

export const config = {
  path: ['/api/*', '/auth/*', '/webhooks/*'],
};
