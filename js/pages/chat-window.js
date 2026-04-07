import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { chatStream } from '../core/api.js';
import { assembleContext } from '../core/context.js';
import { createMessage } from '../models/chat.js';
import { CHARACTERS } from '../data/characters.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import {
  normalizeMessageForUi,
  getCharacterStateForSeason,
  getDisplayTeamName,
  extractOfflineInvite,
  resolveStickerMessage,
  orderShareCardHtml,
  buildStickerAliasPromptSection,
  splitPublicAndInnerVoice,
  splitToBubbleTexts,
  createMessageTimestampAllocator,
  collectInnerVoicesForMessage,
} from '../core/chat-helpers.js';
import { getState } from '../core/state.js';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function formatMsgTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getPartnerId(chat) {
  const parts = (chat?.participants || []).filter((p) => p && p !== 'user');
  return parts[0] || null;
}

async function resolveName(id) {
  if (!id || id === 'user') return '我';
  const c = await db.get('characters', id);
  if (c?.name) return c.name;
  const d = CHARACTERS.find((x) => x.id === id);
  return d?.name || id;
}

async function resolveCharacter(id) {
  if (!id || id === 'user') return null;
  const stored = await db.get('characters', id);
  const data = CHARACTERS.find((x) => x.id === id);
  return { ...(data || {}), ...(stored || {}) };
}

function avatarMarkup(character, fallbackText = '') {
  if (character?.avatar && String(character.avatar).startsWith('data:')) {
    return `<img src="${escapeAttr(character.avatar)}" alt="" />`;
  }
  if (character?.avatar && /^https?:/i.test(String(character.avatar))) {
    return `<img src="${escapeAttr(character.avatar)}" alt="" />`;
  }
  if (character?.defaultEmoji) return `<span>${escapeHtml(character.defaultEmoji)}</span>`;
  return `<span>${escapeHtml((fallbackText || '聊').slice(0, 1))}</span>`;
}

