const CACHE_PREFIX = 'interval-timer-pwa-';
const CACHE_NAME = `${CACHE_PREFIX}v38`;
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=38',
  './app.js?v=38',
  './app-core.js?v=38',
  './storage-lock.js?v=38',
  './audio-player.js?v=38',
  './manifest.json',
  './icons/timer-192.png',
  './icons/timer-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.status >= 500) {
            return (await caches.match('./index.html')) || response;
          }
          if (!response.ok) return response;
          const copy = response.clone();
          try {
            const cache = await caches.open(CACHE_NAME);
            await cache.put('./index.html', copy);
          } catch {
            // A successful network response should still be usable when cache writes fail.
          }
          return response;
        })
        .catch(async () => (await caches.match('./index.html')) || Response.error())
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then(async (response) => {
        if (response.status >= 500) {
          return (await caches.match(request)) || response;
        }
        if (response.ok) {
          const copy = response.clone();
          try {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, copy);
          } catch {
            // A full or unavailable cache must not break the online app.
          }
        }
        return response;
      })
      .catch(async () => (await caches.match(request)) || Response.error())
  );
});
