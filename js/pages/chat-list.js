import { navigate } from '../core/router.js';
import { peekPendingGroupAiBanner, clearPendingGroupAiBanner } from '../core/chat-list-ai-banner.js';
import * as db from '../core/db.js';
import { createChat } from '../models/chat.js';
import { CHARACTERS } from '../data/characters.js';
import { TEAMS, TEAM_LIST } from '../data/teams.js';
import { icon } from '../components/svg-icons.js';
import { DEFAULT_GROUPS } from '../data/default-groups.js';
import { showToast } from '../components/toast.js';
import { openChatRowActionSheet } from '../components/chat-row-action-sheet.js';
import { getCharacterStateForSeason } from '../core/chat-helpers.js';
import { getState } from '../core/state.js';
import { loadPasserbyAvatarPool, pickPasserbyAvatar } from '../core/avatar-pool.js';

let passerbyAvatarPool = [];

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

async function resolveParticipantName(id) {
  if (!id || id === 'user') return null;
  const c = await db.get('characters', id);
  if (c?.name) return c.name;
  const fromData = CHARACTERS.find((x) => x.id === id);
  return fromData?.name || id;
}

function chatDisplayName(chat) {
  const gs = chat.groupSettings || {};
  if (gs.name && String(gs.name).trim()) return gs.name;
  return null;
}

async function chatSubtitleName(chat) {
  const named = chatDisplayName(chat);
  if (named) return named;
  const parts = (chat.participants || []).filter((p) => p && p !== 'user');
  for (const p of parts) {
    const n = await resolveParticipantName(p);
    if (n) return n;
  }
  return '私聊';
}

async function countUnreadForChat(chat) {
  const msgs = await db.getAllByIndex('messages', 'chatId', chat.id);
  const lastReadAt = Number(chat.lastReadAt || 0);
  return msgs.filter((m) => !m.deleted && m.senderId !== 'user' && Number(m.timestamp || 0) > lastReadAt).length;
}

function formatListTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function previewLastMessage(chat) {
  const raw = chat.lastMessage;
  if (raw == null || raw === '') return '暂无消息';
  return String(raw).replace(/\s+/g, ' ').slice(0, 48);
}

