// Service worker: caches the app shell so the app opens offline.
// Recipes themselves are cached by app.js in localStorage.
// The cache name comes from version.js, so bumping the version clears old caches.
importScripts('version.js');
const CACHE = 'rove-recipes-v' + self.APP_VERSION;
const SHELL = [
  './',
  'index.html',
  'version.js',
  'styles.css',
  'app.js',
  'config.js',
  'manifest.webmanifest',
  'vendor/marked.min.js',
  'vendor/purify.min.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so edits show up right away), falling back to cache when
// offline or when the network is slow.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cacheKey = req.mode === 'navigate' ? 'index.html' : req;
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(cacheKey, res.clone());
      return res;
    });
    try {
      return await Promise.race([
        network,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
      ]);
    } catch {
      const cached = await cache.match(cacheKey, { ignoreSearch: req.mode === 'navigate' });
      return cached || network; // nothing cached: keep waiting on the network
    }
  })());
});
