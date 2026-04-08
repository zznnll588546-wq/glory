const CACHE_NAME = 'glory-phone-v16';
const ASSETS = [
  './',
  './index.html',
  './css/variables.css',
  './css/global.css',
  './css/components.css',
  './css/pages.css',
  './js/boot.js',
  './js/app.js',
  './manifest.json',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

function isHtmlNavigation(request) {
  if (request.method !== 'GET') return false;
  if (request.mode === 'navigate') return true;
  const dest = request.destination;
  if (dest === 'document') return true;
  const accept = request.headers.get('accept') || '';
  if (accept.includes('text/html')) {
    const p = new URL(request.url).pathname;
    if (/\.(js|mjs|css|json|png|jpg|jpeg|webp|svg|ico|woff2?)$/i.test(p)) return false;
    return true;
  }
  return false;
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  if (isHtmlNavigation(e.request)) {
    e.respondWith(
      fetch(e.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          }
          return response;
        })
        .catch(() =>
          caches.match(e.request).then((r) => r || caches.match('./index.html'))
        )
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      return fetch(e.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
            return response;
          }
          // 非 2xx 时优先用缓存，避免动态模块短暂 404 直接白屏
          if (cached) return cached;
          return response;
        })
        .catch(() => {
          if (cached) return cached;
          // 始终返回 Response，避免 "Failed to convert value to 'Response'"
          return new Response('Offline', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        });
    })
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
