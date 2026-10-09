/* Isolated /map-lab/ scope. Never deletes courier-pwa caches or user data. */
'use strict';
const CACHE = 'courier-map-lab-v3';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './map-view.js', './router.js', './worker.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './address-store.js', './data/manifest.json'];
const urls = new Set(ASSETS.map(p => new URL(p, self.registration.scope).href));
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Installation succeeds only when the real dataset is also cached.
    const manifestURL = new URL('./data/manifest.json', self.registration.scope);
    const response = await fetch(new Request(manifestURL, { cache: 'reload' }));
    if (!response.ok) throw new Error('Missing map manifest');
    const manifest = await response.json();
    if (manifest.version !== 3 || !Array.isArray(manifest.files) || manifest.files.some(f => !/^[a-zA-Z0-9_./-]+$/.test(f) || f.includes('..'))) throw new Error('Invalid map manifest');
    // Install atomically. Incomplete new upload leaves the old offline version intact.
    await cache.addAll([...ASSETS, ...manifest.files.map(f => './data/' + f)].map(p => new Request(new URL(p, self.registration.scope), { cache: 'reload' })));
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
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || !(urls.has(url.href) || url.origin === self.location.origin && url.href.startsWith(new URL('./data/', self.registration.scope).href))) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE), cached = await cache.match(event.request);
    return cached || fetch(event.request);
  })());
});
