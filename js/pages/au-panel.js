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

const AU_WLO_QUICK_PRESETS = [
  { id: 'champion_s9', label: 'S9冠军改写：非轮回', apply: { championSeason: 'S9', championTeam: '蓝雨' } },
  { id: 'sumuqiu_player', label: '苏沐秋存活（嘉世选手）', apply: { suMuQiuAlive: true, suMuQiuRole: 'player' } },
  { id: 'sumuqiu_staff', label: '苏沐秋存活（嘉世技术）', apply: { suMuQiuAlive: true, suMuQiuRole: 'staff' } },
  { id: 'sumuqiu_dead', label: '苏沐秋未存活（还原）', apply: { suMuQiuAlive: false, suMuQiuRole: '' } },
  { id: 'jiashi_alt', label: '叶修留嘉世 + 嘉世未倒闭', apply: { yeXiuStayedInJiashi: true, jiashiNeverCollapsed: true } },
  { id: 'sunzheping_active', label: '孙哲平未退役', apply: { sunZhepingNeverRetired: true } },
];

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
  const championSeason = wlo.championSeason != null ? String(wlo.championSeason) : '';
  const championTeam = wlo.championTeam != null ? String(wlo.championTeam) : '';
  const suMuQiuAlive = !!wlo.suMuQiuAlive;
  const suMuQiuRole = wlo.suMuQiuRole != null ? String(wlo.suMuQiuRole) : '';
  const yeXiuStayedInJiashi = !!wlo.yeXiuStayedInJiashi;
  const jiashiNeverCollapsed = !!wlo.jiashiNeverCollapsed;
  const sunZhepingNeverRetired = !!wlo.sunZhepingNeverRetired;
  const quickPresetButtons = AU_WLO_QUICK_PRESETS.map(
    (p) => `<button type="button" class="btn btn-outline btn-sm au-wlo-quick" data-qid="${escapeAttr(p.id)}">${escapeHtml(p.label)}</button>`
  ).join('');

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
          <label class="form-label">快捷覆盖</label>
          <div style="display:flex;flex-wrap:wrap;gap:8px;">${quickPresetButtons}</div>
        </div>
        <div class="form-group">
          <label class="form-label">冠军覆盖（某赛季）</label>
          <div style="display:flex;gap:8px;">
            <input type="text" class="form-input au-wlo-season" value="${escapeAttr(championSeason)}" placeholder="赛季，如 S9" />
            <input type="text" class="form-input au-wlo-champion" value="${escapeAttr(championTeam)}" placeholder="冠军战队，如 蓝雨" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">第九赛季冠军</label>
          <input type="text" class="form-input au-wlo-s9" value="${escapeAttr(s9)}" placeholder="例如：轮回" />
        </div>
        <div class="form-group">
          <label class="form-label">苏沐秋状态</label>
          <div style="display:flex;gap:8px;">
            <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="au-wlo-smq-alive" ${suMuQiuAlive ? 'checked' : ''} /> 存活</label>
            <select class="form-input au-wlo-smq-role">
              <option value="" ${!suMuQiuRole ? 'selected' : ''}>未指定</option>
              <option value="player" ${suMuQiuRole === 'player' ? 'selected' : ''}>嘉世选手</option>
              <option value="staff" ${suMuQiuRole === 'staff' ? 'selected' : ''}>嘉世技术人员</option>
            </select>
          </div>
        </div>
        <div class="form-group" style="display:flex;flex-direction:column;gap:8px;">
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="au-wlo-yexiu-jiashi" ${yeXiuStayedInJiashi ? 'checked' : ''} /> 叶修留在嘉世</label>
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="au-wlo-jiashi-safe" ${jiashiNeverCollapsed ? 'checked' : ''} /> 嘉世未倒闭（无兴欣线）</label>
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="au-wlo-szp-active" ${sunZhepingNeverRetired ? 'checked' : ''} /> 孙哲平未退役</label>
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

  container.querySelectorAll('.au-wlo-quick').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const q = AU_WLO_QUICK_PRESETS.find((x) => x.id === btn.dataset.qid);
      if (!q) return;
      user = (await getCurrentUser()) || user;
      user.worldLineOverrides = { ...(user.worldLineOverrides || {}), ...(q.apply || {}) };
      await db.put('users', user);
      setState('currentUser', user);
      await render(container);
    });
  });

  container.querySelector('.au-wlo-save')?.addEventListener('click', async () => {
    user = (await getCurrentUser()) || user;
    if (!user.worldLineOverrides || typeof user.worldLineOverrides !== 'object') {
      user.worldLineOverrides = {};
    }
    user.worldLineOverrides.season9Champion = container.querySelector('.au-wlo-s9')?.value || '';
    user.worldLineOverrides.championSeason = container.querySelector('.au-wlo-season')?.value || '';
    user.worldLineOverrides.championTeam = container.querySelector('.au-wlo-champion')?.value || '';
    user.worldLineOverrides.suMuQiuAlive = !!container.querySelector('.au-wlo-smq-alive')?.checked;
    user.worldLineOverrides.suMuQiuRole = container.querySelector('.au-wlo-smq-role')?.value || '';
    user.worldLineOverrides.yeXiuStayedInJiashi = !!container.querySelector('.au-wlo-yexiu-jiashi')?.checked;
    user.worldLineOverrides.jiashiNeverCollapsed = !!container.querySelector('.au-wlo-jiashi-safe')?.checked;
    user.worldLineOverrides.sunZhepingNeverRetired = !!container.querySelector('.au-wlo-szp-active')?.checked;
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
