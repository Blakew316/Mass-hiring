/* The Sales IQ questionnaire's own service worker, scoped to /assessment/.
 *
 * It exists for one thing: a candidate on a weak signal who reloads the page
 * still gets the page, and their saved answers with it. So it keeps a copy of
 * the page's few files, always tries the network first (a new version is
 * picked up the moment there is signal), and falls back to the copy only when
 * there is none. It never touches /api — answers are submitted by the page
 * itself, which retries on its own and says so on screen.
 */
const CACHE = 'assessment-v1';
const FILES = ['./', './styles.css', './assessment.js', './logo.png', './favicon-32.png', './apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((n) => n.startsWith('assessment-') && n !== CACHE).map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/assessment/') || url.pathname.endsWith('/sw.js')) return;
  // The page itself is one file whatever its query string (?t=…, ?preview=1).
  const key = req.mode === 'navigate' ? './' : url.pathname;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key === './' ? new URL('./', self.location).href : req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(key === './' ? new URL('./', self.location).href : req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
