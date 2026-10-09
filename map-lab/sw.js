/* Isolated /map-lab/ scope. Never deletes courier-pwa caches or user data. */
'use strict';
const CACHE = 'courier-map-lab-v2';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './map-view.js', './router.js', './worker.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './data/moscow-test.json.gz'];
const urls = new Set(ASSETS.map(p => new URL(p, self.registration.scope).href));
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Installation succeeds only when the real dataset is also cached.
    await cache.addAll(ASSETS.map(p => new Request(new URL(p, self.registration.scope), { cache: 'reload' })));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('courier-map-lab-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !urls.has(event.request.url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE), cached = await cache.match(event.request);
    return cached || fetch(event.request);
  })());
});