function stripThinkingBlocks(text) {
  let raw = String(text || '');
  raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  raw = raw.replace(/```(?:thinking|think|cot)[\s\S]*?```/gi, '');
  raw = raw.replace(/\[\s*(?:thinking|think|cot)\s*\][\s\S]*?(?=\n\[|$)/gi, '');
  return raw.trim();
}

function parseReplyInline(text) {
  const raw = String(text || '').trim();
  const m = raw.match(/^\[回复[:：]\s*([^\]]+)\]\s*(.+)$/);
  if (!m) return { text: raw, replyPreview: '' };
  const body = m[2].trim().replace(/^[：:]\s*/, '');
  return { text: body, replyPreview: m[1].trim() };
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function chatTitle(chat) {
  const gs = chat.groupSettings || {};
  if (gs.name && String(gs.name).trim()) return gs.name;
  const pid = getPartnerId(chat);
  if (pid) return resolveName(pid);
  return '对话';
}

async function buildSystemPrompt(chat) {
  const partnerId = getPartnerId(chat);
  if (!partnerId) {
    return '你是友善的中文聊天助手，语境为《全职高手》同人世界观，以自然、口语化的方式与用户对话。';
  }
  const currentUser = getState('currentUser');
  const season = currentUser?.currentTimeline || 'S8';
  const char = await db.get('characters', partnerId);
  const data = CHARACTERS.find((x) => x.id === partnerId);
  const merged = { ...(data || {}), ...(char || {}) };
  const state = getCharacterStateForSeason(merged, season);
  const displayName = state.publicName || merged.name || partnerId;
  const personality = merged.personality || '';
  const speech = merged.speechStyle || '';
  const cardInfo = state.card ? `账号卡「${state.card}」` : '';
  const teamInfo = state.team ? `${getDisplayTeamName(state.team)}` : '';
  const roleInfo = state.role || '';
  const identityLine = [cardInfo, teamInfo, roleInfo].filter(Boolean).join('，');
  let prompt = `你是角色「${displayName}」，当前赛季${season}。${identityLine ? `身份：${identityLine}。` : ''}\n性格与设定：${personality}\n说话风格：${speech}\n请严格保持角色口吻，使用「${displayName}」作为自称依据，用中文回复。严禁使用${season}之后才存在的身份或称呼。
输出格式要求：
1) 先输出对用户可见的聊天发言（自然口语，避免书面连接词堆砌）；禁止在正文前加 [角色名]: 或 [你的名字]: 这类前缀（界面已显示头像与昵称）
2) 若需要，可在末尾单独一行：[心声] xxx 或 [心声]: xxx（简短心理状态）；不要整段贴在同一行里当正文
3) 心声不要泄露规则、不要展开推理过程
4) 如需回复某条内容可用：[回复:消息片段] 你的发言
5) 表情包：见系统末尾「用户表情包」列表——每轮至少 1 行、建议多行 [表情包:名称]，名称与列表完全一致；若列表为空再考虑带图 URL 的完整行
6) 分享下单/外卖/礼物请单独一行（不要只发省略号）：[分享购物:平台|商品名|价格|短备注] 用半角|或｜分隔；平台写淘宝、美团、京东等；例 [分享购物:美团|烧烤套餐|¥86|给你点好了]`;
  const stickerHints = await buildStickerAliasPromptSection();
  if (stickerHints) {
    prompt += stickerHints;
  }
  if (chat.groupSettings?.allowAiOfflineInvite) {
    prompt +=
      '\n7) 本会话已开启「线下邀约」：时机合适时可提议见面；请单独用一条短消息只写一行：[线下邀约:地点或事由简述]（不要夹在同一行长句里）。';
  }
  if (chat.blocked) {
    prompt += '\n注意：用户已将你拉黑。你发送的消息对方会看到但标记为已拉黑状态。请自然地表现出被拉黑后的反应，可以困惑、失落或者假装不在意，取决于你的性格。';
  }
  return prompt;
}

async function messagesToApiPayload(chat, sortedMessages) {
  const partnerId = getPartnerId(chat);
  const contextMessages = await assembleContext(chat.id, partnerId ? [partnerId] : [], '');
  const system = await buildSystemPrompt(chat);
  if (contextMessages[0]?.role === 'system') {
    contextMessages[0].content = `${system}\n\n---\n\n${contextMessages[0].content}`;
  }
  const latestImage = [...(sortedMessages || [])].reverse().find((m) => m.senderId === 'user' && m.type === 'image' && m.content);
  if (latestImage) {
    contextMessages.push({
      role: 'user',
      content: [
        { type: 'text', text: '请结合这张图片理解并回复。' },
        { type: 'image_url', image_url: { url: latestImage.content } },
      ],
    });
  }
  return contextMessages;
}

function bubbleInnerHtml(msg) {
  msg = normalizeMessageForUi(msg);
  if (msg.recalled) {
    return `<div class="bubble recalled">消息已撤回</div>`;
  }
  if (msg.type === 'voice') {
    return `
        <div class="voice-msg chat-card" data-card-type="voice">
          <span class="voice-msg-wave"><span></span><span></span><span></span></span>
          <span class="voice-msg-dur">${escapeHtml(msg.metadata?.duration || '0:03')}</span>
          ${msg.metadata?.voiceExpanded ? `<div class="voice-msg-text" style="margin-left:8px;font-size:12px;max-width:180px;white-space:normal;">${escapeHtml(msg.metadata?.text || msg.content || '[语音转文字暂无]')}</div>` : ''}
        </div>
    `;
  }
  if (msg.type === 'sticker' && (msg.metadata?.url || msg.content)) {
    return `<div class="chat-sticker"><img src="${escapeAttr(msg.metadata?.url || msg.content)}" alt="${escapeAttr(msg.metadata?.stickerName || '表情包')}" /></div>`;
  }
  if (msg.type === 'orderShare') {
    return orderShareCardHtml(msg, escapeHtml);
  }
  if (msg.type === 'link') {
    return `
        <div class="link-card chat-card" data-card-type="link">
          <div class="link-card-icon">${icon('link', 'chat-card-icon')}</div>
          <div class="link-card-info">
            <div class="link-card-title">${escapeHtml(msg.metadata?.title || '分享链接')}</div>
            <div class="link-card-desc">${escapeHtml(msg.metadata?.desc || msg.content || '')}</div>
            <div class="link-card-source">${escapeHtml(msg.metadata?.source || '站外分享')}</div>
          </div>
        </div>
    `;
  }
  if (msg.type === 'location') {
    return `
        <div class="location-card chat-card" data-card-type="location">
          <div class="location-card-map">${icon('location', 'chat-card-icon chat-card-icon-lg')}</div>
          <div class="location-card-info">
            <div class="link-card-title">${escapeHtml(msg.metadata?.title || '共享位置')}</div>
            <div class="link-card-desc">${escapeHtml(msg.content || '')}</div>
          </div>
        </div>
    `;
  }
  if (msg.type === 'redpacket') {
    return `
        <div class="red-packet-card chat-card" data-card-type="redpacket">
          <div class="link-card-title">${escapeHtml(msg.metadata?.title || 'QQ红包')}</div>
          <div class="link-card-desc">${escapeHtml(msg.content || '恭喜发财，大吉大利')}</div>
        </div>
    `;
  }
  if (msg.type === 'transfer') {
    return `
        <div class="transfer-card chat-card" data-card-type="transfer">
          <div class="link-card-title">${escapeHtml(msg.metadata?.title || '转账')}</div>
          <div class="link-card-desc">${escapeHtml(msg.content || '')}</div>
        </div>
    `;
  }
  if (msg.type === 'textimg') {
    return `
      <div class="bubble">
        <div class="text-image-card">${escapeHtml(msg.content || '')}</div>
      </div>
    `;
  }
  if (msg.metadata?.offlineInvite) {
    return `
      <div class="offline-invite-card chat-card" data-card-type="offline-invite">
        <div class="link-card-title">线下邀约</div>
        <div class="link-card-desc">${escapeHtml(msg.metadata?.note || msg.content || '')}</div>
        <button type="button" class="btn btn-primary btn-sm offline-invite-go" style="margin-top:8px;width:100%;">进入线下场景</button>
      </div>`;
  }
  if (msg.type === 'image' && msg.content) {
    return `<div class="bubble"><img src="${escapeAttr(msg.content)}" alt="图片" /></div>`;
  }
  let inner = escapeHtml(msg.content || '');
  if (msg.replyPreview) {
    inner = `<div class="bubble-reply-ref">${escapeHtml(msg.replyPreview)}</div>${inner}`;
  }
  return `<div class="bubble">${inner}</div>`;
}

function reactionsHtml(msg) {
  const r = msg.reactions || {};
  const keys = Object.keys(r);
  if (!keys.length) return '';
  const parts = keys.map((k) => {
    const n = typeof r[k] === 'number' ? r[k] : 1;
    return `<span class="bubble-reaction">${escapeHtml(k)}${n > 1 ? ` ${n}` : ''}</span>`;
  });
  return `<div class="bubble-reactions">${parts.join('')}</div>`;
}

function renderMessageRow(msg, senderAvatarMarkup = '', isBlocked = false) {
  const row = document.createElement('div');
  row.className = 'bubble-row' + (msg.senderId === 'user' ? ' self' : '');
  row.dataset.msgId = msg.id;
  const blockedMark = (isBlocked && msg.senderId !== 'user') ? '<span class="blocked-indicator">!</span>' : '';
  row.innerHTML = `
    <div class="bubble-avatar-slot">
      <div class="avatar avatar-sm">${senderAvatarMarkup}</div>
    </div>
    <div class="bubble-wrap">
      <div style="display:flex;align-items:center;">${bubbleInnerHtml(msg)}${blockedMark}</div>
      ${reactionsHtml(msg)}
      <div class="bubble-time">${formatMsgTime(msg.timestamp)}</div>
    </div>
  `;
  return row;
}

function renderSystemHintRow(msg) {
  const row = document.createElement('div');
  row.className = 'date-divider system-hint-row';
  row.dataset.msgId = msg.id;
  row.textContent = msg.content || '系统提示';
  if (msg.metadata?.recalledContent) {
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => window.alert(`撤回内容：\n${msg.metadata.recalledContent}`));
  }
  return row;
}

