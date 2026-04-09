import { back } from '../core/router.js';
import * as db from '../core/db.js';
import { getState } from '../core/state.js';
import { CHARACTERS } from '../data/characters.js';
import { showToast } from '../components/toast.js';

const USER_RELATION_KEY = 'userRelationConfig';
const DEFAULT_IMPORTANT_IDS = [
  'yexiu', 'yuwenzhou', 'huangshaotian', 'wangjiexi', 'zhouzhekai', 'hanwenqing',
  'zhangxinjie', 'sunxiang', 'tanghao', 'liuxiaobie', 'yuanbaiqing', 'xujingxi',
];

function e(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clamp100(n) {
  return Math.max(0, Math.min(100, Number(n || 0)));
}

/** 关系三项可超出 0~100；非法输入回退 */
function relStatNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseRelInput(raw, fallback) {
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) ? n : fallback;
}

function clampApm(n) {
  return Math.max(200, Math.min(700, Number(n || 300)));
}

function appearanceStage(v) {
  const x = clamp100(v);
  if (x >= 90) return '神颜';
  if (x >= 75) return '高颜值';
  if (x >= 60) return '耐看';
  if (x >= 40) return '普通';
  if (x >= 25) return '朴素';
  return '低存在感';
}

function getKnownSeedIds(user) {
  const s = new Set();
  const friends = Array.isArray(user?.friends) ? user.friends : [];
  for (const f of friends) {
    const id = typeof f === 'string' ? f : f?.id;
    if (id) s.add(id);
  }
  return s;
}

function rollStarterProfile(mode = 'normal') {
  const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const presets = {
    rookie: { apm: [230, 380], appearance: [35, 85], pop: [25, 60], style: [20, 70], talent: [30, 70] },
    normal: { apm: [280, 460], appearance: [35, 90], pop: [30, 75], style: [20, 80], talent: [40, 85] },
    veteran: { apm: [320, 580], appearance: [40, 95], pop: [45, 90], style: [35, 90], talent: [55, 95] },
  }[mode] || { apm: [260, 430], appearance: [35, 85], pop: [30, 70], style: [20, 80], talent: [35, 85] };
  return {
    handSpeedApm: rand(presets.apm[0], presets.apm[1]),
    appearance: rand(presets.appearance[0], presets.appearance[1]),
    popularity: rand(presets.pop[0], presets.pop[1]),
    style: rand(presets.style[0], presets.style[1]),
    talent: rand(presets.talent[0], presets.talent[1]),
  };
}

async function loadPack(userId) {
  const row = await db.get('settings', USER_RELATION_KEY);
  const value = row?.value || { byUserId: {} };
  const byUserId = value.byUserId || {};
  const pack = byUserId[userId] || { profile: {}, relations: {} };
  return { value, byUserId, pack };
}

function applyPreset(relations, mode, knownSeedIds = new Set()) {
  const ids = Object.keys(relations);
  for (const id of ids) {
    const x = relations[id] || {};
    const knownSeed = knownSeedIds.has(id);
    if (mode === 'rookie') {
      x.affection = 20; x.desire = 10; x.bond = 15; x.known = knownSeed;
    } else if (mode === 'normal') {
      x.affection = knownSeed ? 45 : 25;
      x.desire = knownSeed ? 25 : 10;
      x.bond = knownSeed ? 40 : 12;
      x.known = knownSeed;
    } else if (mode === 'veteran') {
      x.affection = knownSeed ? 72 : 36;
      x.desire = knownSeed ? 38 : 16;
      x.bond = knownSeed ? 76 : 22;
      x.known = knownSeed;
    } else if (mode === 'chaos') {
      x.affection = Math.floor(Math.random() * 101);
      x.desire = Math.floor(Math.random() * 101);
      x.bond = Math.floor(Math.random() * 101);
      x.known = knownSeed || Math.random() > 0.7;
    }
    relations[id] = x;
  }
}

function randInt(min, max) {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  return a + Math.floor(Math.random() * (b - a + 1));
}

