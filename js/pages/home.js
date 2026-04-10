import { navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { getState, setState } from '../core/state.js';
import { showToast } from '../components/toast.js';
import { APP_ICON_NAMES, icon } from '../components/svg-icons.js';
import { getVirtualNow } from '../core/virtual-time.js';

const APP_MAP = {
  wechat: { id: 'wechat', label: '微信', page: 'chat-list', theme: 'mint' },
  weibo: { id: 'weibo', label: '微博', page: 'weibo', theme: 'sky' },
  forum: { id: 'forum', label: '论坛', page: 'forum', theme: 'peach' },
  schedule: { id: 'schedule', label: '赛程', page: 'schedule', theme: 'cream' },
  timeline: { id: 'timeline', label: '时间线', page: 'timeline-select', theme: 'mint' },
  profile: { id: 'profile', label: '我的', page: 'user-profile', theme: 'sky' },
  relationship: { id: 'relationship', label: '关系进度', page: 'user-relationship', theme: 'mint' },
  characterBook: { id: 'characterBook', label: '人物书', page: 'character-book', theme: 'cream' },
  worldbook: { id: 'worldbook', label: '世界书', page: 'world-book', theme: 'peach' },
  preset: { id: 'preset', label: '预设', page: 'preset-editor', theme: 'cream' },
  au: { id: 'au', label: 'AU设定', page: 'au-panel', theme: 'sky' },
  novel: { id: 'novel', label: '线下相遇', page: 'novel-mode', theme: 'mint' },
  memory: { id: 'memory', label: '记忆管理', page: 'memory-manager', theme: 'peach' },
  stickers: { id: 'stickers', label: '表情包', page: 'sticker-manager', theme: 'cream' },
  music: { id: 'music', label: '音乐', page: 'music', theme: 'cream' },
  radio: { id: 'radio', label: '电台', page: 'radio', theme: 'mint' },
  game: { id: 'game', label: '游戏大厅', page: 'game-hall', theme: 'peach' },
};

const HOME_GROUPS = [
  { title: '社交', ids: ['wechat', 'weibo', 'forum'] },
  { title: '角色', ids: ['profile', 'relationship', 'characterBook'] },
  { title: '世界与剧情', ids: ['schedule', 'timeline', 'worldbook', 'novel'] },
  { title: '工具箱', ids: ['preset', 'au', 'memory', 'stickers', 'music', 'radio', 'game'] },
];

const DEFAULT_LAYOUT = [
  ['wechat', 'profile', 'relationship', 'characterBook', 'weibo', 'forum', 'schedule', 'timeline', 'worldbook', 'novel'],
  ['preset', 'au', 'memory', 'stickers', 'music', 'radio', 'game'],
];

const DOCK_APPS = [
  { label: '主页', page: 'home' },
  { label: '设置', page: 'settings' },
  { label: '日程表', page: 'now-moment' },
];

const HOME_STYLE_PRESETS = {
  soft: { label: '云朵柔和（默认）' },
  island: { label: '灵动岛卡片（异型）' },
  magazine: { label: '杂志拼贴（异型）' },
};

const DEFAULT_COMPONENT_ORDER = ['hero', 'widgets', 'board'];
const DEFAULT_COMPONENT_ENABLED = { hero: true, widgets: true, board: true };

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
  const base = {
    customIcons: {},
    wallpaper: '',
    showLabels: true,
    layoutPages: DEFAULT_LAYOUT,
    currentPage: 0,
    layoutVersion: 4,
    stylePreset: 'soft',
    componentOrder: [...DEFAULT_COMPONENT_ORDER],
    componentEnabled: { ...DEFAULT_COMPONENT_ENABLED },
    componentSkins: {},
    freeform: { enabled: false, items: [] },
  };
  const raw = record?.value ? { ...base, ...record.value } : base;
  if (Number(raw.layoutVersion || 0) < 4) {
    raw.layoutPages = DEFAULT_LAYOUT.map((p) => [...p]);
    raw.currentPage = 0;
    raw.layoutVersion = 4;
  }
  if (!HOME_STYLE_PRESETS[raw.stylePreset]) raw.stylePreset = 'soft';
  raw.componentOrder = Array.isArray(raw.componentOrder) ? raw.componentOrder.filter((x) => DEFAULT_COMPONENT_ORDER.includes(x)) : [];
  DEFAULT_COMPONENT_ORDER.forEach((id) => {
    if (!raw.componentOrder.includes(id)) raw.componentOrder.push(id);
  });
  raw.componentEnabled = { ...DEFAULT_COMPONENT_ENABLED, ...(raw.componentEnabled || {}) };
  raw.componentSkins = raw.componentSkins && typeof raw.componentSkins === 'object' ? raw.componentSkins : {};
  raw.freeform = raw.freeform && typeof raw.freeform === 'object' ? raw.freeform : { enabled: false, items: [] };
  raw.freeform.enabled = !!raw.freeform.enabled;
  raw.freeform.items = Array.isArray(raw.freeform.items) ? raw.freeform.items : [];
  raw.freeform.pages = Array.isArray(raw.freeform.pages)
    ? raw.freeform.pages.map((p) => (Array.isArray(p) ? p : []))
    : [];
  if (!raw.freeform.pages.length && raw.freeform.items.length) raw.freeform.pages = [raw.freeform.items];
  return raw;
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
  const iconName = APP_ICON_NAMES[app.page] || (app.id === 'wechat' ? 'message' : 'sparkle');
  return `
    <div class="home-app-art app-theme-${app.theme}">
      <span class="home-app-bubble home-app-bubble-a"></span>
      <span class="home-app-bubble home-app-bubble-b"></span>
      ${icon(iconName, 'home-app-svg')}
    </div>
  `;
}

