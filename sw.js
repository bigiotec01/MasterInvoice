const CACHE_NAME = 'masterinvoice-v7';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // All requests — network first, fallback cache
  event.respondWith(
    fetch(event.request).then(resp => {
      if (resp.ok && event.request.method === 'GET') {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
      }
      return resp;
    }).catch(() => caches.match(event.request))
  );
});
