import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { icon, APP_ICON_NAMES } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';

const HOME_STYLE_PRESETS = {
  soft: { label: '云朵柔和（默认）' },
  island: { label: '灵动岛卡片（异型）' },
  magazine: { label: '杂志拼贴（异型）' },
};

const APPS = [
  { label: '微信', page: 'chat-list' },
  { label: '微博', page: 'weibo' },
  { label: '论坛', page: 'forum' },
  { label: '赛程', page: 'schedule' },
  { label: '时间线', page: 'timeline-select' },
  { label: '我的', page: 'user-profile' },
  { label: '关系进度', page: 'user-relationship' },
  { label: '人物书', page: 'character-book' },
  { label: '世界书', page: 'world-book' },
  { label: '线下相遇', page: 'novel-mode' },
];

const COMPONENT_PRESETS = {
  hero: { label: '头像主卡片', w: 4, h: 3 },
  widgets: { label: '时间/主题双卡片', w: 4, h: 2 },
  board: { label: '应用分组面板', w: 6, h: 4 },
};
const TEMPLATE_PRESETS = {
  balanced: {
    label: '均衡双栏',
    stylePreset: 'soft',
    pages: [[
      { type: 'component', componentKey: 'hero', label: '', x: 0, y: 0, w: 3, h: 7, z: 1, shape: 'roundTall' },
      { type: 'component', componentKey: 'widgets', label: '', x: 3, y: 0, w: 3, h: 3, z: 2, shape: 'capsule' },
      { type: 'deco', label: '', x: 3, y: 3, w: 3, h: 2, z: 0, shape: 'blob' },
      { type: 'app', page: 'chat-list', label: '', x: 3, y: 5, w: 1, h: 1, z: 3 },
      { type: 'app', page: 'weibo', label: '', x: 4, y: 5, w: 1, h: 1, z: 3 },
      { type: 'app', page: 'timeline-select', label: '', x: 5, y: 5, w: 1, h: 1, z: 3 },
      { type: 'app', page: 'user-profile', label: '', x: 3, y: 6, w: 1, h: 1, z: 3 },
      { type: 'app', page: 'character-book', label: '', x: 4, y: 6, w: 1, h: 1, z: 3 },
      { type: 'app', page: 'world-book', label: '', x: 5, y: 6, w: 1, h: 1, z: 3 },
    ]],
  },
  kittyPink: {
    label: '奶油粉萌（图示风）',
    stylePreset: 'magazine',
    pages: [[
      { type: 'component', componentKey: 'hero', label: '', x: 0, y: 0, w: 3, h: 8, z: 1, shape: 'roundTall' },
      { type: 'component', componentKey: 'widgets', label: '', x: 3, y: 0, w: 3, h: 3, z: 2, shape: 'capsule' },
      { type: 'deco', label: '', x: 3, y: 3, w: 3, h: 2, z: 0, shape: 'wave' },
      { type: 'deco', label: '', x: 5, y: 2, w: 1, h: 1, z: 4, shape: 'blob' },
      { type: 'app', page: 'chat-list', label: '', x: 3, y: 5, w: 1, h: 1, z: 3 },
      { type: 'app', page: 'weibo', label: '', x: 4, y: 5, w: 1, h: 1, z: 3 },
      { type: 'app', page: 'forum', label: '', x: 5, y: 5, w: 1, h: 1, z: 3 },
      { type: 'app', page: 'schedule', label: '', x: 3, y: 6, w: 1, h: 1, z: 3 },
      { type: 'app', page: 'timeline-select', label: '', x: 4, y: 6, w: 1, h: 1, z: 3 },
      { type: 'app', page: 'user-profile', label: '', x: 5, y: 6, w: 1, h: 1, z: 3 },
    ]],
  },
};
const SHAPE_OPTIONS = [
  { id: 'rounded', label: '圆角' },
  { id: 'square', label: '方形' },
  { id: 'rect', label: '长方形' },
  { id: 'capsule', label: '胶囊' },
  { id: 'circle', label: '圆形' },
  { id: 'disc', label: '碟片' },
  { id: 'blob', label: '异型Blob' },
  { id: 'leaf', label: '叶片' },
  { id: 'wave', label: '波浪' },
  { id: 'roundTall', label: '高圆角卡' },
];
const SIZE_OPTIONS = [
  { id: '1x1', label: '1x1', w: 1, h: 1 },
  { id: '2x1', label: '2x1', w: 2, h: 1 },
  { id: '2x2', label: '2x2', w: 2, h: 2 },
  { id: '3x2', label: '3x2', w: 3, h: 2 },
  { id: '3x3', label: '3x3', w: 3, h: 3 },
  { id: '4x2', label: '4x2', w: 4, h: 2 },
  { id: '4x3', label: '4x3', w: 4, h: 3 },
];

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function loadPrefs() {
  const record = await db.get('settings', 'homeScreenPrefs');
  const v = record?.value || {};
  const freeform = v.freeform && typeof v.freeform === 'object' ? v.freeform : {};
  return {
    ...v,
    stylePreset: HOME_STYLE_PRESETS[v.stylePreset] ? v.stylePreset : 'soft',
    freeform: {
      enabled: freeform.enabled !== false,
      items: Array.isArray(freeform.items) ? freeform.items : [],
      pages: Array.isArray(freeform.pages) ? freeform.pages.map((p) => (Array.isArray(p) ? p : [])) : [],
    },
  };
}

