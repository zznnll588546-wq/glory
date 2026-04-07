import { navigate, back } from '../core/router.js';
import * as db from '../core/db.js';
import { getConfig, saveConfig, fetchModels } from '../core/api.js';
import { exportBackup, importBackup } from '../core/storage.js';
import { setEnabled } from '../core/background.js';

const UI_KEY = 'uiPreferences';
const DEFAULT_UI = {
  darkMode: false,
  primaryColor: '#6ba3d6',
  wallpaperDataUrl: '',
};

function showToast(msg) {
  const wrap = document.getElementById('toast-container');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

async function loadUiPrefs() {
  const row = await db.get('settings', UI_KEY);
  return { ...DEFAULT_UI, ...(row?.value || {}) };
}

async function saveUiPrefs(prefs) {
  await db.put('settings', { key: UI_KEY, value: prefs });
}

function applyUiToDocument(prefs) {
  const root = document.documentElement;
  if (prefs.darkMode) root.setAttribute('data-theme', 'dark');
  else root.setAttribute('data-theme', 'light');
  if (prefs.primaryColor) {
    root.style.setProperty('--primary', prefs.primaryColor);
  }
  if (prefs.wallpaperDataUrl) {
    root.style.setProperty('--wallpaper', `url("${prefs.wallpaperDataUrl}")`);
  } else {
    root.style.removeProperty('--wallpaper');
  }
}

async function mergeBackgroundSettings(partial) {
  const prev = (await db.get('settings', 'backgroundKeepAlive'))?.value || {};
  const next = { ...prev, ...partial };
  await db.put('settings', { key: 'backgroundKeepAlive', value: next });
  return next;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export default async function render(container) {
  const api = await getConfig();
  const ui = await loadUiPrefs();
  applyUiToDocument(ui);
  const bgRow = (await db.get('settings', 'backgroundKeepAlive'))?.value || {};
  const bgEnabled = !!bgRow.enabled;
  const bgIntervalMin = Number(bgRow.checkIntervalMinutes) || 5;

  let modelsList = [];

  container.classList.add('settings-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn settings-back" aria-label="返回">‹</button>
      <h1 class="navbar-title">设置</h1>
      <span class="navbar-btn" style="visibility:hidden" aria-hidden="true"></span>
    </header>

    <div class="section-header">API设置</div>
    <section class="settings-section">
      <div class="settings-item">
        <span class="settings-item-label">API地址</span>
        <div class="settings-item-value" style="flex:1;max-width:55%;">
          <input type="text" class="form-input setting-api-base" style="padding:6px 8px;font-size:var(--font-sm);" value="" />
        </div>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">API密钥</span>
        <div class="settings-item-value" style="flex:1;max-width:55%;">
          <input type="password" class="form-input setting-api-key" style="padding:6px 8px;font-size:var(--font-sm);" autocomplete="off" value="" />
        </div>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">拉取模型</span>
        <div class="settings-item-value" style="flex-wrap:wrap;justify-content:flex-end;gap:8px;">
          <button type="button" class="btn btn-sm btn-outline setting-fetch-models">拉取</button>
          <select class="form-input setting-model-select" style="padding:6px 8px;font-size:var(--font-sm);max-width:160px;"></select>
        </div>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">当前模型</span>
        <span class="settings-item-value setting-model-label"></span>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">Temperature</span>
        <div class="settings-item-value" style="gap:8px;">
          <input type="range" class="setting-temp" min="0" max="2" step="0.1" />
          <span class="setting-temp-val" style="min-width:36px;text-align:right;"></span>
        </div>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">Max Tokens</span>
        <div class="settings-item-value">
          <input type="number" class="form-input setting-max-tokens" style="width:100px;padding:6px 8px;" min="1" step="1" />
        </div>
      </div>
    </section>

    <div class="section-header">主题设置</div>
    <section class="settings-section">
      <div class="settings-item">
        <span class="settings-item-label">深色模式</span>
        <div class="settings-item-value">
          <span class="toggle${ui.darkMode ? ' on' : ''}" role="switch" tabindex="0" aria-checked="${ui.darkMode}" data-toggle="dark"></span>
        </div>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">主题色</span>
        <div class="settings-item-value">
          <input type="color" class="setting-primary-color" value="${ui.primaryColor}" />
        </div>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">自定义壁纸</span>
        <div class="settings-item-value">
          <input type="file" class="setting-wallpaper" accept="image/*" />
        </div>
      </div>
    </section>

    <div class="section-header">后台保活</div>
    <section class="settings-section">
      <div class="settings-item">
        <span class="settings-item-label">启用后台活跃</span>
        <div class="settings-item-value">
          <span class="toggle${bgEnabled ? ' on' : ''}" role="switch" tabindex="0" aria-checked="${bgEnabled}" data-toggle="bg"></span>
        </div>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">检测间隔</span>
        <div class="settings-item-value" style="gap:6px;align-items:center;">
          <input type="number" class="form-input setting-bg-interval" style="width:72px;padding:6px 8px;" min="1" step="1" />
          <span style="font-size:var(--font-sm);color:var(--text-secondary);">分钟</span>
        </div>
      </div>
    </section>

    <div class="section-header">数据管理</div>
    <section class="settings-section">
      <div class="settings-item">
        <span class="settings-item-label">导出备份</span>
        <button type="button" class="btn btn-sm btn-outline setting-export">导出</button>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">导入备份</span>
        <button type="button" class="btn btn-sm btn-outline setting-import">导入</button>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">清除所有数据</span>
        <button type="button" class="btn btn-sm btn-danger setting-clear">清除</button>
      </div>
    </section>

    <div class="section-header">关于</div>
    <section class="settings-section">
      <div class="settings-item">
        <span class="settings-item-label">版本</span>
        <span class="settings-item-value">v1.0.0</span>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">项目</span>
        <span class="settings-item-value" style="text-align:right;max-width:60%;white-space:normal;">荣耀手机 - 全职高手沉浸式角色扮演</span>
      </div>
    </section>
  `;

  const baseInput = container.querySelector('.setting-api-base');
  const keyInput = container.querySelector('.setting-api-key');
  const modelSelect = container.querySelector('.setting-model-select');
  const modelLabel = container.querySelector('.setting-model-label');
  const tempRange = container.querySelector('.setting-temp');
  const tempVal = container.querySelector('.setting-temp-val');
  const maxTok = container.querySelector('.setting-max-tokens');
  const primaryPick = container.querySelector('.setting-primary-color');
  const wallInput = container.querySelector('.setting-wallpaper');
  const bgIntervalInput = container.querySelector('.setting-bg-interval');

  baseInput.value = api.baseUrl || '';
  keyInput.value = api.apiKey || '';
  tempRange.value = String(api.temperature ?? 0.8);
  tempVal.textContent = tempRange.value;
  maxTok.value = String(api.maxTokens ?? 2048);
  modelLabel.textContent = api.model || '（未选择）';
  bgIntervalInput.value = String(bgIntervalMin);

  function fillModelSelect(list, current) {
    modelSelect.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = '选择模型…';
    modelSelect.appendChild(opt0);
    for (const id of list) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = id;
      if (id === current) o.selected = true;
      modelSelect.appendChild(o);
    }
    if (current && !list.includes(current)) {
      const o = document.createElement('option');
      o.value = current;
      o.textContent = current + ' (当前)';
      o.selected = true;
      modelSelect.appendChild(o);
    }
  }
  fillModelSelect([], api.model);

  async function persistApi(partial) {
    const next = { ...api, ...partial };
    Object.assign(api, next);
    await saveConfig(api);
  }

  baseInput.addEventListener('change', () => persistApi({ baseUrl: baseInput.value.trim() }));
  keyInput.addEventListener('change', () => persistApi({ apiKey: keyInput.value }));

  tempRange.addEventListener('input', () => {
    tempVal.textContent = tempRange.value;
  });
  tempRange.addEventListener('change', () => persistApi({ temperature: parseFloat(tempRange.value) }));

  maxTok.addEventListener('change', () => {
    const n = parseInt(maxTok.value, 10);
    if (!Number.isFinite(n) || n < 1) return;
    persistApi({ maxTokens: n });
  });

  modelSelect.addEventListener('change', () => {
    const v = modelSelect.value;
    modelLabel.textContent = v || '（未选择）';
    persistApi({ model: v });
  });

  container.querySelector('.setting-fetch-models')?.addEventListener('click', async () => {
    modelsList = await fetchModels();
    if (!modelsList.length) {
      showToast('未获取到模型列表，请检查地址与密钥');
      return;
    }
    fillModelSelect(modelsList, api.model);
    showToast(`已加载 ${modelsList.length} 个模型`);
  });

  function bindToggle(el, onChange) {
    const sync = (on) => {
      el.classList.toggle('on', on);
      el.setAttribute('aria-checked', String(on));
    };
    el.addEventListener('click', () => {
      const next = !el.classList.contains('on');
      sync(next);
      onChange(next);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        el.click();
      }
    });
  }

  bindToggle(container.querySelector('[data-toggle="dark"]'), async (on) => {
    const nextUi = { ...ui, darkMode: on };
    Object.assign(ui, nextUi);
    applyUiToDocument(nextUi);
    await saveUiPrefs(nextUi);
  });

  primaryPick?.addEventListener('input', async () => {
    const nextUi = { ...ui, primaryColor: primaryPick.value };
    Object.assign(ui, nextUi);
    applyUiToDocument(nextUi);
    await saveUiPrefs(nextUi);
  });

  wallInput?.addEventListener('change', async () => {
    const f = wallInput.files?.[0];
    if (!f) return;
    try {
      const dataUrl = await fileToDataUrl(f);
      const nextUi = { ...ui, wallpaperDataUrl: dataUrl };
      Object.assign(ui, nextUi);
      applyUiToDocument(nextUi);
      await saveUiPrefs(nextUi);
      showToast('壁纸已更新');
    } catch {
      showToast('壁纸读取失败');
    }
    wallInput.value = '';
  });

  bindToggle(container.querySelector('[data-toggle="bg"]'), async (on) => {
    await mergeBackgroundSettings({ enabled: on });
    setEnabled(on);
  });

  bgIntervalInput?.addEventListener('change', async () => {
    const n = parseInt(bgIntervalInput.value, 10);
    if (!Number.isFinite(n) || n < 1) return;
    await mergeBackgroundSettings({ checkIntervalMinutes: n });
    showToast('检测间隔已保存');
  });

  container.querySelector('.setting-export')?.addEventListener('click', () => {
    void exportBackup();
    showToast('已开始导出');
  });

  container.querySelector('.setting-import')?.addEventListener('click', async () => {
    try {
      await importBackup();
      showToast('导入成功');
    } catch (e) {
      showToast(e?.message || '导入失败');
    }
  });

  container.querySelector('.setting-clear')?.addEventListener('click', async () => {
    if (!confirm('确定清除所有本地数据？此操作不可恢复。')) return;
    for (const name of Object.keys(db.STORES)) {
      await db.clear(name);
    }
    showToast('已清除');
    navigate('home', {}, true);
  });

  container.querySelector('.settings-back')?.addEventListener('click', () => back());
}
