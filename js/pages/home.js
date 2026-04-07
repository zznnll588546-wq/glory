import { navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { getState } from '../core/state.js';
import { APP_ICON_NAMES, icon } from '../components/svg-icons.js';

const APPS = [
  { label: '消息', page: 'chat-list', theme: 'sky' },
  { label: '通讯录', page: 'contacts', theme: 'cream' },
  { label: '微博', page: 'weibo', theme: 'mint' },
  { label: '论坛', page: 'forum', theme: 'peach' },
  { label: '朋友圈', page: 'moments', theme: 'sky' },
  { label: '赛程表', page: 'schedule', theme: 'cream' },
  { label: '时间线', page: 'timeline-select', theme: 'mint' },
  { label: '世界书', page: 'world-book', theme: 'peach' },
  { label: 'AU设定', page: 'au-panel', theme: 'sky' },
  { label: '预设', page: 'preset-editor', theme: 'cream' },
  { label: '线下相遇', page: 'novel-mode', theme: 'mint' },
  { label: '人物书', page: 'character-book', theme: 'sky' },
  { label: '记忆管理', page: 'memory-manager', theme: 'peach' },
  { label: '表情包', page: 'sticker-manager', theme: 'cream' },
  { label: '音乐', page: 'music', theme: 'cream' },
  { label: '电台', page: 'radio', theme: 'mint' },
  { label: '游戏大厅', page: 'game-hall', theme: 'peach' },
];

const DOCK_APPS = [
  { label: '通讯录', page: 'contacts' },
  { label: '设置', page: 'settings' },
  { label: '此时此刻', page: 'now-moment' },
];

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function formatDate(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(date);
}

async function getHomePrefs() {
  const record = await db.get('settings', 'homeScreenPrefs');
  return record?.value || {
    customIcons: {},
    wallpaper: '',
    showLabels: true,
  };
}

async function saveHomePrefs(prefs) {
  await db.put('settings', { key: 'homeScreenPrefs', value: prefs });
}

function defaultAvatarMarkup(user) {
  if (user?.avatar && String(user.avatar).startsWith('data:')) {
    return `<img src="${escapeAttr(user.avatar)}" alt="" />`;
  }
  const name = user?.name || '旅';
  return `<span class="home-profile-fallback">${escapeAttr(name.slice(0, 1))}</span>`;
}

function appIconMarkup(app, prefs) {
  const custom = prefs.customIcons?.[app.page];
  if (custom) {
    return `<img class="home-app-custom-icon" src="${escapeAttr(custom)}" alt="${escapeAttr(app.label)}" />`;
  }
  const iconName = APP_ICON_NAMES[app.page] || 'sparkle';
  return `
    <div class="home-app-art app-theme-${app.theme}">
      <span class="home-app-bubble home-app-bubble-a"></span>
      <span class="home-app-bubble home-app-bubble-b"></span>
      ${icon(iconName, 'home-app-svg')}
    </div>
  `;
}

function dockIconMarkup(app, prefs) {
  const custom = prefs.customIcons?.[app.page];
  if (custom) {
    return `<img class="home-dock-custom-icon" src="${escapeAttr(custom)}" alt="${escapeAttr(app.label)}" />`;
  }
  const iconName = APP_ICON_NAMES[app.page] || 'sparkle';
  return `
    <div class="home-dock-icon-shell">
      ${icon(iconName, 'home-dock-svg')}
    </div>
  `;
}

function tabbarHtml() {
  return `
    <div class="home-dock">
      ${DOCK_APPS.map(
        (app) => `
          <button type="button" class="home-dock-item" data-page="${app.page}">
            <div class="home-dock-icon" data-dock-icon="${app.page}"></div>
            <span class="home-dock-label">${app.label}</span>
          </button>`
      ).join('')}
    </div>
  `;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function openHomeEditor(prefs, onSave) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-home-editor-overlay>
      <div class="modal-sheet modal-sheet-tall">
        <div class="modal-header">
          <h3>主屏幕美化</h3>
          <button type="button" class="navbar-btn" data-close-editor>✕</button>
        </div>
        <div class="modal-body home-editor-body">
          <div class="form-group">
            <label class="form-label">桌面壁纸</label>
            <input type="file" class="form-input home-wallpaper-input" accept="image/*" />
          </div>
          <div class="form-group">
            <label class="form-label">应用图标替换</label>
            <div class="home-editor-list">
              ${APPS.concat([{ label: '设置', page: 'settings' }, { label: '我的', page: 'user-profile' }]).map(
                (app) => `
                  <div class="home-editor-row" data-editor-page="${app.page}">
                    <div class="home-editor-row-meta">
                      <strong>${app.label}</strong>
                      <span>${app.page}</span>
                    </div>
                    <div class="home-editor-row-actions">
                      <label class="btn btn-outline btn-sm">
                        上传
                        <input type="file" class="home-icon-input" data-page="${app.page}" accept="image/*" hidden />
                      </label>
                      <button type="button" class="btn btn-sm home-icon-clear" data-page="${app.page}">清除</button>
                    </div>
                  </div>`
              ).join('')}
            </div>
          </div>
          <button type="button" class="btn btn-primary btn-block" data-save-home-editor>保存美化</button>
        </div>
      </div>
    </div>
  `;

  const nextPrefs = {
    ...prefs,
    customIcons: { ...(prefs.customIcons || {}) },
  };

  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };

  host.querySelector('[data-home-editor-overlay]')?.addEventListener('click', (e) => {
    if (e.target.dataset.homeEditorOverlay !== undefined) close();
  });
  host.querySelector('[data-close-editor]')?.addEventListener('click', close);

  host.querySelectorAll('.home-icon-input').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      nextPrefs.customIcons[input.dataset.page] = await fileToDataUrl(file);
      e.target.value = '';
    });
  });

  host.querySelectorAll('.home-icon-clear').forEach((btn) => {
    btn.addEventListener('click', () => {
      delete nextPrefs.customIcons[btn.dataset.page];
    });
  });

  host.querySelector('.home-wallpaper-input')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    nextPrefs.wallpaper = await fileToDataUrl(file);
    e.target.value = '';
  });

  host.querySelector('[data-save-home-editor]')?.addEventListener('click', async () => {
    await onSave(nextPrefs);
    close();
  });
}

export default async function render(container) {
  const now = new Date();
  const user = getState('currentUser') || (await db.get('users', (await db.get('settings', 'currentUserId'))?.value));
  const prefs = await getHomePrefs();
  const teamName = user?.selectedTeam ? ((await import('../data/teams.js')).TEAMS[user.selectedTeam]?.name || '未选择俱乐部') : '未选择俱乐部';

  const wallpaperStyle = prefs.wallpaper
    ? `style="background-image:url('${escapeAttr(prefs.wallpaper)}')"`
    : '';

  container.className = 'page home-page';
  container.innerHTML = `
    <div class="home-scene ${prefs.wallpaper ? 'has-custom-wallpaper' : ''}" ${wallpaperStyle}>
      <div class="home-snow"></div>
      <div class="home-topbar">
        <div class="home-topbar-brand">NuoOS</div>
        <div class="home-topbar-clock">${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
        <button type="button" class="home-topbar-edit" aria-label="编辑桌面">${icon('edit', 'home-inline-icon')}</button>
      </div>

      <section class="home-hero-card">
        <span class="home-cloud home-cloud-left"></span>
        <span class="home-cloud home-cloud-right"></span>
        <div class="home-hero-avatar">${defaultAvatarMarkup(user)}</div>
        <div class="home-hero-name">${escapeAttr(user?.name || '旅行者')}</div>
        <div class="home-hero-id">@${escapeAttr((user?.name || 'traveler').replace(/\s+/g, '_').toLowerCase())}</div>
        <div class="home-hero-bio">${escapeAttr(user?.bio || '汪！')}</div>
        <div class="home-hero-meta">
          <span>${formatDate(now)}</span>
          <span>·</span>
          <span>${escapeAttr(teamName)}</span>
        </div>
        <div class="home-hero-pills">
          <span class="home-pill">${icon('timeline', 'home-pill-icon')} ${escapeAttr(user?.currentTimeline || 'S8')}</span>
          <span class="home-pill">${icon('sparkle', 'home-pill-icon')} 今日灵感值 86</span>
        </div>
      </section>

      <section class="home-widget-row">
        <div class="home-widget home-clock-card">
          <div class="home-widget-title">当前时间</div>
          <div class="home-widget-main">${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
          <div class="home-widget-sub">${formatDate(now)}</div>
        </div>
        <button type="button" class="home-widget home-theme-card" data-open-home-editor>
          <div class="home-widget-title">桌面主题</div>
          <div class="home-widget-main home-widget-main-icon">${icon('theme', 'home-widget-icon')}</div>
          <div class="home-widget-sub">替换图标 / 壁纸</div>
        </button>
      </section>

      <section class="home-grid">
        ${APPS.map(
          (app) => `
          <button type="button" class="home-app" data-page="${app.page}">
            <div class="home-app-icon" data-app-icon="${app.page}">
              ${appIconMarkup(app, prefs)}
            </div>
            <div class="home-app-label">${app.label}</div>
          </button>`
        ).join('')}
      </section>

      ${tabbarHtml()}
    </div>
  `;

  container.querySelectorAll('[data-page]').forEach((el) => {
    el.addEventListener('click', () => navigate(el.dataset.page));
  });

  container.querySelectorAll('[data-dock-icon]').forEach((el) => {
    const app = DOCK_APPS.find((item) => item.page === el.dataset.dockIcon);
    el.innerHTML = dockIconMarkup(app, prefs);
  });

  const openEditor = () => openHomeEditor(prefs, async (nextPrefs) => {
    await saveHomePrefs(nextPrefs);
    await render(container);
  });

  container.querySelector('.home-topbar-edit')?.addEventListener('click', openEditor);
  container.querySelector('[data-open-home-editor]')?.addEventListener('click', openEditor);
}