function freeformItemHtml(item, prefs) {
  const x = Math.max(0, Number(item.x) || 0);
  const y = Math.max(0, Number(item.y) || 0);
  const w = Math.max(1, Math.min(6, Number(item.w) || 1));
  const h = Math.max(1, Math.min(8, Number(item.h) || 1));
  const bg = String(item.image || '').trim();
  const radius = item.shape === 'capsule'
    ? '999px'
    : item.shape === 'blob'
      ? '28px 16px 30px 14px'
      : item.shape === 'leaf'
        ? '32px 8px 30px 12px'
        : item.shape === 'wave'
          ? '24px 24px 10px 28px'
          : item.shape === 'roundTall'
            ? '26px'
            : '';
  const bgScale = Math.max(50, Math.min(300, Number(item.bgScale) || 100));
  const bgPosX = Math.max(0, Math.min(100, Number(item.bgPosX) || 50));
  const bgPosY = Math.max(0, Math.min(100, Number(item.bgPosY) || 50));
  const style = `grid-column:${x + 1} / span ${w};grid-row:${y + 1} / span ${h};${bg ? `background-image:url('${escapeAttr(bg)}');background-repeat:no-repeat;background-size:${bgScale}%;background-position:${bgPosX}% ${bgPosY}%;` : ''}${radius ? `border-radius:${radius};` : ''}`;
  if (item.type === 'app') {
    const app = Object.values(APP_MAP).find((a) => a.page === item.page) || { label: item.label || '应用', page: item.page || 'home', id: 'app', theme: 'sky' };
    const labelText = item.label == null ? app.label : String(item.label);
    return `
      <button type="button" class="home-free-item is-app" data-page="${escapeAttr(app.page)}" style="${style}">
        <div class="home-free-item-icon">${appIconMarkup(app, prefs)}</div>
        ${labelText ? `<div class="home-free-item-label">${escapeAttr(labelText)}</div>` : ''}
      </button>
    `;
  }
  const cls = item.type === 'component' ? 'is-component' : 'is-deco';
  const labelText = item.label == null ? (item.type === 'component' ? '组件' : '装饰卡片') : String(item.label);
  return `
    <div class="home-free-item ${cls}" style="${style}">
      ${labelText ? `<div class="home-free-item-label">${escapeAttr(labelText)}</div>` : ''}
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

function normalizeLayout(layoutPages) {
  const validIds = new Set(Object.keys(APP_MAP));
  const seen = new Set();
  const out = Array.isArray(layoutPages) ? layoutPages.map((p) => (Array.isArray(p) ? p.filter((id) => validIds.has(id)) : [])) : [];
  out.forEach((p) => p.forEach((id) => seen.add(id)));
  Object.keys(APP_MAP).forEach((id) => {
    if (!seen.has(id)) {
      if (!out.length) out.push([]);
      out[out.length - 1].push(id);
    }
  });
  if (!out.length) out.push([...DEFAULT_LAYOUT[0]]);
  return out;
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
            <div style="display:flex;gap:8px;align-items:center;">
              <input type="file" class="form-input home-wallpaper-input" accept="image/*" style="flex:1;" />
              <button type="button" class="btn btn-sm home-wallpaper-clear">清除壁纸</button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">主页预设风格（支持异型组件）</label>
            <select class="form-input home-style-preset">
              ${Object.entries(HOME_STYLE_PRESETS).map(([key, val]) => `<option value="${key}" ${prefs.stylePreset === key ? 'selected' : ''}>${val.label}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">应用图标替换</label>
            <div class="home-editor-list">
              ${Object.values(APP_MAP).concat([{ label: '主页', page: 'home' }, { label: '设置', page: 'settings' }, { label: '日程表', page: 'now-moment' }, { label: '我的', page: 'user-profile' }]).map(
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
  host.querySelector('.home-wallpaper-clear')?.addEventListener('click', () => {
    nextPrefs.wallpaper = '';
  });
  host.querySelector('.home-style-preset')?.addEventListener('change', (e) => {
    const next = String(e.target.value || 'soft');
    nextPrefs.stylePreset = HOME_STYLE_PRESETS[next] ? next : 'soft';
  });

  host.querySelector('[data-save-home-editor]')?.addEventListener('click', async () => {
    await onSave(nextPrefs);
    close();
  });
}

function openSignatureEditor(user, onSaved) {
  const host = document.getElementById('modal-container');
  if (!host || !user?.id) return;
  const initial = String(user.signature || '').slice(0, 160);
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-sig-overlay>
      <div class="modal-sheet">
        <div class="modal-header">
          <h3>个性签名</h3>
          <button type="button" class="navbar-btn" data-sig-close>✕</button>
        </div>
        <div class="modal-body">
          <p class="text-hint" style="font-size:12px;margin-bottom:10px;line-height:1.5;">仅装饰主屏幕卡片，不会替代「我的资料」里的简介参与 AI 人设。</p>
          <textarea class="form-input home-sig-input" rows="3" maxlength="160" placeholder="写一句展示在主页的话…"></textarea>
          <button type="button" class="btn btn-primary btn-block" data-sig-save style="margin-top:12px;">保存</button>
        </div>
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  const ta = host.querySelector('.home-sig-input');
  if (ta) ta.value = initial;
  host.querySelector('[data-sig-overlay]')?.addEventListener('click', (e) => {
    if (e.target.dataset.sigOverlay !== undefined) close();
  });
  host.querySelector('[data-sig-close]')?.addEventListener('click', close);
  host.querySelector('[data-sig-save]')?.addEventListener('click', async () => {
    const next = { ...user, signature: (ta?.value || '').trim().slice(0, 160) };
    await db.put('users', next);
    setState('currentUser', next);
    showToast('已保存个性签名');
    close();
    await onSaved(next);
  });
  host.querySelector('.modal-sheet')?.addEventListener('click', (e) => e.stopPropagation());
  ta?.focus();
}

export default async function render(container) {
  const uidRow = await db.get('settings', 'currentUserId');
  const user = getState('currentUser') || (await db.get('users', uidRow?.value));
  const userId = user?.id || uidRow?.value || '';
  const virtualNowTs = await getVirtualNow(userId, Date.now());
  const now = new Date(virtualNowTs);
  const prefs = await getHomePrefs();
  prefs.layoutPages = normalizeLayout(prefs.layoutPages);
  if (Number(prefs.layoutVersion || 0) < 4) prefs.layoutVersion = 4;
  if (!HOME_STYLE_PRESETS[prefs.stylePreset]) prefs.stylePreset = 'soft';
  const inspiration = Number(user?.homeInspiration ?? 86);
  const teamName = user?.selectedTeam ? ((await import('../data/teams.js')).TEAMS[user.selectedTeam]?.name || '未选择俱乐部') : '未选择俱乐部';

  const wallpaperStyle = prefs.wallpaper
    ? `style="background-image:url('${escapeAttr(prefs.wallpaper)}')"`
    : '';

  const componentStyleAttr = (id) => {
    const img = String(prefs.componentSkins?.[id] || '').trim();
    if (!img) return '';
    return `style="background-image:url('${escapeAttr(img)}');background-size:cover;background-position:center;"`;
  };

  const heroSection = `
      <section class="home-hero-card home-component-block" data-home-component="hero" ${componentStyleAttr('hero')}>
        <span class="home-cloud home-cloud-left"></span>
        <span class="home-cloud home-cloud-right"></span>
        <div class="home-hero-avatar">${defaultAvatarMarkup(user)}</div>
        <div class="home-hero-name">${escapeAttr(user?.name || '旅行者')}</div>
        <div class="home-hero-id">@${escapeAttr((user?.name || 'traveler').replace(/\s+/g, '_').toLowerCase())}</div>
        <button type="button" class="home-hero-signature" aria-label="编辑个性签名">
          <span class="home-hero-signature-label">个性签名</span>
          <span class="home-hero-signature-text${user?.signature?.trim() ? '' : ' is-empty'}">${user?.signature?.trim()
            ? escapeAttr(user.signature.trim())
            : '轻点编辑一句装饰主屏的话'}</span>
        </button>
        <div class="home-hero-meta">
          <span>${formatDate(now)}</span>
          <span>·</span>
          <span>${escapeAttr(teamName)}</span>
        </div>
        <div class="home-hero-pills">
          <span class="home-pill">${icon('timeline', 'home-pill-icon')} ${escapeAttr(user?.currentTimeline || 'S8')}</span>
          <button type="button" class="home-pill home-pill-edit-inspiration" style="border:none;background:transparent;cursor:pointer;">${icon('sparkle', 'home-pill-icon')} 今日灵感值 ${Number.isFinite(inspiration) ? inspiration : 86}</button>
        </div>
      </section>
  `;
  const widgetSection = `
      <section class="home-widget-row home-component-block" data-home-component="widgets">
        <div class="home-widget home-clock-card" ${componentStyleAttr('widgetClock')}>
          <div class="home-widget-title">当前时间</div>
          <div class="home-widget-main">${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
          <div class="home-widget-sub">${formatDate(now)}</div>
        </div>
        <button type="button" class="home-widget home-theme-card" data-open-home-customizer ${componentStyleAttr('widgetTheme')}>
          <div class="home-widget-title">桌面主题</div>
          <div class="home-widget-main home-widget-main-icon">${icon('theme', 'home-widget-icon')}</div>
          <div class="home-widget-sub">预览 / 布局 / 图标</div>
        </button>
      </section>
  `;
  const boardSection = `
      <section class="home-board home-component-block" data-home-component="board" ${componentStyleAttr('board')}>
        <div class="home-page-dots">
          ${prefs.layoutPages.map((_, idx) => `<span class="home-page-dot${idx === (prefs.currentPage || 0) ? ' active' : ''}"></span>`).join('')}
        </div>
        <div class="home-group-list">
          ${HOME_GROUPS.map((group) => {
            const pageIds = prefs.layoutPages[prefs.currentPage || 0] || [];
            const icons = pageIds.filter((id) => group.ids.includes(id)).map((id) => APP_MAP[id]).filter(Boolean);
            if (!icons.length) return '';
            return `
              <section class="home-group-card">
                <div class="home-group-title">${escapeAttr(group.title)}</div>
                <div class="home-grid">
                  ${icons.map((app) => `
                    <button type="button" class="home-app" data-page="${app.page}" draggable="true" data-app-id="${app.id}">
                      <div class="home-app-icon" data-app-icon="${app.page}">
                        ${appIconMarkup(app, prefs)}
                      </div>
                      <div class="home-app-label">${app.label}</div>
                    </button>`).join('')}
                </div>
              </section>`;
          }).join('')}
        </div>
        <div class="home-page-actions">
          <button type="button" class="btn btn-outline btn-sm" data-home-newpage>新分页</button>
        </div>
      </section>
  `;
  const sectionMap = { hero: heroSection, widgets: widgetSection, board: boardSection };
  const sectionsHtml = prefs.componentOrder
    .filter((id) => prefs.componentEnabled?.[id] !== false)
    .map((id) => sectionMap[id] || '')
    .join('');
  const freeformPages = Array.isArray(prefs.freeform?.pages) && prefs.freeform.pages.length
    ? prefs.freeform.pages
    : (Array.isArray(prefs.freeform?.items) && prefs.freeform.items.length ? [prefs.freeform.items] : []);
  const freeformEnabled = !!prefs.freeform?.enabled && freeformPages.some((p) => Array.isArray(p) && p.length > 0);
  const freeformPageCount = Math.max(1, freeformPages.length);
  if ((prefs.currentPage || 0) > freeformPageCount - 1) prefs.currentPage = 0;
  const activeFreeformItems = freeformPages[prefs.currentPage || 0] || [];
  const freeformHtml = freeformEnabled
    ? `
      <section class="home-freeform-board">
        <div class="home-page-dots">
          ${Array.from({ length: freeformPageCount }).map((_, idx) => `<span class="home-page-dot${idx === (prefs.currentPage || 0) ? ' active' : ''}"></span>`).join('')}
        </div>
        <div class="home-freeform-canvas">
          ${[...activeFreeformItems]
            .sort((a, b) => (Number(a?.z) || 0) - (Number(b?.z) || 0))
            .map((it) => freeformItemHtml(it, prefs))
            .join('')}
        </div>
      </section>
    `
    : '';

  container.className = 'page home-page';
  container.innerHTML = `
    <div class="home-scene home-style-${escapeAttr(prefs.stylePreset)} ${prefs.wallpaper ? 'has-custom-wallpaper' : ''}" ${wallpaperStyle}>
      <div class="home-snow"></div>
      <div class="home-topbar">
        <div class="home-topbar-brand">Glory</div>
        <div class="home-topbar-clock">${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
        <button type="button" class="home-topbar-edit" data-open-home-customizer aria-label="主页编辑">${icon('edit', 'home-inline-icon')}</button>
      </div>
      ${freeformEnabled ? freeformHtml : sectionsHtml}

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

  container.querySelectorAll('[data-open-home-customizer]').forEach((el) => {
    el.addEventListener('click', () => navigate('home-customizer'));
  });

  const sigBtn = container.querySelector('.home-hero-signature');
  if (sigBtn && user) {
    sigBtn.addEventListener('click', () => {
      openSignatureEditor(user, async () => {
        await render(container);
      });
    });
  }

  container.querySelector('.home-pill-edit-inspiration')?.addEventListener('click', async () => {
    if (!user?.id) return;
    const raw = window.prompt('编辑今日灵感值（0-100）', String(Number.isFinite(inspiration) ? inspiration : 86));
    if (raw == null) return;
    const nextVal = Math.max(0, Math.min(100, Number(raw) || 0));
    const nextUser = { ...user, homeInspiration: nextVal };
    await db.put('users', nextUser);
    setState('currentUser', nextUser);
    await render(container);
  });

  container.querySelector('[data-home-newpage]')?.addEventListener('click', async () => {
    prefs.layoutPages.push([]);
    prefs.currentPage = prefs.layoutPages.length - 1;
    await saveHomePrefs(prefs);
    showToast('已新增分页');
    await render(container);
  });

  let dragId = '';
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swipeTracking = false;
  let mouseSwipeTracking = false;
  const boardEl = container.querySelector('.home-board') || container.querySelector('.home-freeform-board');
  const pageTotal = freeformEnabled ? freeformPageCount : prefs.layoutPages.length;
  boardEl?.addEventListener('touchstart', (e) => {
    const t = e.touches?.[0];
    if (!t) return;
    swipeStartX = t.clientX;
    swipeStartY = t.clientY;
    swipeTracking = true;
  }, { passive: true });
  boardEl?.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (container.classList.contains('home-edit-mode')) return;
    mouseSwipeTracking = true;
    swipeStartX = e.clientX;
    swipeStartY = e.clientY;
  });
  boardEl?.addEventListener('mouseup', async (e) => {
    if (!mouseSwipeTracking) return;
    mouseSwipeTracking = false;
    const dx = e.clientX - swipeStartX;
    const dy = e.clientY - swipeStartY;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0 && (prefs.currentPage || 0) < pageTotal - 1) {
      prefs.currentPage = (prefs.currentPage || 0) + 1;
      await saveHomePrefs(prefs);
      await render(container);
      return;
    }
    if (dx > 0 && (prefs.currentPage || 0) > 0) {
      prefs.currentPage = (prefs.currentPage || 0) - 1;
      await saveHomePrefs(prefs);
      await render(container);
    }
  });
  boardEl?.addEventListener('mouseleave', () => {
    mouseSwipeTracking = false;
  });
  boardEl?.addEventListener('touchend', async (e) => {
    if (!swipeTracking) return;
    swipeTracking = false;
    const t = e.changedTouches?.[0];
    if (!t) return;
    const dx = t.clientX - swipeStartX;
    const dy = t.clientY - swipeStartY;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0 && (prefs.currentPage || 0) < pageTotal - 1) {
      prefs.currentPage = (prefs.currentPage || 0) + 1;
      await saveHomePrefs(prefs);
      await render(container);
      return;
    }
    if (dx > 0 && (prefs.currentPage || 0) > 0) {
      prefs.currentPage = (prefs.currentPage || 0) - 1;
      await saveHomePrefs(prefs);
      await render(container);
    }
  }, { passive: true });

  container.querySelectorAll('[data-app-id]').forEach((el) => {
    let lpTimer = null;
    el.addEventListener('pointerdown', () => {
      lpTimer = setTimeout(() => {
        container.classList.add('home-edit-mode');
      }, 380);
    });
    el.addEventListener('pointerup', () => {
      if (lpTimer) clearTimeout(lpTimer);
    });
    el.addEventListener('pointerleave', () => {
      if (lpTimer) clearTimeout(lpTimer);
    });
    el.addEventListener('dragstart', (e) => {
      if (!container.classList.contains('home-edit-mode')) {
        e.preventDefault();
        return;
      }
      dragId = el.dataset.appId || '';
      e.dataTransfer?.setData('text/plain', dragId);
    });
    el.addEventListener('dragover', (e) => {
      if (!container.classList.contains('home-edit-mode')) return;
      e.preventDefault();
    });
    el.addEventListener('drop', async (e) => {
      if (!container.classList.contains('home-edit-mode')) return;
      e.preventDefault();
      const toId = el.dataset.appId || '';
      if (!dragId || !toId || dragId === toId) return;
      const pageIdx = prefs.currentPage || 0;
      const page = [...(prefs.layoutPages[pageIdx] || [])];
      const from = page.indexOf(dragId);
      const to = page.indexOf(toId);
      if (from < 0 || to < 0) return;
      page.splice(from, 1);
      page.splice(to, 0, dragId);
      prefs.layoutPages[pageIdx] = page;
      await saveHomePrefs(prefs);
      await render(container);
    });
  });

  container.querySelector('.home-scene')?.addEventListener('dblclick', () => {
    container.classList.remove('home-edit-mode');
  });
}
