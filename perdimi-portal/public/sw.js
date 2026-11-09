// PERDIMI Studio service worker: the app shell opens instantly and offline; media previews are kept
// once downloaded (they never change), so scrolling back costs no data. API calls are never cached.
const SHELL = 'pcp-shell-v1';
const MEDIA = 'pcp-media-v1';
const SHELL_FILES = ['/', '/app.js', '/manifest.webmanifest', '/icon.svg', '/icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, MEDIA].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/admin') return; // always live

  // previews: cache-first (immutable). Full-quality files are not cached (too big for a phone).
  if (url.pathname.startsWith('/media/') && url.pathname.endsWith('/preview')) {
    e.respondWith(
      caches.open(MEDIA).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      })
    );
    return;
  }
  if (url.pathname.startsWith('/media/')) return;

  // shell: serve cached copy at once, refresh it in the background
  e.respondWith(
    caches.open(SHELL).then(async (c) => {
      const key = url.pathname === '/index.html' ? '/' : url.pathname;
      const hit = await c.match(key);
      const net = fetch(req).then((res) => { if (res.ok) c.put(key, res.clone()); return res; }).catch(() => null);
      return hit || (await net) || new Response('Offline', { status: 503 });
    })
  );
});
