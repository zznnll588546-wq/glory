import { register, init as routerInit } from './core/router.js';
import { open as dbOpen } from './core/db.js';
import * as db from './core/db.js';
import { setState } from './core/state.js';
import { init as bgInit } from './core/background.js';

async function bootstrap() {
  await dbOpen();

  const uiPrefs = await db.get('settings', 'uiPreferences');
  if (uiPrefs?.value) {
    if (uiPrefs.value.theme) document.documentElement.dataset.theme = uiPrefs.value.theme;
    if (uiPrefs.value.primaryColor) document.documentElement.style.setProperty('--primary', uiPrefs.value.primaryColor);
    if (uiPrefs.value.wallpaper) document.documentElement.style.setProperty('--wallpaper', `url(${uiPrefs.value.wallpaper})`);
  }

  const userIdRecord = await db.get('settings', 'currentUserId');
  if (userIdRecord?.value) {
    const user = await db.get('users', userIdRecord.value);
    if (user) setState('currentUser', user);
  }

  updateStatusTime();
  setInterval(updateStatusTime, 30000);

  registerRoutes();
  routerInit();
  bgInit();
}

function updateStatusTime() {
  const el = document.getElementById('status-time');
  if (el) el.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function registerRoutes() {
  const pages = {
    'home': () => import('./pages/home.js'),
    'chat-list': () => import('./pages/chat-list.js'),
    'backstage-chat-list': () => import('./pages/backstage-chat-list.js'),
    'chat-window': () => import('./pages/chat-window.js'),
    'group-chat': () => import('./pages/group-chat.js'),
    'contacts': () => import('./pages/contacts.js'),
    'settings': () => import('./pages/settings.js'),
    'user-profile': () => import('./pages/user-profile.js'),
    'weibo': () => import('./pages/weibo.js'),
    'forum': () => import('./pages/forum.js'),
    'moments': () => import('./pages/moments.js'),
    'schedule': () => import('./pages/schedule.js'),
    'timeline-select': () => import('./pages/timeline-select.js'),
    'now-moment': () => import('./pages/now-moment.js'),
    'world-book': () => import('./pages/world-book.js'),
    'au-panel': () => import('./pages/au-panel.js'),
    'preset-editor': () => import('./pages/preset-editor.js'),
    'novel-mode': () => import('./pages/novel-mode.js'),
    'memory-manager': () => import('./pages/memory-manager.js'),
    'sticker-manager': () => import('./pages/sticker-manager.js'),
    'music': () => import('./pages/music.js'),
    'radio': () => import('./pages/radio.js'),
    'game-hall': () => import('./pages/game-hall.js'),
    'character-book': () => import('./pages/character-book.js'),
    'chat-details': () => import('./pages/chat-details.js'),
    'message-detail': () => import('./pages/message-detail.js'),
    'weibo-detail': () => import('./pages/weibo-detail.js'),
    'weibo-profile': () => import('./pages/weibo-profile.js'),
    'weibo-dm': () => import('./pages/weibo-dm.js'),
    'weibo-topic': () => import('./pages/weibo-topic.js'),
    'forum-detail': () => import('./pages/forum-detail.js'),
    'user-relationship': () => import('./pages/user-relationship.js'),
  };

  for (const [path, loader] of Object.entries(pages)) {
    register(path, async (container, params) => {
      const mod = await loader();
      await mod.default(container, params);
    });
  }
}

bootstrap().catch(err => {
  console.error('App bootstrap failed:', err);
  const container = document.getElementById('page-container');
  if (container) {
    container.innerHTML = `<div class="placeholder-page"><div class="placeholder-icon">❌</div><div class="placeholder-text">启动失败</div><div class="placeholder-sub">${err.message}</div></div>`;
  }
});
