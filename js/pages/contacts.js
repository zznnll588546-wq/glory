import { navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { CHARACTERS, searchCharacters } from '../data/characters.js';
import { TEAMS } from '../data/teams.js';
import { createChat } from '../models/chat.js';
import { createCharacterProfile } from '../models/character.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { getVirtualNow } from '../core/virtual-time.js';

import { getCharacterStateForSeason } from '../core/chat-helpers.js';
import { getState } from '../core/state.js';

function getTimelineAwareTeamContacts(teamId) {
  const currentUser = getState('currentUser');
  const season = currentUser?.currentTimeline || 'S8';
  const members = CHARACTERS.filter((c) => {
    const state = getCharacterStateForSeason(c, season);
    return state.team === teamId;
  });
  const captains = members.filter((c) => {
    const state = getCharacterStateForSeason(c, season);
    const role = (state.role || '').toLowerCase();
    return role.includes('队长') || role.includes('副队长') || role.includes('核心');
  });
  if (captains.length > 0) return captains.map((c) => c.id);
  return members.slice(0, 3).map((c) => c.id);
}

function tabbarHtml(active) {
  const items = [
    { key: 'messages', label: '消息', iconName: 'message', page: 'chat-list' },
    { key: 'contacts', label: '通讯录', iconName: 'contacts', page: 'contacts' },
    { key: 'discover', label: '发现', iconName: 'sparkle', page: 'moments' },
    { key: 'profile', label: '我的', iconName: 'profile', page: 'user-profile' },
    { key: 'backstage', label: '幕后', iconName: 'backstage', page: 'backstage-chat-list' },
  ];
  return `
    <nav class="tabbar" aria-label="主导航">
      ${items
        .map(
          (it) => `
        <button type="button" class="tabbar-item${active === it.key ? ' active' : ''}" data-nav="${it.page}">
          <span class="tab-icon">${icon(it.iconName, 'contacts-tab-icon')}</span>
          <span>${it.label}</span>
        </button>`
        )
        .join('')}
    </nav>
  `;
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
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

function mergeCharacter(id) {
  const fromData = CHARACTERS.find((c) => c.id === id);
  return fromData ? { ...fromData } : null;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function resolveCharacter(id) {
  const stored = await db.get('characters', id);
  const base = mergeCharacter(id);
  if (!stored && !base) return null;
  if (!stored) return { ...createCharacterProfile(base), ...base };
  return { ...base, ...stored };
}

async function ensureCharacterInDb(staticChar) {
  const existing = await db.get('characters', staticChar.id);
  if (existing) return existing;
  const profile = createCharacterProfile({
    id: staticChar.id,
    name: staticChar.name,
    realName: staticChar.realName,
    accountCard: staticChar.accountCard,
    aliases: staticChar.aliases || [],
    className: staticChar.className,
    team: staticChar.team,
    avatar: staticChar.avatar,
    defaultEmoji: staticChar.defaultEmoji,
    debutSeason: staticChar.debutSeason,
    personality: staticChar.personality,
    speechStyle: staticChar.speechStyle,
    timelineStates: staticChar.timelineStates || {},
    relationships: staticChar.relationships || {},
  });
  await db.put('characters', profile);
  return profile;
}

function normalizeFriendEntry(entry) {
  if (typeof entry === 'string') return { id: entry, groupId: 'default', source: 'canon' };
  return {
    id: entry?.id,
    groupId: entry?.groupId || 'default',
    source: entry?.source || 'canon',
    relation: entry?.relation || '',
    note: entry?.note || '',
  };
}

function ensureGroups(user) {
  if (!Array.isArray(user.friendGroups) || user.friendGroups.length === 0) {
    user.friendGroups = [{ id: 'default', name: '默认分组' }];
  }
  return user.friendGroups;
}

async function applyDefaultTeamContacts(user) {
  if (!user?.selectedTeam) return false;
  const defaults = getTimelineAwareTeamContacts(user.selectedTeam);
  if (!defaults.length) return false;

  const normalized = (user.friends || []).map(normalizeFriendEntry);
  const existingIds = new Set(normalized.map((f) => f.id));
  let changed = false;

  for (const characterId of defaults) {
    const staticChar = CHARACTERS.find((c) => c.id === characterId);
    if (!staticChar) continue;
    await ensureCharacterInDb(staticChar);
    if (!existingIds.has(characterId)) {
      normalized.push({ id: characterId, groupId: 'default', source: 'club-default' });
      existingIds.add(characterId);
      changed = true;
    }
  }

  if (changed) {
    user.friends = normalized;
    await db.put('users', user);
  }
  return changed;
}

async function findOrCreatePrivateChat(userId, characterId) {
  const chats = userId ? await db.getAllByIndex('chats', 'userId', userId) : await db.getAll('chats');
  const existing = chats.find(
    (c) =>
      c.type === 'private' &&
      Array.isArray(c.participants) &&
      c.participants.includes('user') &&
      c.participants.includes(characterId) &&
      c.participants.filter(Boolean).length === 2
  );
  if (existing) return existing.id;
  const chat = createChat({
    type: 'private',
    userId: userId || null,
    participants: ['user', characterId],
    lastMessage: '',
    lastActivity: await getVirtualNow(userId || '', Date.now()),
  });
  await db.put('chats', chat);
  return chat.id;
}

function friendMatchesQuery(resolved, q) {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  const nick = (resolved.customNickname || '').toLowerCase();
  const name = (resolved.name || '').toLowerCase();
  const card = (resolved.accountCard || '').toLowerCase();
  const aliases = (resolved.aliases || []).map((a) => String(a).toLowerCase());
  return (
    name.includes(t) ||
    nick.includes(t) ||
    card.includes(t) ||
    aliases.some((a) => a.includes(t))
  );
}

function fuzzyContains(hay = '', needle = '') {
  const h = String(hay || '').toLowerCase();
  const n = String(needle || '').toLowerCase();
  if (!n) return true;
  if (h.includes(n)) return true;
  // subsequence match: "xjx" can match "xujingxi"
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i += 1;
    if (i >= n.length) return true;
  }
  return false;
}

function openGlobalModal(innerHtml) {
  const host = document.getElementById('modal-container');
  if (!host) return { close: () => {} };
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-modal-overlay>
      <div class="modal-sheet" role="dialog" aria-modal="true" data-modal-sheet>
        ${innerHtml}
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-modal-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-modal-overlay]')?.addEventListener('click', close);
  return { close, root: host };
}

export default async function render(container) {
  let user = await getCurrentUser();
  if (!user) {
    container.innerHTML = `<div class="placeholder-page"><div class="placeholder-text">请先创建用户档案</div></div>`;
    return;
  }

  ensureGroups(user);
  await applyDefaultTeamContacts(user);
  user = (await getCurrentUser()) || user;

  let groups = ensureGroups(user);
  let friends = Array.isArray(user.friends) ? [...user.friends].map(normalizeFriendEntry) : [];
  const friendIds = friends.map((f) => f.id).filter(Boolean);

  function renderAvatar(character, displayName) {
    if (character?.avatar && String(character.avatar).startsWith('data:')) {
      return `<img src="${escapeAttr(character.avatar)}" alt="" />`;
    }
    if (character?.avatar && /^https?:/i.test(String(character.avatar))) {
      return `<img src="${escapeAttr(character.avatar)}" alt="" />`;
    }
    if (character?.defaultEmoji) return `<span>${escapeAttr(character.defaultEmoji)}</span>`;
    return `<span>${escapeAttr((displayName || '?').slice(0, 1))}</span>`;
  }

  async function buildGroupedHtml(filterQ) {
    const resolvedList = [];
    for (const friend of friends) {
      const r = await resolveCharacter(friend.id);
      if (r && friendMatchesQuery(r, filterQ)) resolvedList.push({ ...r, friendMeta: friend });
    }
    const byGroup = new Map();
    for (const c of resolvedList) {
      const gid = c.friendMeta?.groupId || 'default';
      if (!byGroup.has(gid)) byGroup.set(gid, []);
      byGroup.get(gid).push(c);
    }

    const blocks = [];
    for (const group of groups) {
      const members = byGroup.get(group.id);
      if (!members?.length) continue;
      blocks.push(`<div class="contact-group-header">${escapeAttr(group.name)}</div>`);
      for (const c of members.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'))) {
        const displayName = (c.customNickname && String(c.customNickname).trim()) || c.name || c.id;
        const team = c.team ? TEAMS[c.team] : null;
        const currentSeason = user.currentTimeline || 'S8';
        const timelineState = c.timelineStates?.[currentSeason] || null;
        const stateText = [
          timelineState?.card || c.accountCard,
          timelineState?.class || c.className,
          timelineState?.role,
        ]
          .filter(Boolean)
          .join(' · ');
        const relationText = c.friendMeta?.relation ? ` · ${c.friendMeta.relation}` : '';
        blocks.push(`
          <div class="list-item contact-row" data-character-id="${escapeAttr(c.id)}" role="button" tabindex="0">
            <div class="avatar">${renderAvatar(c, displayName)}</div>
            <div class="list-item-content">
              <div class="list-item-title">${escapeAttr(displayName)}</div>
              <div class="list-item-subtitle">${escapeAttr(stateText)}</div>
              <div class="contact-card-submeta">${escapeAttr(team?.name || '自定义角色')}${escapeAttr(relationText)}</div>
            </div>
            <div class="list-item-right">›</div>
          </div>
        `);
      }
    }
    return blocks.length
      ? blocks.join('')
      : `<div class="placeholder-page" style="padding:32px 16px;min-height:auto;">
          <div class="placeholder-icon">${icon('contacts', 'placeholder-svg')}</div>
          <div class="placeholder-text">暂无联系人</div>
        </div>`;
  }

  const bodyHtml = await buildGroupedHtml('');
  container.classList.add('contacts-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn contacts-back" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">通讯录</h1>
      <button type="button" class="navbar-btn contacts-add" aria-label="添加好友">${icon('plus')}</button>
    </header>
    <div class="contacts-search">
      <input type="search" class="contacts-search-input" placeholder="搜索联系人 / 账号卡 / 别名" autocomplete="off" />
    </div>
    <div class="contacts-toolbar">
      <button type="button" class="btn btn-outline btn-sm contacts-create-npc">${icon('npc', 'contacts-action-icon')} 新建路人角色</button>
      <button type="button" class="btn btn-outline btn-sm contacts-create-group">${icon('folder', 'contacts-action-icon')} 自定义分组</button>
      <button type="button" class="btn btn-outline btn-sm contacts-user-rel">${icon('sparkle', 'contacts-action-icon')} 对User关系</button>
      <button type="button" class="btn btn-outline btn-sm contacts-recommend-card">${icon('recommendation', 'contacts-action-icon')} 推荐名片</button>
    </div>
    <div class="contacts-body">${bodyHtml}</div>
    ${tabbarHtml('contacts')}
  `;

  const userId = user.id;

  async function refreshList(q) {
    user = (await getCurrentUser()) || user;
    groups = ensureGroups(user);
    friends = Array.isArray(user.friends) ? [...user.friends].map(normalizeFriendEntry) : [];
    const el = container.querySelector('.contacts-body');
    if (el) el.innerHTML = await buildGroupedHtml(q);
    bindContactRows();
    bindRecommendedCards();
  }

  function bindContactRows() {
    container.querySelectorAll('.contact-row').forEach((el) => {
      const id = el.dataset.characterId;
      const open = async () => {
        const chatId = await findOrCreatePrivateChat(userId, id);
        navigate('chat-window', { chatId });
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });
  }

  bindContactRows();

  function bindRecommendedCards() {
    container.querySelectorAll('.recommended-card-add').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const cid = btn.dataset.characterId;
        const staticChar = CHARACTERS.find((x) => x.id === cid);
        if (!staticChar) return;
        await ensureCharacterInDb(staticChar);
        user = (await getCurrentUser()) || user;
        const ids = new Set(Array.isArray(user.friends) ? user.friends.map((f) => normalizeFriendEntry(f).id) : []);
        if (!ids.has(cid)) {
          user.friends = [...(user.friends || []).map(normalizeFriendEntry), { id: cid, groupId: 'default', source: 'recommended-card' }];
          await db.put('users', user);
          showToast(`已添加 ${staticChar.name}`);
          await refreshList(container.querySelector('.contacts-search-input')?.value || '');
        }
      });
    });
  }

  bindRecommendedCards();

  container.querySelector('.contacts-back')?.addEventListener('click', () => navigate('home'));
  container.querySelectorAll('.tabbar-item[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.nav));
  });

  container.querySelector('.contacts-search-input')?.addEventListener('input', (e) => {
    refreshList(e.target.value || '');
  });

  container.querySelector('.contacts-add')?.addEventListener('click', () => {
    const groupOptions = ensureGroups(user)
      .map((g) => `<option value="${escapeAttr(g.id)}">${escapeHtml(g.name)}</option>`)
      .join('');
    const { close, root } = openGlobalModal(`
      <div class="modal-header">
        <h3>添加好友</h3>
        <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">${icon('close')}</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">搜索角色</label>
          <input type="search" class="form-input add-friend-search" placeholder="输入姓名或账号卡" autocomplete="off" />
        </div>
        <div class="form-group">
          <label class="form-label">添加到分组</label>
          <select class="form-input add-friend-group">${groupOptions}</select>
        </div>
        <div class="add-friend-results"></div>
      </div>
    `);

    const closeBtn = root.querySelector('.modal-close-btn');
    closeBtn?.addEventListener('click', close);

    const input = root.querySelector('.add-friend-search');
    const groupSelect = root.querySelector('.add-friend-group');
    const resultsEl = root.querySelector('.add-friend-results');

    function renderResults(query) {
      const q = String(query || '').trim();
      if (!q) {
        resultsEl.innerHTML = '<p style="font-size:var(--font-sm);color:var(--text-hint);">输入关键词搜索角色</p>';
        return;
      }
      const t = q.toLowerCase();
      const merged = CHARACTERS.filter((c) => {
        const pool = [
          c.id,
          c.name,
          c.realName,
          c.accountCard,
          ...(c.aliases || []),
        ]
          .filter(Boolean)
          .map((x) => String(x).toLowerCase());
        return pool.some((x) => x.includes(t) || fuzzyContains(x, t));
      });
      const hits = [...new Map([...searchCharacters(q), ...merged].map((c) => [c.id, c])).values()].slice(0, 50);
      if (!hits.length) {
        resultsEl.innerHTML = '<p style="font-size:var(--font-sm);color:var(--text-hint);">无匹配结果</p>';
        return;
      }
      resultsEl.innerHTML = hits
        .map(
          (c) => `
        <div class="list-item add-friend-pick" data-pick-id="${escapeAttr(c.id)}" role="button" tabindex="0">
          <div class="avatar">${c.defaultEmoji ? `<span>${escapeAttr(c.defaultEmoji)}</span>` : icon('profile', 'contacts-pick-icon')}</div>
          <div class="list-item-content">
            <div class="list-item-title">${escapeAttr(c.name)}</div>
            <div class="list-item-subtitle">${escapeAttr(c.accountCard)} · ${escapeAttr(c.className)}</div>
            <div class="contact-card-submeta">${escapeHtml(TEAMS[c.team]?.name || '角色卡')} · ${escapeHtml((c.aliases || []).slice(0, 2).join(' / '))}</div>
          </div>
        </div>`
        )
        .join('');
      resultsEl.querySelectorAll('.add-friend-pick').forEach((row) => {
        const pick = async () => {
          const cid = row.dataset.pickId;
          const staticChar = CHARACTERS.find((x) => x.id === cid);
          if (!staticChar) return;
          await ensureCharacterInDb(staticChar);
          user = (await getCurrentUser()) || user;
          ensureGroups(user);
          const ids = new Set(Array.isArray(user.friends) ? user.friends.map((f) => normalizeFriendEntry(f).id) : []);
          if (!ids.has(cid)) {
            ids.add(cid);
            const next = (user.friends || []).map(normalizeFriendEntry);
            next.push({ id: cid, groupId: groupSelect?.value || 'default', source: 'manual-search' });
            user.friends = next;
            await db.put('users', user);
          }
          await findOrCreatePrivateChat(userId, cid);
          close();
          await render(container);
        };
        row.addEventListener('click', pick);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
          }
        });
      });
    }

    input?.addEventListener('input', (e) => renderResults(e.target.value));
    renderResults('');
    input?.focus();
  });

  container.querySelector('.contacts-create-group')?.addEventListener('click', async () => {
    const { close, root } = openGlobalModal(`
      <div class="modal-header">
        <h3>新建分组</h3>
        <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">${icon('close')}</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">分组名称</label>
          <input type="text" class="form-input group-name-input" placeholder="例如：战队成员 / 日常关系" />
        </div>
        <button type="button" class="btn btn-primary btn-block group-save-btn">保存分组</button>
      </div>
    `);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    root.querySelector('.group-save-btn')?.addEventListener('click', async () => {
      const name = root.querySelector('.group-name-input')?.value?.trim();
      if (!name) {
        showToast('请输入分组名称');
        return;
      }
      const nextId = `group_${Date.now()}`;
      user = (await getCurrentUser()) || user;
      user.friendGroups = ensureGroups(user).concat([{ id: nextId, name }]);
      await db.put('users', user);
      close();
      await render(container);
      showToast('已新增分组');
    });
  });

  container.querySelector('.contacts-user-rel')?.addEventListener('click', () => {
    navigate('user-relationship');
  });

  container.querySelector('.contacts-create-npc')?.addEventListener('click', async () => {
    user = (await getCurrentUser()) || user;
    const options = ensureGroups(user)
      .map((g) => `<option value="${escapeAttr(g.id)}">${escapeHtml(g.name)}</option>`)
      .join('');
    const teamName = user.selectedTeam ? TEAMS[user.selectedTeam]?.name || user.selectedTeam : '当前背景';
    const { close, root } = openGlobalModal(`
      <div class="modal-header">
        <h3>新建路人角色</h3>
        <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">${icon('back')}</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">角色名字</label>
          <input type="text" class="form-input npc-name-input" value="青训生A" />
        </div>
        <div class="form-group">
          <label class="form-label">具体身份</label>
          <input type="text" class="form-input npc-identity-input" value="${escapeAttr(teamName)}经理" />
        </div>
        <div class="form-group">
          <label class="form-label">与你的关联</label>
          <input type="text" class="form-input npc-relation-input" value="认识的人" />
        </div>
        <div class="form-group">
          <label class="form-label">所属分组</label>
          <select class="form-input npc-group-input">${options}</select>
        </div>
        <div class="form-group">
          <label class="form-label">补充备注</label>
          <textarea class="form-textarea npc-note-input" placeholder="例如：负责训练营排班，和队里前辈都熟"></textarea>
        </div>
        <button type="button" class="btn btn-primary btn-block npc-save-btn">创建角色</button>
      </div>
    `);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    root.querySelector('.npc-save-btn')?.addEventListener('click', async () => {
      const name = root.querySelector('.npc-name-input')?.value?.trim();
      const identity = root.querySelector('.npc-identity-input')?.value?.trim();
      const relation = root.querySelector('.npc-relation-input')?.value?.trim();
      const groupIdInput = root.querySelector('.npc-group-input')?.value || 'default';
      const note = root.querySelector('.npc-note-input')?.value?.trim();
      if (!name) {
        showToast('请先填写名字');
        return;
      }
      const id = `custom_${Date.now()}`;
      const npc = createCharacterProfile({
        id,
        name,
        realName: name,
        accountCard: identity || '原创角色',
        className: identity || '路人',
        team: user.selectedTeam || '',
        personality: `${identity || '路人角色'}，由玩家创建，可作为当前世界观补充人物。${note ? `补充：${note}` : ''}`,
        speechStyle: '自然口语化，贴近日常聊天',
        defaultEmoji: '☁️',
        isCustom: true,
      });
      await db.put('characters', npc);
      user = (await getCurrentUser()) || user;
      user.friends = [...(user.friends || []).map(normalizeFriendEntry), {
        id,
        groupId: groupIdInput,
        source: 'custom-npc',
        relation: relation || '',
        note: `${identity || ''}${note ? `｜${note}` : ''}`,
      }];
      await db.put('users', user);
      close();
      await render(container);
      showToast('已创建路人角色');
    });
  });

  container.querySelector('.contacts-recommend-card')?.addEventListener('click', async () => {
    user = (await getCurrentUser()) || user;
    const currentFriendIds = new Set((user.friends || []).map((f) => normalizeFriendEntry(f).id));
    const suggested = searchCharacters('').filter((c) => !currentFriendIds.has(c.id)).slice(0, 8);
    const cards = suggested.length
      ? suggested
          .map((c) => {
            const relation = c.team ? `${TEAMS[c.team]?.name || c.team} · ${c.className}` : c.className;
            return `
              <div class="list-item recommended-card-row">
                <div class="avatar">${c.defaultEmoji ? `<span>${escapeAttr(c.defaultEmoji)}</span>` : icon('recommendation', 'contacts-pick-icon')}</div>
                <div class="list-item-content">
                  <div class="list-item-title">${escapeHtml(c.name)}</div>
                  <div class="list-item-subtitle">${escapeHtml(c.accountCard || '')}</div>
                  <div class="contact-card-submeta">${escapeHtml(relation || '可加入当前世界观')}</div>
                </div>
                <button type="button" class="btn btn-outline btn-sm recommended-card-add" data-character-id="${escapeAttr(c.id)}">加入</button>
              </div>
            `;
          })
          .join('')
      : '<div class="text-hint">当前没有新的推荐角色了。</div>';
    const { close, root } = openGlobalModal(`
      <div class="modal-header">
        <h3>推荐名片</h3>
        <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">${icon('close')}</button>
      </div>
      <div class="modal-body">
        <div class="card-block" style="margin-bottom:12px;">
          <div style="font-weight:600;margin-bottom:6px;">AI/自用推荐池</div>
          <div class="text-hint">可用于“AI 主动介绍给你认识的人”，也可以你手动挑选加入通讯录。</div>
        </div>
        <div class="recommended-card-list">${cards}</div>
      </div>
    `);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    root.querySelectorAll('.recommended-card-add').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const cid = btn.dataset.characterId;
        const chosen = CHARACTERS.find((c) => c.id === cid);
        if (!chosen) return;
        await ensureCharacterInDb(chosen);
        user = (await getCurrentUser()) || user;
        const ids = new Set(Array.isArray(user.friends) ? user.friends.map((f) => normalizeFriendEntry(f).id) : []);
        if (!ids.has(cid)) {
          user.friends = [...(user.friends || []).map(normalizeFriendEntry), { id: cid, groupId: 'default', source: 'recommended-card' }];
        }
        user.recommendedCards = [...(user.recommendedCards || []).filter((x) => x.id !== cid), {
          id: chosen.id,
          name: chosen.name,
          createdAt: Date.now(),
        }];
        await db.put('users', user);
        close();
        await render(container);
        showToast(`已通过推荐添加 ${chosen.name}`);
      });
    });
  });
}
