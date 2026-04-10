/**
 * 界面展示用版本号（发版时可改）
 *
 * GitHub Pages 发版检查清单：
 * 1) index.html 里 `__GLORY_BUILD__` 与 `js/boot.js?v=数字` 两处数字改成相同新号
 * 2) sw.js 顶部的 CACHE_NAME 改成新桶名（如 glory-phone-v16）
 * 3) 推送后若自己仍看到旧页：浏览器 设置 → 站点数据 → 清除「该 GitHub Pages 域名」数据（一次即可）
 */
export const APP_VERSION = '2.0';

async function fetchLatestBuildToken() {
  try {
    const url = new URL('./index.html', window.location.href);
    url.searchParams.set('_cb', String(Date.now()));
    const res = await fetch(url.toString(), {
      cache: 'no-store',
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
    if (!res.ok) return '';
    const html = await res.text();
    const m = html.match(/__GLORY_BUILD__\s*=\s*['"]?([a-zA-Z0-9._-]+)['"]?/);
    return String(m?.[1] || '').trim();
  } catch {
    return '';
  }
}

/**
 * 向 Service Worker 请求检查远端是否有新版本；若有 waiting 则触发跳过等待（通常由 index.html 的 controllerchange 自动刷新）
 */
export async function checkServiceWorkerUpdate() {
  const localBuild = String(globalThis.__GLORY_BUILD__ ?? '').trim();
  const remoteBuild = await fetchLatestBuildToken();
  if (!('serviceWorker' in navigator)) {
    if (remoteBuild && localBuild && remoteBuild !== localBuild) {
      return { ok: true, message: `检测到新构建 ${remoteBuild}（当前 ${localBuild}），请点击「强制拉取最新」` };
    }
    return { ok: false, message: '当前浏览器不支持 Service Worker' };
  }
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) {
    if (remoteBuild && localBuild && remoteBuild !== localBuild) {
      return { ok: true, message: `检测到新构建 ${remoteBuild}（当前 ${localBuild}），请刷新或点「强制拉取最新」` };
    }
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
  if (remoteBuild && localBuild && remoteBuild !== localBuild) {
    return {
      ok: true,
      message: `远端已是新构建 ${remoteBuild}（当前 ${localBuild}），缓存可能未切换，请点「强制拉取最新」。`,
    };
  }
  return { ok: true, message: '未发现待激活的新缓存版本。若界面仍是旧版，请使用「强制拉取最新」。' };
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
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all((regs || []).map((r) => r.unregister()));
    }
  } catch (e) {
    console.warn('forceUpdateAndReload', e);
  }
  const u = new URL(window.location.href);
  u.searchParams.set('_cb', String(Date.now()));
  window.location.replace(u.toString());
}
