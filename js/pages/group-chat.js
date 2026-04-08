/**
 * Group chat window: multi-speaker bubbles, management modal, observer mode, AI round-robin.
 * Private one-on-one UI lives in `./chat-window.js`.
 */
export { default as renderPrivateChatWindow } from './chat-window.js';

import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { chatStream } from '../core/api.js';
import { assembleContext } from '../core/context.js';
import { createChat, createMessage } from '../models/chat.js';
import { CHARACTERS } from '../data/characters.js';
import { TEAMS } from '../data/teams.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { maybeSummarizeChatMemory } from '../core/chat-summary.js';
import { allocateVirtualTimestamps } from '../core/virtual-time.js';
import { getVirtualNow } from '../core/virtual-time.js';
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
  const uid = (await db.get('settings', 'currentUserId'))?.value || '';
  const virtualNow = await getVirtualNow(uid, Date.now());
  const d = new Date(virtualNow);
  const vhm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const plot = (chat.groupSettings?.plotDirective || '').trim();
  const allowPrivateTrigger = !!chat.groupSettings?.allowPrivateTrigger;
  return [
    '你在进行中文群聊角色扮演；你需要同时扮演多个角色并让他们互相接话。',
    `本群参与者（含你）：${names.join('、') || '（待定）'}`,
    `成员ID映射：${members.map((id, i) => `${id}=${names[i] || id}`).join('；')}`,
    `当前世界时间（非现实系统时间）：${vhm}；时间表达必须按该时间判断，不要白天说“深夜该睡了”。`,
    '口语歧义处理：用户说“差一点/发晕一点/一点点”默认理解为程度，不要擅自解释成凌晨1点等具体时刻。',
    plot ? `剧情/气氛提示：${plot}` : '',
    '表达要求：自然口语、短句、可有情绪停顿；避免书面逻辑连接词堆叠；可结合身份切换正式/私下语气。',
    '当群聊冷场时，你可以主动抛出一个新话题推进剧情。',
    '每轮可输出任意数量群消息（按剧情自然决定），至少包含2个不同角色，且角色之间要有连续互动。',
    '群消息格式必须逐行使用：[角色名] 内容（[角色名] 与正文之间不要再用 : 重复写一遍名字）',
    '禁止在正文前额外加 [角色名]: 前缀；心声只放在该行末尾用 [心声]: 短句，勿把 [心声] 当正文展示',
    '如需引用上一条消息，使用格式：[回复:消息片段] 你的发言',
    '表情包按情绪自然使用，避免刷屏；若使用请单独一行：优先带完整图片URL；仅有 [表情包:名称] 时名称贴近导入包内标题/文件名；无URL时会就近匹配或随机抽选避免总出同一张',
    '分享礼物/点外卖/下单为低频行为：仅在剧情非常合适时偶尔使用，且单独一行 [分享购物:平台|商品名|价格|短备注]；若无明显触发条件，本轮不要输出该标签',
    '每行只写一句或一个短段，不要把多句合成超长一行。',
    '若要输出角色心理，可在对应行末尾追加 [心声]: 内容（简短）。',
    '关系边界：默认禁止家长式说教/管教，不要反复训诫作息饮食等小事；优先玩笑、陪伴、邀请、协商。',
    allowPrivateTrigger
      ? '你可以在消息末尾追加1-3行私聊片段，格式必须是 [[PM:角色ID]] 内容。仅使用群成员角色ID，不要写用户ID。'
      : '',
    chat.groupSettings?.allowAiOfflineInvite
      ? '本群已开启「线下邀约」：可由某一角色单独一行输出 [线下邀约:地点或事由]，该行须以 [角色名] 开头与其他消息一致，且该行除该标签外不要长篇解释。'
      : '',
    chat.groupSettings?.allowAiGroupOps
      ? '本群已开启「AI群管理权限」：如需拉群/邀请/禁言，可单独输出控制行 [群操作:动作|参数A|参数B]。动作仅限：创建群、邀请入群、禁言、解除禁言。示例：[群操作:创建群|训练复盘群|huangshaotian,wangjiexi]。若要创建“无用户小群”，可写动作“创建群无用户”或在参数B追加 nouser。允许按关系网临场拉“惊喜筹备群/吐槽群/暗恋群/二人小窗”等。该控制行不要夹杂其他正文。另可使用 [社交联动:动作|目标|内容|参数]，动作可用发言/错发/跳群，参数可写邀请user/撤回/无用户。'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function parseAiGroupOps(rawText = '') {
  const text = String(rawText || '');
  const out = [];
  const re = /\[群操作[:：]\s*([^\]]+)\]/g;
  let m;
  while ((m = re.exec(text))) {
    const parts = String(m[1] || '').split('|').map((s) => s.trim());
    if (!parts[0]) continue;
    out.push({
      action: parts[0],
      argA: parts[1] || '',
      argB: parts.slice(2).join('|') || '',
      raw: m[0],
    });
  }
  return out;
}

function stripAiGroupOpsTags(text = '') {
  return String(text || '').replace(/\[群操作[:：]\s*[^\]]+\]/g, '').trim();
}

function inferGroupOpsFromIntent(text = '', actorId = '', season = 'S8') {
  const t = String(text || '');
  if (!t || /\[群操作[:：]/.test(t)) return [];
  if (!/(拉你进群|拉你进|进群|加群|拉群|战队群|职业群|同期群|训练群)/.test(t)) return [];
  const actor = CHARACTERS.find((c) => c.id === actorId);
  const state = actor ? getCharacterStateForSeason(actor, season) : null;
  const team = state?.team || '';
  let groupName = `${team || '战队'}战队群`;
  if (/职业群/.test(t)) groupName = '职业选手群';
  else if (/同期群/.test(t)) groupName = '同期选手群';
  else if (/训练群/.test(t)) groupName = `${team || '战队'}训练群`;
  return [{ action: '创建群', argA: groupName, argB: '' }];
}

function buildTeamGroupProfile(groupName = '', season = 'S8') {
  const name = String(groupName || '').trim();
  if (!name || !/战队群/.test(name)) return null;
  const teamId = Object.keys(TEAMS).find((tid) => {
    const n = getDisplayTeamName(tid);
    return n && name.includes(n);
  });
  if (!teamId) return null;
  const members = CHARACTERS
    .filter((c) => getCharacterStateForSeason(c, season)?.team === teamId)
    .map((c) => c.id);
  const owner = CHARACTERS.find((c) => {
    const s = getCharacterStateForSeason(c, season);
    return s?.team === teamId && /队长/.test(String(s.role || ''));
  })?.id || '';
  const admins = CHARACTERS
    .filter((c) => {
      const s = getCharacterStateForSeason(c, season);
      return s?.team === teamId && /副队/.test(String(s.role || ''));
    })
    .map((c) => c.id);
  return {
    teamId,
    participants: [...new Set(['user', ...members])],
    owner,
    admins: [...new Set(admins)],
  };
}

async function isAiOpsDebugEnabled() {
  const row = await db.get('settings', 'aiOpsDebugEnabled');
  return !!row?.value;
}

async function saveAiDebugSnapshot(chatId, patch = {}) {
  if (!chatId) return;
  const key = `aiDebugSnapshot_${chatId}`;
  const prev = (await db.get('settings', key))?.value || {};
  await db.put('settings', {
    key,
    value: {
      ...prev,
      ...patch,
      savedAt: Date.now(),
      page: 'group-chat',
    },
  });
}

function parseAiSocialOps(rawText = '') {
  const text = String(rawText || '');
  const out = [];
  const re = /\[社交联动[:：]\s*([^|\]]+)\|([^|\]]*)\|([^|\]]*)\|([^\]]*)\]/g;
  let m;
  while ((m = re.exec(text))) {
    out.push({
      action: String(m[1] || '').trim(),
      target: String(m[2] || '').trim(),
      content: String(m[3] || '').trim(),
      extra: String(m[4] || '').trim(),
    });
  }
  return out;
}

