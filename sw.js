const CACHE='courier-pwa-ui-v7';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png','./icons/apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('courier-pwa-')&&k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET'||new URL(e.request.url).origin!==self.location.origin)return;
  e.respondWith((async()=>{
    try{
      const r=await fetch(e.request);
      if(r.ok){const c=await caches.open(CACHE);await c.put(e.request,r.clone())}
      return r;
    }catch(_){
      const cached=await caches.match(e.request);
      if(cached)return cached;
      if(e.request.mode==='navigate')return caches.match('./index.html');
      return Response.error();
    }
  })());
});
