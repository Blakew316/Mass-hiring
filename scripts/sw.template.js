/* WPI Outreach — the service worker.
 *
 * Generated from scripts/sw.template.js by scripts/build-sw.mjs, which stamps
 * the build constant with a hash of the shell files. Do not edit public/sw.js.
 *
 * This is deliberately the smallest service worker that does the job, because
 * this app sends real email and real text messages to real people, and almost
 * everything a service worker can do to help is also a way to send the wrong
 * thing twice. So:
 *
 *   - It caches the shell — the HTML, CSS and JavaScript — and nothing else.
 *   - It never touches /api, /auth or /webhooks. Not to cache them, not even
 *     to pass them through: it returns without answering, so the browser makes
 *     the request itself. That one rule is what keeps the conditional poll's
 *     304s, the session cookie, the Google sign-in redirect and the open
 *     tracking pixel all working exactly as they did before.
 *   - It never replays a request in the background. A send that failed because
 *     the phone was in a tunnel must fail, visibly, and be sent again by a
 *     person who meant to.
 *   - It does not take over from the previous version behind your back. A page
 *     that is halfway through a send, running last week's code against this
 *     week's API, is the worst thing that could come of any of this.
 *
 * If it fails to register, or the browser has never heard of service workers,
 * the app is byte for byte the app it was before.
 */

const BUILD = '__BUILD__';
const SHELL = `shell-${BUILD}`;
const ASSETS = 'assets-v1';
const FONTS = 'fonts-v1';

/* The whole client. If one of these is missing the app is a blank page, and if
 * one is a different version from the others it is subtly and silently wrong —
 * so they go into one cache, written in one go, named for their own contents. */
const PRECACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/mobile.css',
  '/app.js',
  '/icons.js',
  '/xlsx-lite.js',
  '/manifest.webmanifest',
  '/assets/logo.png',
  '/assets/logo-dark.png',
];

/* Not a cached file: a cached file can be evicted, and then the page that says
 * "you are offline" is itself unreachable. */
const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>WPI Outreach — offline</title><style>
 :root{color-scheme:light dark}
 body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;
   font:16px/1.5 -apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif;
   background:#e8eaf0;color:#1f2430;text-align:center}
 @media (prefers-color-scheme:dark){body{background:#131519;color:#e4e7ef}}
 h1{font-size:20px;margin:0 0 8px}p{margin:0 0 20px;opacity:.75}
 button{font:inherit;font-weight:600;padding:12px 22px;border:0;border-radius:12px;
   background:#1088e8;color:#fff;min-height:44px}
</style></head><body><div>
 <h1>No connection</h1>
 <p>WPI Outreach needs the network to show your candidates.</p>
 <button onclick="location.reload()">Try again</button>
</div></body></html>`;

const offline = () => new Response(OFFLINE_PAGE, {
  status: 503,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
});

// Anything the server decides. Caching a 401, a redirect or a partial response
// is how a service worker locks somebody out of their own app.
const storable = (res) => res && res.status === 200 && (res.type === 'basic' || res.type === 'cors');

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // cache: 'reload' so the install cannot capture whatever the HTTP cache
    // happens to be holding from before the deploy.
    await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
    // No skipWaiting. The new worker waits until the page asks for it.
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // Only the shells: assets-v1 and fonts-v1 outlive a version bump on purpose.
    await Promise.all(names.filter((n) => n.startsWith('shell-') && n !== SHELL).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// Never cached, never intercepted, never rebuilt. Rebuilding the request would
// drop the session cookie and every call would come back 401.
const LIVE = /^\/(api|auth|webhooks)(\/|$)/;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // (1) The five most important lines in the file.
  if (sameOrigin && LIVE.test(url.pathname)) return;

  // (2) A page. Paint the shell straight from the cache — no network wait,
  //     which is what makes a cold launch feel instant — then fall back.
  //     `navigate` and the path check are two independent guards: an API call
  //     is never mode 'navigate', and a /auth path never gets this far.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const shell = await caches.match('/index.html');
      if (shell) return shell;
      try { return await fetch(req); } catch { return offline(); }
    })());
    return;
  }

  if (!sameOrigin) {
    // Fonts, and only fonts. Cache-first, and kept out of the install so one
    // slow CDN cannot stop the app being installable at all.
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
      event.respondWith((async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (storable(res)) (await caches.open(FONTS)).put(req, res.clone());
          return res;
        } catch { return hit || Response.error(); }
      })());
    }
    return;
  }

  // (3) The shell itself. Cache-first from the version cache, never
  //     stale-while-revalidate: revalidating these one at a time is exactly
  //     how app.js ends up a different version from the index.html that
  //     loaded it.
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith((async () => {
      const hit = await caches.match(url.pathname);
      if (hit) return hit;
      try { return await fetch(req); } catch { return offline(); }
    })());
    return;
  }

  // (4) Pictures. They change rarely and matter little, so show the copy we
  //     have and quietly fetch a fresh one for next time.
  if (/^\/(icons|splash|assets)\//.test(url.pathname)) {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      const live = fetch(req).then(async (res) => {
        if (storable(res)) (await caches.open(ASSETS)).put(req, res.clone());
        return res;
      }).catch(() => null);
      return hit || (await live) || Response.error();
    })());
  }

  // (5) Everything else goes to the network, untouched.
});