function applyUnknownAffinityPreset(relations, preset) {
  for (const [cid, r] of Object.entries(relations || {})) {
    if (r?.known === true) continue;
    const next = { ...(r || {}) };
    if (preset === 'popular') {
      next.affection = randInt(48, 72);
      next.bond = randInt(22, 46);
      next.desire = randInt(8, 34);
    } else if (preset === 'unpopular') {
      next.affection = randInt(10, 34);
      next.bond = randInt(8, 30);
      next.desire = randInt(5, 22);
    } else if (preset === 'lowkey') {
      next.affection = randInt(28, 52);
      next.bond = randInt(10, 28);
      next.desire = randInt(6, 24);
    } else if (preset === 'charm') {
      next.affection = randInt(68, 92);
      next.desire = randInt(55, 90);
    } else if (preset === 'dislike') {
      next.affection = randInt(8, 28);
      next.desire = randInt(4, 18);
    } else {
      continue;
    }
    relations[cid] = next;
  }
}

function rankTop(relations, key) {
  return Object.entries(relations)
    .map(([id, v]) => ({ id, val: relStatNum(v?.[key], 0), known: v?.known === true }))
    .sort((a, b) => b.val - a.val)
    .slice(0, 10);
}

function calcRelationScore(v = {}) {
  return Number(v?.affection || 0) + Number(v?.bond || 0) + Number(v?.desire || 0) * 0.5;
}

function teamOf(c) {
  return String(c?.team || 'other').trim() || 'other';
}

function teamLabel(tid) {
  const map = {
    jiashi: '嘉世', batu: '霸图', lanyu: '蓝雨', weicao: '微草', lunhui: '轮回',
    huxiao: '呼啸', baihua: '百花', leiting: '雷霆', xukong: '虚空', yanyu: '烟雨',
    yizhan: '义斩', shenqi: '神奇', huangfeng: '皇风', sanlingyi: '三零一', other: '其他',
  };
  return map[tid] || tid;
}

