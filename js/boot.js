/**
 * 仅负责带版本号加载主入口 + 注册 Service Worker（版本号只改 ../index.html 里一处 BUILD）
 */
const BUILD = globalThis.__GLORY_BUILD__ ?? '20';

const appPromise = import(`./app.js?v=${encodeURIComponent(BUILD)}`);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register(`sw.js?v=${encodeURIComponent(BUILD)}`)
    .then(async (registration) => {
      registration.update().catch(() => {});
      if (registration.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
      registration.addEventListener('updatefound', () => {
        const nextWorker = registration.installing;
        nextWorker?.addEventListener('statechange', () => {
          if (nextWorker.state === 'installed' && navigator.serviceWorker.controller) {
            nextWorker.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    })
    .catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!globalThis.__gloryReloading) {
      globalThis.__gloryReloading = true;
      globalThis.location.reload();
    }
  });
}

await appPromise;
