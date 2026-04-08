import { navigate, back } from '../core/router.js';
import * as db from '../core/db.js';
import { AU_PRESETS } from '../data/au-presets.js';
import { setState, getState } from '../core/state.js';
import { getMergedWorldBooksForSeason } from '../core/context.js';

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

  if (!Array.isArray(user.auBoundWorldBookIds)) user.auBoundWorldBookIds = [];
  if (!Array.isArray(user.auSavedPresets)) user.auSavedPresets = [];

  const season = getState('currentUser')?.currentTimeline || user.currentTimeline || 'S8';
  let wbItems = [];
  try {
    wbItems = await getMergedWorldBooksForSeason(season, user);
  } catch (_) {
    wbItems = [];
  }
  const boundSet = new Set(user.auBoundWorldBookIds);
  const wbBindHtml = wbItems.length
    ? wbItems
        .map(
          (w) => `
    <label style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <input type="checkbox" class="au-wb-bind-cb" value="${escapeAttr(w.id)}" ${boundSet.has(w.id) ? 'checked' : ''} style="margin-top:2px;flex-shrink:0;" />
      <span>${escapeHtml(w.name || w.id)} <span class="text-hint" style="font-size:11px;">${escapeHtml(w.id)}</span></span>
    </label>`,
        )
        .join('')
    : '<div class="text-hint" style="padding:10px;">当前赛季暂无可用世界书页（或未启用）。请在世界书中启用条目后再来勾选。</div>';

  const auSlots = user.auSavedPresets;
  const slotsHtml = auSlots.length
    ? auSlots
        .map(
          (s) => `
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);">
      <span style="flex:1;min-width:140px;font-weight:500;">${escapeHtml(s.name)}</span>
      <button type="button" class="btn btn-sm btn-primary au-slot-apply" data-slot-id="${escapeAttr(s.id)}">套用</button>
      <button type="button" class="btn btn-sm btn-outline au-slot-del" data-slot-id="${escapeAttr(s.id)}">删除</button>
    </div>`,
        )
        .join('')
    : '<div class="text-hint" style="padding:8px 0;">暂无命名存档。选好上方「快捷预设」、写好「自定义AU」并勾选绑定世界书后，点下方保存为新预设。</div>';

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
        <h2 class="au-section-title">AU 绑定世界书</h2>
        <p class="au-override-explain">勾选的世界书页会在 AU 上下文中<strong>额外全文注入</strong>（不受 selective 关键词限制）。用于把某套设定与当前 AU 常驻绑定。</p>
        <div style="max-height:240px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:4px 10px;">${wbBindHtml}</div>
        <button type="button" class="btn btn-primary au-wb-bind-save" style="width:100%;margin-top:10px;">保存绑定世界书</button>
      </section>
      <section class="au-section">
        <h2 class="au-section-title">命名 AU 存档（常驻预设）</h2>
        <p class="au-override-explain">一键保存当前「快捷预设 + 自定义AU正文 + 绑定世界书」，可随时套用切换。</p>
        <div>${slotsHtml}</div>
        <button type="button" class="btn btn-outline au-slot-add" style="width:100%;margin-top:10px;">将当前设定存为新预设…</button>
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

  container.querySelector('.au-wb-bind-save')?.addEventListener('click', async () => {
    user = (await getCurrentUser()) || user;
    const ids = [...container.querySelectorAll('.au-wb-bind-cb:checked')].map((el) => el.value);
    user.auBoundWorldBookIds = ids;
    await db.put('users', user);
    setState('currentUser', user);
  });

  container.querySelector('.au-slot-add')?.addEventListener('click', async () => {
    const name = window.prompt('新 AU 预设名称（保存当前快捷预设、自定义正文、绑定世界书）', '');
    if (!name || !String(name).trim()) return;
    user = (await getCurrentUser()) || user;
    const list = Array.isArray(user.auSavedPresets) ? [...user.auSavedPresets] : [];
    list.push({
      id: `auslot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: String(name).trim(),
      auPreset: user.auPreset || null,
      auCustom: user.auCustom || '',
      worldBookIds: [...(user.auBoundWorldBookIds || [])],
    });
    user.auSavedPresets = list;
    await db.put('users', user);
    setState('currentUser', user);
    await render(container);
  });

  container.querySelectorAll('.au-slot-apply').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.slotId;
      user = (await getCurrentUser()) || user;
      const slot = (user.auSavedPresets || []).find((x) => x.id === id);
      if (!slot) return;
      user.auPreset = slot.auPreset || null;
      user.auCustom = slot.auCustom || '';
      user.auBoundWorldBookIds = Array.isArray(slot.worldBookIds) ? [...slot.worldBookIds] : [];
      await db.put('users', user);
      setState('currentUser', user);
      await render(container);
    });
  });

  container.querySelectorAll('.au-slot-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.slotId;
      if (!window.confirm('删除该命名 AU 存档？')) return;
      user = (await getCurrentUser()) || user;
      user.auSavedPresets = (user.auSavedPresets || []).filter((x) => x.id !== id);
      await db.put('users', user);
      setState('currentUser', user);
      await render(container);
    });
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
    if (!window.confirm('确定清除当前生效的 AU（快捷预设、自定义正文、绑定世界书）与世界线覆盖？\n命名 AU 存档列表将保留，可继续套用或逐个删除。')) return;
    user = (await getCurrentUser()) || user;
    user.auPreset = null;
    user.auCustom = '';
    user.auBoundWorldBookIds = [];
    user.worldLineOverrides = {};
    await db.put('users', user);
    setState('currentUser', user);
    await render(container);
  });

  void navigate;
}
