/**
 * Group chat window: multi-speaker bubbles, management modal, observer mode, AI round-robin.
 * Private one-on-one UI lives in `./chat-window.js`.
 */
export { default as renderPrivateChatWindow } from './chat-window.js';

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

function getAiMembers(chat) {
  return (chat?.participants || []).filter((p) => p && p !== 'user');
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

function extractPrivateLines(text) {
  const raw = String(text || '');
  const lines = raw.split('\n');
  const privateItems = [];
  const publicLines = [];
  for (const line of lines) {
    const m = line.match(/^\[\[PM:([a-zA-Z0-9_-]+)\]\]\s*(.+)$/);
    if (m) {
      privateItems.push({ characterId: m[1], content: m[2].trim() });
    } else {
      publicLines.push(line);
    }
  }
  return { publicText: publicLines.join('\n').trim(), privateItems };
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

async function buildSpeakerLookup(chat, season) {
  const lookup = new Map();
  for (const id of getAiMembers(chat)) {
    const c = await resolveCharacter(id);
    if (!c) continue;
    const state = getCharacterStateForSeason(c, season);
    const names = [
      c.id,
      c.name,
      c.realName,
      state.publicName,
      ...(c.aliases || []),
    ].filter(Boolean);
    for (const n of names) {
      lookup.set(String(n).trim().toLowerCase(), id);
    }
  }
  return lookup;
}

function parseSpeakerBlocks(text, fallbackId, lookup) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const blocks = [];
  for (const line of lines) {
    const m = line.match(/^\[([^\]]+)\]\s*(.+)$/);
    if (m) {
      const speakerRaw = m[1].trim().toLowerCase();
      const senderId = lookup.get(speakerRaw) || fallbackId;
      const body = m[2].trim().replace(/^[：:]\s*/, '');
      blocks.push({ senderId, text: body });
    } else {
      blocks.push({ senderId: fallbackId, text: line });
    }
  }
  return blocks;
}

