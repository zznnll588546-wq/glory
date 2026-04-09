/**
 * 微博/论坛等「生成后转发进聊天」共用：按 AI 输出的 chatShares 落库，
 * 避免角色在其不在的群内以第一人称发言。
 */
import * as db from './db.js';
import { createMessage } from '../models/chat.js';
import { CHARACTERS } from '../data/characters.js';
import { getVirtualNow } from './virtual-time.js';

export async function getUserChatsForRelay(userId) {
  if (!userId) return [];
  return (await db.getAllByIndex('chats', 'userId', userId))
    .filter((c) => (c.groupSettings?.allowSocialLinkage ?? true))
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
}

export async function normalizeAuthorIdentity(authorIdRaw, authorNameRaw) {
  const idRaw = String(authorIdRaw || '').trim();
  const nameRaw = String(authorNameRaw || '').trim();
  const allStored = await db.getAll('characters');
  const merged = [...CHARACTERS, ...allStored];
  const byId = merged.find((c) => c?.id && c.id === idRaw);
  if (byId) return { id: byId.id, name: byId.name || nameRaw || byId.id, isKnown: true };
  const byName = merged.find((c) =>
    c?.name === nameRaw || c?.realName === nameRaw || c?.customNickname === nameRaw || (c?.aliases || []).includes(nameRaw)
  );
  if (byName) return { id: byName.id, name: byName.name || nameRaw || byName.id, isKnown: true };
  return { id: '', name: nameRaw || idRaw || '匿名用户', isKnown: false };
}

export async function findOrCreatePrivateChat(userId, actorId) {
  if (!userId || !actorId) return null;
  const staticHit = CHARACTERS.find((c) => c.id === actorId);
  const storedHit = await db.get('characters', actorId);
  if (!staticHit && !storedHit) return null;
  const all = await getUserChatsForRelay(userId);
  const found = all.find((c) => c.type === 'private' && (c.participants || []).includes('user') && (c.participants || []).includes(actorId));
  if (found) return found;
  const chat = {
    id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'private',
    userId,
    participants: ['user', actorId],
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
      allowSocialLinkage: true,
      allowWrongSend: true,
      allowAiOfflineInvite: false,
    },
    lastMessage: '',
    lastActivity: await getVirtualNow(userId || '', 0),
    unread: 0,
    autoActive: false,
    autoInterval: 300000,
    pinned: false,
  };
  await db.put('chats', chat);
  return chat;
}

export function findGroupChatByNameHint(chats, nameHint, requireForwarderId) {
  const hint = String(nameHint || '').trim();
  if (!hint) return null;
  const groups = chats.filter((c) => c.type === 'group' && (c.participants || []).includes('user'));
  const ok = (c) => !requireForwarderId || (c.participants || []).includes(requireForwarderId);
  const exact = groups.find((c) => (c.groupSettings?.name || '') === hint);
  if (exact && ok(exact)) return exact;
  const partial = groups.find(
    (c) =>
      ok(c)
      && ((c.groupSettings?.name || '').includes(hint) || hint.includes(c.groupSettings?.name || '')),
  );
  return partial || null;
}

export function findGroupChatByNameHintUserOnly(chats, nameHint) {
  const hint = String(nameHint || '').trim();
  if (!hint) return null;
  const groups = chats.filter((c) => c.type === 'group' && (c.participants || []).includes('user'));
  return (
    groups.find((c) => (c.groupSettings?.name || '') === hint)
    || groups.find(
      (c) => (c.groupSettings?.name || '').includes(hint) || hint.includes(c.groupSettings?.name || ''),
    )
    || null
  );
}

