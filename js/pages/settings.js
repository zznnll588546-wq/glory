import { navigate, back } from '../core/router.js';
import * as db from '../core/db.js';
import { getConfig, saveConfig, fetchModels } from '../core/api.js';
import { exportBackup, importBackup } from '../core/storage.js';
import { setEnabled } from '../core/background.js';
import { APP_VERSION, checkServiceWorkerUpdate, forceUpdateAndReload } from '../core/app-update.js';

const UI_KEY = 'uiPreferences';
const SOCIAL_LINK_KEY = 'socialLinkConfig';
const ARENA_PROFILE_KEY = 'arenaProfile';
const DEFAULT_UI = {
  darkMode: false,
  primaryColor: '#6ba3d6',
  wallpaperDataUrl: '',
};
const DEFAULT_SOCIAL_LINK = {
  autoLinkChance: 0.35,
  wrongSendChance: 0.22,
  recallChance: 0.55,
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

async function loadSocialLinkConfig() {
  const row = await db.get('settings', SOCIAL_LINK_KEY);
  return { ...DEFAULT_SOCIAL_LINK, ...(row?.value || {}) };
}

async function saveSocialLinkConfig(cfg) {
  await db.put('settings', { key: SOCIAL_LINK_KEY, value: cfg });
}

async function loadArenaProfile() {
  const row = await db.get('settings', ARENA_PROFILE_KEY);
  return row?.value || { cardName: '', silverWeapon: '', profession: '', playStyle: '' };
}

async function saveArenaProfile(profile) {
  await db.put('settings', { key: ARENA_PROFILE_KEY, value: profile });
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
  const api = await getConfig().catch((e) => {
    console.error('[settings] load api config failed:', e);
    return {
      baseUrl: '',
      apiKey: '',
      model: '',
      temperature: 0.8,
      maxTokens: 2048,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      customHeaders: {},
      endpointType: 'openai',
    };
  });
  const ui = await loadUiPrefs().catch((e) => {
    console.error('[settings] load ui prefs failed:', e);
    return { ...DEFAULT_UI };
  });
  applyUiToDocument(ui);
  const bgRow = (await db.get('settings', 'backgroundKeepAlive').catch((e) => {
    console.error('[settings] load background settings failed:', e);
    return null;
  }))?.value || {};
  const socialCfg = await loadSocialLinkConfig().catch((e) => {
    console.error('[settings] load social-link config failed:', e);
    return { ...DEFAULT_SOCIAL_LINK };
  });
  const arenaProfile = await loadArenaProfile().catch(() => ({ cardName: '', silverWeapon: '', profession: '', playStyle: '' }));
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

    <div class="section-header">社交联动</div>
    <section class="settings-section">
      <div class="settings-item">
        <span class="settings-item-label">自动转发到聊天概率</span>
        <div class="settings-item-value" style="gap:6px;align-items:center;">
          <input type="number" class="form-input setting-social-autolink" style="width:80px;padding:6px 8px;" min="0" max="1" step="0.01" />
        </div>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">错屏/错群概率</span>
        <div class="settings-item-value" style="gap:6px;align-items:center;">
          <input type="number" class="form-input setting-social-wrongsend" style="width:80px;padding:6px 8px;" min="0" max="1" step="0.01" />
        </div>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">错发后撤回概率</span>
        <div class="settings-item-value" style="gap:6px;align-items:center;">
          <input type="number" class="form-input setting-social-recall" style="width:80px;padding:6px 8px;" min="0" max="1" step="0.01" />
        </div>
      </div>
      <div class="settings-item">
        <span class="text-hint" style="font-size:11px;line-height:1.5;">范围 0~1，越高触发越频繁。作用于微博/论坛自动联动与错发事件。</span>
      </div>
      <div class="settings-item" style="display:flex;gap:8px;justify-content:flex-end;">
        <button type="button" class="btn btn-sm btn-outline setting-social-preset" data-preset="safe">保守</button>
        <button type="button" class="btn btn-sm btn-outline setting-social-preset" data-preset="balanced">均衡</button>
        <button type="button" class="btn btn-sm btn-outline setting-social-preset" data-preset="drama">戏剧化</button>
      </div>
    </section>

    <div class="section-header">竞技场档案</div>
    <section class="settings-section">
      <div class="settings-item">
        <span class="settings-item-label">账号卡名</span>
        <div class="settings-item-value" style="flex:1;max-width:58%;">
          <input type="text" class="form-input setting-arena-card" style="padding:6px 8px;font-size:var(--font-sm);" value="${arenaProfile.cardName || ''}" />
        </div>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">银武名</span>
        <div class="settings-item-value" style="flex:1;max-width:58%;">
          <input type="text" class="form-input setting-arena-weapon" style="padding:6px 8px;font-size:var(--font-sm);" value="${arenaProfile.silverWeapon || ''}" />
        </div>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">职业</span>
        <div class="settings-item-value" style="flex:1;max-width:58%;">
          <input type="text" class="form-input setting-arena-profession" style="padding:6px 8px;font-size:var(--font-sm);" value="${arenaProfile.profession || ''}" />
        </div>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">作战风格</span>
        <div class="settings-item-value" style="flex:1;max-width:58%;">
          <input type="text" class="form-input setting-arena-style" style="padding:6px 8px;font-size:var(--font-sm);" value="${arenaProfile.playStyle || ''}" />
        </div>
      </div>
      <div class="settings-item">
        <span class="text-hint" style="font-size:11px;line-height:1.5;">用于竞技场建房、自动组队和战果总结引用。</span>
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
        <span class="settings-item-label">清空冗余信息</span>
        <button type="button" class="btn btn-sm btn-outline setting-clean-orphans">自检清理</button>
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
        <span class="settings-item-value">v${APP_VERSION}</span>
      </div>
      <div class="settings-item" style="flex-direction:column;align-items:stretch;gap:8px;">
        <span class="settings-item-label">获取最新版</span>
        <p class="text-hint" style="font-size:11px;line-height:1.45;margin:0;">GitHub Pages 部署后，浏览器可能仍用旧缓存。可先「检查更新」；若刷新后仍是旧界面，请「强制拉取最新」。</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          <button type="button" class="btn btn-sm btn-outline setting-check-update">检查更新</button>
          <button type="button" class="btn btn-sm btn-primary setting-force-update">强制拉取最新</button>
        </div>
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
  const socialAutoLinkInput = container.querySelector('.setting-social-autolink');
  const socialWrongSendInput = container.querySelector('.setting-social-wrongsend');
  const socialRecallInput = container.querySelector('.setting-social-recall');
  const arenaCardInput = container.querySelector('.setting-arena-card');
  const arenaWeaponInput = container.querySelector('.setting-arena-weapon');
  const arenaProfessionInput = container.querySelector('.setting-arena-profession');
  const arenaStyleInput = container.querySelector('.setting-arena-style');

  baseInput.value = api.baseUrl || '';
  keyInput.value = api.apiKey || '';
  tempRange.value = String(api.temperature ?? 0.8);
  tempVal.textContent = tempRange.value;
  maxTok.value = String(api.maxTokens ?? 2048);
  modelLabel.textContent = api.model || '（未选择）';
  bgIntervalInput.value = String(bgIntervalMin);
  socialAutoLinkInput.value = String(socialCfg.autoLinkChance ?? DEFAULT_SOCIAL_LINK.autoLinkChance);
  socialWrongSendInput.value = String(socialCfg.wrongSendChance ?? DEFAULT_SOCIAL_LINK.wrongSendChance);
  socialRecallInput.value = String(socialCfg.recallChance ?? DEFAULT_SOCIAL_LINK.recallChance);

  function persistArenaProfile() {
    const next = {
      cardName: String(arenaCardInput?.value || '').trim(),
      silverWeapon: String(arenaWeaponInput?.value || '').trim(),
      profession: String(arenaProfessionInput?.value || '').trim(),
      playStyle: String(arenaStyleInput?.value || '').trim(),
    };
    saveArenaProfile(next);
  }
  arenaCardInput?.addEventListener('change', persistArenaProfile);
  arenaWeaponInput?.addEventListener('change', persistArenaProfile);
  arenaProfessionInput?.addEventListener('change', persistArenaProfile);
  arenaStyleInput?.addEventListener('change', persistArenaProfile);

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

  function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return Number(n.toFixed(2));
  }
  async function persistSocialConfigFromInputs() {
    const auto = clamp01(socialAutoLinkInput.value);
    const wrong = clamp01(socialWrongSendInput.value);
    const recall = clamp01(socialRecallInput.value);
    if (auto == null || wrong == null || recall == null) {
      showToast('请输入 0~1 之间的数字');
      return;
    }
    socialAutoLinkInput.value = String(auto);
    socialWrongSendInput.value = String(wrong);
    socialRecallInput.value = String(recall);
    await saveSocialLinkConfig({
      autoLinkChance: auto,
      wrongSendChance: wrong,
      recallChance: recall,
    });
    showToast('社交联动概率已保存');
  }
  socialAutoLinkInput?.addEventListener('change', persistSocialConfigFromInputs);
  socialWrongSendInput?.addEventListener('change', persistSocialConfigFromInputs);
  socialRecallInput?.addEventListener('change', persistSocialConfigFromInputs);

  const PRESETS = {
    safe: { autoLinkChance: 0.18, wrongSendChance: 0.08, recallChance: 0.75 },
    balanced: { autoLinkChance: 0.35, wrongSendChance: 0.22, recallChance: 0.55 },
    drama: { autoLinkChance: 0.65, wrongSendChance: 0.45, recallChance: 0.35 },
  };
  container.querySelectorAll('.setting-social-preset').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const preset = PRESETS[btn.dataset.preset];
      if (!preset) return;
      socialAutoLinkInput.value = String(preset.autoLinkChance);
      socialWrongSendInput.value = String(preset.wrongSendChance);
      socialRecallInput.value = String(preset.recallChance);
      await saveSocialLinkConfig(preset);
      showToast(`已应用${btn.textContent}预设`);
    });
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

  container.querySelector('.setting-clean-orphans')?.addEventListener('click', async () => {
    const chats = await db.getAll('chats');
    const chatIds = new Set(chats.map((c) => c.id));
    const [messages, memories, settingsRows] = await Promise.all([
      db.getAll('messages'),
      db.getAll('memories'),
      db.getAll('settings'),
    ]);
    let deletedMsg = 0;
    let deletedMem = 0;
    let deletedPref = 0;

    for (const m of messages) {
      if (!m?.chatId || !chatIds.has(m.chatId)) {
        await db.del('messages', m.id);
        deletedMsg += 1;
      }
    }
    for (const m of memories) {
      if (!m?.chatId || !chatIds.has(m.chatId)) {
        await db.del('memories', m.id);
        deletedMem += 1;
      }
    }
    for (const row of settingsRows) {
      const k = String(row?.key || '');
      if (!k.startsWith('chatPrefs_')) continue;
      const cid = k.slice('chatPrefs_'.length);
      if (!cid || !chatIds.has(cid)) {
        await db.del('settings', row.key);
        deletedPref += 1;
      }
    }
    showToast(`清理完成：消息${deletedMsg}条，记忆${deletedMem}条，会话偏好${deletedPref}项`);
  });

  container.querySelector('.setting-clear')?.addEventListener('click', async () => {
    if (!confirm('确定清除所有本地数据？此操作不可恢复。')) return;
    for (const name of Object.keys(db.STORES)) {
      await db.clear(name);
    }
    showToast('已清除');
    navigate('home', {}, true);
  });

  container.querySelector('.setting-check-update')?.addEventListener('click', async () => {
    showToast('正在检查…');
    const r = await checkServiceWorkerUpdate();
    showToast(r.message || (r.ok ? '完成' : '失败'));
  });

  container.querySelector('.setting-force-update')?.addEventListener('click', () => {
    void forceUpdateAndReload();
  });

  container.querySelector('.settings-back')?.addEventListener('click', () => back());
}
