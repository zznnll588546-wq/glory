import { navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { CHARACTERS } from '../data/characters.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { openChatRowActionSheet } from '../components/chat-row-action-sheet.js';

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

async function resolveParticipantName(id) {
  if (!id || id === 'user') return null;
  const c = await db.get('characters', id);
  if (c?.name) return c.name;
  const fromData = CHARACTERS.find((x) => x.id === id);
  return fromData?.name || id;
}

async function chatSubtitleName(chat) {
  const named = String(chat?.groupSettings?.name || '').trim();
  if (named) return named;
  const parts = (chat.participants || []).filter((p) => p && p !== 'user');
  const names = [];
  for (const p of parts.slice(0, 2)) {
    names.push((await resolveParticipantName(p)) || p);
  }
  return names.join(' · ') || '幕后窗口';
}

async function avatarEmoji(chat) {
  const parts = (chat.participants || []).filter((p) => p && p !== 'user');
  for (const p of parts) {
    const c = await db.get('characters', p);
    if (c?.avatar && (/^data:/i.test(String(c.avatar)) || /^https?:/i.test(String(c.avatar)))) {
      return `<img src="${escapeAttr(c.avatar)}" alt="" />`;
    }
    if (c?.defaultEmoji) return c.defaultEmoji;
  }
  return `<span class="chat-avatar-fallback">${icon('backstage', 'chat-list-avatar-icon')}</span>`;
}

function previewLastMessage(chat) {
  const raw = chat.lastMessage;
  if (raw == null || raw === '') return '暂无消息';
  return String(raw).replace(/\s+/g, ' ').slice(0, 48);
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

async function getCurrentUserId() {
  const row = await db.get('settings', 'currentUserId');
  return row?.value ?? null;
}

export default async function render(container) {
  const currentUserId = await getCurrentUserId();
  let chats = currentUserId
    ? await db.getAllByIndex('chats', 'userId', currentUserId)
    : await db.getAll('chats');
  chats = chats
    .filter((c) => (c.type === 'private' || c.type === 'group') && !(c.participants || []).includes('user'))
    .sort((a, b) => {
      const ap = !!a.pinned;
      const bp = !!b.pinned;
      if (ap !== bp) return ap ? -1 : 1;
      if (ap && bp) return (Number(b.pinnedAt) || 0) - (Number(a.pinnedAt) || 0);
      return (b.lastActivity || 0) - (a.lastActivity || 0);
    });

  const rows = [];
  for (const chat of chats) {
    const title = (await chatSubtitleName(chat)) || '幕后私窗';
    const av = await avatarEmoji(chat);
    const pinMark = chat.pinned ? '<span class="chat-list-pin" title="已置顶">📌</span> ' : '';
    rows.push(`
      <div class="list-item chat-list-item" data-chat-id="${escapeAttr(chat.id)}" data-chat-type="${escapeAttr(chat.type || 'private')}" role="button" tabindex="0">
        <div class="avatar">${av}</div>
        <div class="list-item-content">
          <div class="list-item-title">${pinMark}${escapeAttr(title)}</div>
          <div class="list-item-subtitle">${escapeAttr(previewLastMessage(chat))}</div>
        </div>
        <div class="list-item-right chat-list-right">
          <span>${formatListTime(chat.lastActivity)}</span>
        </div>
      </div>
    `);
  }

  const listBlock =
    chats.length === 0
      ? `<div class="placeholder-page" style="padding: 48px 24px;">
          <div class="placeholder-icon">${icon('backstage', 'placeholder-svg')}</div>
          <div class="placeholder-text">暂无幕后窗口</div>
          <div class="placeholder-sub" style="margin-top:8px;font-size:var(--font-sm);color:var(--text-hint);">角色之间的无 user 私聊/群聊会收纳在这里</div>
        </div>`
      : `<div class="chat-list-body">${rows.join('')}</div>`;

  container.classList.add('chat-list-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn backstage-home" title="返回主页" aria-label="返回主页">${icon('back')}</button>
      <h1 class="navbar-title">幕后</h1>
      <span class="navbar-btn" style="visibility:hidden"></span>
    </header>
    ${listBlock}
    ${tabbarHtml('backstage')}
  `;

  container.querySelector('.backstage-home')?.addEventListener('click', () => navigate('home'));
  container.querySelectorAll('.tabbar-item[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.nav));
  });

  container.querySelectorAll('.chat-list-item').forEach((el) => {
    const id = el.dataset.chatId;
    let suppressNextClick = false;
    const open = () => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
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
        const name = (await chatSubtitleName(chat)) || '幕后会话';
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