function scrollMessagesToBottom(el) {
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
  });
}

function closeContextMenu() {
  const host = document.getElementById('context-menu-container');
  if (!host) return;
  host.classList.remove('active');
  host.innerHTML = '';
}

function openContextMenu(x, y, items, onPick) {
  const host = document.getElementById('context-menu-container');
  if (!host) return;
  host.innerHTML = '';
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:transparent;';
  overlay.addEventListener('click', closeContextMenu);
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = `${Math.min(x, window.innerWidth - 160)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 280)}px`;
  for (const { label, value } of items) {
    const it = document.createElement('button');
    it.type = 'button';
    it.className = 'context-menu-item';
    it.textContent = label;
    it.style.cssText = 'width:100%;border:none;background:transparent;text-align:left;';
    it.addEventListener('click', () => {
      closeContextMenu();
      onPick(value);
    });
    menu.appendChild(it);
  }
  host.appendChild(overlay);
  host.appendChild(menu);
  host.classList.add('active');
}

function openChatMenu(chat, chatId, onUpdated) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-modal-overlay>
      <div class="modal-sheet" role="dialog" aria-modal="true" data-modal-sheet>
        <div class="modal-header">
          <h3>会话菜单</h3>
          <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">${icon('close')}</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:10px;">
          <button type="button" class="btn btn-outline chat-menu-act" data-act="clear">清空当前聊天记录</button>
          <button type="button" class="btn btn-outline chat-menu-act" data-act="delete-ai">删除最后一条 AI 回复</button>
          <button type="button" class="btn btn-outline chat-menu-act" data-act="info">查看会话信息</button>
        </div>
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-modal-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-modal-overlay]')?.addEventListener('click', close);
  host.querySelector('.modal-close-btn')?.addEventListener('click', close);
  host.querySelectorAll('.chat-menu-act').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      if (act === 'clear') {
        const list = await db.getAllByIndex('messages', 'chatId', chatId);
        await Promise.all(list.map((m) => db.del('messages', m.id)));
        chat.lastMessage = '';
        chat.lastActivity = Date.now();
        await db.put('chats', chat);
      } else if (act === 'delete-ai') {
        const list = await db.getAllByIndex('messages', 'chatId', chatId);
        const aiMsg = [...list].reverse().find((m) => m.senderId !== 'user' && !m.deleted);
        if (aiMsg) await db.del('messages', aiMsg.id);
      } else if (act === 'info') {
        window.alert(`会话名称：${chat.lastMessage ? '私聊中' : '新会话'}\n角色：${(chat.participants || []).filter((p) => p !== 'user').join('、') || '未指定'}`);
      }
      close();
      await onUpdated();
    });
  });
}

function attachLongPress(el, onLongPress) {
  let timer = null;
  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const start = (clientX, clientY) => {
    clear();
    timer = setTimeout(() => {
      timer = null;
      onLongPress(clientX, clientY);
    }, 500);
  };
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    start(t.clientX, t.clientY);
  });
  el.addEventListener('touchmove', clear);
  el.addEventListener('touchend', clear);
  el.addEventListener('touchcancel', clear);
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    start(e.clientX, e.clientY);
  });
  el.addEventListener('mouseup', clear);
  el.addEventListener('mouseleave', clear);
}