async function savePrefs(next) {
  await db.put('settings', { key: 'homeScreenPrefs', value: next });
}

function clampItem(item) {
  return {
    ...item,
    x: Math.max(0, Math.min(5, Number(item.x) || 0)),
    y: Math.max(0, Math.min(11, Number(item.y) || 0)),
    w: Math.max(1, Math.min(6, Number(item.w) || 1)),
    h: Math.max(1, Math.min(8, Number(item.h) || 1)),
    z: Math.max(0, Number(item.z) || 0),
    bgScale: Math.max(50, Math.min(300, Number(item.bgScale) || 100)),
    bgPosX: Math.max(0, Math.min(100, Number(item.bgPosX) || 50)),
    bgPosY: Math.max(0, Math.min(100, Number(item.bgPosY) || 50)),
  };
}

function shapeRadius(shape) {
  if (shape === 'capsule') return '999px';
  if (shape === 'blob') return '28px 16px 30px 14px';
  if (shape === 'leaf') return '32px 8px 30px 12px';
  if (shape === 'wave') return '24px 24px 10px 28px';
  if (shape === 'roundTall') return '26px';
  if (shape === 'circle') return '50%';
  if (shape === 'disc') return '50%';
  if (shape === 'square') return '8px';
  if (shape === 'rect') return '10px';
  return '';
}

function overlaps(a, b) {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  return a.x < bx2 && ax2 > b.x && a.y < by2 && ay2 > b.y;
}

function findNonOverlapPosition(items, movingId, candidate) {
  const next = { ...candidate };
  const others = items.filter((x) => x.id !== movingId).map(clampItem);
  const maxY = 11;
  for (let y = next.y; y <= maxY; y += 1) {
    const trial = clampItem({ ...next, y });
    if (trial.y + trial.h > 12) continue;
    const hit = others.some((it) => overlaps(trial, it));
    if (!hit) return trial;
  }
  return clampItem(candidate);
}

function renderCanvasItems(items, selectedId) {
  const sorted = [...items].map(clampItem).sort((a, b) => (a.z || 0) - (b.z || 0));
  return sorted.map((raw) => {
    const it = clampItem(raw);
    const radius = shapeRadius(it.shape);
    const bgStyle = it.image
      ? `background-image:url('${escapeAttr(it.image)}');background-repeat:no-repeat;background-size:${Number(it.bgScale) || 100}%;background-position:${Number(it.bgPosX) || 50}% ${Number(it.bgPosY) || 50}%;`
      : '';
    const style = `grid-column:${it.x + 1} / span ${it.w};grid-row:${it.y + 1} / span ${it.h};${bgStyle}${radius ? `border-radius:${radius};` : ''}`;
    if (it.type === 'app') {
      const iconName = APP_ICON_NAMES[it.page] || 'sparkle';
      const labelText = it.label == null ? '应用' : String(it.label);
      return `
        <button type="button" class="hc-item is-app ${selectedId === it.id ? 'is-selected' : ''}" data-item-id="${it.id}" style="${style}">
          <span class="hc-item-icon">${icon(iconName, 'hc-item-svg')}</span>
          ${labelText ? `<span class="hc-item-text">${escapeAttr(labelText)}</span>` : ''}
        </button>
      `;
    }
    const labelText = it.label == null ? (it.type === 'component' ? '组件' : '装饰卡') : String(it.label);
    return `
      <button type="button" class="hc-item ${it.type === 'component' ? 'is-component' : 'is-deco'} ${selectedId === it.id ? 'is-selected' : ''}" data-item-id="${it.id}" style="${style}">
        ${labelText ? `<span class="hc-item-text">${escapeAttr(labelText)}</span>` : ''}
      </button>
    `;
  }).join('');
}