export default async function render(container, params = {}) {
  const user = getState('currentUser');
  if (!user?.id) {
    container.innerHTML = '<div class="placeholder-page"><div class="placeholder-text">请先创建用户档案</div></div>';
    return;
  }
  const { value, byUserId, pack } = await loadPack(user.id);
  const knownSeedIds = getKnownSeedIds(user);
  const profile = {
    tags: [],
    attributes: { handSpeedApm: 320, appearance: 50, popularity: 50, style: 50, talent: 50 },
    debutSeason: user.currentTimeline || 'S8',
    hometown: '',
    initialPersona: '普通',
    spotlightMode: 'normal',
    behaviorThresholds: { high: 70, low: 35 },
    ...(pack.profile || {}),
  };
  if (!Number.isFinite(Number(profile.attributes?.handSpeedApm))) {
    profile.attributes.handSpeedApm = clampApm(profile.attributes?.handSpeed || 320);
  }
  if (!Array.isArray(profile.importantCharacterIds)) profile.importantCharacterIds = [];
  let importantCharacterIds = [...new Set(profile.importantCharacterIds.filter(Boolean))];
  const relations = { ...(pack.relations || {}) };
  for (const c of CHARACTERS) {
    if (!relations[c.id]) relations[c.id] = { affection: 35, desire: 20, bond: 30, known: knownSeedIds.has(c.id) };
  }
  const list = CHARACTERS.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'));
  const autoImportantSet = new Set([
    ...DEFAULT_IMPORTANT_IDS,
    ...Array.from(knownSeedIds),
    ...Object.entries(relations)
      .sort((a, b) => calcRelationScore(b[1]) - calcRelationScore(a[1]))
      .slice(0, 24)
      .map(([id]) => id),
  ]);
  const teamIds = [...new Set(list.map((c) => teamOf(c)))].sort((a, b) => teamLabel(a).localeCompare(teamLabel(b), 'zh-CN'));
  const viewMode = String(params.view || 'important');
  const teamFilter = String(params.team || teamIds[0] || 'other');

  const rowHtml = (c) => {
    const r = relations[c.id] || {};
    const starred = importantCharacterIds.includes(c.id);
    const aff = relStatNum(r.affection, 35);
    const des = relStatNum(r.desire, 20);
    const bond = relStatNum(r.bond, 30);
    return `<div class="card-block" style="margin:8px 12px;" data-cid="${e(c.id)}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
        <strong>${e(c.name)}</strong>
        <div style="display:flex;align-items:center;gap:10px;">
          <button type="button" class="btn btn-sm btn-outline ur-star" data-cid="${e(c.id)}" title="加入/移出重点列表">${starred ? '★ 重点' : '☆ 星标'}</button>
          <label style="font-size:12px;color:var(--text-hint);"><input type="checkbox" class="ur-known" ${r.known === true ? 'checked' : ''}/> 已结识</label>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:70px 1fr;gap:8px;align-items:center;margin-top:6px;">
        <span style="font-size:12px;">好感</span><input class="form-input ur-aff" type="number" step="any" inputmode="decimal" value="${e(String(aff))}" />
      </div>
      <div style="display:grid;grid-template-columns:70px 1fr;gap:8px;align-items:center;margin-top:4px;">
        <span style="font-size:12px;">欲望</span><input class="form-input ur-des" type="number" step="any" inputmode="decimal" value="${e(String(des))}" />
      </div>
      <div style="display:grid;grid-template-columns:70px 1fr;gap:8px;align-items:center;margin-top:4px;">
        <span style="font-size:12px;">关系</span><input class="form-input ur-bond" type="number" step="any" inputmode="decimal" value="${e(String(bond))}" />
      </div>
      <div class="text-hint" style="margin-top:6px;">三项可填任意数值（负数、超过100均可）；非法输入保存时按该行原值保留。</div>
    </div>`;
  };

  function filterList(mode, team) {
    if (mode === 'known') return list.filter((c) => relations[c.id]?.known === true);
    if (mode === 'team') return list.filter((c) => teamOf(c) === team);
    if (importantCharacterIds.length) {
      return importantCharacterIds
        .map((id) => list.find((c) => c.id === id))
        .filter(Boolean);
    }
    return list.filter((c) => autoImportantSet.has(c.id));
  }

  container.innerHTML = `<header class="navbar">
      <button type="button" class="navbar-btn ur-back">‹</button>
      <h1 class="navbar-title">关系进度（对User）</h1>
      <button type="button" class="navbar-btn ur-save">保存</button>
    </header>
    <div class="page-scroll">
      <div class="card-block" style="margin:10px 12px;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm btn-outline ur-preset" data-mode="rookie">新人开局</button>
          <button type="button" class="btn btn-sm btn-outline ur-preset" data-mode="normal">普通开局</button>
          <button type="button" class="btn btn-sm btn-outline ur-preset" data-mode="veteran">老将开局</button>
          <button type="button" class="btn btn-sm btn-outline ur-preset" data-mode="chaos">随机roll</button>
          <button type="button" class="btn btn-sm btn-outline ur-roll-start" data-mode="normal">剧情前ROLL</button>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
          <button type="button" class="btn btn-sm btn-outline ur-unk-aff" data-preset="popular">未结识默认：人缘好</button>
          <button type="button" class="btn btn-sm btn-outline ur-unk-aff" data-preset="unpopular">未结识默认：人缘坏</button>
          <button type="button" class="btn btn-sm btn-outline ur-unk-aff" data-preset="lowkey">未结识默认：小透明</button>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
          <button type="button" class="btn btn-sm btn-outline ur-mode${profile.spotlightMode === 'normal' ? ' active' : ''}" data-mode="normal">普通模式</button>
          <button type="button" class="btn btn-sm btn-outline ur-mode${profile.spotlightMode === 'charm' ? ' active' : ''}" data-mode="charm">万人迷模式</button>
          <button type="button" class="btn btn-sm btn-outline ur-mode${profile.spotlightMode === 'dislike' ? ' active' : ''}" data-mode="dislike">万人嫌模式</button>
          <button type="button" class="btn btn-sm btn-outline ur-mode${profile.spotlightMode === 'lowkey' ? ' active' : ''}" data-mode="lowkey">小透明模式</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">
          <input class="form-input ur-tags" placeholder="标签，逗号分隔：人缘好,高调" value="${e((profile.tags || []).join(','))}" />
          <input class="form-input ur-hometown" placeholder="故乡" value="${e(profile.hometown || '')}" />
          <input class="form-input ur-debut" placeholder="出道赛季" value="${e(profile.debutSeason || '')}" />
          <input class="form-input ur-persona" placeholder="初始人设（小透明/惹人厌/天降紫微星...）" value="${e(profile.initialPersona || '')}" />
        </div>
      </div>
      <div class="card-block" style="margin:10px 12px;">
        <strong>用户属性</strong>
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:8px;">
          <input class="form-input ur-attr-apm" data-k="handSpeedApm" type="number" min="200" max="700" value="${clampApm(profile.attributes?.handSpeedApm)}" />
          <input class="form-input ur-attr" data-k="appearance" type="number" min="0" max="100" value="${clamp100(profile.attributes?.appearance)}" />
          <input class="form-input ur-attr" data-k="popularity" type="number" min="0" max="100" value="${clamp100(profile.attributes?.popularity)}" />
          <input class="form-input ur-attr" data-k="style" type="number" min="0" max="100" value="${clamp100(profile.attributes?.style)}" />
          <input class="form-input ur-attr" data-k="talent" type="number" min="0" max="100" value="${clamp100(profile.attributes?.talent)}" />
        </div>
        <div class="text-hint" style="margin-top:6px;">顺序：手速APM / 外貌 / 人缘 / 作风 / 天赋（职业常规约300-450，500+极强，喻文州约200+）</div>
        <div class="text-hint" style="margin-top:4px;">当前外貌档位：${e(appearanceStage(profile.attributes?.appearance))}</div>
      </div>
      <div class="card-block" style="margin:10px 12px;">
        <strong>关系管理视图</strong>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center;">
          <button type="button" class="btn btn-sm btn-outline ur-view${viewMode === 'important' ? ' active' : ''}" data-view="important">重点角色</button>
          <button type="button" class="btn btn-sm btn-outline ur-view${viewMode === 'known' ? ' active' : ''}" data-view="known">已结识</button>
          <button type="button" class="btn btn-sm btn-outline ur-view${viewMode === 'team' ? ' active' : ''}" data-view="team">按战队</button>
          <button type="button" class="btn btn-sm btn-outline ur-clear-stars"${importantCharacterIds.length ? '' : ' style="opacity:0.45;"'}">清空星标</button>
        </div>
        <div style="margin-top:8px;${viewMode === 'team' ? '' : 'display:none;'}" class="ur-team-filter-wrap">
          <select class="form-input ur-team-filter" style="max-width:220px;">
            ${teamIds.map((tid) => `<option value="${e(tid)}" ${teamFilter === tid ? 'selected' : ''}>${e(teamLabel(tid))}</option>`).join('')}
          </select>
        </div>
        <div class="text-hint" style="margin-top:6px;">聊天心声卡片读取的是同一份关系数据；此页保存后，后续点击头像会读取最新值。好感/欲望/关系已与自动增减逻辑一致，不再锁在 0~100。</div>
        <div class="text-hint" style="margin-top:4px;">「重点角色」：点击各行「星标」维护；未星标任何人时，使用自动推荐列表。</div>
      </div>
      <div class="card-block" style="margin:10px 12px;">
        <strong>行为档位阈值</strong>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">
          <input class="form-input ur-th-high" type="number" min="0" max="100" value="${clamp100(profile.behaviorThresholds?.high)}" placeholder="高档阈值" />
          <input class="form-input ur-th-low" type="number" min="0" max="100" value="${clamp100(profile.behaviorThresholds?.low)}" placeholder="低档阈值" />
        </div>
        <div class="text-hint" style="margin-top:6px;">示例：高档≥70，低档≤35，其余为中档。</div>
      </div>
      <div class="card-block" style="margin:10px 12px;">
        <strong>行为策略矩阵（生效于提示词）</strong>
        <div style="margin-top:8px;font-size:12px;line-height:1.6;">
          <div><b>私聊</b>：高档=主动且温和；中档=礼貌稳定；低档=克制疏离但不失礼</div>
          <div><b>群聊</b>：高档=支持与接话；中档=公事公办；低档=维持体面、减少点名互动</div>
          <div><b>微博/论坛</b>：高档=轻互动或维护；中档=中立观望；低档=谨慎评论、避免人身攻击</div>
          <div class="text-hint" style="margin-top:4px;">所有档位都遵守职业边界：可有分歧，不可霸凌。</div>
        </div>
      </div>
      <div class="card-block" style="margin:10px 12px;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm btn-outline ur-open-rank" data-rank="affection">好感榜</button>
          <button type="button" class="btn btn-sm btn-outline ur-open-rank" data-rank="desire">欲望榜</button>
          <button type="button" class="btn btn-sm btn-outline ur-open-rank" data-rank="bond">关系榜</button>
        </div>
        <div class="text-hint" style="margin-top:6px;">点击按钮展开动态排序榜单。</div>
      </div>
      <div class="ur-list-wrap">${filterList(viewMode, teamFilter).map(rowHtml).join('')}</div>
    </div>`;

  container.querySelector('.ur-back')?.addEventListener('click', () => back());

  async function persistImportantAndRerender() {
    profile.importantCharacterIds = [...importantCharacterIds];
    const byUserIdNext = { ...byUserId, [user.id]: { profile, relations } };
    await db.put('settings', { key: USER_RELATION_KEY, value: { ...value, byUserId: byUserIdNext } });
    showToast(importantCharacterIds.length ? `已更新重点角色（${importantCharacterIds.length}人）` : '已清空星标，重点列表恢复自动推荐');
    await render(container, { ...params, view: viewMode, team: teamFilter });
  }

  container.querySelectorAll('.ur-star').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const cid = String(btn.dataset.cid || '').trim();
      if (!cid) return;
      const idx = importantCharacterIds.indexOf(cid);
      if (idx >= 0) importantCharacterIds.splice(idx, 1);
      else importantCharacterIds.push(cid);
      await persistImportantAndRerender();
    });
  });

  container.querySelector('.ur-clear-stars')?.addEventListener('click', async () => {
    if (!importantCharacterIds.length) {
      showToast('当前没有手动星标');
      return;
    }
    if (!window.confirm('清空全部星标？「重点角色」将恢复为自动推荐。')) return;
    importantCharacterIds = [];
    await persistImportantAndRerender();
  });

  container.querySelectorAll('.ur-view').forEach((btn) => {
    btn.addEventListener('click', () => {
      render(container, { ...params, view: btn.dataset.view || 'important', team: teamFilter });
    });
  });
  container.querySelector('.ur-team-filter')?.addEventListener('change', (e) => {
    const v = String(e.target?.value || teamFilter);
    render(container, { ...params, view: 'team', team: v });
  });
  container.querySelectorAll('.ur-open-rank').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const k = String(btn.dataset.rank || 'affection');
      const label = k === 'desire' ? '欲望榜' : k === 'bond' ? '关系榜' : '好感榜';
      const rows = Object.entries(relations)
        .map(([id, v]) => ({ id, val: relStatNum(v?.[k], 0), known: v?.known === true }))
        .sort((a, b) => b.val - a.val);
      const host = document.getElementById('modal-container');
      if (!host) return;
      host.innerHTML = `
        <div class="modal-overlay" data-modal-overlay>
          <div class="modal-sheet" role="dialog" aria-modal="true" data-modal-sheet style="max-width:420px;">
            <div class="modal-header">
              <h3>${e(label)}</h3>
              <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">×</button>
            </div>
            <div class="modal-body">
              ${rows.map((x, i) => {
                const c = CHARACTERS.find((it) => it.id === x.id);
                const n = c?.name || x.id;
                return `<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
                  <span>${i + 1}. ${e(n)}${x.known ? '' : '（未结识）'}</span>
                  <strong>${x.val}</strong>
                </div>`;
              }).join('')}
            </div>
          </div>
        </div>
      `;
      host.classList.add('active');
      const close = () => { host.classList.remove('active'); host.innerHTML = ''; };
      host.querySelector('[data-modal-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
      host.querySelector('[data-modal-overlay]')?.addEventListener('click', close);
      host.querySelector('.modal-close-btn')?.addEventListener('click', close);
    });
  });

  container.querySelectorAll('.ur-preset').forEach((btn) => {
    btn.addEventListener('click', async () => {
      applyPreset(relations, btn.dataset.mode, knownSeedIds);
      const byUserIdNext = { ...byUserId, [user.id]: { profile, relations } };
      await db.put('settings', { key: USER_RELATION_KEY, value: { ...value, byUserId: byUserIdNext } });
      showToast('预设已应用');
      await render(container);
    });
  });

  container.querySelectorAll('.ur-unk-aff').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const preset = btn.dataset.preset;
      applyUnknownAffinityPreset(relations, preset);
      const hint = preset === 'popular' ? '人缘好' : preset === 'unpopular' ? '人缘坏' : '小透明';
      profile.initialPersona = hint;
      const byUserIdNext = { ...byUserId, [user.id]: { profile, relations } };
      await db.put('settings', { key: USER_RELATION_KEY, value: { ...value, byUserId: byUserIdNext } });
      showToast(`已应用：未结识角色「${hint}」初始区间`);
      await render(container);
    });
  });

  container.querySelectorAll('.ur-mode').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode || 'normal';
      profile.spotlightMode = mode;
      if (mode === 'charm') {
        applyUnknownAffinityPreset(relations, 'charm');
      } else if (mode === 'dislike') {
        applyUnknownAffinityPreset(relations, 'dislike');
      } else if (mode === 'lowkey') {
        applyUnknownAffinityPreset(relations, 'lowkey');
      }
      const byUserIdNext = { ...byUserId, [user.id]: { profile, relations } };
      await db.put('settings', { key: USER_RELATION_KEY, value: { ...value, byUserId: byUserIdNext } });
      showToast(`已切换：${mode === 'charm' ? '万人迷' : mode === 'dislike' ? '万人嫌' : mode === 'lowkey' ? '小透明' : '普通'}模式`);
      await render(container);
    });
  });

  container.querySelector('.ur-roll-start')?.addEventListener('click', async () => {
    const mode = 'normal';
    let rolled = rollStarterProfile(mode);
    const applyRoll = async () => {
      profile.attributes.handSpeedApm = clampApm(rolled.handSpeedApm);
      profile.attributes.appearance = clamp100(rolled.appearance);
      profile.attributes.popularity = clamp100(rolled.popularity);
      profile.attributes.style = clamp100(rolled.style);
      profile.attributes.talent = clamp100(rolled.talent);
      applyPreset(relations, profile.initialPersona?.includes('老') ? 'veteran' : 'normal', knownSeedIds);
      const byUserIdNext = { ...byUserId, [user.id]: { profile, relations } };
      await db.put('settings', { key: USER_RELATION_KEY, value: { ...value, byUserId: byUserIdNext } });
      showToast('ROLL已确认，已写入初始关系与属性');
      await render(container);
    };
    const loop = async () => {
      const msg =
        `手速APM: ${rolled.handSpeedApm}\n` +
        `外貌: ${rolled.appearance}（${appearanceStage(rolled.appearance)}）\n` +
        `人缘: ${rolled.popularity}\n` +
        `作风: ${rolled.style}\n` +
        `天赋: ${rolled.talent}\n\n` +
        '确定使用这组ROLL吗？\n确定=写入，取消=重roll';
      const ok = window.confirm(msg);
      if (ok) {
        await applyRoll();
      } else {
        rolled = rollStarterProfile(mode);
        await loop();
      }
    };
    await loop();
  });

  container.querySelector('.ur-save')?.addEventListener('click', async () => {
    const nextProfile = {
      ...profile,
      importantCharacterIds: [...importantCharacterIds],
      tags: String(container.querySelector('.ur-tags')?.value || '').split(',').map((x) => x.trim()).filter(Boolean),
      hometown: String(container.querySelector('.ur-hometown')?.value || '').trim(),
      debutSeason: String(container.querySelector('.ur-debut')?.value || '').trim(),
      initialPersona: String(container.querySelector('.ur-persona')?.value || '').trim(),
      attributes: { ...(profile.attributes || {}) },
      behaviorThresholds: {
        high: clamp100(container.querySelector('.ur-th-high')?.value),
        low: clamp100(container.querySelector('.ur-th-low')?.value),
      },
    };
    if (nextProfile.behaviorThresholds.low > nextProfile.behaviorThresholds.high) {
      const t = nextProfile.behaviorThresholds.low;
      nextProfile.behaviorThresholds.low = nextProfile.behaviorThresholds.high;
      nextProfile.behaviorThresholds.high = t;
    }
    nextProfile.attributes.handSpeedApm = clampApm(container.querySelector('.ur-attr-apm')?.value);
    container.querySelectorAll('.ur-attr').forEach((el) => {
      nextProfile.attributes[el.dataset.k] = clamp100(el.value);
    });
    const nextRelations = { ...relations };
    container.querySelectorAll('.ur-list-wrap > [data-cid]').forEach((row) => {
      const cid = row.dataset.cid;
      const base = nextRelations[cid] || {};
      nextRelations[cid] = {
        ...base,
        known: !!row.querySelector('.ur-known')?.checked,
        affection: parseRelInput(row.querySelector('.ur-aff')?.value, relStatNum(base.affection, 35)),
        desire: parseRelInput(row.querySelector('.ur-des')?.value, relStatNum(base.desire, 20)),
        bond: parseRelInput(row.querySelector('.ur-bond')?.value, relStatNum(base.bond, 30)),
      };
    });
    const byUserIdNext = { ...byUserId, [user.id]: { profile: nextProfile, relations: nextRelations } };
    await db.put('settings', { key: USER_RELATION_KEY, value: { ...value, byUserId: byUserIdNext } });
    showToast('关系进度已保存');
    await render(container);
  });

  const focusId = String(params.characterId || '').trim();
  if (focusId) {
    const target = container.querySelector(`[data-cid="${focusId.replace(/"/g, '&quot;')}"]`);
    if (target) {
      target.style.outline = '2px solid var(--primary)';
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}
