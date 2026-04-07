/**
 * 前端版本号（部署后若希望用户区分是否已更新，可随发布改此值）
 */
export const APP_VERSION = '1.1.0';

/**
 * 向 Service Worker 请求检查远端是否有新版本；若有 waiting 则触发跳过等待（通常由 index.html 的 controllerchange 自动刷新）
 */
export async function checkServiceWorkerUpdate() {
  if (!('serviceWorker' in navigator)) {
    return { ok: false, message: '当前浏览器不支持 Service Worker' };
  }
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) {
    return { ok: true, message: '未启用离线缓存，页面由网络直接加载' };
  }
  try {
    await reg.update();
  } catch (e) {
    return { ok: false, message: `检查失败：${e?.message || e}` };
  }
  if (reg.waiting) {
    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    return { ok: true, message: '发现新版本，正在切换…' };
  }
  if (reg.installing) {
    return { ok: true, message: '正在下载更新，完成后请再点一次「检查更新」或稍后刷新' };
  }
  return {
    ok: true,
    message: '未发现待激活的新缓存版本。若界面仍是旧版，请使用「强制拉取最新」。',
  };
}

/**
 * 清除本域下所有 Cache Storage、注销 SW，并带时间戳重新打开页面（不删 IndexedDB 聊天数据）
 */
export async function forceUpdateAndReload() {
  if (
    !confirm(
      '将清除本站点静态资源缓存并重新加载，以强制获取最新 HTML/JS/CSS（聊天记录等本地数据不会删除）。确定？'
    )
  ) {
    return;
  }
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.unregister();
    }
  } catch (e) {
    console.warn('forceUpdateAndReload', e);
  }
  const u = new URL(window.location.href);
  u.searchParams.set('_cb', String(Date.now()));
  window.location.href = u.toString();
}