function stripAiSocialOpsTags(text = '') {
  return String(text || '').replace(/\[社交联动[:：]\s*[^|\]]+\|[^|\]]*\|[^|\]]*\|[^\]]*\]/g, '').trim();
}

function parseMemberTokens(raw = '') {
  return String(raw || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

function opNeedsNoUser(op) {
  const act = String(op?.action || '');
  const b = String(op?.argB || '').toLowerCase();
  return act.includes('无用户') || b.includes('nouser') || b.includes('!user') || b.includes('-user');
}

function parseGroupNameAndTags(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return { name: '新群聊', tags: [] };
  const parts = s.split('#');
  const name = (parts[0] || '新群聊').trim() || '新群聊';
  const tagRaw = parts.slice(1).join('#');
  const tags = [...new Set(tagRaw.split(/[、,，|/\s]+/).map((x) => x.trim()).filter(Boolean))].slice(0, 6);
  const extra = [];
  const low = s.toLowerCase();
  if (/pvp/.test(low)) extra.push('PVP');
  if (/竞争|pk|solo|对抗/.test(s)) extra.push('竞争');
  if (/吐槽|蛐蛐|八卦/.test(s)) extra.push('吐槽');
  if (/惊喜|筹备|策划/.test(s)) extra.push('惊喜');
  if (/暗恋|痴汉|心动/.test(s)) extra.push('暗恋');
  return { name, tags: [...new Set([...tags, ...extra])].slice(0, 6) };
}

function isLegacyGroupName(name = '') {
  const n = String(name || '');
  return /战队群|职业群|同期群|训练群/.test(n);
}

async function resolveCharacterIdFlexible(input) {
  const v = String(input || '').trim();
  if (!v) return '';
  if (v === 'user' || v === '我') return 'user';
  const byId = CHARACTERS.find((c) => c.id === v) || (await db.get('characters', v));
  if (byId?.id) return byId.id;
  const all = await db.getAll('characters');
  const byName = CHARACTERS.find((c) => c.name === v || c.realName === v || (c.aliases || []).includes(v))
    || all.find((c) => c.name === v || c.realName === v || c.customNickname === v || (c.aliases || []).includes(v));
  return byName?.id || '';
}

async function executeAiGroupOps({ ops = [], actorId = '', sourceChat = null, currentUserId = '' }) {
  if (!ops.length || !sourceChat || !currentUserId) return [];
  const logs = [];
  const userChats = await db.getAllByIndex('chats', 'userId', currentUserId);
  const currentUserName = (await db.get('users', currentUserId))?.name || '';
  const season = getState('currentUser')?.currentTimeline || 'S8';
  for (const op of ops.slice(0, 3)) {
    const act = op.action;
    if (act.includes('创建群') || act.includes('拉群')) {
      const parsed = parseGroupNameAndTags(op.argA);
      const teamProfile = buildTeamGroupProfile(parsed.name, season);
      const memberIdsRaw = parseMemberTokens(op.argB).filter((x) => !/^(!?user|-user|nouser)$/i.test(x));
      const memberIds = [];
      for (const raw of memberIdsRaw) {
        const id = await resolveCharacterIdFlexible(raw);
        if (id && id !== 'user') memberIds.push(id);
      }
      const includeUser = !opNeedsNoUser(op);
      const participants = includeUser
        ? [...new Set(['user', actorId, ...memberIds].filter(Boolean))]
        : [...new Set([actorId, ...memberIds].filter(Boolean))];
      if (includeUser && teamProfile) {
        participants.splice(0, participants.length, ...teamProfile.participants);
      }
      if (includeUser && participants.filter((x) => x !== 'user').length < 2) {
        const actor = CHARACTERS.find((c) => c.id === actorId) || await db.get('characters', actorId);
        const actorTeam = actor ? getCharacterStateForSeason(actor, season)?.team : '';
        const fallback = CHARACTERS
          .filter((c) => c.id !== actorId && c.id !== 'user' && !participants.includes(c.id))
          .find((c) => getCharacterStateForSeason(c, season)?.team && getCharacterStateForSeason(c, season)?.team === actorTeam)
          || CHARACTERS.find((c) => c.id !== actorId && c.id !== 'user' && !participants.includes(c.id));
        if (fallback?.id) participants.push(fallback.id);
      }
      if (participants.filter((x) => x !== 'user').length < 2) continue;
      const existing = userChats.find((c) => c.type === 'group' && (c.groupSettings?.name || '') === parsed.name);
      if (existing) {
        if (teamProfile) {
          existing.participants = [...new Set([...(existing.participants || []), ...teamProfile.participants])];
          const gse = existing.groupSettings || {};
          gse.owner = teamProfile.owner || gse.owner || actorId || '';
          gse.admins = [...new Set([...(gse.admins || []), ...teamProfile.admins])];
          existing.groupSettings = gse;
          await db.put('chats', existing);
        }
        const alreadyIn = (existing.participants || []).includes('user');
        logs.push(includeUser ? `沿用已有群「${parsed.name}」并准备拉你入群` : `沿用已有群「${parsed.name}」`);
        if (includeUser && !alreadyIn) {
          await db.put('messages', createMessage({
            chatId: sourceChat.id,
            senderId: actorId || 'npc',
            senderName: await resolveName(actorId),
            type: 'groupInvite',
            content: `邀请你加入群聊：${parsed.name}`,
            metadata: {
              targetChatId: existing.id,
              groupName: parsed.name,
              inviterId: actorId || '',
              inviteState: 'pending',
              existingGroup: true,
            },
          }));
        } else {
          await db.put('messages', createMessage({
            chatId: sourceChat.id,
            senderId: 'system',
            type: 'system',
            content: includeUser
              ? `你已在已有群「${parsed.name}」中`
              : `${await resolveName(actorId)} 在已有群「${parsed.name}」发起小群协作`,
            metadata: { linkageGoal: (sourceChat.lastMessage || '').slice(0, 80), linkedTargetChatId: existing.id },
          }));
        }
        continue;
      }
      const chat = createChat({
        type: 'group',
        userId: currentUserId,
        participants: includeUser ? participants : participants,
        groupSettings: {
          name: parsed.name || '新群聊',
          avatar: null,
          owner: teamProfile?.owner || actorId || '',
          admins: teamProfile ? teamProfile.admins : (actorId ? [actorId] : []),
          announcement: '',
          muted: [],
          allMuted: false,
          isObserverMode: false,
          plotDirective: '',
          allowPrivateTrigger: false,
          allowSocialLinkage: true,
          linkageMode: 'notify',
          allowWrongSend: true,
          allowPrivateMentionLinkage: true,
          allowAiOfflineInvite: false,
          allowAiGroupOps: true,
          useCustomLinkageTargets: false,
          linkageTargetGroupIds: [],
          linkagePrivateMemberIds: [],
          groupThemeTags: parsed.tags,
          groupOrigin: 'dynamic',
        },
      });
      await db.put('chats', chat);
      const legacyLike = isLegacyGroupName(parsed.name);
      if (!legacyLike) {
        await db.put('messages', createMessage({
          chatId: chat.id,
          senderId: 'system',
          type: 'system',
          content: `群已创建：${parsed.name || '新群聊'}（发起人：${await resolveName(actorId)}）`,
        }));
      }
      if (includeUser && sourceChat?.id) {
        await db.put('messages', createMessage({
          chatId: sourceChat.id,
          senderId: actorId || 'npc',
          senderName: await resolveName(actorId),
          type: 'groupInvite',
          content: `邀请你加入群聊：${parsed.name || '新群聊'}`,
          metadata: {
            targetChatId: chat.id,
            groupName: parsed.name || '新群聊',
            inviterId: actorId || '',
            inviteState: 'pending',
            existingGroup: false,
          },
        }));
      }
      logs.push(legacyLike && includeUser ? `已发起加入「${parsed.name || '群聊'}」邀请` : `已创建群「${parsed.name || '新群聊'}」`);
      continue;
    }
    if (act.includes('邀请')) {
      let target = userChats.find((c) => c.type === 'group' && (c.id === op.argA || c.groupSettings?.name === op.argA));
      const teamProfile = buildTeamGroupProfile(op.argA || '', season);
      if (!target && op.argA) {
        target = createChat({
          type: 'group',
          userId: currentUserId,
          participants: teamProfile
            ? [...new Set(teamProfile.participants.filter((p) => p !== 'user'))]
            : [...new Set([actorId].filter(Boolean))],
          groupSettings: {
            name: op.argA || '新群聊',
            avatar: null,
            owner: teamProfile?.owner || actorId || '',
            admins: teamProfile ? teamProfile.admins : (actorId ? [actorId] : []),
            announcement: '',
            muted: [],
            allMuted: false,
            isObserverMode: false,
            plotDirective: '',
            allowPrivateTrigger: false,
            allowSocialLinkage: true,
            linkageMode: 'notify',
            allowWrongSend: true,
            allowPrivateMentionLinkage: true,
            allowAiOfflineInvite: false,
            allowAiGroupOps: true,
            useCustomLinkageTargets: false,
            linkageTargetGroupIds: [],
            linkagePrivateMemberIds: [],
            groupThemeTags: [],
            groupOrigin: 'dynamic',
          },
        });
        await db.put('chats', target);
      }
      if (!target || target.type !== 'group') continue;
      if (teamProfile) {
        target.participants = [...new Set([...(target.participants || []), ...teamProfile.participants.filter((p) => p !== 'user')])];
        const gst = target.groupSettings || {};
        gst.owner = teamProfile.owner || gst.owner || actorId || '';
        gst.admins = [...new Set([...(gst.admins || []), ...teamProfile.admins])];
        target.groupSettings = gst;
        await db.put('chats', target);
      }
      const who = String(op.argB || '').trim();
      const whoNorm = who.toLowerCase();
      const wantsUser =
        who === 'user' ||
        who === '我' ||
        who === currentUserId ||
        whoNorm === String(currentUserId || '').toLowerCase() ||
        (currentUserName && who === currentUserName);
      if (wantsUser) {
        if (sourceChat?.id && !(target.participants || []).includes('user')) {
          await db.put('messages', createMessage({
            chatId: sourceChat.id,
            senderId: actorId || 'npc',
            senderName: await resolveName(actorId),
            type: 'groupInvite',
            content: `邀请你加入群聊：${target.groupSettings?.name || op.argA || '群聊'}`,
            metadata: {
              targetChatId: target.id,
              groupName: target.groupSettings?.name || op.argA || '群聊',
              inviterId: actorId || '',
              inviteState: 'pending',
              existingGroup: true,
            },
          }));
          logs.push(`已向你发起加入「${target.groupSettings?.name || op.argA || '群聊'}」邀请`);
        } else if ((target.participants || []).includes('user')) {
          logs.push(`你已在「${target.groupSettings?.name || op.argA || '群聊'}」中`);
        }
        continue;
      }
      const id = await resolveCharacterIdFlexible(op.argB);
      if (!id || id === 'user') {
        logs.push(`邀请失败：未识别成员「${op.argB || ''}」`);
        continue;
      }
      if (!target.participants.includes(id)) {
        target.participants.push(id);
        await db.put('chats', target);
      }
      await db.put('messages', createMessage({
        chatId: target.id,
        senderId: 'system',
        type: 'system',
        content: `${await resolveName(actorId)} 邀请 ${await resolveName(id)} 入群`,
      }));
      logs.push(`已邀请 ${await resolveName(id)} 入群`);
      continue;
    }
    const target = userChats.find((c) => c.type === 'group' && (c.id === op.argA || c.groupSettings?.name === op.argA)) || sourceChat;
    if (!target || target.type !== 'group') continue;
    if (act.includes('禁言') || act.includes('解除禁言')) {
      const id = await resolveCharacterIdFlexible(op.argB);
      if (!id || id === 'user') continue;
      const gs = target.groupSettings || {};
      gs.muted = Array.isArray(gs.muted) ? gs.muted : [];
      if (act.includes('解除')) gs.muted = gs.muted.filter((x) => x !== id);
      else gs.muted = [...new Set([...gs.muted, id])];
      target.groupSettings = gs;
      await db.put('chats', target);
      await db.put('messages', createMessage({
        chatId: target.id,
        senderId: 'system',
        type: 'system',
        content: `${await resolveName(actorId)} ${act.includes('解除') ? '解除禁言' : '禁言'}了 ${await resolveName(id)}`,
      }));
      logs.push(`${act.includes('解除') ? '解除禁言' : '禁言'} ${await resolveName(id)}`);
    }
  }
  return logs;
}

async function pickLinkedMembers(actorId, limit = 2) {
  const stored = await db.get('characters', actorId);
  const base = CHARACTERS.find((c) => c.id === actorId);
  const actor = { ...(base || {}), ...(stored || {}) };
  const rel = Object.keys(actor.relationships || {}).filter((id) => id && id !== actorId && id !== 'user');
  return rel.slice(0, limit);
}

async function executeAiSocialOps({ ops = [], actorId = '', sourceChat = null, currentUserId = '' }) {
  if (!ops.length || !actorId || !sourceChat || !currentUserId) return [];
  const logs = [];
  const userChats = await db.getAllByIndex('chats', 'userId', currentUserId);
  for (const op of ops.slice(0, 3)) {
    const targetSpec = op.target;
    const content = op.content;
    const extra = op.extra;
    if (!content) continue;
    const includeUser = /邀请user|includeUser|withUser|含user|拉你/i.test(extra);
    const needRecall = /撤回|recall|错发/i.test(extra) || op.action.includes('错发');

    if (targetSpec.startsWith('私聊:')) {
      const targetId = await resolveCharacterIdFlexible(targetSpec.slice('私聊:'.length));
      if (!targetId || targetId === 'user') continue;
      const dm = await ensurePrivateChatWith(targetId);
      const msg = createMessage({
        chatId: dm.id,
        senderId: actorId,
        senderName: await resolveName(actorId),
        type: 'text',
        content,
        metadata: { aiSocialOp: true, fromChatId: sourceChat.id },
      });
      await db.put('messages', msg);
      dm.lastMessage = content.slice(0, 80);
      dm.lastActivity = await getVirtualNow(currentUserId || '', Date.now());
      await db.put('chats', dm);
      logs.push(`已私聊 ${await resolveName(targetId)}`);
      continue;
    }

    let targetGroup = userChats.find((c) => c.type === 'group' && (c.id === targetSpec || c.groupSettings?.name === targetSpec));
    if (!targetGroup) {
      const name = targetSpec || '临时群';
      const linked = await pickLinkedMembers(actorId, 2);
      const participants = includeUser
        ? ['user', actorId, ...linked].filter(Boolean)
        : [actorId, ...linked].filter(Boolean);
      if (participants.filter((x) => x !== 'user').length < 2) continue;
      targetGroup = createChat({
        type: 'group',
        userId: currentUserId,
        participants: includeUser ? participants : participants,
        groupSettings: {
          name,
          avatar: null,
          owner: actorId,
          admins: [actorId],
          announcement: '',
          muted: [],
          allMuted: false,
          isObserverMode: !includeUser,
          plotDirective: includeUser ? '社交联动临时群' : '社交联动无用户群',
          allowPrivateTrigger: false,
          allowSocialLinkage: true,
          linkageMode: 'notify',
          allowWrongSend: true,
          allowPrivateMentionLinkage: true,
          allowAiOfflineInvite: false,
          allowAiGroupOps: true,
          useCustomLinkageTargets: false,
          linkageTargetGroupIds: [],
          linkagePrivateMemberIds: [],
          groupThemeTags: ['联动'],
          groupOrigin: 'dynamic',
        },
      });
      await db.put('chats', targetGroup);
      if (includeUser && sourceChat?.id) {
        await db.put('messages', createMessage({
          chatId: sourceChat.id,
          senderId: actorId,
          senderName: await resolveName(actorId),
          type: 'groupInvite',
          content: `邀请你加入群聊：${name}`,
          metadata: { targetChatId: targetGroup.id, groupName: name, inviterId: actorId, inviteState: 'pending', existingGroup: false },
        }));
      }
    } else if (includeUser && sourceChat?.id && !(targetGroup.participants || []).includes('user')) {
      await db.put('messages', createMessage({
        chatId: sourceChat.id,
        senderId: actorId,
        senderName: await resolveName(actorId),
        type: 'groupInvite',
        content: `邀请你加入群聊：${targetGroup.groupSettings?.name || '群聊'}`,
        metadata: { targetChatId: targetGroup.id, groupName: targetGroup.groupSettings?.name || '群聊', inviterId: actorId, inviteState: 'pending', existingGroup: true },
      }));
    }

    const msg = createMessage({
      chatId: targetGroup.id,
      senderId: actorId,
      senderName: await resolveName(actorId),
      type: 'text',
      content,
      metadata: { aiSocialOp: true, fromChatId: sourceChat.id },
    });
    await db.put('messages', msg);
    if (needRecall) {
      msg.recalled = true;
      msg.metadata = { ...(msg.metadata || {}), recalledContent: msg.content };
      await db.put('messages', msg);
      await db.put('messages', createMessage({
        chatId: targetGroup.id,
        senderId: 'system',
        type: 'system',
        content: `${await resolveName(actorId)} 撤回了一条消息`,
      }));
    }
    targetGroup.lastMessage = needRecall ? '[已撤回]' : content.slice(0, 80);
    targetGroup.lastActivity = await getVirtualNow(currentUserId || '', Date.now());
    await db.put('chats', targetGroup);
    logs.push(`已联动到${targetGroup.groupSettings?.name || '群聊'}`);
  }
  return logs;
}

async function cleanupPresetBackgroundGroups(userId) {
  if (!userId) return;
  const all = await db.getAllByIndex('chats', 'userId', userId);
  for (const g of all) {
    const emptyParticipants = !Array.isArray(g.participants) || g.participants.length === 0;
    const isPreset = g.type === 'group' && g.groupSettings?.groupOrigin === 'preset';
    const noPreview = !String(g.lastMessage || '').trim();
    if (!isPreset || !emptyParticipants || !noPreview) continue;
    const msgs = await db.getAllByIndex('messages', 'chatId', g.id);
    if (msgs.length > 0) continue;
    await db.del('chats', g.id);
  }
}

async function buildPrivateCarryContext(userId, characterId) {
  if (!userId || !characterId || characterId === 'user') return '';
  const chats = await db.getAllByIndex('chats', 'userId', userId);
  const dm = chats.find(
    (c) => c.type === 'private'
      && Array.isArray(c.participants)
      && c.participants.includes('user')
      && c.participants.includes(characterId)
  );
  if (!dm) return '';
  const msgs = (await db.getAllByIndex('messages', 'chatId', dm.id))
    .filter((m) => !m.deleted && !m.recalled)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .slice(-10);
  if (!msgs.length) return '';
  const who = await resolveName(characterId);
  const lines = msgs.map((m) => {
    const name = m.senderId === 'user' ? '我' : (m.senderName || who);
    return `${name}: ${String(m.content || '').slice(0, 80)}`;
  });
  return `【私聊继承上下文/${who}】\n以下为你（${who}）与我的最近私聊片段，请在本群发言中延续这些已发生的信息与语气，不要当作首次认识：\n${lines.join('\n')}`;
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
  const bundles = [...(sortedMessages || [])]
    .filter((m) => m.type === 'chatBundle' && !m.deleted && !m.recalled)
    .slice(-2);
  if (bundles.length) {
    const text = bundles.map((b) => {
      const items = Array.isArray(b.metadata?.items) ? b.metadata.items : [];
      const rows = items.slice(0, 6).map((x) => `${x.senderName || x.senderId || '某人'}: ${String(x.content || '').slice(0, 48)}`);
      return `[转发上下文:${b.metadata?.bundleTitle || '聊天记录'}]\n${rows.join('\n')}`;
    }).join('\n---\n');
    contextMessages.push({ role: 'user', content: `以下是刚转发到本群的聊天片段，仅基于这些片段共享上下文：\n${text}` });
  }
  const linkageHints = [...(sortedMessages || [])]
    .filter((m) => !m.deleted && !m.recalled && (m.metadata?.linkageGoal || m.metadata?.mentionLinkage || m.metadata?.linkedTargetChatId))
    .slice(-5)
    .map((m) => {
      if (m.metadata?.linkageGoal) return `联动目标：${String(m.metadata.linkageGoal).slice(0, 60)}`;
      if (m.metadata?.mentionLinkage) return `提及联动：${String(m.content || '').slice(0, 60)}`;
      return `群联动：${String(m.content || '').slice(0, 60)}`;
    });
  if (linkageHints.length) {
    contextMessages.push({ role: 'user', content: `近期跨窗联动线索（请延续，不要遗忘原目标）：\n- ${linkageHints.join('\n- ')}` });
  }
  const uid = (await db.get('settings', 'currentUserId'))?.value || '';
  const privateCarry = await buildPrivateCarryContext(uid, speakingAsId);
  if (privateCarry) {
    contextMessages.push({ role: 'user', content: privateCarry });
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
  if (msg.type === 'chatBundle') {
    const items = Array.isArray(msg.metadata?.items) ? msg.metadata.items : [];
    return `
      <div class="link-card chat-card" data-card-type="chat-bundle">
        <div class="link-card-icon">${icon('message', 'chat-card-icon')}</div>
        <div class="link-card-info">
          <div class="link-card-title">${escapeHtml(msg.metadata?.bundleTitle || '合并转发')}</div>
          <div class="link-card-desc">${escapeHtml(msg.metadata?.bundleSummary || `共 ${items.length} 条聊天记录`)}</div>
          <div class="link-card-source">点击查看详情</div>
        </div>
      </div>
    `;
  }
  if (msg.type === 'groupInvite') {
    const gname = msg.metadata?.groupName || '群聊';
    const st = msg.metadata?.inviteState || 'pending';
    return `
      <div class="link-card chat-card" data-card-type="group-invite">
        <div class="link-card-icon">${icon('contacts', 'chat-card-icon')}</div>
        <div class="link-card-info">
          <div class="link-card-title">群聊邀请</div>
          <div class="link-card-desc">${escapeHtml(gname)} · ${st === 'accepted' ? '已加入' : st === 'rejected' ? '已拒绝' : '待确认'}</div>
          <div class="link-card-source">由 ${escapeHtml(msg.senderName || '对方')} 发起</div>
          ${st === 'pending'
            ? '<div style="display:flex;gap:6px;margin-top:8px;"><button type="button" class="btn btn-sm btn-primary group-invite-confirm">同意</button><button type="button" class="btn btn-sm btn-outline group-invite-reject">拒绝</button></div>'
            : ''}
        </div>
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
    g.titles = { ...(g.titles || {}) };
    g.linkagePrivateMemberIds = Array.isArray(g.linkagePrivateMemberIds) ? [...g.linkagePrivateMemberIds] : [];
    const parts = (chat.participants || []).filter(Boolean);
    const memberNames = await Promise.all(parts.map((id) => resolveNameForDisplay(id)));
    const admins = g.admins || [];
    const adminNames = await Promise.all(admins.map((id) => resolveNameForDisplay(id)));
    const ownerName = g.owner ? await resolveNameForDisplay(g.owner) : '未设置';
    const linkageSet = new Set(g.linkagePrivateMemberIds);

    const memberGrid = parts.map((id, i) => {
      const isAdmin = admins.includes(id);
      const isOwner = g.owner === id;
      const badge = isOwner ? '群主' : isAdmin ? '管理' : '';
      const customTitle = String(g.titles?.[id] || '').trim();
      const linkageBadge = linkageSet.has(id) ? ' <span class="gi-badge">私聊联动</span>' : '';
      return `
        <div class="gi-member" data-member-id="${escapeAttr(id)}" role="button">
          <div class="avatar avatar-sm">${avatarMarkup(null, memberNames[i])}</div>
          <div class="gi-member-name">${escapeHtml(memberNames[i])}${badge ? ` <span class="gi-badge">${badge}</span>` : ''}${linkageBadge}</div>
          ${customTitle ? `<div class="gi-member-title">${escapeHtml(customTitle)}</div>` : ''}
        </div>
      `;
    }).join('');
    const linkageOptions = parts
      .filter((id) => id !== 'user')
      .map((id, i) => `
        <label style="display:flex;align-items:center;gap:8px;padding:4px 0;">
          <input type="checkbox" class="gi-linkage-member-cb" value="${escapeAttr(id)}" ${linkageSet.has(id) ? 'checked' : ''} />
          <span>${escapeHtml(memberNames[parts.indexOf(id)] || id)}</span>
        </label>
      `)
      .join('');

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
              <div class="text-hint" style="margin-top:4px;">开启后，你不参与发言，仅观看 AI 角色间的互动。</div>
            </div>

            <div class="card-block">
              <div class="gi-setting-row">
                <span>全员禁言</span>
                <div class="toggle gi-mute-all-toggle${g.allMuted ? ' on' : ''}"></div>
              </div>
            </div>

            <div class="card-block">
              <div style="font-weight:600;margin-bottom:8px;">群聊→私聊联动成员</div>
              <div class="text-hint" style="margin-bottom:8px;">只勾选这些成员可从本群触发私聊联动（职业群人多时推荐设置）。</div>
              <div style="max-height:180px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px 10px;">
                ${linkageOptions || '<div class="text-hint">暂无可选成员</div>'}
              </div>
              <button type="button" class="btn btn-outline btn-sm gi-save-linkage-members" style="margin-top:8px;width:100%;">保存联动成员</button>
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

    host.querySelector('.gi-save-linkage-members')?.addEventListener('click', async () => {
      const ids = [...host.querySelectorAll('.gi-linkage-member-cb:checked')].map((el) => el.value);
      g.linkagePrivateMemberIds = ids;
      await saveAndRefresh(g);
      showToast(ids.length ? `已设置 ${ids.length} 位私聊联动成员` : '已清空成员限制（群内角色均可）');
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

    host.querySelectorAll('.gi-member').forEach((el) => {
      el.addEventListener('click', async () => {
        const memberId = el.dataset.memberId;
        if (!memberId) return;
        const memberName = await resolveNameForDisplay(memberId);
        const currentTitle = String(g.titles?.[memberId] || '').trim();
        const action = window.prompt(
          `${memberName}\n输入操作编号：\n1 设头衔\n2 设为管理员\n3 移除管理员\n4 转让群主\n5 禁言\n6 解除禁言\n7 踢出群聊\n8 切换私聊联动`,
          '1'
        );
        if (!action) return;
        if (action === '1') {
          const nextTitle = window.prompt(`设置 ${memberName} 的头衔（留空清除）`, currentTitle);
          if (nextTitle == null) return;
          const normalized = String(nextTitle).trim();
          if (normalized) g.titles[memberId] = normalized;
          else delete g.titles[memberId];
          await saveAndRefresh(g);
          return;
        }
        if (action === '2') {
          g.admins = [...new Set([...(g.admins || []), memberId])];
          await saveAndRefresh(g);
          return;
        }
        if (action === '3') {
          g.admins = (g.admins || []).filter((id) => id !== memberId);
          await saveAndRefresh(g);
          return;
        }
        if (action === '4') {
          g.owner = memberId;
          g.admins = [...new Set([...(g.admins || []), memberId])];
          await saveAndRefresh(g);
          return;
        }
        if (action === '5') {
          g.muted = [...new Set([...(g.muted || []), memberId])];
          await saveAndRefresh(g);
          return;
        }
        if (action === '6') {
          g.muted = (g.muted || []).filter((id) => id !== memberId);
          await saveAndRefresh(g);
          return;
        }
        if (action === '7') {
          if (memberId === 'user') {
            showToast('不能踢出自己');
            return;
          }
          chat.participants = chat.participants.filter((p) => p !== memberId);
          g.admins = (g.admins || []).filter((id) => id !== memberId);
          g.muted = (g.muted || []).filter((id) => id !== memberId);
          delete g.titles[memberId];
          g.linkagePrivateMemberIds = (g.linkagePrivateMemberIds || []).filter((id) => id !== memberId);
          if (g.owner === memberId) g.owner = null;
          chat.groupSettings = g;
          await db.put('chats', chat);
          await renderPanel();
          await onUpdated();
          return;
        }
        if (action === '8') {
          const set = new Set(g.linkagePrivateMemberIds || []);
          if (set.has(memberId)) set.delete(memberId);
          else set.add(memberId);
          g.linkagePrivateMemberIds = [...set];
          await saveAndRefresh(g);
          showToast(set.has(memberId) ? `已允许 ${memberName} 触发私聊联动` : `已取消 ${memberName} 私聊联动`);
        }
      });
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
    <div class="chat-action-bar chat-action-bar--icons" style="${observerMode ? 'display:none;' : ''}">
      <button type="button" class="chat-toolbar-icon-btn group-advance-btn" aria-label="推进">${icon('arrowRight', 'chat-toolbar-svg')}</button>
      <button type="button" class="chat-toolbar-icon-btn group-reroll-btn" aria-label="重 roll">${icon('reroll', 'chat-toolbar-svg')}</button>
      <button type="button" class="chat-toolbar-icon-btn group-stop-btn" aria-label="中止">${icon('squareStop', 'chat-toolbar-svg')}</button>
      <button type="button" class="chat-toolbar-icon-btn group-select-btn" aria-label="多选">${icon('dotsFour', 'chat-toolbar-svg')}</button>
      <button type="button" class="btn btn-sm btn-outline group-forward-selected-btn" style="display:none;margin-left:4px;">转发已选</button>
      <button type="button" class="btn btn-sm btn-outline group-delete-selected-btn" style="display:none;margin-left:4px;">删除已选</button>
    </div>
    <footer class="chat-input-bar" style="${observerMode ? 'display:none;' : ''}">
      <button type="button" class="navbar-btn chat-tools-toggle" aria-label="更多">${icon('plus')}</button>
      <textarea class="chat-input" rows="1" placeholder="发送消息…"></textarea>
      <button type="button" class="chat-send-btn" aria-label="发送">${icon('send')}</button>
    </footer>
    <div class="observer-bar" style="${observerMode ? 'display:flex;' : 'display:none;'}padding:10px 16px;padding-bottom:calc(10px + var(--safe-bottom));gap:8px;background:var(--glass-bg);border-top:1px solid var(--border);">
      <button type="button" class="observer-next" style="flex:1;padding:12px;background:var(--primary);color:var(--text-inverse);border-radius:var(--radius-md);font-weight:600;">推进剧情</button>
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
  const forwardSelectedBtn = container.querySelector('.group-forward-selected-btn');
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
    if (!selecting) scrollMessagesToBottom(messagesEl);
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
    if (!selecting) scrollMessagesToBottom(messagesEl);
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
    chat.lastActivity = await getVirtualNow(currentUser?.id || '', Date.now());
    await db.put('chats', chat);
  }

  async function pickTargetChatId() {
    const uid = currentUser?.id || '';
    const chats = (await db.getAllByIndex('chats', 'userId', uid)).filter((c) => c.id !== chatId).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    if (!chats.length) return '';
    const text = chats.slice(0, 20).map((c, i) => `${i + 1}. ${c.type === 'group' ? (c.groupSettings?.name || '群聊') : '私聊'}`).join('\n');
    const idx = Number(window.prompt(`选择转发目标：\n${text}`, '1') || '1') - 1;
    const t = chats[Math.max(0, Math.min(chats.length - 1, idx))];
    return t?.id || '';
  }

  async function forwardBundleToChat(targetChatId, msgs, title = '聊天记录') {
    if (!targetChatId || !msgs?.length) return;
    const target = await db.get('chats', targetChatId);
    if (!target) return;
    const items = msgs
      .map((m) => normalizeMessageForUi(m))
      .map((m) => ({ senderId: m.senderId, senderName: m.senderName || (m.senderId === 'user' ? (currentUser?.name || '我') : ''), type: m.type, content: String(m.content || '').slice(0, 280), timestamp: m.timestamp || 0 }));
    const summary = items.slice(0, 2).map((x) => `${x.senderName || x.senderId}:${x.content.slice(0, 14)}`).join(' / ');
    const bundle = createMessage({
      chatId: targetChatId,
      senderId: 'user',
      type: 'chatBundle',
      content: `[合并转发] ${title}`,
      metadata: { bundleTitle: title, bundleSummary: summary, items, fromChatId: chatId },
    });
    await db.put('messages', bundle);
    target.lastMessage = '[合并转发]';
    target.lastActivity = await getVirtualNow(currentUser?.id || '', Date.now());
    await db.put('chats', target);
    showToast('已转发');
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
          const targetChatId = await pickTargetChatId();
          if (!targetChatId) return;
          await forwardBundleToChat(targetChatId, [msg], '单条转发');
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
    row.querySelector('.group-invite-confirm')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const targetChatId = msg.metadata?.targetChatId;
      if (!targetChatId) return;
      const target = await db.get('chats', targetChatId);
      if (!target) {
        showToast('邀请已失效');
        return;
      }
      if (!target.participants.includes('user')) target.participants.push('user');
      target.lastActivity = await getVirtualNow(currentUser?.id || '', Date.now());
      target.lastMessage = '[群聊邀请已接受]';
      await db.put('chats', target);
      msg.metadata = { ...(msg.metadata || {}), inviteState: 'accepted' };
      await db.put('messages', msg);
      const me = currentUser?.name || '我';
      await db.put('messages', createMessage({
        chatId: target.id,
        senderId: 'system',
        type: 'system',
        content: `${await resolveName(msg.metadata?.inviterId)} 邀请 ${me} 加入群聊`,
      }));
      showToast('已加入群聊');
      await loadAndRenderMessages();
    });
    row.querySelector('.group-invite-reject')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      msg.metadata = { ...(msg.metadata || {}), inviteState: 'rejected' };
      await db.put('messages', msg);
      await loadAndRenderMessages();
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
      lastActivity: await getVirtualNow(currentUser?.id || '', Date.now()),
      unread: 0,
      autoActive: false,
      autoInterval: 300000,
      pinned: false,
    };
    await db.put('chats', chatItem);
    return chatItem;
  }

  async function persistPrivateFollowups(items) {
    const limitedIds = Array.isArray(chat.groupSettings?.linkagePrivateMemberIds)
      ? chat.groupSettings.linkagePrivateMemberIds
      : [];
    for (const it of items) {
      if (!it.characterId || !it.content) continue;
      if (!chat.participants.includes(it.characterId)) continue;
      if (limitedIds.length && !limitedIds.includes(it.characterId)) continue;
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
      targetChat.lastActivity = await getVirtualNow(currentUser?.id || '', Date.now());
      await db.put('chats', targetChat);
    }
  }

  async function runAiTurn(speakingAsId, afterPersistUser, forcedRoundId = '') {
    await cleanupPresetBackgroundGroups(currentUser?.id || '');
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
    const lastUserMsg = [...sortedForApi].reverse().find((m) => m.senderId === 'user' && !m.deleted);
    await saveAiDebugSnapshot(chatId, {
      phase: 'request',
      payload,
      lastUserText: String(lastUserMsg?.content || ''),
      aiSenderId: speakingAsId,
    });

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
    let latestCleaned = '';
    let processedBlockCount = 0;
    let persistQueue = Promise.resolve();
    const [roundBaseTs] = await allocateVirtualTimestamps(currentUser?.id || '', 1, 30000);
    const nextTs = createMessageTimestampAllocator(roundBaseTs);
    let carryInner = '';
    let lastPublic = '…';
    let lastPersisted = null;
    const persistBlocksIncrementally = async (blocksToPersist) => {
      for (const block of blocksToPersist) {
        const sid = block.senderId || speakingAsId;
        const senderName = await resolveName(sid);
        const pieces = splitToBubbleTexts(block.text);
        for (const piece of pieces) {
          const voiceParsed = splitPublicAndInnerVoice(piece);
          const mergedInner = [carryInner, voiceParsed.innerVoice].filter(Boolean).join('；');
          carryInner = '';
          const publicT = (voiceParsed.publicText || '').trim();
          const safePublic = stripAiSocialOpsTags(stripAiGroupOpsTags(publicT));
          if (!publicT) {
            carryInner = mergedInner;
            continue;
          }
          if (!safePublic) continue;
          const replyParsed = parseReplyInline(safePublic);
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
            lastPersisted = stickerMsg;
            lastPublic = '[表情包]';
            if (inv.note) {
              const invMsg = createMessage({
                chatId,
                senderId: sid,
                senderName,
                type: 'text',
                content: `线下邀约：${inv.note}`,
                timestamp: nextTs(),
                metadata: { offlineInvite: true, note: inv.note, aiRoundId },
              });
              await db.put('messages', invMsg);
              lastPersisted = invMsg;
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
          lastPersisted = item;
          lastPublic = inv.text || lastPublic;
          if (inv.note) {
            const invMsg = createMessage({
              chatId,
              senderId: sid,
              senderName,
              type: 'text',
              content: `线下邀约：${inv.note}`,
              timestamp: nextTs(),
              metadata: { offlineInvite: true, note: inv.note, aiRoundId },
            });
            await db.put('messages', invMsg);
            lastPersisted = invMsg;
          }
        }
      }
      await loadAndRenderMessages();
    };
    try {
      await chatStream(
        payload,
        (_d, acc) => {
          full = acc;
          latestCleaned = stripThinkingBlocks(full || '');
          const completedLines = splitToBubbleTexts(latestCleaned, { onlyCompleted: true }).join('\n');
          const season = (getState('currentUser')?.currentTimeline || 'S8');
          const updateCurrentLine = () => {
            const allPieces = splitToBubbleTexts(latestCleaned);
            const tail = allPieces[allPieces.length - 1] || '...';
            if (bubbleEl) bubbleEl.textContent = tail;
          };
          persistQueue = persistQueue.then(async () => {
            const lookup = await buildSpeakerLookup(chat, season);
            const completedBlocks = parseSpeakerBlocks(completedLines || '', speakingAsId, lookup);
            if (completedBlocks.length > processedBlockCount) {
              const freshBlocks = completedBlocks.slice(processedBlockCount);
              processedBlockCount = completedBlocks.length;
              await persistBlocksIncrementally(freshBlocks);
            }
            updateCurrentLine();
          });
          if (!selecting) scrollMessagesToBottom(messagesEl);
        },
        { signal: currentAbortController.signal }
      );
      await persistQueue;
      const cleaned = latestCleaned || stripThinkingBlocks(full || '');
      const pmParsed = extractPrivateLines(cleaned);
      const season = (getState('currentUser')?.currentTimeline || 'S8');
      const lookup = await buildSpeakerLookup(chat, season);
      const blocks = parseSpeakerBlocks(pmParsed.publicText || '...', speakingAsId, lookup);
      const remainBlocks = blocks.slice(processedBlockCount);
      await db.del('messages', aiMsg.id);
      if (remainBlocks.length) {
        await persistBlocksIncrementally(remainBlocks);
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
      await persistChatPreview(lastPublic.slice(0, 80));
      if (chat.groupSettings?.allowPrivateTrigger && pmParsed.privateItems.length) {
        await persistPrivateFollowups(pmParsed.privateItems.slice(0, 3));
      }
      if (chat.groupSettings?.allowAiGroupOps) {
        const season = currentUser?.currentTimeline || 'S8';
        const ops = parseAiGroupOps(cleaned);
        const inferredOps = ops.length ? [] : inferGroupOpsFromIntent(cleaned, speakingAsId, season);
        const debugOn = await isAiOpsDebugEnabled();
        const logs = await executeAiGroupOps({
          ops: [...ops, ...inferredOps],
          actorId: speakingAsId,
          sourceChat: chat,
          currentUserId: currentUser?.id || '',
        });
        if (debugOn) {
          const debugText = `群操作调试：标签=${ops.length}条，意图兜底=${inferredOps.length}条，执行=${logs.length}条`;
          await db.put('messages', createMessage({
            chatId,
            senderId: 'system',
            type: 'system',
            content: debugText,
            metadata: {
              debug: 'ai-group-ops',
              taggedOps: ops,
              inferredOps,
              logs,
            },
          }));
        }
        if (logs.length) {
          await db.put('messages', createMessage({
            chatId,
            senderId: 'system',
            type: 'system',
            content: `AI 群管理动作：${logs.join('；')}`,
          }));
          showToast(`AI 群动作已执行：${logs[0]}`);
        }
        const socialOps = parseAiSocialOps(cleaned);
        const socialLogs = await executeAiSocialOps({
          ops: socialOps,
          actorId: speakingAsId,
          sourceChat: chat,
          currentUserId: currentUser?.id || '',
        });
        if (socialLogs.length) {
          await db.put('messages', createMessage({
            chatId,
            senderId: 'system',
            type: 'system',
            content: `AI 社交联动：${socialLogs.join('；')}`,
          }));
        }
        await saveAiDebugSnapshot(chatId, {
          phase: 'after-ops',
          raw: full,
          cleaned,
          taggedOps: ops,
          inferredOps,
          opLogs: logs,
        });
      }
      await loadAndRenderMessages();
    } catch (e) {
      if (String(e?.name || '').toLowerCase().includes('abort')) {
        await persistQueue;
        const cleaned = latestCleaned || stripThinkingBlocks(full || '');
        if (cleaned) {
          const pmParsed = extractPrivateLines(cleaned);
          const season = (getState('currentUser')?.currentTimeline || 'S8');
          const lookup = await buildSpeakerLookup(chat, season);
          const blocks = parseSpeakerBlocks(pmParsed.publicText || '...', speakingAsId, lookup);
          await db.del('messages', aiMsg.id);
          const remainBlocks = blocks.slice(processedBlockCount);
          if (remainBlocks.length) {
            await persistBlocksIncrementally(remainBlocks);
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
      sendBtn.style.opacity = '1';
      if (advanceBtn) advanceBtn.style.opacity = '1';
      if (rerollBtn) rerollBtn.style.opacity = '1';
      if (!selecting) scrollMessagesToBottom(messagesEl);
    }

    aiTurn = (mlist.indexOf(speakingAsId) + 1) % mlist.length;
  }

  await loadAndRenderMessages();

  container.querySelector('.group-back-btn')?.addEventListener('click', () => back());

  container.querySelector('.group-menu-btn')?.addEventListener('click', () => {
    openGroupModal(chat, chatId, loadAndRenderMessages);
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
                  `<button type="button" class="stk-pick" data-url="${escapeAttr(s.url)}" data-name="${escapeAttr(s.name || '表情')}"><img class="stk-pick-img" src="${escapeAttr(s.url)}" alt="" loading="lazy" decoding="async" /></button>`
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
    const [ts] = await allocateVirtualTimestamps(currentUser?.id || '', 1, 20000);
    const msg = createMessage({
      chatId,
      senderId: 'user',
      type: 'text',
      content: trimmed,
      timestamp: ts,
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
    try {
      await maybeSummarizeChatMemory({
        chat,
        userId: currentUser?.id || '',
        currentUserName: currentUser?.name || '我',
        resolveName,
        force: false,
      });
    } catch (_) {}
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
      forwardSelectedBtn.style.display = selecting ? 'inline-flex' : 'none';
      deleteSelectedBtn.style.display = selecting ? 'inline-flex' : 'none';
      await loadAndRenderMessages();
    });
    forwardSelectedBtn?.addEventListener('click', async () => {
      if (!selectedIds.size) return;
      const all = await db.getAllByIndex('messages', 'chatId', chatId);
      const picked = all
        .filter((m) => selectedIds.has(m.id))
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      if (!picked.length) return;
      const targetChatId = await pickTargetChatId();
      if (!targetChatId) return;
      await forwardBundleToChat(targetChatId, picked, `转发${picked.length}条`);
      selectedIds.clear();
      selecting = false;
      forwardSelectedBtn.style.display = 'none';
      deleteSelectedBtn.style.display = 'none';
      await loadAndRenderMessages();
    });
    deleteSelectedBtn?.addEventListener('click', async () => {
      if (!selectedIds.size) return;
      await Promise.all([...selectedIds].map((id) => db.del('messages', id)));
      selectedIds.clear();
      selecting = false;
      forwardSelectedBtn.style.display = 'none';
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