export default async function render(container) {
  const prefs = await loadPrefs();
  const pages = prefs.freeform.pages.length
    ? prefs.freeform.pages.map((p) => p.map(clampItem))
    : [prefs.freeform.items.map(clampItem)];
  let editPage = Math.max(0, Math.min(pages.length - 1, Number(prefs.currentPage) || 0));
  let items = pages[editPage] || [];
  let selectedId = items[0]?.id || '';
  let dragging = null;

  const selected = () => items.find((x) => x.id === selectedId) || null;

  const rerenderSelf = async () => {
    pages[editPage] = items;
    prefs.currentPage = editPage;
    prefs.freeform.pages = pages;
    prefs.freeform.items = pages[0] || [];
    await savePrefs(prefs);
    await render(container);
  };

  const addApp = (page) => {
    const app = APPS.find((a) => a.page === page) || APPS[0];
    items.push({ id: `it_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`, type: 'app', page: app.page, label: app.label, x: 0, y: 0, w: 1, h: 1, z: items.length, image: '' });
  };
  const addComponent = (key) => {
    const preset = COMPONENT_PRESETS[key] || COMPONENT_PRESETS.hero;
    const size = String(container.querySelector('.hc-new-size')?.value || `${preset.w}x${preset.h}`);
    const [sw, sh] = size.split('x').map((n) => Number(n) || 1);
    const shape = String(container.querySelector('.hc-new-shape')?.value || 'rounded');
    items.push({ id: `it_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`, type: 'component', componentKey: key, label: preset.label, x: 0, y: 1, w: sw, h: sh, z: items.length, image: '', shape });
  };
  const addDeco = () => {
    const size = String(container.querySelector('.hc-new-size')?.value || '2x2');
    const [sw, sh] = size.split('x').map((n) => Number(n) || 1);
    const shape = String(container.querySelector('.hc-new-shape')?.value || 'blob');
    items.push({ id: `it_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`, type: 'deco', label: '装饰卡片', x: 1, y: 2, w: sw, h: sh, z: items.length, image: '', shape });
  };

  container.className = 'page home-customizer-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn hc-back">‹</button>
      <h1 class="navbar-title">主页编辑模式</h1>
      <button type="button" class="navbar-btn hc-save">保存</button>
    </header>
    <div class="page-scroll" style="padding:10px 12px 18px;">
      <section class="card-block">
        <div class="form-label">风格预设</div>
        <select class="form-input hc-style">
          ${Object.entries(HOME_STYLE_PRESETS).map(([k, v]) => `<option value="${k}" ${prefs.stylePreset === k ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select>
      </section>
      <section class="card-block" style="margin-top:10px;">
        <div class="form-label">模板一键套用（含异型）</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <select class="form-input hc-template" style="flex:1;">
            ${Object.entries(TEMPLATE_PRESETS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
          </select>
          <button type="button" class="btn btn-sm btn-outline hc-apply-template">套用</button>
        </div>
        <div style="display:flex;gap:12px;align-items:center;margin-top:8px;">
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;">
            <input type="radio" name="tpl-target" value="current" checked />
            当前分页
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;">
            <input type="radio" name="tpl-target" value="new" />
            新分页
          </label>
        </div>
      </section>
      <section class="card-block" style="margin-top:10px;">
        <div class="form-label">编辑分页</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <select class="form-input hc-page-select" style="flex:1;min-width:120px;">
            ${pages.map((_, idx) => `<option value="${idx}" ${idx === editPage ? 'selected' : ''}>分页 ${idx + 1}</option>`).join('')}
          </select>
          <button type="button" class="btn btn-sm hc-page-prev">上一页</button>
          <div class="text-hint">第 ${editPage + 1} / ${pages.length} 页</div>
          <button type="button" class="btn btn-sm hc-page-next">下一页</button>
          <button type="button" class="btn btn-sm btn-outline hc-page-add">+分页</button>
        </div>
      </section>
      <section class="card-block" style="margin-top:10px;">
        <div class="form-label">编辑画布（拖动自动对齐）</div>
        <div class="text-hint" style="font-size:12px;">长按并拖动任意卡片；点击选中后可改大小、上传图、删除。</div>
        <div class="hc-phone-frame">
          <div class="hc-canvas home-style-${escapeAttr(prefs.stylePreset)}" data-canvas>
            ${renderCanvasItems(items, selectedId)}
          </div>
        </div>
      </section>
      <section class="card-block" style="margin-top:10px;">
        <div class="form-label">添加元素</div>
        <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          <select class="form-input hc-new-size" style="flex:1;min-width:120px;">
            ${SIZE_OPTIONS.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}
          </select>
          <select class="form-input hc-new-shape" style="flex:1;min-width:140px;">
            ${SHAPE_OPTIONS.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <select class="form-input hc-add-app" style="flex:1;min-width:140px;">
            ${APPS.map((a) => `<option value="${a.page}">${a.label}</option>`).join('')}
          </select>
          <button type="button" class="btn btn-sm btn-outline hc-add-app-btn">添加图标</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
          <select class="form-input hc-add-component" style="flex:1;min-width:140px;">
            ${Object.entries(COMPONENT_PRESETS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
          </select>
          <button type="button" class="btn btn-sm btn-outline hc-add-component-btn">添加组件</button>
          <button type="button" class="btn btn-sm btn-outline hc-add-deco-btn">添加装饰卡</button>
        </div>
      </section>
      <section class="card-block" style="margin-top:10px;">
        <div class="form-label">选中元素设置</div>
        <div class="text-hint hc-selected-hint" style="font-size:12px;">${selected() ? `当前：${escapeAttr(selected().label || selected().type)}` : '未选中'}</div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
          <input type="text" class="form-input hc-label-input" style="flex:1;min-width:160px;" value="${escapeAttr(selected()?.label || '')}" placeholder="元素文字" />
          <select class="form-input hc-shape-input" style="flex:1;min-width:140px;">
            ${SHAPE_OPTIONS.map((s) => `<option value="${s.id}" ${selected()?.shape === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}
          </select>
          <button type="button" class="btn btn-sm hc-apply-meta-btn">应用文字/形状</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm hc-size-btn">切换尺寸</button>
          <button type="button" class="btn btn-sm hc-layer-down-btn">下移一层</button>
          <button type="button" class="btn btn-sm hc-layer-up-btn">上移一层</button>
          <label class="btn btn-sm btn-outline">
            上传填充图
            <input type="file" hidden accept="image/*" class="hc-item-image-upload" />
          </label>
          <button type="button" class="btn btn-sm hc-item-image-clear">清除填充图</button>
          <button type="button" class="btn btn-sm btn-danger hc-delete-btn">删除元素</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap;">
          <span class="text-hint" style="font-size:12px;min-width:72px;">图片缩放</span>
          <input type="range" class="hc-bg-scale" min="50" max="300" step="1" value="${Number(selected()?.bgScale || 100)}" style="flex:1;min-width:140px;" />
          <span class="text-hint hc-bg-scale-val" style="font-size:12px;min-width:42px;">${Number(selected()?.bgScale || 100)}%</span>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap;">
          <span class="text-hint" style="font-size:12px;min-width:72px;">位置X/Y</span>
          <input type="range" class="hc-bg-posx" min="0" max="100" step="1" value="${Number(selected()?.bgPosX || 50)}" style="flex:1;min-width:120px;" />
          <input type="range" class="hc-bg-posy" min="0" max="100" step="1" value="${Number(selected()?.bgPosY || 50)}" style="flex:1;min-width:120px;" />
        </div>
      </section>
      <div style="margin-top:12px;display:flex;gap:8px;">
        <button type="button" class="btn btn-outline hc-cancel" style="flex:1;">取消</button>
        <button type="button" class="btn btn-outline hc-save-page" style="flex:1;">仅保存当前分页</button>
        <button type="button" class="btn btn-primary hc-save-bottom" style="flex:1;">保存并返回主页</button>
      </div>
    </div>
  `;

  const canvas = container.querySelector('[data-canvas]');
  const snapFromPoint = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    const colW = rect.width / 6;
    const rowH = 56;
    const x = Math.floor((clientX - rect.left) / colW);
    const y = Math.floor((clientY - rect.top) / rowH);
    return { x: Math.max(0, Math.min(5, x)), y: Math.max(0, Math.min(11, y)) };
  };

  const saveAndGo = async () => {
    prefs.stylePreset = String(container.querySelector('.hc-style')?.value || 'soft');
    prefs.freeform.enabled = true;
    pages[editPage] = items;
    prefs.currentPage = editPage;
    prefs.freeform.pages = pages.map((p) => p.map(clampItem));
    prefs.freeform.items = prefs.freeform.pages[0] || [];
    await savePrefs(prefs);
    showToast('主页布局已保存');
    navigate('home');
  };

  container.querySelector('.hc-back')?.addEventListener('click', () => back());
  container.querySelector('.hc-cancel')?.addEventListener('click', () => back());
  container.querySelector('.hc-save')?.addEventListener('click', saveAndGo);
  container.querySelector('.hc-save-bottom')?.addEventListener('click', saveAndGo);
  container.querySelector('.hc-save-page')?.addEventListener('click', async () => {
    pages[editPage] = items;
    prefs.currentPage = editPage;
    prefs.freeform.enabled = true;
    prefs.freeform.pages = pages.map((p) => p.map(clampItem));
    prefs.freeform.items = prefs.freeform.pages[0] || [];
    await savePrefs(prefs);
    showToast(`已保存分页 ${editPage + 1}`);
  });

  container.querySelector('.hc-style')?.addEventListener('change', async (e) => {
    prefs.stylePreset = String(e.target.value || 'soft');
    await rerenderSelf();
  });
  container.querySelector('.hc-page-select')?.addEventListener('change', async (e) => {
    const nextPage = Math.max(0, Math.min(pages.length - 1, Number(e.target.value) || 0));
    pages[editPage] = items;
    editPage = nextPage;
    items = pages[editPage] || [];
    selectedId = items[0]?.id || '';
    await rerenderSelf();
  });
  container.querySelector('.hc-page-prev')?.addEventListener('click', async () => {
    if (editPage <= 0) return;
    pages[editPage] = items;
    editPage -= 1;
    items = pages[editPage] || [];
    selectedId = items[0]?.id || '';
    await rerenderSelf();
  });
  container.querySelector('.hc-page-next')?.addEventListener('click', async () => {
    if (editPage >= pages.length - 1) return;
    pages[editPage] = items;
    editPage += 1;
    items = pages[editPage] || [];
    selectedId = items[0]?.id || '';
    await rerenderSelf();
  });
  container.querySelector('.hc-page-add')?.addEventListener('click', async () => {
    pages[editPage] = items;
    pages.push([]);
    editPage = pages.length - 1;
    items = pages[editPage];
    selectedId = '';
    await rerenderSelf();
  });
  container.querySelector('.hc-apply-template')?.addEventListener('click', async () => {
    const key = String(container.querySelector('.hc-template')?.value || 'balanced');
    const target = String(container.querySelector('input[name="tpl-target"]:checked')?.value || 'current');
    const tpl = TEMPLATE_PRESETS[key] || TEMPLATE_PRESETS.balanced;
    prefs.stylePreset = tpl.stylePreset || prefs.stylePreset;
    const nextPages = (tpl.pages || []).map((page, pidx) => page.map((x, idx) => clampItem({
      id: `tpl_${Date.now()}_${pidx}_${idx}`,
      image: '',
      ...x,
      z: Number(x.z) || idx,
    })));
    const pageToApply = nextPages[0] || [];
    if (target === 'new') {
      pages.push(pageToApply);
      editPage = pages.length - 1;
    } else {
      pages[editPage] = pageToApply;
    }
    items = pages[editPage] || [];
    selectedId = items[0]?.id || '';
    await rerenderSelf();
    showToast(`已套用模板：${tpl.label}（${target === 'new' ? '新分页' : '当前分页'}）`);
  });
  container.querySelector('.hc-add-app-btn')?.addEventListener('click', async () => {
    addApp(String(container.querySelector('.hc-add-app')?.value || 'chat-list'));
    await rerenderSelf();
  });
  container.querySelector('.hc-add-component-btn')?.addEventListener('click', async () => {
    addComponent(String(container.querySelector('.hc-add-component')?.value || 'hero'));
    await rerenderSelf();
  });
  container.querySelector('.hc-add-deco-btn')?.addEventListener('click', async () => {
    addDeco();
    await rerenderSelf();
  });

  container.querySelector('.hc-size-btn')?.addEventListener('click', async () => {
    const cur = selected();
    if (!cur) return;
    const steps = [[1, 1], [2, 1], [2, 2], [3, 2], [4, 2], [4, 3]];
    const idx = Math.max(0, steps.findIndex(([w, h]) => cur.w === w && cur.h === h));
    const next = steps[(idx + 1) % steps.length];
    cur.w = next[0];
    cur.h = next[1];
    const placed = findNonOverlapPosition(items, cur.id, cur);
    cur.x = placed.x;
    cur.y = placed.y;
    await rerenderSelf();
  });
  container.querySelector('.hc-apply-meta-btn')?.addEventListener('click', async () => {
    const cur = selected();
    if (!cur) return;
    const label = String(container.querySelector('.hc-label-input')?.value || '');
    const shape = String(container.querySelector('.hc-shape-input')?.value || 'rounded');
    cur.label = label;
    cur.shape = shape;
    if (shape === 'circle' || shape === 'disc') {
      const side = Math.max(1, Math.min(cur.w, cur.h));
      cur.w = side;
      cur.h = side;
    }
    const placed = findNonOverlapPosition(items, cur.id, cur);
    cur.x = placed.x;
    cur.y = placed.y;
    await rerenderSelf();
  });
  container.querySelector('.hc-layer-up-btn')?.addEventListener('click', async () => {
    const cur = selected();
    if (!cur) return;
    cur.z = (Number(cur.z) || 0) + 1;
    await rerenderSelf();
  });
  container.querySelector('.hc-layer-down-btn')?.addEventListener('click', async () => {
    const cur = selected();
    if (!cur) return;
    cur.z = Math.max(0, (Number(cur.z) || 0) - 1);
    await rerenderSelf();
  });
  container.querySelector('.hc-delete-btn')?.addEventListener('click', async () => {
    if (!selectedId) return;
    const idx = items.findIndex((x) => x.id === selectedId);
    if (idx >= 0) items.splice(idx, 1);
    selectedId = items[0]?.id || '';
    await rerenderSelf();
  });
  container.querySelector('.hc-item-image-upload')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    const cur = selected();
    if (!file || !cur) return;
    cur.image = await fileToDataUrl(file);
    e.target.value = '';
    await rerenderSelf();
  });
  container.querySelector('.hc-item-image-clear')?.addEventListener('click', async () => {
    const cur = selected();
    if (!cur) return;
    cur.image = '';
    await rerenderSelf();
  });
  const syncBgControls = async () => {
    const cur = selected();
    if (!cur) return;
    const scale = Number(container.querySelector('.hc-bg-scale')?.value || cur.bgScale || 100);
    const px = Number(container.querySelector('.hc-bg-posx')?.value || cur.bgPosX || 50);
    const py = Number(container.querySelector('.hc-bg-posy')?.value || cur.bgPosY || 50);
    cur.bgScale = Math.max(50, Math.min(300, scale));
    cur.bgPosX = Math.max(0, Math.min(100, px));
    cur.bgPosY = Math.max(0, Math.min(100, py));
    const valEl = container.querySelector('.hc-bg-scale-val');
    if (valEl) valEl.textContent = `${cur.bgScale}%`;
    await rerenderSelf();
  };
  container.querySelector('.hc-bg-scale')?.addEventListener('input', () => {
    const v = Number(container.querySelector('.hc-bg-scale')?.value || 100);
    const valEl = container.querySelector('.hc-bg-scale-val');
    if (valEl) valEl.textContent = `${v}%`;
  });
  container.querySelector('.hc-bg-scale')?.addEventListener('change', async () => syncBgControls());
  container.querySelector('.hc-bg-posx')?.addEventListener('change', async () => syncBgControls());
  container.querySelector('.hc-bg-posy')?.addEventListener('change', async () => syncBgControls());

  container.querySelectorAll('.hc-item').forEach((el) => {
    const id = el.dataset.itemId;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      selectedId = id;
      void rerenderSelf();
    });
    let timer = null;
    el.addEventListener('pointerdown', (e) => {
      timer = setTimeout(() => {
        dragging = { id, pointerId: e.pointerId };
        el.setPointerCapture?.(e.pointerId);
      }, 220);
    });
    el.addEventListener('pointerup', () => {
      if (timer) clearTimeout(timer);
      dragging = null;
    });
    el.addEventListener('pointermove', async (e) => {
      if (!dragging || dragging.id !== id) return;
      const cur = items.find((x) => x.id === id);
      if (!cur) return;
      const pos = snapFromPoint(e.clientX, e.clientY);
      const placed = findNonOverlapPosition(items, cur.id, { ...cur, x: pos.x, y: pos.y });
      cur.x = placed.x;
      cur.y = placed.y;
      await rerenderSelf();
    });
  });
}