export function normalizeChatShareFromAi(raw = {}) {
  const lines = Array.isArray(raw.lines)
    ? raw.lines.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6)
    : [];
  return {
    postIndex: Math.max(0, Math.floor(Number(raw.postIndex ?? 0))),
    forwarderId: String(raw.forwarderId || '').trim(),
    forwarderName: String(raw.forwarderName || '').trim(),
    targetType: String(raw.targetType || 'private_user').toLowerCase().replace(/\s+/g, '_'),
    groupName: String(raw.groupName || '').trim(),
    wrongGroupName: String(raw.wrongGroupName || '').trim(),
    wrongSend: !!raw.wrongSend,
    recallLink: !!raw.recallLink,
    lines,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.userId
 * @param {unknown} opts.chatShares
 * @param {Array<{ id: string }>} opts.relayItems
 * @param {number} opts.virtualNow
 * @param {object} opts.relaySpec
 * @param {string} opts.relaySpec.urlScheme - e.g. 'weibo' | 'forum'
 * @param {string} opts.relaySpec.sourceLabel
 * @param {string} opts.relaySpec.lastMessagePreview
 * @param {(item: object, forwarderDisplayName: string) => string} opts.relaySpec.linkTitle
 * @param {(item: object) => string} opts.relaySpec.linkDesc
 * @param {(item: object, forwarderDisplayName: string) => object} [opts.relaySpec.extraLinkMetadata]
 */
export async function applyGeneratedChatShares({
  userId,
  chatShares,
  relayItems,
  virtualNow,
  relaySpec,
}) {
  if (!userId || !relayItems.length) return;
  const list = (Array.isArray(chatShares) ? chatShares : []).slice(0, 2).map(normalizeChatShareFromAi);
  const shares = list.filter((s) => s.forwarderId || s.forwarderName);
  if (!shares.length) return;

  const {
    urlScheme,
    sourceLabel,
    lastMessagePreview,
    linkTitle,
    linkDesc,
    extraLinkMetadata,
  } = relaySpec;
  if (!urlScheme || !sourceLabel) return;

  const all = await getUserChatsForRelay(userId);
  let tick = Number(virtualNow || (await getVirtualNow(userId, 0)));

  try {
    for (const sh of shares) {
      const item = relayItems[Math.min(sh.postIndex, relayItems.length - 1)];
      if (!item?.id) continue;
      const who = await normalizeAuthorIdentity(sh.forwarderId, sh.forwarderName);
      const fid = who.id;
      if (!fid) continue;
      const fname = who.name || sh.forwarderName || '角色';

      const isGroupTarget =
        sh.targetType === 'group'
        || sh.targetType === 'group_chat'
        || sh.targetType === '群'
        || sh.targetType === '群聊';
      let intended = null;
      if (isGroupTarget) {
        intended = findGroupChatByNameHint(all, sh.groupName, fid);
      } else {
        intended = await findOrCreatePrivateChat(userId, fid);
      }
      if (!intended) continue;

      let linkChat = intended;
      if (sh.wrongSend && sh.wrongGroupName) {
        const wrong = findGroupChatByNameHintUserOnly(all, sh.wrongGroupName);
        if (wrong && wrong.id !== intended.id) linkChat = wrong;
      }

      const parts = linkChat.participants || [];
      const forwarderInLink = linkChat.type !== 'group' || parts.includes(fid);

      const extraMeta = typeof extraLinkMetadata === 'function' ? extraLinkMetadata(item, fname) : {};

      const linkMsg = createMessage({
        chatId: linkChat.id,
        senderId: forwarderInLink ? fid : 'system',
        senderName: forwarderInLink ? fname : '',
        type: 'link',
        content: `${urlScheme}://${item.id}`,
        timestamp: tick++,
        metadata: {
          title: linkTitle(item, fname),
          desc: String(linkDesc(item) || '').slice(0, 80),
          source: sourceLabel,
          fromSocialRelay: true,
          relayForwarderId: fid,
          relayForwarderName: fname,
          wrongRelay: sh.wrongSend && linkChat.id !== intended.id,
          ...(forwarderInLink ? {} : { relaySystemNote: `${fname}似乎把链接发到了本群` }),
          ...extraMeta,
        },
      });
      await db.put('messages', linkMsg);

      const textMeta = { fromSocialRelay: true, relaySource: sourceLabel, ...extraMeta };

      if (sh.recallLink && forwarderInLink) {
        linkMsg.recalled = true;
        linkMsg.metadata = { ...(linkMsg.metadata || {}), recalledContent: linkMsg.content };
        await db.put('messages', linkMsg);
        await db.put('messages', createMessage({
          chatId: linkChat.id,
          senderId: 'system',
          type: 'system',
          content: `${fname} 撤回了一条${sourceLabel}链接`,
          timestamp: tick++,
        }));
      } else if (forwarderInLink) {
        for (const line of sh.lines) {
          await db.put('messages', createMessage({
            chatId: linkChat.id,
            senderId: fid,
            senderName: fname,
            type: 'text',
            content: line,
            timestamp: tick++,
            metadata: { ...textMeta },
          }));
        }
      } else {
        for (const line of sh.lines) {
          await db.put('messages', createMessage({
            chatId: intended.id,
            senderId: fid,
            senderName: fname,
            type: 'text',
            content: line,
            timestamp: tick++,
            metadata: { ...textMeta, relaySpokenInIntendedChat: true },
          }));
        }
      }

      const bump = async (c) => {
        if (!c?.id) return;
        const row = await db.get('chats', c.id);
        if (!row) return;
        row.lastMessage = lastMessagePreview;
        row.lastActivity = tick;
        await db.put('chats', row);
      };
      await bump(linkChat);
      if (intended.id !== linkChat.id) await bump(intended);
    }
  } catch (e) {
    console.warn('applyGeneratedChatShares', e);
  }
}