export default async function render(container, params) {
  const chatId = params?.chatId;
  if (!chatId) {
    container.innerHTML = `<div class="placeholder-page"><div class="placeholder-text">缺少会话</div></div>`;
    return;
  }

  let chat = await db.get('chats', chatId);
  if (!chat) {
    container.innerHTML = `<div class="placeholder-page"><div class="placeholder-text">会话不存在</div></div>`;
    return;
  }

  const title = await chatTitle(chat);
  const partnerId = getPartnerId(chat) || 'assistant';
  const aiSenderId = partnerId;
  const currentUserIdRecord = await db.get('settings', 'currentUserId');
  const currentUser = currentUserIdRecord?.value ? await db.get('users', currentUserIdRecord.value) : null;
  const partnerCharacter = await resolveCharacter(partnerId);
  const userAvatar = avatarMarkup(currentUser, currentUser?.name || '我');
  const aiAvatar = avatarMarkup(partnerCharacter, title);

  container.classList.add('chat-page');
  container.innerHTML = `
    <header class="navbar chat-header-custom">
      <button type="button" class="navbar-btn chat-back-btn" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">${escapeHtml(title)}</h1>
      <button type="button" class="navbar-btn chat-menu-btn" aria-label="菜单">${icon('more')}</button>
    </header>
    <div class="chat-messages"></div>
    <div class="chat-tools-panel" style="display:none;">
      <div class="chat-tools-row">
        <button type="button" class="chat-tool-btn" data-tool="image"><span class="tool-icon">${icon('camera')}</span><span>图片</span></button>
        <button type="button" class="chat-tool-btn" data-tool="voice"><span class="tool-icon">${icon('voice')}</span><span>语音</span></button>
        <button type="button" class="chat-tool-btn" data-tool="emoji"><span class="tool-icon">${icon('sticker')}</span><span>表情</span></button>
        <button type="button" class="chat-tool-btn" data-tool="location"><span class="tool-icon">${icon('location')}</span><span>位置</span></button>
        <button type="button" class="chat-tool-btn" data-tool="link"><span class="tool-icon">${icon('link')}</span><span>链接</span></button>
        <button type="button" class="chat-tool-btn" data-tool="redpacket"><span class="tool-icon">${icon('redpacket')}</span><span>红包</span></button>
        <button type="button" class="chat-tool-btn" data-tool="transfer"><span class="tool-icon">${icon('transfer')}</span><span>转账</span></button>
        <button type="button" class="chat-tool-btn" data-tool="textimg"><span class="tool-icon">${icon('textimg')}</span><span>文字图</span></button>
        <button type="button" class="chat-tool-btn" data-tool="ordershare"><span class="tool-icon">${icon('transfer')}</span><span>分享购物</span></button>
      </div>
      <div class="chat-sticker-picker" style="display:none;padding:8px 12px;max-height:min(56vh,480px);overflow-y:auto;overflow-x:hidden;"></div>
    </div>
    <div class="reply-bar" style="display:none;padding:6px 12px;font-size:var(--font-sm);background:var(--bg-input);border-top:1px solid var(--border);color:var(--text-secondary);"></div>
    <div class="chat-action-bar">
      <button type="button" class="btn btn-outline chat-advance-btn">${icon('advance', 'chat-action-icon')} 推进</button>
      <button type="button" class="btn btn-outline chat-reroll-btn">${icon('reroll', 'chat-action-icon')} 重roll</button>
      <button type="button" class="btn btn-outline chat-stop-btn">中止</button>
      <button type="button" class="btn btn-outline chat-select-btn">多选</button>
      <button type="button" class="btn btn-outline chat-delete-selected-btn" style="display:none;">删除已选</button>
    </div>
    <footer class="chat-input-bar">
      <button type="button" class="navbar-btn chat-tools-toggle" aria-label="更多">${icon('plus')}</button>
      <textarea class="chat-input" rows="1" placeholder="发送消息…"></textarea>
      <button type="button" class="chat-send-btn" aria-label="发送">${icon('send')}</button>
    </footer>
    <input type="file" class="chat-image-input" accept="image/*" style="display:none;" />
  `;

  const messagesEl = container.querySelector('.chat-messages');
  const inputEl = container.querySelector('.chat-input');
  const sendBtn = container.querySelector('.chat-send-btn');
  const toolsPanel = container.querySelector('.chat-tools-panel');
  const stickerPicker = container.querySelector('.chat-sticker-picker');
  const toolsToggle = container.querySelector('.chat-tools-toggle');
  const replyBar = container.querySelector('.reply-bar');
  const advanceBtn = container.querySelector('.chat-advance-btn');
  const rerollBtn = container.querySelector('.chat-reroll-btn');
  const stopBtn = container.querySelector('.chat-stop-btn');
  const selectBtn = container.querySelector('.chat-select-btn');
  const deleteSelectedBtn = container.querySelector('.chat-delete-selected-btn');
  const imageInput = container.querySelector('.chat-image-input');
  let replyTarget = null;
  let isStreaming = false;
  let lastUserTurnId = null;
  let lastAiMessageId = null;
  let lastAiRoundId = '';
  let currentAbortController = null;
  let typingIndicatorId = '';
  let selecting = false;
  const selectedIds = new Set();

  function showTypingIndicator(name) {
    hideTypingIndicator();
    const el = document.createElement('div');
    typingIndicatorId = 'typing_' + Date.now();
    el.className = 'date-divider';
    el.dataset.msgId = typingIndicatorId;
    el.textContent = `${name} 正在输入中...`;
    messagesEl.appendChild(el);
    scrollMessagesToBottom(messagesEl);
  }
  function hideTypingIndicator() {
    if (!typingIndicatorId) return;
    const target = messagesEl.querySelector(`[data-msg-id="${typingIndicatorId}"]`);
    if (target) target.remove();
    typingIndicatorId = '';
  }

  async function loadAndRenderMessages() {
    let list = await db.getAllByIndex('messages', 'chatId', chatId);
    list = [...list].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    messagesEl.innerHTML = '';
    for (const m of list) {
      if (m.deleted) continue;
      const normalized = normalizeMessageForUi(m);
      if (normalized.type === 'system') {
        messagesEl.appendChild(renderSystemHintRow(normalized));
        continue;
      }
      const senderAvatarMarkup = normalized.senderId === 'user' ? userAvatar : aiAvatar;
      const row = renderMessageRow(normalized, senderAvatarMarkup, !!chat.blocked);
      if (selecting && normalized.type !== 'system') {
        const mark = document.createElement('input');
        mark.type = 'checkbox';
        mark.style.marginRight = '6px';
        mark.checked = selectedIds.has(normalized.id);
        mark.addEventListener('change', () => {
          if (mark.checked) selectedIds.add(normalized.id);
          else selectedIds.delete(normalized.id);
        });
        row.prepend(mark);
      }
      messagesEl.appendChild(row);
      bindRow(row, normalized);
      bindAvatarInnerVoice(row, normalized, chatId);
    }
    const userTurns = list.filter((m) => m.senderId === 'user' && !m.deleted);
    lastUserTurnId = userTurns[userTurns.length - 1]?.id || null;
    const aiTurns = list.filter((m) => m.senderId !== 'user' && !m.deleted && !m.recalled);
    lastAiMessageId = aiTurns[aiTurns.length - 1]?.id || null;
    lastAiRoundId = aiTurns[aiTurns.length - 1]?.metadata?.aiRoundId || '';
    scrollMessagesToBottom(messagesEl);
    return list;
  }

  function setReplyTo(msg) {
    replyTarget = msg;
    if (!msg) {
      replyBar.style.display = 'none';
      replyBar.textContent = '';
      return;
    }
    const prev = msg.recalled ? '已撤回' : String(msg.content || '').slice(0, 40);
    replyBar.style.display = 'block';
    replyBar.innerHTML = `回复：${escapeHtml(prev)} <button type="button" class="reply-cancel" style="margin-left:8px;color:var(--primary);">取消</button>`;
    replyBar.querySelector('.reply-cancel')?.addEventListener('click', () => setReplyTo(null));
  }

  async function persistChatPreview(text) {
    chat = (await db.get('chats', chatId)) || chat;
    chat.lastMessage = text;
    chat.lastActivity = Date.now();
    await db.put('chats', chat);
  }

  function bindRow(row, msg) {
    if (selecting) {
      row.addEventListener('click', () => {
        if (msg.type === 'system') return;
        if (selectedIds.has(msg.id)) selectedIds.delete(msg.id);
        else selectedIds.add(msg.id);
        loadAndRenderMessages();
      });
      return;
    }
    attachLongPress(row, (cx, cy) => {
      const items = [
        { label: '回复', value: 'reply' },
        { label: '撤回', value: 'recall' },
        { label: '删除', value: 'delete' },
        { label: '转发', value: 'forward' },
        { label: '编辑', value: 'edit' },
        { label: '表情回应', value: 'react' },
      ];
      openContextMenu(cx, cy, items, async (action) => {
        if (action === 'reply') {
          setReplyTo(msg);
          inputEl.focus();
        }
        if (action === 'recall') {
          if (msg.senderId !== 'user') return;
          const sender = msg.senderId === 'user' ? (currentUser?.name || '你') : (await resolveName(msg.senderId));
          msg.recalled = true;
          msg.metadata = { ...(msg.metadata || {}), recalledContent: msg.content || '' };
          await db.put('messages', msg);
          await db.put('messages', createMessage({
            chatId,
            senderId: 'system',
            type: 'system',
            content: `${sender} 撤回了一条消息`,
            metadata: { recalledContent: msg.content || '' },
          }));
          await loadAndRenderMessages();
        }
        if (action === 'delete') {
          await db.del('messages', msg.id);
          await loadAndRenderMessages();
        }
        if (action === 'forward') {
          const t = msg.recalled ? '' : String(msg.content || '');
          try {
            await navigator.clipboard.writeText(t);
          } catch (_) {}
        }
        if (action === 'edit') {
          if (msg.recalled) return;
          const next = window.prompt('编辑消息', msg.content || '');
          if (next == null) return;
          msg.content = next;
          await db.put('messages', msg);
          await loadAndRenderMessages();
        }
        if (action === 'react') {
          const em = window.prompt('表情', '👍');
          if (!em) return;
          msg.reactions = { ...(msg.reactions || {}), [em]: (msg.reactions?.[em] || 0) + 1 };
          await db.put('messages', msg);
          await loadAndRenderMessages();
        }
      });
    });
    row.querySelector('.offline-invite-go')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const pid = getPartnerId(chat);
      navigate('novel-mode', { chatId, characterIds: pid || '' });
    });
    row.querySelector('.chat-card')?.addEventListener('click', async () => {
      const kind = msg.type;
      if (kind === 'voice') {
        msg.metadata = { ...(msg.metadata || {}), voiceExpanded: !msg.metadata?.voiceExpanded, text: msg.metadata?.text || msg.content || '[语音转文字暂无]' };
        await db.put('messages', msg);
        await loadAndRenderMessages();
        return;
      }
      navigate('message-detail', { chatId, msgId: msg.id });
    });
  }

  function bindAvatarInnerVoice(row, msg, chatIdForVoice) {
    if (msg.senderId === 'user') return;
    row.querySelector('.bubble-avatar-slot .avatar')?.addEventListener('click', async () => {
      const fresh = (await db.get('messages', msg.id)) || msg;
      const inner = await collectInnerVoicesForMessage(fresh, chatIdForVoice);
      if (!inner.trim()) {
        showToast('当前暂无可查看的心声');
        return;
      }
      window.alert(`【心声】\n${inner}`);
    });
  }

  await loadAndRenderMessages();

  container.querySelector('.chat-back-btn')?.addEventListener('click', () => back());
  container.querySelector('.chat-menu-btn')?.addEventListener('click', () => {
    navigate('chat-details', { chatId });
  });

  toolsToggle.addEventListener('click', () => {
    const open = toolsPanel.style.display === 'none';
    toolsPanel.style.display = open ? 'block' : 'none';
  });

  container.querySelectorAll('.chat-tool-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.tool;
      if (kind !== 'emoji') {
        toolsPanel.style.display = 'none';
        stickerPicker.style.display = 'none';
      }
      if (kind === 'image') {
        imageInput.click();
        return;
      }
      if (kind === 'emoji') {
        const packs = await db.getAll('stickerPacks');
        const all = packs.flatMap((p) => (p.stickers || []).map((s) => ({ ...s, pack: p.name })));
        if (!all.length) {
          showToast('还没有表情包，请先在表情包管理里导入');
          return;
        }
        toolsPanel.style.display = 'block';
        const open = stickerPicker.style.display === 'none';
        stickerPicker.style.display = open ? 'grid' : 'none';
        stickerPicker.style.gridTemplateColumns = 'repeat(5, 1fr)';
        stickerPicker.style.gap = '8px';
        if (open) {
          stickerPicker.innerHTML = all
            .map(
              (s) =>
                `<button type="button" class="stk-pick" data-url="${escapeAttr(s.url)}" data-name="${escapeAttr(s.name || '表情')}"><img src="${escapeAttr(s.url)}" alt="" loading="lazy" decoding="async" style="width:44px;height:44px;object-fit:contain;border-radius:8px;background:var(--bg-card);" /></button>`
            )
            .join('');
          stickerPicker.querySelectorAll('.stk-pick').forEach((it) => {
            it.addEventListener('click', async () => {
              const msg = createMessage({
                chatId,
                senderId: 'user',
                type: 'sticker',
                content: it.dataset.url,
                metadata: { stickerName: it.dataset.name, url: it.dataset.url, packName: '' },
              });
              await db.put('messages', msg);
              await persistChatPreview('[表情包]');
              stickerPicker.style.display = 'none';
              toolsPanel.style.display = 'none';
              await loadAndRenderMessages();
            });
          });
        }
        return;
      }
      if (kind === 'voice') {
        const spokenText = window.prompt('语音转文字内容', inputEl.value.trim() || '');
        if (!spokenText) return;
        const msg = createMessage({
          chatId,
          senderId: 'user',
          type: 'voice',
          content: '[语音消息]',
          metadata: { duration: '0:03', text: spokenText },
        });
        await db.put('messages', msg);
        await persistChatPreview('[语音]');
        await loadAndRenderMessages();
        return;
      }
      if (kind === 'location') {
        const msg = createMessage({
          chatId,
          senderId: 'user',
          type: 'location',
          content: '杭州市 · 兴欣网吧',
          metadata: { title: '位置共享' },
        });
        await db.put('messages', msg);
        await persistChatPreview('[位置]');
        await loadAndRenderMessages();
        return;
      }
      if (kind === 'link') {
        const url = window.prompt('链接地址', 'https://example.com');
        if (!url) return;
        const title = window.prompt('链接标题', '荣耀赛事资讯');
        const source = window.prompt('来源', 'B站');
        const msg = createMessage({
          chatId,
          senderId: 'user',
          type: 'link',
          content: url,
          metadata: {
            title: title || '分享链接',
            desc: url,
            source: source || '站外分享',
          },
        });
        await db.put('messages', msg);
        await persistChatPreview('[链接]');
        await loadAndRenderMessages();
        return;
      }
      if (kind === 'redpacket') {
        const blessing = window.prompt('红包文案', '恭喜发财');
        const msg = createMessage({
          chatId,
          senderId: 'user',
          type: 'redpacket',
          content: blessing || '恭喜发财',
          metadata: { title: 'QQ红包' },
        });
        await db.put('messages', msg);
        await persistChatPreview('[红包]');
        await loadAndRenderMessages();
        return;
      }
      if (kind === 'transfer') {
        const amount = window.prompt('转账金额', '0.01');
        const msg = createMessage({
          chatId,
          senderId: 'user',
          type: 'transfer',
          content: `¥${amount || '0.01'}`,
          metadata: { title: '转账' },
        });
        await db.put('messages', msg);
        await persistChatPreview('[转账]');
        await loadAndRenderMessages();
        return;
      }
      if (kind === 'textimg') {
        const text = window.prompt('文字图内容', '荣耀永不散场');
        if (!text) return;
        const msg = createMessage({
          chatId,
          senderId: 'user',
          type: 'textimg',
          content: text,
        });
        await db.put('messages', msg);
        await persistChatPreview('[文字图]');
        await loadAndRenderMessages();
        return;
      }
      if (kind === 'ordershare') {
        const plat = window.prompt('平台（如 淘宝、美团、京东）', '美团');
        if (plat == null) return;
        const title = window.prompt('商品/套餐名称', '夜宵套餐');
        if (title == null || !String(title).trim()) return;
        const price = window.prompt('价格（可含¥）', '¥58');
        const note = window.prompt('备注（可空）', '给你点的') || '';
        const msg = createMessage({
          chatId,
          senderId: 'user',
          type: 'orderShare',
          content: String(title).trim(),
          metadata: {
            orderPlatform: String(plat).trim() || '购物',
            orderTitle: String(title).trim(),
            orderPrice: String(price || '').trim(),
            orderNote: String(note).trim(),
          },
        });
        await db.put('messages', msg);
        await persistChatPreview('[分享购物]');
        await loadAndRenderMessages();
      }
    });
  });

  imageInput?.addEventListener('change', async () => {
    const file = imageInput.files?.[0];
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    const msg = createMessage({
      chatId,
      senderId: 'user',
      type: 'image',
      content: dataUrl,
      metadata: { localName: file.name, description: `[本地图片:${file.name}]` },
    });
    await db.put('messages', msg);
    await persistChatPreview('[图片]');
    await loadAndRenderMessages();
    imageInput.value = '';
  });

  async function sendUserText(text) {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    const msg = createMessage({
      chatId,
      senderId: 'user',
      type: 'text',
      content: trimmed,
      replyTo: replyTarget?.id || null,
      replyPreview: replyTarget
        ? replyTarget.recalled
          ? '[已撤回]'
          : String(replyTarget.content || '').slice(0, 80)
        : null,
    });
    await db.put('messages', msg);
    setReplyTo(null);
    inputEl.value = '';
    await persistChatPreview(trimmed);
    await loadAndRenderMessages();
  }

  async function requestAiReply({ reroll = false } = {}) {
    if (isStreaming) return;
    const allMessages = await db.getAllByIndex('messages', 'chatId', chatId);
    const sorted = [...allMessages].map(normalizeMessageForUi).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const lastUserMsg = [...sorted].reverse().find((m) => m.senderId === 'user' && !m.deleted);
    const noUserMessageYet = !lastUserMsg;

    if (!reroll && !noUserMessageYet) {
      const latestAfterUser = sorted.filter((m) => !m.deleted && (m.timestamp || 0) > (lastUserMsg.timestamp || 0));
      if (latestAfterUser.some((m) => m.senderId !== 'user' && !m.recalled)) {
        showToast('这一轮已经回复过了，可以点重roll');
        return;
      }
    } else if (lastAiMessageId) {
      const scope = await db.getAllByIndex('messages', 'chatId', chatId);
      const latestAi = scope.find((m) => m.id === lastAiMessageId);
      const targetRoundId = latestAi?.metadata?.aiRoundId || lastAiRoundId || '';
      if (targetRoundId) {
        const toDelete = scope.filter((m) => m.senderId !== 'user' && m.metadata?.aiRoundId === targetRoundId);
        await Promise.all(toDelete.map((m) => db.del('messages', m.id)));
      } else if (lastUserMsg) {
        const toDelete = scope.filter((m) => m.senderId !== 'user' && (m.timestamp || 0) > (lastUserMsg.timestamp || 0));
        await Promise.all(toDelete.map((m) => db.del('messages', m.id)));
      } else if (latestAi) {
        await db.del('messages', latestAi.id);
      }
    }

    isStreaming = true;
    currentAbortController = new AbortController();
    advanceBtn.style.opacity = '0.55';
    rerollBtn.style.opacity = '0.55';
    stopBtn.style.opacity = '1';

    const beforeAi = await db.getAllByIndex('messages', 'chatId', chatId);
    const sortedForApi = [...beforeAi]
      .map(normalizeMessageForUi)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const aiRoundId = `air_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const payload = await messagesToApiPayload(chat, sortedForApi);
    if (noUserMessageYet) {
      payload.push({
        role: 'user',
        content: '[系统] 当前还没有用户发言。请你以生活化、符合设定的方式主动开一个自然话题，不要尬聊。',
      });
    }

    const aiMsg = createMessage({
      chatId,
      senderId: aiSenderId,
      senderName: await resolveName(aiSenderId),
      type: 'text',
      content: '',
      metadata: { generatedFrom: lastUserMsg?.id || null, reroll, aiRoundId },
    });
    await db.put('messages', aiMsg);
    await loadAndRenderMessages();
    showTypingIndicator(await resolveName(aiSenderId));

    const escId =
      typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(aiMsg.id) : aiMsg.id.replace(/"/g, '\\"');
    const aiRow = messagesEl.querySelector(`[data-msg-id="${escId}"]`);
    const bubbleEl = aiRow?.querySelector('.bubble');

    let full = '';
    try {
      await chatStream(
        payload,
        (_delta, acc) => {
          full = acc;
          if (bubbleEl) bubbleEl.textContent = full;
          scrollMessagesToBottom(messagesEl);
        },
        { signal: currentAbortController.signal }
      );
      const cleaned = stripThinkingBlocks(full || '...');
      const pieces = splitToBubbleTexts(cleaned);
      await db.del('messages', aiMsg.id);
      const nextTs = createMessageTimestampAllocator();
      let lastPublic = '…';
      let lastPersisted = null;
      let carryInner = '';
      const senderName = await resolveName(aiSenderId);
      for (const piece of pieces) {
        const parsed = splitPublicAndInnerVoice(piece);
        const mergedInner = [carryInner, parsed.innerVoice].filter(Boolean).join('；');
        carryInner = '';
        const publicT = (parsed.publicText || '').trim();
        if (!publicT) {
          carryInner = mergedInner;
          continue;
        }
        const replyParsed = parseReplyInline(publicT);
        const inv = extractOfflineInvite(replyParsed.text);
        const stickerMsg = await resolveStickerMessage(inv.text, chatId, aiSenderId, senderName);
        if (stickerMsg) {
          stickerMsg.timestamp = nextTs();
          stickerMsg.metadata = {
            ...(stickerMsg.metadata || {}),
            aiRoundId,
            ...(mergedInner ? { innerVoice: mergedInner } : {}),
          };
          await db.put('messages', stickerMsg);
          lastPersisted = stickerMsg;
          lastPublic = '[表情包]';
          lastAiMessageId = stickerMsg.id;
          if (inv.note) {
            const invMsg = createMessage({
              chatId,
              senderId: aiSenderId,
              senderName,
              type: 'text',
              content: `线下邀约：${inv.note}`,
              timestamp: nextTs(),
              metadata: { offlineInvite: true, note: inv.note, aiRoundId },
            });
            await db.put('messages', invMsg);
            lastAiMessageId = invMsg.id;
          }
          continue;
        }
        const item = createMessage({
          chatId,
          senderId: aiSenderId,
          senderName,
          type: 'text',
          content: inv.text || '…',
          replyPreview: replyParsed.replyPreview || null,
          timestamp: nextTs(),
          metadata: {
            ...(mergedInner ? { innerVoice: mergedInner } : {}),
            aiRoundId,
          },
        });
        await db.put('messages', item);
        lastPersisted = item;
        lastPublic = inv.text || lastPublic;
        lastAiMessageId = item.id;
        if (inv.note) {
          const invMsg = createMessage({
            chatId,
            senderId: aiSenderId,
            senderName,
            type: 'text',
            content: `线下邀约：${inv.note}`,
            timestamp: nextTs(),
            metadata: { offlineInvite: true, note: inv.note, aiRoundId },
          });
          await db.put('messages', invMsg);
          lastAiMessageId = invMsg.id;
        }
      }
      if (carryInner && lastPersisted) {
        const prev = lastPersisted.metadata?.innerVoice || '';
        lastPersisted.metadata = {
          ...lastPersisted.metadata,
          innerVoice: [prev, carryInner].filter(Boolean).join('；'),
        };
        await db.put('messages', lastPersisted);
      }
      await loadAndRenderMessages();
      await persistChatPreview((lastPublic || '…').slice(0, 80));
    } catch (e) {
      if (String(e?.name || '').toLowerCase().includes('abort')) {
        const cleaned = stripThinkingBlocks(full || '');
        if (cleaned) {
          const pieces = splitToBubbleTexts(cleaned);
          await db.del('messages', aiMsg.id);
          const nextTs = createMessageTimestampAllocator();
          let lastPersisted = null;
          let carryInner = '';
          const senderName = await resolveName(aiSenderId);
          for (const piece of pieces) {
            const parsed = splitPublicAndInnerVoice(piece);
            const mergedInner = [carryInner, parsed.innerVoice].filter(Boolean).join('；');
            carryInner = '';
            const publicT = (parsed.publicText || '').trim();
            if (!publicT) {
              carryInner = mergedInner;
              continue;
            }
            const replyParsed = parseReplyInline(publicT);
            const inv = extractOfflineInvite(replyParsed.text);
            const stickerMsg = await resolveStickerMessage(inv.text, chatId, aiSenderId, senderName);
            if (stickerMsg) {
              stickerMsg.timestamp = nextTs();
              stickerMsg.metadata = {
                ...(stickerMsg.metadata || {}),
                aiRoundId,
                ...(mergedInner ? { innerVoice: mergedInner } : {}),
              };
              await db.put('messages', stickerMsg);
              lastPersisted = stickerMsg;
              lastAiMessageId = stickerMsg.id;
              if (inv.note) {
                const invMsg = createMessage({
                  chatId,
                  senderId: aiSenderId,
                  senderName,
                  type: 'text',
                  content: `线下邀约：${inv.note}`,
                  timestamp: nextTs(),
                  metadata: { offlineInvite: true, note: inv.note, aiRoundId },
                });
                await db.put('messages', invMsg);
                lastAiMessageId = invMsg.id;
              }
              continue;
            }
            const item = createMessage({
              chatId,
              senderId: aiSenderId,
              senderName,
              type: 'text',
              content: inv.text || '…',
              replyPreview: replyParsed.replyPreview || null,
              timestamp: nextTs(),
              metadata: {
                ...(mergedInner ? { innerVoice: mergedInner } : {}),
                aiRoundId,
              },
            });
            await db.put('messages', item);
            lastPersisted = item;
            lastAiMessageId = item.id;
            if (inv.note) {
              const invMsg = createMessage({
                chatId,
                senderId: aiSenderId,
                senderName,
                type: 'text',
                content: `线下邀约：${inv.note}`,
                timestamp: nextTs(),
                metadata: { offlineInvite: true, note: inv.note, aiRoundId },
              });
              await db.put('messages', invMsg);
              lastAiMessageId = invMsg.id;
            }
          }
          if (carryInner && lastPersisted) {
            const prev = lastPersisted.metadata?.innerVoice || '';
            lastPersisted.metadata = {
              ...lastPersisted.metadata,
              innerVoice: [prev, carryInner].filter(Boolean).join('；'),
            };
            await db.put('messages', lastPersisted);
          }
          await loadAndRenderMessages();
          await persistChatPreview(cleaned.slice(0, 80));
        } else {
          await db.del('messages', aiMsg.id);
          await loadAndRenderMessages();
        }
        return;
      }
      const errText = `发送失败：${e.message || e}`;
      aiMsg.content = errText;
      await db.put('messages', aiMsg);
      if (bubbleEl) bubbleEl.textContent = errText;
      await persistChatPreview(errText.slice(0, 80));
    } finally {
      hideTypingIndicator();
      isStreaming = false;
      currentAbortController = null;
      advanceBtn.style.opacity = '1';
      rerollBtn.style.opacity = '1';
      stopBtn.style.opacity = '1';
      scrollMessagesToBottom(messagesEl);
    }
  }

  sendBtn.addEventListener('click', () => sendUserText(inputEl.value));
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendUserText(inputEl.value);
    }
  });
  advanceBtn.addEventListener('click', () => requestAiReply({ reroll: false }));
  rerollBtn.addEventListener('click', () => requestAiReply({ reroll: true }));
  stopBtn.addEventListener('click', () => {
    if (currentAbortController) currentAbortController.abort();
  });
  selectBtn.addEventListener('click', async () => {
    selecting = !selecting;
    selectedIds.clear();
    deleteSelectedBtn.style.display = selecting ? 'inline-flex' : 'none';
    await loadAndRenderMessages();
  });
  deleteSelectedBtn.addEventListener('click', async () => {
    if (!selectedIds.size) return;
    await Promise.all([...selectedIds].map((id) => db.del('messages', id)));
    selectedIds.clear();
    selecting = false;
    deleteSelectedBtn.style.display = 'none';
    await loadAndRenderMessages();
  });

}
