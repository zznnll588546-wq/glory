import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { CHARACTERS } from '../data/characters.js';
import { TEAMS, TEAM_LIST } from '../data/teams.js';
import { SEASONS } from '../models/timeline.js';
import { getCharacterStateForSeason, getDisplayTeamName } from '../core/chat-helpers.js';
import { getState } from '../core/state.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { loadPasserbyAvatarPool, pickPasserbyAvatar } from '../core/avatar-pool.js';

let passerbyAvatarPool = [];

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function renderAvatar(character) {
  if (character?.avatar && String(character.avatar).startsWith('data:')) {
    return `<img src="${escapeAttr(character.avatar)}" alt="" />`;
  }
  if (character?.avatar && /^https?:/i.test(String(character.avatar))) {
    return `<img src="${escapeAttr(character.avatar)}" alt="" />`;
  }
  const passerby = pickPasserbyAvatar(passerbyAvatarPool, character?.id || character?.name || '');
  if (passerby) return `<img src="${escapeAttr(passerby)}" alt="" />`;
  if (character?.defaultEmoji) return `<span>${escapeHtml(character.defaultEmoji)}</span>`;
  return `<span>${escapeHtml((character?.name || '?').slice(0, 1))}</span>`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default async function render(container) {
  passerbyAvatarPool = await loadPasserbyAvatarPool();
  const currentUser = getState('currentUser');
  let selectedSeason = currentUser?.currentTimeline || 'S8';
  let selectedTeam = '';
  let searchQuery = '';
  let showNotDebuted = false;
  const storedChars = await db.getAll('characters');
  const storedMap = new Map(storedChars.map((c) => [c.id, c]));
  const mergedCharacters = CHARACTERS.map((c) => ({ ...c, ...(storedMap.get(c.id) || {}) }));

  container.classList.add('character-book-page');

  function buildSeasonOptions() {
    return SEASONS.map((s) =>
      `<option value="${escapeAttr(s.id)}"${s.id === selectedSeason ? ' selected' : ''}>${escapeHtml(s.name)}</option>`
    ).join('');
  }

  function buildTeamOptions() {
    return [
      `<option value=""${!selectedTeam ? ' selected' : ''}>全部战队</option>`,
      ...TEAM_LIST.map((t) =>
        `<option value="${escapeAttr(t.id)}"${selectedTeam === t.id ? ' selected' : ''}>${escapeHtml(t.name)}</option>`
      ),
    ].join('');
  }

  function getFilteredCharacters() {
    return mergedCharacters.filter((c) => {
      const state = getCharacterStateForSeason(c, selectedSeason);

      if (!showNotDebuted && state.status?.includes('未正式出道')) return false;

      if (selectedTeam && state.team !== selectedTeam) return false;

      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const nameMatch = c.name?.includes(q) || c.realName?.includes(q);
        const cardMatch = (state.card || '').includes(q);
        const aliasMatch = (c.aliases || []).some((a) => a.toLowerCase().includes(q));
        if (!nameMatch && !cardMatch && !aliasMatch) return false;
      }

      return true;
    });
  }

  function renderCharacterCard(c) {
    const state = getCharacterStateForSeason(c, selectedSeason);
    const displayName = state.publicName || c.name;
    const isNotDebuted = state.status?.includes('未正式出道');

    return `
      <div class="cb-card${isNotDebuted ? ' cb-card-dimmed' : ''}" data-character-id="${escapeAttr(c.id)}" role="button" tabindex="0">
        <div class="avatar">${renderAvatar(c)}</div>
        <div class="cb-card-info">
          <div class="cb-card-name">${escapeHtml(displayName)}</div>
          <div class="cb-card-detail">${escapeHtml(state.card || '无账号卡')} · ${escapeHtml(state.class || '无职业')}</div>
          <div class="cb-card-meta">${escapeHtml(getDisplayTeamName(state.team))} · ${escapeHtml(state.role || '无')} · ${escapeHtml(state.status || '未知')}</div>
        </div>
      </div>
    `;
  }

  function renderList() {
    const chars = getFilteredCharacters().sort((a, b) => {
      const sa = getCharacterStateForSeason(a, selectedSeason);
      const sb = getCharacterStateForSeason(b, selectedSeason);
      const ta = sa.team || 'zzz';
      const tb = sb.team || 'zzz';
      if (ta !== tb) return ta.localeCompare(tb);
      return (a.name || '').localeCompare(b.name || '', 'zh-CN');
    });

    let currentTeam = null;
    let html = '';

    for (const c of chars) {
      const state = getCharacterStateForSeason(c, selectedSeason);
      const teamId = state.team || '_none';

      if (teamId !== currentTeam) {
        currentTeam = teamId;
        const teamName = teamId === '_none' ? '无战队/退役/未出道' : getDisplayTeamName(teamId);
        html += `<div class="cb-team-header">${escapeHtml(teamName)}</div>`;
      }
      html += renderCharacterCard(c);
    }

    if (!chars.length) {
      html = `<div class="text-hint" style="padding:32px 0;text-align:center;">当前筛选条件下无角色</div>`;
    }

    return html;
  }

  function fullRender() {
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn cb-back" aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">人物书</h1>
        <span class="navbar-btn" style="visibility:hidden"></span>
      </header>
      <div class="cb-filters">
        <select class="form-input cb-season-select" style="flex:1;">${buildSeasonOptions()}</select>
        <select class="form-input cb-team-select" style="flex:1;">${buildTeamOptions()}</select>
      </div>
      <div class="cb-search">
        <input type="search" class="form-input cb-search-input" placeholder="搜索角色名 / 账号卡 / 别名" value="${escapeAttr(searchQuery)}" />
      </div>
      <div class="cb-toggle-row">
        <label style="display:flex;align-items:center;gap:6px;font-size:var(--font-sm);color:var(--text-secondary);">
          <input type="checkbox" class="cb-show-not-debuted" ${showNotDebuted ? 'checked' : ''} />
          显示未出道角色
        </label>
        <span class="text-hint" style="font-size:var(--font-xs);">共 ${getFilteredCharacters().length} 人</span>
      </div>
      <div class="cb-list">${renderList()}</div>
    `;

    container.querySelector('.cb-back')?.addEventListener('click', () => back());

    container.querySelector('.cb-season-select')?.addEventListener('change', (e) => {
      selectedSeason = e.target.value;
      fullRender();
    });

    container.querySelector('.cb-team-select')?.addEventListener('change', (e) => {
      selectedTeam = e.target.value;
      fullRender();
    });

    container.querySelector('.cb-search-input')?.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      const listEl = container.querySelector('.cb-list');
      if (listEl) {
        listEl.innerHTML = renderList();
        bindCardClicks();
      }
      const countEl = container.querySelector('.cb-toggle-row .text-hint');
      if (countEl) countEl.textContent = `共 ${getFilteredCharacters().length} 人`;
    });

    container.querySelector('.cb-show-not-debuted')?.addEventListener('change', (e) => {
      showNotDebuted = e.target.checked;
      const listEl = container.querySelector('.cb-list');
      if (listEl) {
        listEl.innerHTML = renderList();
        bindCardClicks();
      }
      const countEl = container.querySelector('.cb-toggle-row .text-hint');
      if (countEl) countEl.textContent = `共 ${getFilteredCharacters().length} 人`;
    });

    bindCardClicks();
  }

  function bindCardClicks() {
    container.querySelectorAll('.cb-card').forEach((card) => {
      const open = () => openCharacterDetail(card.dataset.characterId);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }

  async function openCharacterDetail(characterId) {
    const staticChar = CHARACTERS.find((c) => c.id === characterId);
    if (!staticChar) return;
    const storedChar = await db.get('characters', characterId);
    const merged = { ...staticChar, ...(storedChar || {}) };
    const states = merged.timelineStates || {};

    const seasonTabs = SEASONS.map((s) => {
      const st = getCharacterStateForSeason(merged, s.id);
      const hasData = states[s.id];
      return `
        <div class="cb-detail-season-tab${s.id === selectedSeason ? ' active' : ''}${!hasData ? ' dimmed' : ''}" data-season="${escapeAttr(s.id)}">
          <div class="cb-detail-season-label">${escapeHtml(s.id)}</div>
          <div class="cb-detail-season-info">
            <div>${escapeHtml(st.publicName || merged.name)}</div>
            <div class="text-hint">${escapeHtml(st.card || '无')} · ${escapeHtml(getDisplayTeamName(st.team))}</div>
            <div class="text-hint">${escapeHtml(st.role || '无')} · ${escapeHtml(st.status || '未知')}</div>
          </div>
        </div>
      `;
    }).join('');

    const relationshipEntries = Object.entries(merged.relationships || {});
    const relationships = relationshipEntries.map(([id, desc]) => {
      const target = CHARACTERS.find((c) => c.id === id);
      return `<div class="cb-rel-row"><span class="cb-rel-name">${escapeHtml(target?.name || id)}</span><span class="cb-rel-desc">${escapeHtml(desc)}</span></div>`;
    }).join('') || '<div class="text-hint">暂无关系数据</div>';
    const relationOptions = CHARACTERS
      .filter((c) => c.id !== characterId)
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'))
      .map((c) => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.name || c.id)}</option>`)
      .join('');

    const host = document.getElementById('modal-container');
    if (!host) return;
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay" data-modal-overlay>
        <div class="modal-sheet modal-sheet-tall" role="dialog" aria-modal="true" data-modal-sheet>
          <div class="modal-header">
            <h3>${escapeHtml(merged.name)} 角色详情</h3>
            <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">${icon('close')}</button>
          </div>
          <div class="modal-body">
            <div class="cb-detail-header">
              <div class="avatar avatar-lg">${renderAvatar(merged)}</div>
              <div>
                <div style="font-weight:700;font-size:var(--font-lg);">${escapeHtml(merged.name)}</div>
                <div class="text-hint">${escapeHtml((merged.aliases || []).join(' / ') || '无别名')}</div>
              </div>
            </div>
            <div class="card-block" style="margin:12px 0;">
              <div class="form-label">性格设定</div>
              <div style="font-size:var(--font-sm);line-height:1.5;">${escapeHtml(merged.personality || '无')}</div>
            </div>
            <div class="card-block" style="margin:12px 0;">
              <div class="form-label">说话风格</div>
              <div style="font-size:var(--font-sm);">${escapeHtml(merged.speechStyle || '无')}</div>
            </div>
            <div class="card-block" style="margin:12px 0;">
              <div class="form-label">人物信息编辑（手动覆盖）</div>
              <label class="form-label" style="margin-top:8px;">显示名</label>
              <input class="form-input cb-edit-name" value="${escapeAttr(merged.name || '')}" />
              <label class="form-label" style="margin-top:8px;">真实姓名</label>
              <input class="form-input cb-edit-realname" value="${escapeAttr(merged.realName || '')}" />
              <label class="form-label" style="margin-top:8px;">别名（用 / 分隔）</label>
              <input class="form-input cb-edit-aliases" value="${escapeAttr((merged.aliases || []).join(' / '))}" />
              <label class="form-label" style="margin-top:8px;">性格设定</label>
              <textarea class="form-input cb-edit-personality" rows="3">${escapeHtml(merged.personality || '')}</textarea>
              <label class="form-label" style="margin-top:8px;">说话风格</label>
              <textarea class="form-input cb-edit-speech" rows="3">${escapeHtml(merged.speechStyle || '')}</textarea>
              <button type="button" class="btn btn-primary btn-sm cb-save-basic" style="margin-top:10px;">保存人物信息</button>
            </div>
            <div class="form-label" style="margin:16px 0 8px;">各赛季状态</div>
            <div class="cb-detail-seasons">${seasonTabs}</div>
            <div class="form-label" style="margin:16px 0 8px;">关系网络</div>
            <div class="cb-rels">${relationships}</div>
            <div class="card-block" style="margin-top:10px;">
              <div class="form-label">关系管理</div>
              <div style="display:flex;gap:8px;align-items:center;">
                <select class="form-input cb-rel-target" style="flex:1;">${relationOptions}</select>
                <button type="button" class="btn btn-outline btn-sm cb-rel-add">新增/更新</button>
              </div>
              <textarea class="form-input cb-rel-text" rows="2" placeholder="关系描述（例如：亦敌亦友 / 队友 / 师徒）" style="margin-top:8px;"></textarea>
              <div class="cb-rel-editor-list" style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">
                ${relationshipEntries.length
                  ? relationshipEntries.map(([rid, rdesc]) => {
                      const target = CHARACTERS.find((c) => c.id === rid);
                      return `<div class="cb-rel-editor-row" data-rel-id="${escapeAttr(rid)}" style="display:flex;gap:8px;align-items:center;">
                        <div class="text-hint" style="min-width:72px;">${escapeHtml(target?.name || rid)}</div>
                        <input class="form-input cb-rel-edit-input" style="flex:1;padding:6px 8px;" value="${escapeAttr(rdesc)}" />
                        <button type="button" class="btn btn-outline btn-sm cb-rel-save">保存</button>
                        <button type="button" class="btn btn-danger btn-sm cb-rel-del">删除</button>
                      </div>`;
                    }).join('')
                  : '<div class="text-hint">暂无可编辑关系</div>'}
              </div>
            </div>
            <div style="margin-top:16px;display:flex;gap:8px;">
              <button type="button" class="btn btn-primary btn-sm cb-add-friend">添加到通讯录</button>
              <button type="button" class="btn btn-outline btn-sm cb-user-rel">对User关系</button>
              <button type="button" class="btn btn-outline btn-sm cb-edit-custom">编辑自定义字段</button>
              <button type="button" class="btn btn-outline btn-sm cb-upload-avatar">上传头像</button>
            </div>
            <input type="file" class="cb-avatar-input" accept="image/*" style="display:none;" />
          </div>
        </div>
      </div>
    `;

    const close = () => { host.classList.remove('active'); host.innerHTML = ''; };
    host.querySelector('[data-modal-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('[data-modal-overlay]')?.addEventListener('click', close);
    host.querySelector('.modal-close-btn')?.addEventListener('click', close);

    host.querySelector('.cb-add-friend')?.addEventListener('click', async () => {
      const user = getState('currentUser');
      if (!user) { showToast('请先创建用户档案'); return; }
      const friends = Array.isArray(user.friends) ? [...user.friends] : [];
      const ids = new Set(friends.map((f) => typeof f === 'string' ? f : f?.id));
      if (ids.has(characterId)) { showToast('已在通讯录中'); return; }
      friends.push({ id: characterId, groupId: 'default', source: 'character-book' });
      user.friends = friends;
      await db.put('users', user);
      if (!await db.get('characters', characterId)) {
        await db.put('characters', { ...staticChar });
      }
      showToast(`已添加 ${merged.name}`);
    });

    host.querySelector('.cb-edit-custom')?.addEventListener('click', async () => {
      const nickname = window.prompt('自定义昵称（留空保持默认）', storedChar?.customNickname || '');
      if (nickname === null) return;
      const notes = window.prompt('备注', storedChar?.notes || '');
      if (notes === null) return;
      const toSave = { ...staticChar, ...(storedChar || {}), customNickname: nickname, notes };
      await db.put('characters', toSave);
      showToast('已保存自定义字段');
    });

    host.querySelector('.cb-save-basic')?.addEventListener('click', async () => {
      const aliasesRaw = String(host.querySelector('.cb-edit-aliases')?.value || '');
      const aliases = aliasesRaw
        .split(/[\/、，,\n]/)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 20);
      const next = {
        ...staticChar,
        ...(storedChar || {}),
        ...merged,
        name: String(host.querySelector('.cb-edit-name')?.value || merged.name || '').trim() || merged.name,
        realName: String(host.querySelector('.cb-edit-realname')?.value || merged.realName || '').trim(),
        aliases,
        personality: String(host.querySelector('.cb-edit-personality')?.value || '').trim(),
        speechStyle: String(host.querySelector('.cb-edit-speech')?.value || '').trim(),
      };
      await db.put('characters', next);
      showToast('人物信息已保存');
      close();
      await fullRender();
      await openCharacterDetail(characterId);
    });

    host.querySelector('.cb-rel-add')?.addEventListener('click', async () => {
      const rid = host.querySelector('.cb-rel-target')?.value;
      const rtext = (host.querySelector('.cb-rel-text')?.value || '').trim();
      if (!rid || !rtext) {
        showToast('请选择关系对象并填写关系描述');
        return;
      }
      const next = { ...(storedChar || {}), ...merged, relationships: { ...(storedChar?.relationships || merged.relationships || {}) } };
      next.relationships[rid] = rtext;
      await db.put('characters', next);
      showToast('关系已保存');
      close();
      await openCharacterDetail(characterId);
    });
    host.querySelectorAll('.cb-rel-editor-row').forEach((row) => {
      const rid = row.dataset.relId;
      row.querySelector('.cb-rel-save')?.addEventListener('click', async () => {
        const val = (row.querySelector('.cb-rel-edit-input')?.value || '').trim();
        if (!val) {
          showToast('关系描述不能为空');
          return;
        }
        const next = { ...(storedChar || {}), ...merged, relationships: { ...(storedChar?.relationships || merged.relationships || {}) } };
        next.relationships[rid] = val;
        await db.put('characters', next);
        showToast('关系已更新');
      });
      row.querySelector('.cb-rel-del')?.addEventListener('click', async () => {
        const next = { ...(storedChar || {}), ...merged, relationships: { ...(storedChar?.relationships || merged.relationships || {}) } };
        delete next.relationships[rid];
        await db.put('characters', next);
        showToast('关系已删除');
        close();
        await openCharacterDetail(characterId);
      });
    });

    host.querySelector('.cb-upload-avatar')?.addEventListener('click', () => {
      host.querySelector('.cb-avatar-input')?.click();
    });
    host.querySelector('.cb-user-rel')?.addEventListener('click', () => {
      close();
      navigate('user-relationship', { characterId });
    });
    host.querySelector('.cb-avatar-input')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const dataUrl = await fileToDataUrl(file);
        const next = { ...(storedChar || {}), ...merged, avatar: dataUrl };
        await db.put('characters', next);
        showToast('头像已更新（全存档通用）');
        close();
        await fullRender();
      } catch (_) {
        showToast('头像读取失败');
      } finally {
        e.target.value = '';
      }
    });
  }

  fullRender();
}
