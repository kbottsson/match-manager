/* App shell cache. Bump VERSION whenever a shell file changes. */
const VERSION = 'mm-v6';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './engine.js',
  './store.js',
  './i18n/index.js',
  './i18n/en.js',
  './i18n/sv.js',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  // Stale-while-revalidate: instant from cache, refreshed in the background.
  e.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req).then((res) => {
        if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || fetched;
    }),
  );
});
