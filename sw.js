const CACHE='courier-pwa-notebook-v29';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png','./icons/apple-touch-icon.png'];
async function removeOldCaches(){
  const keys=await caches.keys();
  await Promise.all(keys.filter(k=>k.startsWith('courier-pwa-')&&k!==CACHE).map(k=>caches.delete(k)));
}
self.addEventListener('install',e=>{
  e.waitUntil((async()=>{const cache=await caches.open(CACHE);await cache.addAll(ASSETS);await self.skipWaiting()})());
});
self.addEventListener('activate',e=>{
  e.waitUntil((async()=>{await removeOldCaches();await self.clients.claim()})());
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET'||new URL(e.request.url).origin!==self.location.origin)return;
  e.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    try{
      const response=await fetch(e.request);
      if(e.request.mode==='navigate')await removeOldCaches();
      if(response.ok)await cache.put(e.request,response.clone());
      return response;
    }catch(_){
      const cached=await cache.match(e.request);
      if(cached)return cached;
      if(e.request.mode==='navigate')return await cache.match('./index.html')||Response.error();
      return Response.error();
    }
  })());
});
