import { navigate, back } from '../core/router.js';
import * as db from '../core/db.js';
import { AU_PRESETS } from '../data/au-presets.js';
import { setState } from '../core/state.js';

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function getCurrentUserId() {
  const row = await db.get('settings', 'currentUserId');
  return row?.value ?? null;
}

async function getCurrentUser() {
  const uid = await getCurrentUserId();
  if (!uid) return null;
  return db.get('users', uid);
}

export default async function render(container) {
  let user = await getCurrentUser();
  if (!user) {
    container.innerHTML = `<div class="placeholder-page"><div class="placeholder-text">请先创建用户档案</div></div>`;
    return;
  }

  if (!user.worldLineOverrides || typeof user.worldLineOverrides !== 'object') {
    user.worldLineOverrides = {};
  }

  const activePreset = user.auPreset || null;
  const customAu = user.auCustom || '';
  const wlo = user.worldLineOverrides;
  const s9 = wlo.season9Champion != null ? String(wlo.season9Champion) : '';
  const detail = wlo.specialDetails != null ? String(wlo.specialDetails) : '';

  const presetCards = AU_PRESETS.map(
    (p) => `
    <div class="au-preset-card${activePreset === p.id ? ' active' : ''}" data-preset-id="${escapeAttr(p.id)}" role="button" tabindex="0">
      <div class="au-preset-icon">${escapeHtml(p.icon)}</div>
      <div class="au-preset-name">${escapeHtml(p.name)}</div>
      <div class="au-preset-desc">${escapeHtml(p.description)}</div>
    </div>`
  ).join('');

  container.classList.add('au-panel-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn au-back" aria-label="返回">‹</button>
      <h1 class="navbar-title">AU设定</h1>
      <span class="navbar-btn" style="visibility:hidden" aria-hidden="true"></span>
    </header>
    <div class="page-scroll au-panel-body">
      <section class="au-section">
        <h2 class="au-section-title">快捷预设</h2>
        <div class="au-preset-grid">${presetCards}</div>
      </section>
      <section class="au-section">
        <h2 class="au-section-title">自定义AU</h2>
        <textarea class="form-input au-custom-text" rows="6" placeholder="在此写入世界书叠加内容…">${escapeHtml(customAu)}</textarea>
        <button type="button" class="btn btn-primary au-custom-save" style="width:100%;margin-top:8px;">保存自定义AU</button>
      </section>
      <section class="au-section">
        <h2 class="au-section-title">虚拟世界线覆盖</h2>
        <p class="au-override-explain">在原作时间线基础上修改设定（仅限当前存档）</p>
        <div class="form-group">
          <label class="form-label">第九赛季冠军</label>
          <input type="text" class="form-input au-wlo-s9" value="${escapeAttr(s9)}" placeholder="例如：轮回" />
        </div>
        <div class="form-group">
          <label class="form-label">特殊细节</label>
          <input type="text" class="form-input au-wlo-detail" value="${escapeAttr(detail)}" placeholder="自由填写" />
        </div>
        <button type="button" class="btn btn-primary au-wlo-save" style="width:100%;margin-top:8px;">保存世界线覆盖</button>
      </section>
      <button type="button" class="btn btn-outline au-clear-all" style="width:calc(100% - 32px);margin:24px 16px 32px;">清除所有AU设定</button>
    </div>
  `;

  container.querySelector('.au-back')?.addEventListener('click', () => back());

  container.querySelectorAll('.au-preset-card').forEach((card) => {
    const select = async () => {
      const id = card.dataset.presetId;
      if (!id) return;
      user = (await getCurrentUser()) || user;
      user.auPreset = id;
      await db.put('users', user);
      setState('currentUser', user);
      container.querySelectorAll('.au-preset-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
    };
    card.addEventListener('click', select);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select();
      }
    });
  });

  container.querySelector('.au-custom-save')?.addEventListener('click', async () => {
    const ta = container.querySelector('.au-custom-text');
    user = (await getCurrentUser()) || user;
    user.auCustom = ta?.value || '';
    await db.put('users', user);
    setState('currentUser', user);
  });

  container.querySelector('.au-wlo-save')?.addEventListener('click', async () => {
    user = (await getCurrentUser()) || user;
    if (!user.worldLineOverrides || typeof user.worldLineOverrides !== 'object') {
      user.worldLineOverrides = {};
    }
    user.worldLineOverrides.season9Champion = container.querySelector('.au-wlo-s9')?.value || '';
    user.worldLineOverrides.specialDetails = container.querySelector('.au-wlo-detail')?.value || '';
    await db.put('users', user);
    setState('currentUser', user);
  });

  container.querySelector('.au-clear-all')?.addEventListener('click', async () => {
    if (!confirm('确定清除所有 AU 设定与世界线覆盖？')) return;
    user = (await getCurrentUser()) || user;
    user.auPreset = null;
    user.auCustom = '';
    user.worldLineOverrides = {};
    await db.put('users', user);
    setState('currentUser', user);
    await render(container);
  });

  void navigate;
}