async function avatarEmoji(chat) {
  const gs = chat.groupSettings || {};
  if (gs.avatar) {
    return `<img src="${escapeAttr(gs.avatar)}" alt="" />`;
  }
  const parts = (chat.participants || []).filter((p) => p && p !== 'user');
  for (const p of parts) {
    const c = await db.get('characters', p);
    if (c?.avatar && (/^data:/i.test(String(c.avatar)) || /^https?:/i.test(String(c.avatar)))) {
      return `<img src="${escapeAttr(c.avatar)}" alt="" />`;
    }
    const fallbackAvatar = pickPasserbyAvatar(passerbyAvatarPool, c?.id || p);
    if (fallbackAvatar) return `<img src="${escapeAttr(fallbackAvatar)}" alt="" />`;
    if (c?.defaultEmoji) return c.defaultEmoji;
    const fromData = CHARACTERS.find((x) => x.id === p);
    if (fromData?.avatar && (/^data:/i.test(String(fromData.avatar)) || /^https?:/i.test(String(fromData.avatar)))) {
      return `<img src="${escapeAttr(fromData.avatar)}" alt="" />`;
    }
    const fallbackAvatarData = pickPasserbyAvatar(passerbyAvatarPool, fromData?.id || p);
    if (fallbackAvatarData) return `<img src="${escapeAttr(fallbackAvatarData)}" alt="" />`;
    if (fromData?.defaultEmoji) return fromData.defaultEmoji;
  }
  const generic = pickPasserbyAvatar(passerbyAvatarPool, chat?.id || 'chat');
  if (generic) return `<img src="${escapeAttr(generic)}" alt="" />`;
  return `<span class="chat-avatar-fallback">${icon(chat.type === 'group' ? 'contacts' : 'message', 'chat-list-avatar-icon')}</span>`;
}

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
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function openGlobalModal(innerHtml) {
  const host = document.getElementById('modal-container');
  if (!host) return { close: () => {} };
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-modal-overlay>
      <div class="modal-sheet modal-sheet-tall" role="dialog" aria-modal="true" data-modal-sheet>
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

async function ensureCharacterInDb(staticChar) {
  const existing = await db.get('characters', staticChar.id);
  if (existing) return existing;
  await db.put('characters', { ...staticChar });
  return staticChar;
}

async function getCurrentUserId() {
  const row = await db.get('settings', 'currentUserId');
  return row?.value ?? null;
}

export default async function render(container) {
  passerbyAvatarPool = await loadPasserbyAvatarPool();
  const currentUserId = await getCurrentUserId();
  let chats = currentUserId
    ? await db.getAllByIndex('chats', 'userId', currentUserId)
    : await db.getAll('chats');
  for (const c of chats) {
    const isEmptyPreset = c.type === 'group'
      && c.groupSettings?.groupOrigin === 'preset'
      && (!Array.isArray(c.participants) || c.participants.length === 0)
      && !String(c.lastMessage || '').trim();
    if (!isEmptyPreset) continue;
    const msgs = await db.getAllByIndex('messages', 'chatId', c.id);
    if (msgs.length) continue;
    await db.del('chats', c.id);
  }
  chats = currentUserId
    ? await db.getAllByIndex('chats', 'userId', currentUserId)
    : await db.getAll('chats');
  chats = [...chats]
    .filter((c) => (c.participants || []).includes('user'))
    .sort((a, b) => {
      const ap = !!a.pinned;
      const bp = !!b.pinned;
      if (ap !== bp) return ap ? -1 : 1;
      if (ap && bp) return (Number(b.pinnedAt) || 0) - (Number(a.pinnedAt) || 0);
      return (b.lastActivity || 0) - (a.lastActivity || 0);
    });

  const pendingAiBanner = peekPendingGroupAiBanner();
  const aiBannerHtml = pendingAiBanner
    ? `<div class="chat-list-ai-banner" role="button" tabindex="0" data-ai-banner-chat="${escapeAttr(pendingAiBanner.chatId)}">
        <span class="chat-list-ai-banner-text">${escapeHtml(pendingAiBanner.label)} 有新回复，点击进入群聊</span>
        <button type="button" class="chat-list-ai-banner-dismiss" aria-label="关闭">×</button>
      </div>`
    : '';

  const rows = [];
  const unreadCounts = await Promise.all(chats.map((c) => countUnreadForChat(c)));
  for (let i = 0; i < chats.length; i += 1) {
    const chat = chats[i];
    const unread = unreadCounts[i] || 0;
    const title = (await chatSubtitleName(chat)) || '私聊';
    const av = await avatarEmoji(chat);
    const tags = Array.isArray(chat.groupSettings?.groupThemeTags) ? chat.groupSettings.groupThemeTags.slice(0, 3) : [];
    const tagText = tags.length ? `${tags.map((t) => `【${t}】`).join('')} ` : '';
    const pinMark = chat.pinned ? '<span class="chat-list-pin" title="已置顶">📌</span> ' : '';
    rows.push(`
      <div class="list-item chat-list-item" data-chat-id="${escapeAttr(chat.id)}" data-chat-type="${escapeAttr(chat.type || 'private')}" role="button" tabindex="0">
        <div class="avatar">${av}</div>
        <div class="list-item-content">
          <div class="list-item-title">${pinMark}${escapeAttr(title)}</div>
          <div class="list-item-subtitle">${escapeAttr(tagText + previewLastMessage(chat))}</div>
        </div>
        <div class="list-item-right chat-list-right">
          <span>${formatListTime(chat.lastActivity)}</span>
          ${unread > 0 ? `<span class="badge">${unread > 99 ? '99+' : unread}</span>` : ''}
        </div>
      </div>
    `);
  }

  const listBlock =
    chats.length === 0
      ? `<div class="placeholder-page" style="padding: 48px 24px;">
          <div class="placeholder-icon">${icon('message', 'placeholder-svg')}</div>
          <div class="placeholder-text">暂无会话</div>
          <div class="placeholder-sub" style="margin-top:8px;font-size:var(--font-sm);color:var(--text-hint);">点击右上角 + 开始聊天</div>
        </div>`
      : `<div class="chat-list-body">${rows.join('')}</div>`;

  container.classList.add('chat-list-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn chat-list-home" title="返回主页" aria-label="返回主页">${icon('back')}</button>
      <h1 class="navbar-title">消息</h1>
      <button type="button" class="navbar-btn chat-list-new" title="创建群聊" aria-label="创建群聊">${icon('plus')}</button>
    </header>
    ${aiBannerHtml}
    ${listBlock}
    ${tabbarHtml('messages')}
  `;

  container.querySelector('.chat-list-home')?.addEventListener('click', () => navigate('home'));
  container.querySelectorAll('.tabbar-item[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.nav));
  });

  const bannerEl = container.querySelector('.chat-list-ai-banner');
  if (bannerEl && pendingAiBanner) {
    const go = () => {
      clearPendingGroupAiBanner();
      navigate('group-chat', { chatId: pendingAiBanner.chatId });
    };
    bannerEl.addEventListener('click', (e) => {
      if (e.target.closest?.('.chat-list-ai-banner-dismiss')) return;
      go();
    });
    bannerEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
    bannerEl.querySelector('.chat-list-ai-banner-dismiss')?.addEventListener('click', (e) => {
      e.stopPropagation();
      clearPendingGroupAiBanner();
      bannerEl.remove();
    });
  }

  container.querySelector('.chat-list-new')?.addEventListener('click', async () => {
    const currentUser = getState('currentUser');
    const season = currentUser?.currentTimeline || 'S8';

    const mainTeamIds = ['batu', 'lanyu', 'weicao', 'lunhui', 'huxiao', 'huangfeng', 'jiashi', 'sanlingyi', 'yanyu', 'yizhan', 'baihua', 'leiting', 'xukong', 'shenqi', 'xingxin'];
    const teamAbbrs = { batu: '霸', lanyu: '蓝', weicao: '草', lunhui: '轮', huxiao: '呼', huangfeng: '皇', jiashi: '嘉', sanlingyi: '三', yanyu: '烟', yizhan: '义', baihua: '花', leiting: '雷', xukong: '鬼', shenqi: '奇', xingxin: '兴' };

    function groupCharactersByTeam() {
      const groups = {};
      for (const tid of mainTeamIds) groups[tid] = [];
      groups['_other'] = [];
      for (const c of CHARACTERS) {
        const state = getCharacterStateForSeason(c, season);
        if (state.team && groups[state.team]) {
          groups[state.team].push(c);
        } else if (state.team) {
          groups['_other'].push(c);
        } else if (!state.status?.includes('未正式出道')) {
          groups['_other'].push(c);
        }
      }
      for (const k of Object.keys(groups)) {
        groups[k].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'));
      }
      return groups;
    }

    const grouped = groupCharactersByTeam();

    function buildMemberList(filterQ) {
      const q = (filterQ || '').trim().toLowerCase();
      let html = '';
      for (const tid of [...mainTeamIds, '_other']) {
        const members = grouped[tid]?.filter((c) => {
          if (!q) return true;
          const state = getCharacterStateForSeason(c, season);
          return c.name?.includes(q) || (state.card || '').includes(q) || (c.aliases || []).some((a) => a.toLowerCase().includes(q));
        });
        if (!members?.length) continue;
        const teamName = tid === '_other' ? '其他/退役/公会' : (TEAMS[tid]?.name || tid);
        html += `<div class="gc-team-header" data-team-id="${escapeAttr(tid)}">${escapeHtml(teamName)}</div>`;
        for (const c of members) {
          const state = getCharacterStateForSeason(c, season);
          html += `
            <label class="gc-member-row">
              <input type="checkbox" class="gc-member-cb" value="${escapeAttr(c.id)}" />
              <div class="gc-member-info">
                <span class="gc-member-name">${escapeHtml(state.publicName || c.name)}</span>
                <span class="gc-member-detail">${escapeHtml(state.card || '')} · ${escapeHtml(state.class || '')}</span>
              </div>
            </label>`;
        }
      }
      return html || '<div class="text-hint" style="padding:16px;text-align:center;">无匹配角色</div>';
    }

    const sidebarHtml = mainTeamIds.map((tid) => `<div class="gc-sidebar-item" data-jump-team="${escapeAttr(tid)}">${teamAbbrs[tid] || tid.slice(0, 1)}</div>`).join('');

    const defaultGroupHtml = DEFAULT_GROUPS.map((group) => {
      const memberNames = group.participants.filter((id) => id !== 'user').map((id) => CHARACTERS.find((c) => c.id === id)?.name || id).join('、');
      return `<div class="list-item default-group-row" data-default-group-id="${escapeAttr(group.id)}" role="button" tabindex="0"><div class="list-item-content"><div class="list-item-title">${escapeHtml(group.name)}</div><div class="list-item-subtitle" style="font-size:11px;">${escapeHtml(memberNames).slice(0, 60)}</div></div><div class="list-item-right" style="color:var(--primary);">创建</div></div>`;
    }).join('');

    const { close, root } = openGlobalModal(`
      <div class="gc-create-header">
        <button type="button" class="navbar-btn gc-back-btn">${icon('back')}</button>
        <h3 class="navbar-title">发起群聊</h3>
        <button type="button" class="btn btn-primary btn-sm gc-complete-btn">完成</button>
      </div>
      <div class="gc-create-body">
        <div class="gc-top-settings">
          <input type="text" class="form-input gc-group-name" placeholder="输入群聊名称（可选）" />
          <label class="gc-toggle-row">
            <span>包含我自己</span>
            <span class="text-hint" style="font-size:11px;">你可以在群聊中发言互动</span>
            <div class="toggle gc-include-self on"></div>
          </label>
        </div>
        <div class="gc-search-bar">
          <input type="search" class="form-input gc-search-input" placeholder="寻找你想添加的人…" />
        </div>
        <details class="gc-defaults-section" open>
          <summary style="font-weight:600;font-size:var(--font-sm);padding:8px 0;cursor:pointer;">内置默认群（快速创建）</summary>
          <div class="gc-defaults-list">${defaultGroupHtml || '<div class="text-hint">暂无</div>'}</div>
        </details>
        <div class="gc-member-container">
          <div class="gc-member-scroll">${buildMemberList('')}</div>
          <div class="gc-team-sidebar">${sidebarHtml}</div>
        </div>
      </div>
    `);

    root.querySelector('.gc-back-btn')?.addEventListener('click', close);

    root.querySelector('.gc-include-self')?.addEventListener('click', function () {
      this.classList.toggle('on');
    });

    root.querySelector('.gc-search-input')?.addEventListener('input', (e) => {
      const scrollEl = root.querySelector('.gc-member-scroll');
      if (scrollEl) scrollEl.innerHTML = buildMemberList(e.target.value);
    });

    root.querySelectorAll('.gc-sidebar-item').forEach((item) => {
      item.addEventListener('click', () => {
        const tid = item.dataset.jumpTeam;
        const target = root.querySelector(`.gc-team-header[data-team-id="${tid}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    async function createDefaultGroup(group) {
      for (const id of group.participants.filter((p) => p !== 'user')) {
        const char = CHARACTERS.find((c) => c.id === id);
        if (char) await ensureCharacterInDb(char);
      }
      const chat = createChat({
        type: 'group',
        userId: currentUserId || null,
        participants: [...new Set(group.participants)],
        groupSettings: {
          name: group.name, avatar: null, owner: group.owner, admins: group.admins || [],
          announcement: group.announcement || '', muted: [], allMuted: false,
          isObserverMode: false, plotDirective: group.plotDirective || '',
        },
      });
      await db.put('chats', chat);
      close();
      navigate('group-chat', { chatId: chat.id });
    }

    root.querySelectorAll('.default-group-row').forEach((row) => {
      row.addEventListener('click', async () => {
        const group = DEFAULT_GROUPS.find((g) => g.id === row.dataset.defaultGroupId);
        if (group) await createDefaultGroup(group);
      });
    });

    root.querySelector('.gc-complete-btn')?.addEventListener('click', async () => {
      const name = root.querySelector('.gc-group-name')?.value?.trim() || '';
      const includeSelf = root.querySelector('.gc-include-self')?.classList.contains('on');
      const selectedIds = [...root.querySelectorAll('.gc-member-cb:checked')].map((el) => el.value);
      const participants = [...new Set(includeSelf ? ['user', ...selectedIds] : selectedIds)];

      if (participants.filter((p) => p !== 'user').length === 0) {
        showToast('请至少选择一个角色');
        return;
      }

      for (const id of participants.filter((p) => p !== 'user')) {
        const char = CHARACTERS.find((c) => c.id === id);
        if (char) await ensureCharacterInDb(char);
      }

      const chat = createChat({
        type: 'group',
        userId: currentUserId || null,
        participants,
        groupSettings: {
          name: name || participants.filter((p) => p !== 'user').slice(0, 3).map((id) => CHARACTERS.find((c) => c.id === id)?.name || id).join('、'),
          avatar: null, owner: '', admins: [], announcement: '', muted: [],
          allMuted: false, isObserverMode: !includeSelf, plotDirective: '',
        },
      });
      await db.put('chats', chat);
      close();
      navigate('group-chat', { chatId: chat.id });
    });
  });

  container.querySelectorAll('.chat-list-item').forEach((el) => {
    const id = el.dataset.chatId;
    let suppressNextClick = false;
    const open = () => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      if (pendingAiBanner && id === pendingAiBanner.chatId) clearPendingGroupAiBanner();
      if (el.dataset.chatType === 'group') navigate('group-chat', { chatId: id });
      else navigate('chat-window', { chatId: id });
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    let timer = null;
    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const startPress = () => {
      clearTimer();
      timer = setTimeout(async () => {
        timer = null;
        const chat = await db.get('chats', id);
        if (!chat) return;
        suppressNextClick = true;
        const name = (await chatSubtitleName(chat)) || '会话';
        openChatRowActionSheet({
          chatTitle: name,
          pinned: !!chat.pinned,
          onClosed: () => {
            suppressNextClick = false;
          },
          onTogglePin: async () => {
            const fresh = await db.get('chats', id);
            if (!fresh) return;
            const next = !fresh.pinned;
            fresh.pinned = next;
            fresh.pinnedAt = next ? Date.now() : 0;
            await db.put('chats', fresh);
            showToast(next ? '已置顶' : '已取消置顶');
            await render(container);
          },
          onDelete: async () => {
            const msgs = await db.getAllByIndex('messages', 'chatId', id);
            await Promise.all(msgs.map((m) => db.del('messages', m.id)));
            const mems = await db.getAllByIndex('memories', 'chatId', id);
            await Promise.all(mems.map((m) => db.del('memories', m.id)));
            await db.del('settings', `chatPrefs_${id}`);
            await db.del('chats', id);
            showToast('已删除会话');
            await render(container);
          },
        });
      }, 550);
    };
    el.addEventListener('mousedown', startPress);
    el.addEventListener('mouseup', clearTimer);
    el.addEventListener('mouseleave', clearTimer);
    el.addEventListener('touchstart', startPress);
    el.addEventListener('touchend', clearTimer);
    el.addEventListener('touchcancel', clearTimer);
  });
}