/** 将解析后的发言块落库：稳定时间序、心声不单独成泡、合并仅心声的片段 */
async function persistGroupAiOutputBlocks(blocks, chatId, speakingAsId, aiRoundId) {
  const nextTs = createMessageTimestampAllocator();
  let lastPublic = '…';
  let lastInnerCarrier = null;
  let carryInner = '';
  for (const block of blocks) {
    const sid = block.senderId || speakingAsId;
    const senderName = await resolveName(sid);
    const pieces = splitToBubbleTexts(block.text);
    for (const piece of pieces) {
      const voiceParsed = splitPublicAndInnerVoice(piece);
      const mergedInner = [carryInner, voiceParsed.innerVoice].filter(Boolean).join('；');
      carryInner = '';
      const publicT = (voiceParsed.publicText || '').trim();
      if (!publicT) {
        carryInner = mergedInner;
        continue;
      }
      const replyParsed = parseReplyInline(publicT);
      const inv = extractOfflineInvite(replyParsed.text);
      const stickerMsg = await resolveStickerMessage(inv.text, chatId, sid, senderName);
      if (stickerMsg) {
        stickerMsg.timestamp = nextTs();
        stickerMsg.metadata = {
          ...(stickerMsg.metadata || {}),
          aiRoundId,
          ...(mergedInner ? { innerVoice: mergedInner } : {}),
        };
        await db.put('messages', stickerMsg);
        lastInnerCarrier = stickerMsg;
        lastPublic = '[表情包]';
        if (inv.note) {
          await db.put(
            'messages',
            createMessage({
              chatId,
              senderId: sid,
              senderName: await resolveName(sid),
              type: 'text',
              content: `线下邀约：${inv.note}`,
              timestamp: nextTs(),
              metadata: { offlineInvite: true, note: inv.note, aiRoundId },
            })
          );
        }
        continue;
      }
      const item = createMessage({
        chatId,
        senderId: sid,
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
      lastInnerCarrier = item;
      lastPublic = inv.text || lastPublic;
      if (inv.note) {
        await db.put(
          'messages',
          createMessage({
            chatId,
            senderId: sid,
            senderName: await resolveName(sid),
            type: 'text',
            content: `线下邀约：${inv.note}`,
            timestamp: nextTs(),
            metadata: { offlineInvite: true, note: inv.note, aiRoundId },
          })
        );
      }
    }
  }
  if (carryInner && lastInnerCarrier) {
    const prev = lastInnerCarrier.metadata?.innerVoice || '';
    lastInnerCarrier.metadata = {
      ...lastInnerCarrier.metadata,
      innerVoice: [prev, carryInner].filter(Boolean).join('；'),
    };
    await db.put('messages', lastInnerCarrier);
  }
  return lastPublic;
}

async function chatTitle(chat) {
  const gs = chat.groupSettings || {};
  if (gs.name && String(gs.name).trim()) return gs.name;
  const members = getAiMembers(chat);
  if (members.length) {
    const names = await Promise.all(members.slice(0, 3).map((id) => resolveName(id)));
    return names.join('、') + (members.length > 3 ? '…' : '');
  }
  return '群聊';
}

async function buildGroupSystemBase(chat) {
  const members = getAiMembers(chat);
  const names = await Promise.all(members.map((id) => resolveName(id)));
  const plot = (chat.groupSettings?.plotDirective || '').trim();
  const allowPrivateTrigger = !!chat.groupSettings?.allowPrivateTrigger;
  return [
    '你在进行中文群聊角色扮演；你需要同时扮演多个角色并让他们互相接话。',
    `本群参与者（含你）：${names.join('、') || '（待定）'}`,
    `成员ID映射：${members.map((id, i) => `${id}=${names[i] || id}`).join('；')}`,
    plot ? `剧情/气氛提示：${plot}` : '',
    '表达要求：自然口语、短句、可有情绪停顿；避免书面逻辑连接词堆叠；可结合身份切换正式/私下语气。',
    '当群聊冷场时，你可以主动抛出一个新话题推进剧情。',
    '每轮可输出任意数量群消息（按剧情自然决定），至少包含2个不同角色，且角色之间要有连续互动。',
    '群消息格式必须逐行使用：[角色名] 内容（[角色名] 与正文之间不要再用 : 重复写一遍名字）',
    '禁止在正文前额外加 [角色名]: 前缀；心声只放在该行末尾用 [心声]: 短句，勿把 [心声] 当正文展示',
    '如需引用上一条消息，使用格式：[回复:消息片段] 你的发言',
    '表情包单独一行：优先带完整图片URL；仅有 [表情包:名称] 时名称贴近导入包内标题/文件名；勿每轮同一个词；无URL时会就近匹配或随机抽选避免总出同一张',
    '分享礼物/点外卖/下单用单独一行：[分享购物:平台|商品名|价格|短备注] 不要只发省略号；例 [分享购物:淘宝|键帽套装|¥39|给你买的]',
    '每行只写一句或一个短段，不要把多句合成超长一行。',
    '若要输出角色心理，可在对应行末尾追加 [心声]: 内容（简短）。',
    allowPrivateTrigger
      ? '你可以在消息末尾追加1-3行私聊片段，格式必须是 [[PM:角色ID]] 内容。仅使用群成员角色ID，不要写用户ID。'
      : '',
    chat.groupSettings?.allowAiOfflineInvite
      ? '本群已开启「线下邀约」：可由某一角色单独一行输出 [线下邀约:地点或事由]，该行须以 [角色名] 开头与其他消息一致，且该行除该标签外不要长篇解释。'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function messagesToApiPayload(chat, sortedMessages, speakingAsId) {
  const base = await buildGroupSystemBase(chat);
  const stickerHints = await buildStickerAliasPromptSection();
  const system = `${base}${stickerHints ? '\n\n' + stickerHints : ''}\n\n【本轮优先开口角色】${await resolveName(speakingAsId)}`;
  const characterIds = getAiMembers(chat);
  const contextMessages = await assembleContext(chat.id, characterIds, '');
  if (contextMessages[0]?.role === 'system') {
    contextMessages[0].content = `${system}\n\n---\n\n${contextMessages[0].content}`;
  }
  const latestImage = [...(sortedMessages || [])].reverse().find((m) => m.senderId === 'user' && m.type === 'image' && m.content);
  if (latestImage) {
    contextMessages.push({
      role: 'user',
      content: [
        { type: 'text', text: '请结合这张图片理解群聊上下文并接话。' },
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
  if (msg.type === 'image' && msg.content) {
    return `<div class="bubble"><img src="${escapeAttr(msg.content)}" alt="图片" /></div>`;
  }
  if (msg.type === 'location') {
    return `
        <div class="location-card chat-card" data-card-type="location">
          <div class="location-card-map">${icon('location', 'chat-card-icon chat-card-icon-lg')}</div>
          <div class="location-card-info">
            <div class="link-card-title">${escapeHtml(msg.metadata?.title || '位置共享')}</div>
            <div class="link-card-desc">${escapeHtml(msg.content || '')}</div>
          </div>
        </div>
    `;
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
  if (msg.type === 'redpacket') {
    return `
        <div class="red-packet-card chat-card" data-card-type="redpacket">
          <div class="link-card-title">${escapeHtml(msg.metadata?.title || 'QQ红包')}</div>
          <div class="link-card-desc">${escapeHtml(msg.content || '恭喜发财')}</div>
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

function renderMessageRow(msg, senderLabel, senderAvatarMarkup = '') {
  const row = document.createElement('div');
  row.className = 'bubble-row' + (msg.senderId === 'user' ? ' self' : '');
  row.dataset.msgId = msg.id;
  const senderBlock =
    msg.senderId !== 'user' && senderLabel
      ? `<div class="bubble-sender">${escapeHtml(senderLabel)}</div>`
      : '';
  row.innerHTML = `
    <div class="bubble-avatar-slot">
      <div class="avatar avatar-sm">${senderAvatarMarkup}</div>
    </div>
    <div class="bubble-wrap">
      ${senderBlock}
      ${bubbleInnerHtml(msg)}
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

async function resolveNameForDisplay(id) {
  if (!id || id === 'user') return '我';
  const c = await db.get('characters', id);
  if (c?.name) return c.name;
  const d = CHARACTERS.find((x) => x.id === id);
  return d?.name || id;
}

function openGroupModal(chat, chatId, onUpdated) {
  const host = document.getElementById('modal-container');
  if (!host) return;

  async function renderPanel() {
    const g = { ...(chat.groupSettings || {}) };
    const parts = (chat.participants || []).filter(Boolean);
    const memberNames = await Promise.all(parts.map((id) => resolveNameForDisplay(id)));
    const admins = g.admins || [];
    const adminNames = await Promise.all(admins.map((id) => resolveNameForDisplay(id)));
    const ownerName = g.owner ? await resolveNameForDisplay(g.owner) : '未设置';

    const memberGrid = parts.map((id, i) => {
      const isAdmin = admins.includes(id);
      const isOwner = g.owner === id;
      const badge = isOwner ? '群主' : isAdmin ? '管理' : '';
      return `
        <div class="gi-member" data-member-id="${escapeAttr(id)}">
          <div class="avatar avatar-sm">${avatarMarkup(null, memberNames[i])}</div>
          <div class="gi-member-name">${escapeHtml(memberNames[i])}${badge ? ` <span class="gi-badge">${badge}</span>` : ''}</div>
        </div>
      `;
    }).join('');

    host.innerHTML = `
      <div class="modal-overlay" data-modal-overlay>
        <div class="modal-sheet modal-sheet-tall" role="dialog" aria-modal="true" data-modal-sheet>
          <div class="modal-header">
            <h3>聊天信息</h3>
            <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">${icon('close')}</button>
          </div>
          <div class="modal-body" style="display:flex;flex-direction:column;gap:12px;">
            <div class="card-block">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <span style="font-weight:600;">群成员</span>
                <span class="text-hint">${parts.length}人</span>
              </div>
              <div class="gi-member-grid">${memberGrid}</div>
              <button type="button" class="btn btn-outline btn-sm gi-add-member" style="margin-top:8px;width:100%;">+ 邀请成员</button>
            </div>

            <div class="card-block">
              <div class="gi-setting-row">
                <span>群名称</span>
                <span class="gi-setting-value gi-rename" role="button">${escapeHtml(g.name || '未命名')} ›</span>
              </div>
              <div class="gi-setting-row">
                <span>群主</span>
                <span class="gi-setting-value">${escapeHtml(ownerName)}</span>
              </div>
              <div class="gi-setting-row">
                <span>管理员</span>
                <span class="gi-setting-value">${adminNames.length ? escapeHtml(adminNames.join('、')) : '无'}</span>
              </div>
            </div>

            <div class="card-block">
              <div class="gi-setting-row">
                <span>群公告</span>
                <span class="gi-setting-value gi-announce" role="button">${escapeHtml(g.announcement || '未设置')} ›</span>
              </div>
            </div>

            <div class="card-block">
              <div class="gi-setting-row">
                <span>剧情推进提示</span>
                <span class="gi-setting-value gi-plot" role="button">${escapeHtml(g.plotDirective || '未设置')} ›</span>
              </div>
            </div>

            <div class="card-block">
              <div class="gi-setting-row">
                <span>旁观者模式</span>
                <div class="toggle gi-observer-toggle${g.isObserverMode ? ' on' : ''}"></div>
              </div>
              <div class="text-hint" style="margin-top:4px;">开启后，user不参与发言，仅观看 AI 角色间的互动。</div>
            </div>

            <div class="card-block">
              <div class="gi-setting-row">
                <span>全员禁言</span>
                <div class="toggle gi-mute-all-toggle${g.allMuted ? ' on' : ''}"></div>
              </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:8px;">
              <button type="button" class="btn btn-outline btn-sm gi-set-admin">设置管理员</button>
              <button type="button" class="btn btn-outline btn-sm gi-set-owner">转让群主</button>
              <button type="button" class="btn btn-outline btn-sm gi-kick">踢出成员</button>
              <button type="button" class="btn btn-outline btn-sm gi-mute-one">禁言成员</button>
            </div>
          </div>
        </div>
      </div>
    `;

    const close = () => { host.classList.remove('active'); host.innerHTML = ''; };
    host.querySelector('[data-modal-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('[data-modal-overlay]')?.addEventListener('click', close);
    host.querySelector('.modal-close-btn')?.addEventListener('click', close);

    async function saveAndRefresh(newGs) {
      chat.groupSettings = newGs;
      await db.put('chats', chat);
      await renderPanel();
    }

    host.querySelector('.gi-rename')?.addEventListener('click', async () => {
      const n = window.prompt('群名称', g.name || '');
      if (n == null) return;
      g.name = n;
      await saveAndRefresh(g);
      await onUpdated();
    });

    host.querySelector('.gi-announce')?.addEventListener('click', async () => {
      const t = window.prompt('群公告', g.announcement || '');
      if (t == null) return;
      g.announcement = t;
      await saveAndRefresh(g);
    });

    host.querySelector('.gi-plot')?.addEventListener('click', async () => {
      const t = window.prompt('剧情推进提示', g.plotDirective || '');
      if (t == null) return;
      g.plotDirective = t;
      await saveAndRefresh(g);
    });

    host.querySelector('.gi-observer-toggle')?.addEventListener('click', async () => {
      g.isObserverMode = !g.isObserverMode;
      chat.groupSettings = g;
      await db.put('chats', chat);
      close();
      navigate('group-chat', { chatId }, true);
    });

    host.querySelector('.gi-mute-all-toggle')?.addEventListener('click', async () => {
      g.allMuted = !g.allMuted;
      await saveAndRefresh(g);
    });

    host.querySelector('.gi-add-member')?.addEventListener('click', async () => {
      const name = window.prompt('输入要添加的角色名');
      if (!name) return;
      const found = CHARACTERS.find((c) =>
        c.name === name || c.id === name || (c.aliases || []).includes(name)
      );
      if (!found) { showToast('未找到该角色'); return; }
      if (!chat.participants.includes(found.id)) {
        chat.participants.push(found.id);
        const existing = await db.get('characters', found.id);
        if (!existing) await db.put('characters', { ...found });
        await db.put('chats', chat);
        await renderPanel();
        await onUpdated();
        showToast(`已添加 ${found.name}`);
      }
    });

    host.querySelector('.gi-kick')?.addEventListener('click', async () => {
      const name = window.prompt('要踢出的成员名');
      if (!name) return;
      const idx = parts.findIndex((id) => {
        const c = CHARACTERS.find((x) => x.id === id);
        return id === name || c?.name === name;
      });
      if (idx === -1) { showToast('未找到该成员'); return; }
      const kickId = parts[idx];
      chat.participants = chat.participants.filter((p) => p !== kickId);
      g.admins = (g.admins || []).filter((a) => a !== kickId);
      g.muted = (g.muted || []).filter((a) => a !== kickId);
      chat.groupSettings = g;
      await db.put('chats', chat);
      await renderPanel();
      await onUpdated();
    });

    host.querySelector('.gi-set-admin')?.addEventListener('click', async () => {
      const name = window.prompt('设为管理员的成员名');
      if (!name) return;
      const found = parts.find((id) => {
        const c = CHARACTERS.find((x) => x.id === id);
        return id === name || c?.name === name;
      });
      if (!found) { showToast('未找到该成员'); return; }
      g.admins = [...new Set([...(g.admins || []), found])];
      await saveAndRefresh(g);
    });

    host.querySelector('.gi-set-owner')?.addEventListener('click', async () => {
      const name = window.prompt('转让群主给');
      if (!name) return;
      const found = parts.find((id) => {
        const c = CHARACTERS.find((x) => x.id === id);
        return id === name || c?.name === name;
      });
      if (!found) { showToast('未找到该成员'); return; }
      g.owner = found;
      await saveAndRefresh(g);
    });

    host.querySelector('.gi-mute-one')?.addEventListener('click', async () => {
      const name = window.prompt('禁言成员名');
      if (!name) return;
      const found = parts.find((id) => {
        const c = CHARACTERS.find((x) => x.id === id);
        return id === name || c?.name === name;
      });
      if (!found) { showToast('未找到该成员'); return; }
      g.muted = [...new Set([...(g.muted || []), found])];
      await saveAndRefresh(g);
    });
  }

  host.classList.add('active');
  renderPanel();
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
  if (chat.type !== 'group') {
    container.innerHTML = `<div class="placeholder-page"><div class="placeholder-text">不是群聊会话</div><div class="placeholder-sub">请从群聊入口进入</div></div>`;
    return;
  }

  const members = getAiMembers(chat);
  if (!members.length) {
    container.innerHTML = `<div class="placeholder-page"><div class="placeholder-text">群内暂无 AI 角色</div><div class="placeholder-sub">请在群管理中添加成员</div></div>`;
    return;
  }

  let aiTurn = 0;
  const observerMode = !!chat.groupSettings?.isObserverMode;
  const currentUserIdRecord = await db.get('settings', 'currentUserId');
  const currentUser = currentUserIdRecord?.value ? await db.get('users', currentUserIdRecord.value) : null;

  const title = await chatTitle(chat);

  container.classList.add('chat-page');
  container.innerHTML = `
    <header class="navbar chat-header-custom">
      <button type="button" class="navbar-btn group-back-btn" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">${escapeHtml(title)}</h1>
      <button type="button" class="navbar-btn group-menu-btn" aria-label="群管理">${icon('settings')}</button>
    </header>
    <div class="chat-messages"></div>
    <div class="chat-tools-panel" style="display:none;">
      <div class="chat-tools-row">
        <button type="button" class="chat-tool-btn" data-tool="image"><span class="tool-icon">${icon('camera')}</span><span>图片</span></button>
        <button type="button" class="chat-tool-btn" data-tool="voice"><span class="tool-icon">${icon('voice')}</span><span>语音</span></button>
        <button type="button" class="chat-tool-btn" data-tool="emoji"><span class="tool-icon">${icon('sticker')}</span><span>表情</span></button>
        <button type="button" class="chat-tool-btn" data-tool="location"><span class="tool-icon">${icon('location')}</span><span>位置</span></button>
        <button type="button" class="chat-tool-btn" data-tool="ordershare"><span class="tool-icon">${icon('transfer')}</span><span>分享购物</span></button>
      </div>
      <div class="chat-sticker-picker" style="display:none;padding:8px 12px;max-height:min(56vh,480px);overflow-y:auto;overflow-x:hidden;"></div>
    </div>
    <div class="reply-bar" style="display:none;padding:6px 12px;font-size:var(--font-sm);background:var(--bg-input);border-top:1px solid var(--border);color:var(--text-secondary);"></div>
    <div class="chat-action-bar" style="${observerMode ? 'display:none;' : ''}">
      <button type="button" class="btn btn-outline group-advance-btn">${icon('advance', 'chat-action-icon')} 推进</button>
      <button type="button" class="btn btn-outline group-reroll-btn">${icon('reroll', 'chat-action-icon')} 重roll</button>
      <button type="button" class="btn btn-outline group-stop-btn">中止</button>
      <button type="button" class="btn btn-outline group-select-btn">多选</button>
      <button type="button" class="btn btn-outline group-delete-selected-btn" style="display:none;">删除已选</button>
    </div>
    <footer class="chat-input-bar" style="${observerMode ? 'display:none;' : ''}">
      <button type="button" class="navbar-btn chat-tools-toggle" aria-label="更多">${icon('plus')}</button>
      <textarea class="chat-input" rows="1" placeholder="发送消息…"></textarea>
      <button type="button" class="chat-send-btn" aria-label="发送">${icon('send')}</button>
    </footer>
    <div class="observer-bar" style="${observerMode ? 'display:flex;' : 'display:none;'}padding:10px 16px;padding-bottom:calc(10px + var(--safe-bottom));gap:8px;background:var(--glass-bg);border-top:1px solid var(--border);">
      <button type="button" class="observer-next" style="flex:1;padding:12px;background:var(--primary);color:var(--text-inverse);border-radius:var(--radius-md);font-weight:600;">下一句（AI 接龙）</button>
    </div>
    <input type="file" class="chat-image-input" accept="image/*" style="display:none;" />
  `;

  const messagesEl = container.querySelector('.chat-messages');
  const inputEl = container.querySelector('.chat-input');
  const sendBtn = container.querySelector('.chat-send-btn');
  const toolsPanel = container.querySelector('.chat-tools-panel');
  const stickerPicker = container.querySelector('.chat-sticker-picker');
  const toolsToggle = container.querySelector('.chat-tools-toggle');
  const replyBar = container.querySelector('.reply-bar');
  const advanceBtn = container.querySelector('.group-advance-btn');
  const rerollBtn = container.querySelector('.group-reroll-btn');
  const stopBtn = container.querySelector('.group-stop-btn');
  const selectBtn = container.querySelector('.group-select-btn');
  const deleteSelectedBtn = container.querySelector('.group-delete-selected-btn');
  const imageInput = container.querySelector('.chat-image-input');
  let replyTarget = null;
  let isStreaming = false;
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
      const label = normalized.senderId !== 'user' ? normalized.senderName || (await resolveName(normalized.senderId)) : '';
      const senderCharacter = normalized.senderId === 'user' ? currentUser : await resolveCharacter(normalized.senderId);
      const senderAvatarMarkup = avatarMarkup(senderCharacter, label || currentUser?.name || '我');
      const row = renderMessageRow(normalized, label, senderAvatarMarkup);
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
          if (observerMode) return;
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
      const ids = getAiMembers(chat).join(',');
      navigate('novel-mode', { chatId, characterIds: ids });
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

  async function ensurePrivateChatWith(characterId) {
    const allChats = await db.getAllByIndex('chats', 'userId', currentUser?.id || '');
    let chatItem = allChats.find((c) => c.type === 'private' && (c.participants || []).includes('user') && (c.participants || []).includes(characterId));
    if (chatItem) return chatItem;
    chatItem = {
      id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'private',
      userId: currentUser?.id || '',
      participants: ['user', characterId],
      groupSettings: {
        name: '',
        avatar: null,
        owner: null,
        admins: [],
        announcement: '',
        muted: [],
        allMuted: false,
        isObserverMode: false,
        plotDirective: '',
        allowPrivateTrigger: false,
      },
      lastMessage: '',
      lastActivity: Date.now(),
      unread: 0,
      autoActive: false,
      autoInterval: 300000,
      pinned: false,
    };
    await db.put('chats', chatItem);
    return chatItem;
  }

  async function persistPrivateFollowups(items) {
    for (const it of items) {
      if (!it.characterId || !it.content) continue;
      if (!chat.participants.includes(it.characterId)) continue;
      const targetChat = await ensurePrivateChatWith(it.characterId);
      const pm = createMessage({
        chatId: targetChat.id,
        senderId: it.characterId,
        senderName: await resolveName(it.characterId),
        type: 'text',
        content: it.content,
        metadata: { source: 'group-followup', fromGroupChatId: chatId },
      });
      await db.put('messages', pm);
      targetChat.lastMessage = it.content.slice(0, 80);
      targetChat.lastActivity = Date.now();
      await db.put('chats', targetChat);
    }
  }

  async function runAiTurn(speakingAsId, afterPersistUser, forcedRoundId = '') {
    const mlist = getAiMembers(chat);
    if (!mlist.includes(speakingAsId)) speakingAsId = mlist[aiTurn % mlist.length];

    isStreaming = true;
    currentAbortController = new AbortController();
    sendBtn.style.opacity = '0.5';
    if (advanceBtn) advanceBtn.style.opacity = '0.55';
    if (rerollBtn) rerollBtn.style.opacity = '0.55';

    const beforeAi = await db.getAllByIndex('messages', 'chatId', chatId);
    const sortedForApi = [...beforeAi].map(normalizeMessageForUi).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const aiRoundId = forcedRoundId || `gair_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    let payload = await messagesToApiPayload(chat, sortedForApi, speakingAsId);
    if (afterPersistUser === 'observer') {
      payload = [
        ...payload,
        { role: 'user', content: '[系统] 群聊继续，请作为你的角色自然接话，不要复述他人刚说过的话，可略作互动或推进话题。' },
      ];
    } else if (!sortedForApi.some((m) => m.senderId === 'user' && !m.deleted)) {
      payload = [
        ...payload,
        { role: 'user', content: '[系统] 当前群里无人发言，请你自然开一个符合场景和关系的话题，避免尴尬开场。' },
      ];
    }

    const aiMsg = createMessage({
      chatId,
      senderId: speakingAsId,
      senderName: await resolveName(speakingAsId),
      type: 'text',
      content: '',
      metadata: { aiRoundId },
    });
    await db.put('messages', aiMsg);
    await loadAndRenderMessages();
    showTypingIndicator(await resolveName(speakingAsId));

    const escId =
      typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(aiMsg.id) : aiMsg.id.replace(/"/g, '\\"');
    const aiRow = messagesEl.querySelector(`[data-msg-id="${escId}"]`);
    const bubbleEl = aiRow?.querySelector('.bubble');

    let full = '';
    try {
      await chatStream(
        payload,
        (_d, acc) => {
          full = acc;
          if (bubbleEl) bubbleEl.textContent = full;
          scrollMessagesToBottom(messagesEl);
        },
        { signal: currentAbortController.signal }
      );
      const cleaned = stripThinkingBlocks(full || '');
      const pmParsed = extractPrivateLines(cleaned);
      const season = (getState('currentUser')?.currentTimeline || 'S8');
      const lookup = await buildSpeakerLookup(chat, season);
      const blocks = parseSpeakerBlocks(pmParsed.publicText || '...', speakingAsId, lookup);
      await db.del('messages', aiMsg.id);
      const lastPublic = await persistGroupAiOutputBlocks(blocks, chatId, speakingAsId, aiRoundId);
      await loadAndRenderMessages();
      await persistChatPreview(lastPublic.slice(0, 80));
      if (chat.groupSettings?.allowPrivateTrigger && pmParsed.privateItems.length) {
        await persistPrivateFollowups(pmParsed.privateItems.slice(0, 3));
      }
    } catch (e) {
      if (String(e?.name || '').toLowerCase().includes('abort')) {
        const cleaned = stripThinkingBlocks(full || '');
        if (cleaned) {
          const pmParsed = extractPrivateLines(cleaned);
          const season = (getState('currentUser')?.currentTimeline || 'S8');
          const lookup = await buildSpeakerLookup(chat, season);
          const blocks = parseSpeakerBlocks(pmParsed.publicText || '...', speakingAsId, lookup);
          await db.del('messages', aiMsg.id);
          await persistGroupAiOutputBlocks(blocks, chatId, speakingAsId, aiRoundId);
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
      sendBtn.style.opacity = '1';
      if (advanceBtn) advanceBtn.style.opacity = '1';
      if (rerollBtn) rerollBtn.style.opacity = '1';
      scrollMessagesToBottom(messagesEl);
    }

    aiTurn = (mlist.indexOf(speakingAsId) + 1) % mlist.length;
  }

  await loadAndRenderMessages();

  container.querySelector('.group-back-btn')?.addEventListener('click', () => back());

  container.querySelector('.group-menu-btn')?.addEventListener('click', () => {
    navigate('chat-details', { chatId });
  });

  if (!observerMode) {
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
        if (kind === 'ordershare') {
          const plat = window.prompt('平台（如 淘宝、美团）', '美团');
          if (plat == null) return;
          const title = window.prompt('商品/套餐名称', '夜宵');
          if (title == null || !String(title).trim()) return;
          const price = window.prompt('价格', '¥58') || '';
          const note = window.prompt('备注（可空）', '') || '';
          const msg = createMessage({
            chatId,
            senderId: 'user',
            type: 'orderShare',
            content: String(title).trim(),
            metadata: {
              orderPlatform: String(plat).trim() || '购物',
              orderTitle: String(title).trim(),
              orderPrice: String(price).trim(),
              orderNote: String(note).trim(),
            },
          });
          await db.put('messages', msg);
          await persistChatPreview('[分享购物]');
          await loadAndRenderMessages();
        }
      });
    });
  }

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
    if (!trimmed || isStreaming || observerMode) return;
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

  if (!observerMode) {
    sendBtn.addEventListener('click', () => sendUserText(inputEl.value));
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendUserText(inputEl.value);
      }
    });
    advanceBtn?.addEventListener('click', async () => {
      if (isStreaming) return;
      const allMessages = await db.getAllByIndex('messages', 'chatId', chatId);
      const sorted = [...allMessages].map(normalizeMessageForUi).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      const lastUserMsg = [...sorted].reverse().find((m) => m.senderId === 'user' && !m.deleted);
      if (lastUserMsg) {
        const latestAfterUser = sorted.filter((m) => !m.deleted && (m.timestamp || 0) > (lastUserMsg.timestamp || 0));
        if (latestAfterUser.some((m) => m.senderId !== 'user' && !m.recalled)) {
          showToast('这一轮已经有人接话了，可以点重roll');
          return;
        }
      }
      const mlist = getAiMembers(chat);
      const speaker = mlist[aiTurn % mlist.length];
      await runAiTurn(speaker, false);
    });
    rerollBtn?.addEventListener('click', async () => {
      if (isStreaming) return;
      if (lastAiMessageId) {
        const scope = await db.getAllByIndex('messages', 'chatId', chatId);
        const latestAi = scope.find((m) => m.id === lastAiMessageId);
        const targetRoundId = latestAi?.metadata?.aiRoundId || lastAiRoundId || '';
        if (targetRoundId) {
          const toDelete = scope.filter((m) => m.senderId !== 'user' && m.metadata?.aiRoundId === targetRoundId);
          await Promise.all(toDelete.map((m) => db.del('messages', m.id)));
        } else {
          const allSorted = [...scope].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
          const lastUser = [...allSorted].reverse().find((m) => m.senderId === 'user' && !m.deleted);
          if (lastUser) {
            const toDelete = allSorted.filter((m) => m.senderId !== 'user' && (m.timestamp || 0) > (lastUser.timestamp || 0));
            await Promise.all(toDelete.map((m) => db.del('messages', m.id)));
          } else if (latestAi) {
            await db.del('messages', latestAi.id);
          }
        }
        await loadAndRenderMessages();
      }
      const mlist = getAiMembers(chat);
      const previousIndex = aiTurn === 0 ? mlist.length - 1 : aiTurn - 1;
      const speaker = mlist[Math.max(previousIndex, 0)];
      await runAiTurn(speaker, false);
    });
    stopBtn?.addEventListener('click', () => {
      if (currentAbortController) currentAbortController.abort();
    });
    selectBtn?.addEventListener('click', async () => {
      selecting = !selecting;
      selectedIds.clear();
      deleteSelectedBtn.style.display = selecting ? 'inline-flex' : 'none';
      await loadAndRenderMessages();
    });
    deleteSelectedBtn?.addEventListener('click', async () => {
      if (!selectedIds.size) return;
      await Promise.all([...selectedIds].map((id) => db.del('messages', id)));
      selectedIds.clear();
      selecting = false;
      deleteSelectedBtn.style.display = 'none';
      await loadAndRenderMessages();
    });
  }

  container.querySelector('.observer-next')?.addEventListener('click', async () => {
    if (!observerMode || isStreaming) return;
    const mlist = getAiMembers(chat);
    const speaker = mlist[aiTurn % mlist.length];
    await runAiTurn(speaker, 'observer');
  });
}
