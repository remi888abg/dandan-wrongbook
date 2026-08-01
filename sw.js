const CACHE = 'ctb-v4';
const PRECACHE = ['./index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './favicon-64.png'];
self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(PRECACHE); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener('fetch', function(e){
  if(e.request.method !== 'GET') return;
  if(e.request.url.indexOf('http') !== 0) return;
  // 网络优先：联网时总是取最新版本并更新缓存；断网时才用缓存（保证离线可用 + 更新即时生效）
  e.respondWith(
    fetch(e.request).then(function(res){
      if(res.ok){
        var cp = res.clone();
        caches.open(CACHE).then(function(c){ c.put(e.request, cp); });
      }
      return res;
    }).catch(function(){
      return caches.match(e.request).then(function(r){
        if(r) return r;
        if(e.request.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
