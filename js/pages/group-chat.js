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
  sanitizeStickerDisplayName,
  mergeReplyTagContinuations,
  recomputeChatLastMessagePreview,
  formatChatPickerLabel,
  normalizeUserPlaceholderInText,
  formatBubbleDisplayContent,
  applyGroupBlueprintTags,
  parseAiSocialOps,
  stripAiSocialOpsTags,
  stripLinkageStyleTags,
  matchGroupChatForSocialLinkage,
  findGroupChatLooseName,
  isUserSideTurnMessage,
  isAiRoundReplyMessage,
} from '../core/chat-helpers.js';
import { getState } from '../core/state.js';
import {
  applyRelationDeltaFromMessage,
  getLatestRelationDelta,
  getRelationSnapshot,
} from '../core/user-relation.js';

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

function openTextimgModal(rawText) {
  const text = String(rawText || '').trim() || '（无文字内容）';
  const host = document.getElementById('modal-container');
  if (!host) return;
  host.innerHTML = `
    <div class="modal-overlay" data-modal-overlay>
      <div class="modal-sheet" role="dialog" aria-modal="true" data-modal-sheet style="max-width:460px;">
        <div class="modal-header">
          <h3>文字图片</h3>
          <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">${icon('close')}</button>
        </div>
        <div class="modal-body">
          <div class="card-block" style="max-height:62vh;overflow:auto;white-space:pre-wrap;line-height:1.65;">${escapeHtml(text)}</div>
        </div>
      </div>
    </div>
  `;
  host.classList.add('active');
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-modal-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-modal-overlay]')?.addEventListener('click', close);
  host.querySelector('.modal-close-btn')?.addEventListener('click', close);
}

function getAiMembers(chat) {
  return (chat?.participants || []).filter((p) => p && p !== 'user');
}

const PARTICIPANT_ID_ALIAS = {
  iuxiaobie: 'liuxiaobie',
  luxiaobie: 'liuxiaobie',
  liuxiaobie: 'liuxiaobie',
  zhouyuan: 'zouyuan',
  yuanboqing: 'yuanbaiqing',
};

const DEBUT_SEASON_OVERRIDES = {
  sunxiang: 'S7',
  tanghao: 'S7',
  zouyuan: 'S7',
  lihua_yanyu: 'S7',
  liuxiaobie: 'S7',
  zhouyebai: 'S7',
  yuanbaiqing: 'S7',
  xujingxi: 'S7',
};

const FIXED_PERIOD_GROUP_MEMBERS = {
  S7: ['sunxiang', 'tanghao', 'zouyuan', 'lihua_yanyu', 'liuxiaobie', 'zhouyebai', 'yuanbaiqing', 'xujingxi'],
};

const KNOWN_CHARACTER_IDS = new Set(CHARACTERS.map((c) => c.id));

function normalizeParticipantIds(rawParticipants = []) {
  const out = [];
  const input = Array.isArray(rawParticipants) ? rawParticipants : [];
  for (const item of input) {
    const parts = String(item || '')
      .split(/[,，/|、\s]+/)
      .map((x) => x.trim().replace(/^[\[\(（【<《]+/, '').replace(/[\]\)）】>》]+$/, ''))
      .filter(Boolean);
    for (let token of parts) {
      const low = token.toLowerCase();
      if (low === 'user' || token === '我') {
        out.push('user');
        continue;
      }
      token = PARTICIPANT_ID_ALIAS[low] || token;
      if (KNOWN_CHARACTER_IDS.has(token)) out.push(token);
    }
  }
  return [...new Set(out)];
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
    const normalized = String(line || '');
    const pmRe = /(?:\[\[|［［)\s*PM\s*:\s*([a-zA-Z0-9_-]+)\s*(?:\]\]|］］)\s*(.+)$/i;
    const m = normalized.match(pmRe);
    if (m) {
      privateItems.push({ characterId: String(m[1] || '').trim(), content: String(m[2] || '').trim() });
      const prefix = normalized.slice(0, m.index).trim();
      // 若前缀只剩角色标签/空白，则不再作为公屏消息显示
      if (prefix && !/^\[[^\]]+\]$/.test(prefix)) publicLines.push(prefix);
      continue;
    }
    publicLines.push(line);
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
  text = mergeReplyTagContinuations(text);
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const blocks = [];
  let lastSenderId = fallbackId;
  for (const line of lines) {
    const tagRe = /\[([^\]]+)\]/g;
    const tags = [];
    let m;
    while ((m = tagRe.exec(line))) {
      const speakerRaw = String(m[1] || '').trim().toLowerCase();
      const senderId = lookup.get(speakerRaw);
      if (!senderId) continue;
      tags.push({ senderId, start: m.index, end: tagRe.lastIndex });
    }
    if (!tags.length) {
      const inheritIfControl = /^\[(?:骰子|群投票|分享购物|线下邀约|回复|合并转发|联动风格)[:：]?[^\]]*\]/.test(line);
      blocks.push({ senderId: inheritIfControl ? (lastSenderId || fallbackId) : fallbackId, text: line });
      continue;
    }
    if (tags[0].start > 0) {
      const prefix = line.slice(0, tags[0].start).trim();
      if (prefix) blocks.push({ senderId: fallbackId, text: prefix });
    }
    for (let i = 0; i < tags.length; i += 1) {
      const cur = tags[i];
      const next = tags[i + 1];
      const body = line.slice(cur.end, next ? next.start : line.length).trim().replace(/^[：:]\s*/, '');
      if (!body) continue;
      blocks.push({ senderId: cur.senderId, text: body });
      lastSenderId = cur.senderId || lastSenderId;
    }
  }
  return blocks;
}

function isBrokenSpeakerFragment(text = '') {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/^\[[^\]\n]{1,8}$/.test(s)) return true;
  if (/^[^\[\]\n]{1,4}\]$/.test(s)) return true;
  return false;
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
  const jump = String(chat.groupSettings?.groupJumpIntent || '').trim();
  const starters = Array.isArray(chat.groupSettings?.dialogueStarters)
    ? chat.groupSettings.dialogueStarters.filter(Boolean)
    : [];
  const allowPrivateTrigger = !!chat.groupSettings?.allowPrivateTrigger;
  return [
    '你在进行中文群聊角色扮演；你需要同时扮演多个角色并让他们互相接话。',
    `本群参与者（含你）：${names.join('、') || '（待定）'}`,
    `成员ID映射：${members.map((id, i) => `${id}=${names[i] || id}`).join('；')}`,
    `当前世界时间（非现实系统时间）：${vhm}；时间表达必须按该时间判断，不要白天说“深夜该睡了”。`,
    '口语歧义处理：用户说“差一点/发晕一点/一点点”默认理解为程度，不要擅自解释成凌晨1点等具体时刻。',
    plot ? `剧情/气氛提示：${plot}` : '',
    jump ? `跳转/建群角色意图（编剧向）：${jump}` : '',
    starters.length
      ? `可参考开场方向（勿照抄整句，可改编语气接话）：\n${starters.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : '',
    '表达要求：自然口语、短句、可有情绪停顿；避免书面逻辑连接词堆叠；可结合身份切换正式/私下语气。',
    '当群聊冷场时，你可以主动抛出一个新话题推进剧情。',
    '每轮可输出任意数量群消息（按剧情自然决定），至少包含2个不同角色，且角色之间要有连续互动。',
    '群消息格式必须逐行使用：[角色名] 内容（[角色名] 与正文之间不要再用 : 重复写一遍名字）',
    '禁止在正文前额外加 [角色名]: 前缀；心声只放在该行末尾用 [心声]: 短句，勿把 [心声] 当正文展示',
    '如需引用某条消息，必须把 [回复:消息片段] 与你要说的正文写在同一行，禁止单独一行只写 [回复:…] 再在下一行写台词（否则会被拆成两条消息）。',
    '表情包按情绪自然使用，避免刷屏；若使用请单独一行：优先带完整图片URL；仅有 [表情包:名称] 时名称贴近导入包内标题/文件名；无URL时会就近匹配或随机抽选避免总出同一张',
    '分享礼物/点外卖/下单为低频行为：仅在剧情非常合适时偶尔使用，且单独一行 [分享购物:平台|商品名|价格|短备注]；若无明显触发条件，本轮不要输出该标签',
    '支持骰子与投票：需要随机判定可单独一行 [骰子:d6=点数]（推荐你先决定点数再续写，确保同轮连贯）；若省略点数写成 [骰子:d6] 则系统随机。需要群体表决可单独一行 [群投票:标题|选项A/选项B/选项C]。',
    '合并转发卡片：剧情里转发记录时可单独一行 [合并转发:标题] 或 [合并转发] 标题（可与上一行 [角色名] 台词分行写）；会记为当前角色气泡并带原会话名，勿把整段聊天记录塞进同一行。',
    '当群里提到不在本群的角色时，你可以自然触发“衍生跳群”：例如A说“我去隔壁找他对线/笑话他”，并输出 [社交联动:跳群|目标群名或留空|要在新群说的话|无用户]。',
    '每行只写一句或一个短段，不要把多句合成超长一行。',
    '若要输出角色心理，可在对应行末尾追加 [心声]: 内容（简短）。',
    '关系边界：默认禁止家长式说教/管教，不要反复训诫作息饮食等小事；优先玩笑、陪伴、邀请、协商。',
    allowPrivateTrigger
      ? '你可以在消息末尾追加1-3行私聊片段，格式必须是 [[PM:角色ID]] 内容。仅使用群成员角色ID，不要写用户ID。建议在“想私下补充/想单独解释/想悄悄吐槽”时积极使用，不要过于保守。若该私聊是在“拉对方进群”，PM内容必须包含“拉你了”。'
      : '',
    chat.groupSettings?.allowAiOfflineInvite
      ? '本群已开启「线下邀约」：可由某一角色单独一行输出 [线下邀约:地点或事由]，该行须以 [角色名] 开头与其他消息一致，且该行除该标签外不要长篇解释。'
      : '',
    chat.groupSettings?.allowAiGroupOps
      ? '本群已开启「AI群管理权限」：如需拉群/邀请/禁言，可单独输出控制行 [群操作:动作|参数A|参数B]。动作仅限：创建群、邀请入群、禁言、解除禁言。示例：[群操作:创建群|训练复盘群|huangshaotian,wangjiexi]。若要创建“无用户小群”，可写动作“创建群无用户”或在参数B追加 nouser。允许按关系网临场拉“惊喜筹备群/吐槽群/暗恋群/二人小窗”等。该控制行不要夹杂其他正文。另可使用 [社交联动:动作|目标|内容|参数]，无参数时可只写前三段；动作可用发言/错发/跳群，参数可写邀请user/撤回/无用户；目标群名可与实际群聊差「群」等少量字，系统会模糊匹配。错发/跳群的目标群必须是「当前正在说话的你」也在成员里的群，不要指定你不在其中的群。创建或拉群成功后，宜再单独一行输出 [群备注:群名｜剧情推进提示｜跳转角色意图｜开场对白1｜对白2｜对白3]（用全角｜分隔；群名须与刚建/目标群一致；对白2～3条即可；该行勿写角色台词）。'
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

function parseDiceTag(text = '') {
  const m = String(text || '').trim().match(/^\[骰子[:：]?\s*(d?\d+)?(?:\s*[=＝]\s*(\d+))?\]$/i);
  if (!m) return null;
  const raw = String(m[1] || 'd6').toLowerCase();
  const sides = Math.max(2, Math.min(100, Number(raw.replace(/^d/, '')) || 6));
  const explicit = Number(m[2] || 0);
  const result = explicit > 0 ? Math.max(1, Math.min(sides, explicit)) : (1 + Math.floor(Math.random() * sides));
  return { sides, result };
}

function parseVoteTag(text = '') {
  const m = String(text || '').trim().match(/^\[群投票[:：]\s*([^|\]]+)\|([^\]]+)\]$/i);
  if (!m) return null;
  const title = String(m[1] || '').trim();
  const options = String(m[2] || '')
    .split(/[\/／|]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!title || options.length < 2) return null;
  return { title, options };
}

function inferGroupOpsFromIntent(text = '', actorId = '', season = 'S8') {
  const t = String(text || '');
  if (!t || /\[群操作[:：]/.test(t)) return [];
  if (!/(我来拉你进群|我拉你进|这就拉你进|邀请你进群|拉你进群)/.test(t)) return [];
  if (/(已经|刚刚|刚才|难怪|之前|都在|进过)/.test(t) && !/(我来|这就|马上)/.test(t)) return [];
  const actor = CHARACTERS.find((c) => c.id === actorId);
  const state = actor ? getCharacterStateForSeason(actor, season) : null;
  const team = state?.team || '';
  let groupName = `${team || '战队'}战队群`;
  if (/职业群/.test(t)) groupName = '职业选手群';
  else if (parsePeriodToSeason(t)) groupName = `${parsePeriodToSeason(t).replace('S', '')}期生交流群`;
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

function normalizeSeasonTag(raw = '') {
  const m = String(raw || '').trim().match(/^S?(\d{1,2})$/i);
  return m ? `S${Number(m[1])}` : '';
}

function inferDebutSeasonFromTimelineStates(character) {
  const keys = Object.keys(character?.timelineStates || {})
    .map((k) => normalizeSeasonTag(k))
    .filter(Boolean)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return keys[0] || '';
}

async function buildDebutSeasonGroupProfile(groupName = '', actorId = '') {
  const season = parsePeriodToSeason(groupName);
  if (!season) return null;
  const fixed = FIXED_PERIOD_GROUP_MEMBERS[String(season).toUpperCase()];
  if (Array.isArray(fixed) && fixed.length) {
    const fixedMembers = normalizeParticipantIds(fixed);
    if (fixedMembers.length) {
      return {
        season,
        participants: [...new Set(['user', ...fixedMembers])],
        owner: actorId || fixedMembers[0] || '',
        admins: [],
      };
    }
  }
  const stored = await db.getAll('characters');
  const mergedMap = new Map();
  for (const c of CHARACTERS) mergedMap.set(c.id, { ...c });
  for (const c of stored) {
    if (!c?.id) continue;
    const prev = mergedMap.get(c.id) || {};
    mergedMap.set(c.id, {
      ...prev,
      ...c,
      debutSeason: c.debutSeason || prev.debutSeason || '',
      timelineStates: c.timelineStates || prev.timelineStates || {},
    });
  }
  const members = [...mergedMap.values()]
    .filter((c) => {
      const debut = normalizeSeasonTag(c.debutSeason || '')
        || normalizeSeasonTag(DEBUT_SEASON_OVERRIDES[c.id] || '')
        || inferDebutSeasonFromTimelineStates(c);
      return debut && debut.toUpperCase() === String(season).toUpperCase();
    })
    .map((c) => c.id);
  if (!members.length) return null;
  return {
    season,
    participants: [...new Set(['user', ...members])],
    owner: actorId || members[0] || '',
    admins: [],
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

function parseMemberTokens(raw = '') {
  return String(raw || '')
    .split(/[,，\s]+/)
    .map((x) => x.trim().replace(/^[\[\(（【<《]+/, '').replace(/[\]\)）】>》]+$/, ''))
    .filter(Boolean);
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

function inferGroupTier(name = '') {
  const n = String(name || '').trim();
  if (!n) return 'generic';
  if (parsePeriodToSeason(n)) return 'period';
  if (/职业/.test(n)) return 'career';
  if (/同期/.test(n)) return 'peer';
  if (/训练/.test(n)) return 'training';
  if (/战队/.test(n)) return 'team';
  return 'generic';
}

function isLegacyGroupName(name = '') {
  const n = String(name || '');
  return /战队群|职业群|同期群|训练群/.test(n);
}

async function resolveCharacterIdFlexible(input) {
  const v = String(input || '').trim();
  if (!v) return '';
  if (v === 'user' || v === '我') return 'user';
  const aliased = PARTICIPANT_ID_ALIAS[v.toLowerCase()] || v;
  const byId = CHARACTERS.find((c) => c.id === aliased) || (await db.get('characters', aliased));
  if (byId?.id) return byId.id;
  const all = await db.getAll('characters');
  const byName = CHARACTERS.find((c) => c.name === aliased || c.realName === aliased || (c.aliases || []).includes(aliased))
    || all.find((c) => c.name === aliased || c.realName === aliased || c.customNickname === aliased || (c.aliases || []).includes(aliased));
  return byName?.id || '';
}

async function executeAiGroupOps({ ops = [], actorId = '', sourceChat = null, currentUserId = '' }) {
  if (!ops.length || !sourceChat || !currentUserId) return [];
  const logs = [];
  const seen = new Set();
  const dedupedOps = ops.filter((op) => {
    const k = `${String(op?.action || '').trim()}|${String(op?.argA || '').trim()}|${String(op?.argB || '').trim()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const userChats = await db.getAllByIndex('chats', 'userId', currentUserId);
  const currentUserName = (await db.get('users', currentUserId))?.name || '';
  const season = getState('currentUser')?.currentTimeline || 'S8';
  async function hasPendingInvite(sourceChatId, targetChatId, inviterId) {
    if (!sourceChatId || !targetChatId) return false;
    const msgs = await db.getAllByIndex('messages', 'chatId', sourceChatId);
    return msgs.some((m) =>
      !m.deleted
      && m.type === 'groupInvite'
      && m.metadata?.inviteState === 'pending'
      && m.metadata?.targetChatId === targetChatId
      && (!inviterId || m.metadata?.inviterId === inviterId)
    );
  }
  async function isTierLocked(groupName) {
    const tier = inferGroupTier(groupName);
    const key = `groupTierInviteLock_${currentUserId}_${sourceChat?.id || ''}_${tier}`;
    return { tier, key, locked: !!(await db.get('settings', key))?.value };
  }
  async function lockTier(groupName, targetGroupName = '') {
    const tier = inferGroupTier(groupName);
    const key = `groupTierInviteLock_${currentUserId}_${sourceChat?.id || ''}_${tier}`;
    await db.put('settings', {
      key,
      value: { at: Date.now(), tier, actorId: actorId || '', groupName: targetGroupName || groupName || '' },
    });
  }
  for (const op of dedupedOps.slice(0, 3)) {
    const act = op.action;
    if (act.includes('创建群') || act.includes('拉群')) {
      const parsed = parseGroupNameAndTags(op.argA);
      const teamProfile = buildTeamGroupProfile(parsed.name, season);
      const periodProfile = await buildDebutSeasonGroupProfile(parsed.name, actorId);
      const rosterProfile = teamProfile || periodProfile;
      const memberIdsRaw = parseMemberTokens(op.argB).filter((x) => !/^(!?user|-user|nouser)$/i.test(x));
      const memberIds = [];
      for (const raw of memberIdsRaw) {
        const id = await resolveCharacterIdFlexible(raw);
        if (id && id !== 'user') memberIds.push(id);
      }
      const includeUser = !opNeedsNoUser(op);
      if (includeUser) {
        const lock = await isTierLocked(parsed.name);
        if (lock.locked) {
          logs.push(`已拦截重复拉群：同档位（${lock.tier}）本轮前已处理`);
          continue;
        }
      }
      const participants = includeUser
        ? [...new Set(['user', actorId, ...memberIds].filter(Boolean))]
        : [...new Set([actorId, ...memberIds].filter(Boolean))];
      if (includeUser && rosterProfile) {
        participants.splice(0, participants.length, ...rosterProfile.participants);
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
        if (rosterProfile) {
          existing.participants = [...new Set([...(existing.participants || []), ...rosterProfile.participants])];
          const gse = existing.groupSettings || {};
          gse.owner = rosterProfile.owner || gse.owner || actorId || '';
          gse.admins = [...new Set([...(gse.admins || []), ...(rosterProfile.admins || [])])];
          existing.groupSettings = gse;
          await db.put('chats', existing);
        }
        const alreadyIn = (existing.participants || []).includes('user');
        logs.push(includeUser ? `沿用已有群「${parsed.name}」并准备拉你入群` : `沿用已有群「${parsed.name}」`);
        if (includeUser && !alreadyIn) {
          const duplicated = await hasPendingInvite(sourceChat.id, existing.id, actorId || '');
          if (!duplicated) {
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
            await lockTier(parsed.name, parsed.name);
          } else {
            logs.push(`已存在待确认邀请「${parsed.name}」`);
          }
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
        participants: includeUser ? participants.filter((x) => x !== 'user') : participants,
        groupSettings: {
          name: parsed.name || '新群聊',
          avatar: null,
          owner: rosterProfile?.owner || actorId || '',
          admins: rosterProfile ? (rosterProfile.admins || []) : (actorId ? [actorId] : []),
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
        const duplicated = await hasPendingInvite(sourceChat.id, chat.id, actorId || '');
        if (!duplicated) {
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
          await lockTier(parsed.name, parsed.name || chat.groupSettings?.name || '');
        }
      }
      logs.push(legacyLike && includeUser ? `已发起加入「${parsed.name || '群聊'}」邀请` : `已创建群「${parsed.name || '新群聊'}」`);
      continue;
    }
    if (act.includes('邀请')) {
      let target = userChats.find((c) => c.type === 'group' && (c.id === op.argA || c.groupSettings?.name === op.argA));
      const teamProfile = buildTeamGroupProfile(op.argA || '', season);
      const periodProfile = await buildDebutSeasonGroupProfile(op.argA || '', actorId);
      const rosterProfile = teamProfile || periodProfile;
      if (!target && op.argA) {
        target = createChat({
          type: 'group',
          userId: currentUserId,
          participants: rosterProfile
            ? [...new Set(rosterProfile.participants.filter((p) => p !== 'user'))]
            : [...new Set([actorId].filter(Boolean))],
          groupSettings: {
            name: op.argA || '新群聊',
            avatar: null,
            owner: rosterProfile?.owner || actorId || '',
            admins: rosterProfile ? (rosterProfile.admins || []) : (actorId ? [actorId] : []),
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
      if (rosterProfile) {
        target.participants = [...new Set([...(target.participants || []), ...rosterProfile.participants.filter((p) => p !== 'user')])];
        const gst = target.groupSettings || {};
        gst.owner = rosterProfile.owner || gst.owner || actorId || '';
        gst.admins = [...new Set([...(gst.admins || []), ...(rosterProfile.admins || [])])];
        target.groupSettings = gst;
        await db.put('chats', target);
      }
      const whoTokens = parseMemberTokens(op.argB || '');
      const hasUserToken = whoTokens.some((who) => {
        const whoNorm = String(who || '').toLowerCase();
        return who === 'user'
          || who === '我'
          || who === currentUserId
          || whoNorm === String(currentUserId || '').toLowerCase()
          || (currentUserName && who === currentUserName);
      });
      if (hasUserToken) {
        const lock = await isTierLocked(target.groupSettings?.name || op.argA || '');
        if (lock.locked) {
          logs.push(`已拦截重复拉群：同档位（${lock.tier}）本轮前已处理`);
          continue;
        }
        if (sourceChat?.id && !(target.participants || []).includes('user')) {
          const duplicated = await hasPendingInvite(sourceChat.id, target.id, actorId || '');
          if (!duplicated) {
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
            await lockTier(target.groupSettings?.name || op.argA || '', target.groupSettings?.name || op.argA || '');
            logs.push(`已向你发起加入「${target.groupSettings?.name || op.argA || '群聊'}」邀请`);
          } else {
            logs.push(`已存在待确认邀请「${target.groupSettings?.name || op.argA || '群聊'}」`);
          }
        } else if ((target.participants || []).includes('user')) {
          logs.push(`你已在「${target.groupSettings?.name || op.argA || '群聊'}」中`);
        }
        // 用户邀请卡已处理，剩余 token 继续邀请入群
      }
      const inviteTokens = whoTokens.length ? whoTokens : [String(op.argB || '').trim()];
      let invitedCount = 0;
      for (const token of inviteTokens) {
        if (!token) continue;
        if (token === 'user' || token === '我' || token === currentUserId) continue;
        const id = await resolveCharacterIdFlexible(token);
        if (!id || id === 'user') {
          logs.push(`邀请失败：未识别成员「${token}」`);
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
        invitedCount += 1;
      }
      if (invitedCount > 0) logs.push(`已邀请 ${invitedCount} 位成员入群`);
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
    const legacyTarget = /战队群|职业群|同期|七期|八期|九期|训练群/.test(String(targetSpec || ''));
    const includeUser = /邀请user|includeUser|withUser|含user|拉你/i.test(extra) || legacyTarget;
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

    let targetGroup = matchGroupChatForSocialLinkage(userChats, targetSpec, actorId);
    if (!targetGroup) {
      const wrongRoster = findGroupChatLooseName(userChats, targetSpec);
      if (wrongRoster && !(wrongRoster.participants || []).includes(actorId)) {
        logs.push(`跳过联动：目标群「${wrongRoster.groupSettings?.name || targetSpec}」中不含当前发言角色`);
        continue;
      }
    }
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
        metadata: { recalledContent: content },
      }));
    }
    targetGroup.lastMessage = needRecall ? '[已撤回]' : content.slice(0, 80);
    targetGroup.lastActivity = await getVirtualNow(currentUserId || '', Date.now());
    await db.put('chats', targetGroup);
    logs.push(`已联动到${targetGroup.groupSettings?.name || '群聊'}`);
  }
  return logs;
}

function parsePeriodToSeason(text = '') {
  const s = String(text || '');
  const sm = s.match(/\bS(\d{1,2})\b/i);
  if (sm) return `S${Number(sm[1])}`;
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const m = s.match(/([一二三四五六七八九十\d])期/);
  if (!m) return '';
  const raw = m[1];
  const n = /^\d+$/.test(raw) ? Number(raw) : (map[raw] || 0);
  if (!n) return '';
  return `S${n}`;
}

function extractMentionNames(text = '') {
  const raw = String(text || '');
  const out = [];
  const re = /@([^\s，。,.!！?？:：；;、]+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const n = String(m[1] || '').trim();
    if (n) out.push(n);
  }
  return [...new Set(out)];
}

function isExplicitMentionInviteRequest(text = '') {
  const s = String(text || '').trim();
  if (!s) return false;
  if (!extractMentionNames(s).length) return false;
  if (!/私聊我|来私聊|单聊我|私聊.*我|私信我|给我私聊/.test(s)) return false;
  if (!/邀请我|拉我进|加我进|让我进/.test(s)) return false;
  return true;
}

function inferRequestedGroupNameFromText(text = '', inviterId = '', season = 'S8') {
  const s = String(text || '');
  const periodSeason = parsePeriodToSeason(s);
  if (periodSeason) return `${periodSeason.replace('S', '')}期生交流群`;
  if (/职业群/.test(s)) return '职业选手群';
  if (/同期群/.test(s)) return '同期选手群';
  const actor = CHARACTERS.find((c) => c.id === inviterId);
  const state = actor ? getCharacterStateForSeason(actor, season) : null;
  const teamName = state?.team ? getDisplayTeamName(state.team) : '';
  const teamBase = teamName || '战队';
  const teamGroupBase = /战队$/.test(teamBase) ? teamBase : `${teamBase}战队`;
  if (/训练群/.test(s)) return `${teamGroupBase}训练群`;
  return `${teamGroupBase}群`;
}

function extractExplicitRequestedGroupName(text = '', inviterId = '', season = 'S8') {
  const s = String(text || '');
  if (!/(期群|期生群|职业群|同期群|训练群|战队群|S\d+\s*群)/i.test(s)) return '';
  return inferRequestedGroupNameFromText(s, inviterId, season);
}

async function ensureInviteTargetGroupForRequest({ userId, inviterId, groupName, season = 'S8' }) {
  const allChats = await db.getAllByIndex('chats', 'userId', userId);
  let g = allChats.find((c) => c.type === 'group' && (c.groupSettings?.name || '') === groupName);
  if (g) return g;
  const periodSeason = parsePeriodToSeason(groupName);
  let participants = [];
  if (periodSeason) {
    const periodProfile = await buildDebutSeasonGroupProfile(groupName, inviterId);
    participants = periodProfile ? periodProfile.participants.filter((x) => x !== 'user') : [];
  } else {
    const teamProfile = buildTeamGroupProfile(groupName, season);
    if (teamProfile) participants = teamProfile.participants.filter((x) => x !== 'user');
  }
  participants = [...new Set([inviterId, ...participants].filter(Boolean))];
  if (participants.length < 2) {
    const fallback = CHARACTERS.find((c) => c.id !== inviterId && c.id !== 'user');
    if (fallback?.id) participants.push(fallback.id);
  }
  g = createChat({
    type: 'group',
    userId,
    participants: [...new Set(participants.filter((x) => x !== 'user'))],
    groupSettings: {
      name: groupName,
      avatar: null,
      owner: inviterId || '',
      admins: inviterId ? [inviterId] : [],
      announcement: '',
      muted: [],
      allMuted: false,
      isObserverMode: false,
      plotDirective: '用户点名邀请触发',
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
      groupThemeTags: ['点名邀请'],
      groupOrigin: 'dynamic',
    },
  });
  await db.put('chats', g);
  return g;
}

function detectMentionedCharacterId(text = '', actorId = '', excludeIds = []) {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  const excludes = new Set([actorId, 'user', ...(excludeIds || [])].filter(Boolean));
  let best = { id: '', idx: Infinity };
  for (const c of CHARACTERS) {
    if (!c?.id || excludes.has(c.id)) continue;
    const names = [c.name, c.realName, ...(c.aliases || [])].filter(Boolean);
    for (const n of names) {
      const i = raw.indexOf(String(n));
      if (i >= 0 && i < best.idx) best = { id: c.id, idx: i };
    }
  }
  return best.id;
}

async function maybeRunGroupMentionLinkage({ userId, actorId, latestPublic, sourceChat, currentChatId }) {
  if (!userId || !actorId || !latestPublic || !sourceChat) return;
  if (sourceChat.groupSettings?.allowPrivateMentionLinkage === false) return;
  if (sourceChat.groupSettings?.allowSocialLinkage === false) return;
  const groupMembers = Array.isArray(sourceChat.participants) ? sourceChat.participants : [];
  const targetId = detectMentionedCharacterId(latestPublic, actorId, groupMembers);
  if (!targetId) return;
  if (Math.random() > 0.58) return;

  const allChats = await db.getAllByIndex('chats', 'userId', userId);
  let targetGroup = allChats.find((c) =>
    c.type === 'group'
    && c.id !== currentChatId
    && Array.isArray(c.participants)
    && c.participants.includes(targetId)
    && c.participants.includes(actorId)
  );
  if (!targetGroup) {
    targetGroup = createChat({
      type: 'group',
      userId,
      participants: [actorId, targetId],
      groupSettings: {
        name: `${await resolveName(actorId)}&${await resolveName(targetId)}衍生群`,
        avatar: null,
        owner: actorId,
        admins: [actorId],
        announcement: '',
        muted: [],
        allMuted: false,
        isObserverMode: true,
        plotDirective: '群聊提及触发的衍生群聊',
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
        groupThemeTags: ['衍生', '提及联动'],
        groupOrigin: 'dynamic',
      },
    });
    await db.put('chats', targetGroup);
  }

  const actorName = await resolveName(actorId);
  const targetName = await resolveName(targetId);
  const content = `${actorName}：刚在群里提到你了，${String(latestPublic).slice(0, 28)}…我来当面说。`;
  await db.put('messages', createMessage({
    chatId: targetGroup.id,
    senderId: actorId,
    senderName: actorName,
    type: 'text',
    content,
    metadata: { mentionLinkage: true, mentionLinkageGroup: true, fromChatId: currentChatId, targetCharacterId: targetId },
  }));
  targetGroup.lastMessage = content.slice(0, 80);
  targetGroup.lastActivity = await getVirtualNow(userId || '', Date.now());
  await db.put('chats', targetGroup);
  await db.put('messages', createMessage({
    chatId: currentChatId,
    senderId: 'system',
    type: 'system',
    content: `${actorName} 转去「${targetGroup.groupSettings?.name || '衍生群'}」找 ${targetName} 对线了`,
    metadata: { linkedTargetChatId: targetGroup.id, linkageGoal: `提及联动:${targetName}` },
  }));
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

async function buildLinkedCrossChatContext(chat, userId, speakingAsId, maxLines = 100, scope = 'loose') {
  if (!chat?.id || !userId) return '';
  const cap = Math.max(0, Math.min(300, Number(maxLines || 100)));
  if (!cap) return '';
  const aiIds = getAiMembers(chat);
  if (!aiIds.length) return '';

  const allChats = await db.getAllByIndex('chats', 'userId', userId);
  const currentSet = new Set(['user', ...aiIds]);
  const strict = String(scope || 'loose') === 'strict';
  const speakingTeam = String(CHARACTERS.find((c) => c.id === speakingAsId)?.team || '').trim();

  const privateChats = allChats.filter(
    (c) =>
      c.type === 'private'
      && c.id !== chat.id
      && Array.isArray(c.participants)
      && c.participants.includes('user')
      && c.participants.some((p) => p !== 'user' && aiIds.includes(p))
      && (!strict
        || c.participants.includes(speakingAsId)
        || c.participants.some((p) => String(CHARACTERS.find((x) => x.id === p)?.team || '').trim() === speakingTeam))
  );
  const linkedSmallGroups = allChats.filter(
    (c) =>
      c.type === 'group'
      && c.id !== chat.id
      && Array.isArray(c.participants)
      && !c.participants.includes('user')
      && c.participants.some((p) => currentSet.has(p))
      && c.participants.length <= 6
      && (!strict || (c.participants.includes(speakingAsId) && c.participants.some((p) => p !== speakingAsId && aiIds.includes(p))))
  );

  const candidates = [...privateChats, ...linkedSmallGroups]
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
    .slice(0, 12);
  if (!candidates.length) return '';

  const blocks = [];
  let used = 0;
  for (const c of candidates) {
    if (used >= cap) break;
    const msgs = (await db.getAllByIndex('messages', 'chatId', c.id))
      .filter((m) => !m.deleted && !m.recalled)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      .slice(-Math.min(30, cap - used));
    if (!msgs.length) continue;
    const title =
      c.type === 'private'
        ? `私聊/${await resolveName((c.participants || []).find((p) => p && p !== 'user') || '')}`
        : `关联小群/${c.groupSettings?.name || c.id}`;
    const lines = [];
    for (const m of msgs) {
      const who = m.senderId === 'user' ? '我' : (m.senderName || (await resolveName(m.senderId)));
      lines.push(`${who}: ${String(m.content || '').slice(0, 80)}`);
    }
    used += lines.length;
    blocks.push(`【${title}】\n${lines.join('\n')}`);
  }
  if (!blocks.length) return '';
  return `【跨会话补充上下文】\n以下片段来自“本群关联”的私聊与小群（总计约${used}条，供延续关系线）：\n${blocks.join('\n\n')}`;
}

async function messagesToApiPayload(
  chat,
  sortedMessages,
  speakingAsId,
  linkedContextLines = 100,
  linkedContextScope = 'loose',
  viewerUser = null,
) {
  const uname = String(viewerUser?.name || '').trim() || '我';
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
      const fromLab = String(b.metadata?.fromChatLabel || '').trim();
      const head = `[转发上下文:${b.metadata?.bundleTitle || '聊天记录'}${fromLab ? `|转自「${fromLab}」` : ''}]`;
      return `${head}\n${rows.join('\n')}`;
    }).join('\n---\n');
    contextMessages.push({
      role: 'user',
      content: `以下是刚转发到本群的聊天片段（「转自」为原会话名），仅基于这些片段与正文接话：\n${text}`,
    });
  }
  const replyCandidates = [...(sortedMessages || [])]
    .filter((m) => !m.deleted && !m.recalled && m.type !== 'system')
    .slice(-12)
    .map((m) => {
      const who = m.senderId === 'user' ? uname : (m.senderName || m.senderId || '某角色');
      return `- ${who}: ${String(m.content || '').slice(0, 28)}`;
    });
  if (replyCandidates.length) {
    contextMessages.push({
      role: 'user',
      content: `可用于[回复:消息片段]的最近消息候选：\n${replyCandidates.join('\n')}`,
    });
  }
  const linkageHints = [...(sortedMessages || [])]
    .filter((m) =>
      !m.deleted
      && !m.recalled
      && m.senderId !== 'system'
      && m.type !== 'groupInvite'
      && (m.metadata?.linkageGoal || m.metadata?.mentionLinkage || m.metadata?.linkedTargetChatId))
    .slice(-2)
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
  const linkedCarry = await buildLinkedCrossChatContext(chat, uid, speakingAsId, linkedContextLines, linkedContextScope);
  if (linkedCarry) {
    contextMessages.push({ role: 'user', content: linkedCarry });
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
    return `<div class="chat-sticker-slot"><div class="chat-sticker"><img src="${escapeAttr(msg.metadata?.url || msg.content)}" alt="${escapeAttr(msg.metadata?.stickerName || '表情包')}" /></div></div>`;
  }
  if (msg.type === 'orderShare') {
    return orderShareCardHtml(msg, escapeHtml);
  }
  if (msg.type === 'image' && msg.content) {
    return `<div class="chat-sticker-slot"><div class="chat-sticker"><img src="${escapeAttr(msg.content)}" alt="图片" /></div></div>`;
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
      <div class="link-card chat-card textimg-card" data-card-type="textimg">
        <div class="link-card-icon">${icon('camera', 'chat-card-icon')}</div>
        <div class="link-card-info">
          <div class="link-card-title">文字图片</div>
          <div class="link-card-desc">${escapeHtml(msg.content || '未命名文字图')}</div>
          <div class="link-card-source">图片卡片 · 点击查看</div>
        </div>
      </div>
    `;
  }
  if (msg.type === 'chatBundle') {
    const items = Array.isArray(msg.metadata?.items) ? msg.metadata.items : [];
    const fromLab = String(msg.metadata?.fromChatLabel || '').trim();
    const srcFoot = fromLab ? `来自「${escapeHtml(fromLab)}」 · 点击查看详情` : '点击查看详情';
    return `
      <div class="link-card chat-card" data-card-type="chat-bundle">
        <div class="link-card-icon">${icon('message', 'chat-card-icon')}</div>
        <div class="link-card-info">
          <div class="link-card-title">${escapeHtml(msg.metadata?.bundleTitle || '合并转发')}</div>
          <div class="link-card-desc">${escapeHtml(msg.metadata?.bundleSummary || `共 ${items.length} 条聊天记录`)}</div>
          <div class="link-card-source">${srcFoot}</div>
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
  if (msg.type === 'dice') {
    const sides = Number(msg.metadata?.sides || 6) || 6;
    const result = Number(msg.metadata?.result || 0) || 0;
    return `
      <div class="link-card chat-card" data-card-type="dice">
        <div class="link-card-icon">${icon('sparkle', 'chat-card-icon')}</div>
        <div class="link-card-info">
          <div class="link-card-title">掷骰 d${sides}</div>
          <div class="link-card-desc">点数：${result}</div>
        </div>
      </div>
    `;
  }
  if (msg.type === 'vote') {
    const title = String(msg.metadata?.title || '群投票');
    const opts = Array.isArray(msg.metadata?.options) ? msg.metadata.options : [];
    const votes = msg.metadata?.votes || {};
    const closed = !!msg.metadata?.closed;
    const rows = opts.map((opt) => {
      const count = Array.isArray(votes[opt]) ? votes[opt].length : 0;
      return `<button type="button" class="btn btn-sm btn-outline vote-option-btn" data-vote-opt="${escapeAttr(opt)}" ${closed ? 'disabled' : ''}>${escapeHtml(opt)}（${count}）</button>`;
    }).join('');
    return `
      <div class="link-card chat-card" data-card-type="vote">
        <div class="link-card-icon">${icon('message', 'chat-card-icon')}</div>
        <div class="link-card-info">
          <div class="link-card-title">群投票：${escapeHtml(title)}</div>
          <div class="link-card-desc">${closed ? '已结束，可查看结果' : '点击选项投票'}</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">${rows}</div>
          <button type="button" class="btn btn-sm vote-end-btn" style="margin-top:8px;" ${closed ? 'disabled' : ''}>结束投票</button>
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
  let inner = escapeHtml(formatBubbleDisplayContent(msg));
  if (msg.replyPreview) {
    const rpShow = normalizeUserPlaceholderInText(msg.replyPreview, getState('currentUser')?.name || '');
    inner = `<div class="bubble-reply-ref">${escapeHtml(rpShow)}</div>${inner}`;
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

function isMediaBubbleMsg(msg) {
  if (!msg || msg.recalled) return false;
  if (msg.type === 'sticker' && (msg.metadata?.url || msg.content)) return true;
  if (msg.type === 'image' && msg.content) return true;
  return false;
}

function renderMessageRow(msg, senderLabel, senderAvatarMarkup = '') {
  const row = document.createElement('div');
  row.className = 'bubble-row' + (msg.senderId === 'user' ? ' self' : '');
  row.dataset.msgId = msg.id;
  const senderBlock =
    msg.senderId !== 'user' && senderLabel
      ? `<div class="bubble-sender">${escapeHtml(senderLabel)}</div>`
      : '';
  const media = isMediaBubbleMsg(msg);
  const bodyHtml = media
    ? `<div class="bubble-mainline bubble-mainline--media">${bubbleInnerHtml(msg)}</div>`
    : bubbleInnerHtml(msg);
  row.innerHTML = `
    <div class="bubble-avatar-slot">
      <div class="avatar avatar-sm">${senderAvatarMarkup}</div>
    </div>
    <div class="bubble-wrap">
      ${senderBlock}
      ${bodyHtml}
      ${reactionsHtml(msg)}
      <div class="bubble-time">${formatMsgTime(msg.timestamp)}</div>
    </div>
  `;
  return row;
}

function getMessageCopyText(msg) {
  if (!msg) return '';
  if (msg.type === 'sticker') return String(msg.metadata?.url || msg.content || '').trim();
  if (msg.type === 'image') return String(msg.content || '').trim();
  if (msg.type === 'location') return String(msg.metadata?.locationName || msg.content || '').trim();
  if (msg.type === 'voice') return String(msg.metadata?.text || msg.content || '').trim();
  if (msg.type === 'textimg') return String(msg.metadata?.text || msg.content || '').trim();
  if (msg.type === 'chatBundle') {
    const items = Array.isArray(msg.metadata?.items) ? msg.metadata.items : [];
    return items.map((it) => `${it.senderName || it.senderId || '某人'}：${it.content || ''}`).join('\n').trim();
  }
  return String(formatBubbleDisplayContent(msg) || msg.content || '').trim();
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
    g.privateFollowupIntensity = String(g.privateFollowupIntensity || 'medium');
    g.allowPrivateTrigger = g.allowPrivateTrigger !== false;
    const parts = (chat.participants || []).filter(Boolean);
    const memberNames = await Promise.all(parts.map((id) => resolveNameForDisplay(id)));
    const admins = g.admins || [];
    const adminNames = await Promise.all(admins.map((id) => resolveNameForDisplay(id)));
    const ownerName = g.owner ? await resolveNameForDisplay(g.owner) : '未设置';
    const linkageSet = new Set(g.linkagePrivateMemberIds);
    const debugEnabled = await isAiOpsDebugEnabled();

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
                <span>群头像</span>
                <span class="gi-setting-value gi-avatar-change" role="button">更换 ›</span>
              </div>
              <div style="margin-top:8px;display:flex;align-items:center;gap:10px;">
                <div class="avatar avatar-sm">${g.avatar ? `<img src="${escapeAttr(g.avatar)}" alt="" />` : avatarMarkup(null, g.name || '群')}</div>
                <span class="text-hint">${g.avatar ? '已设置自定义头像' : '当前使用默认头像'}</span>
              </div>
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

            <div class="card-block">
              <div class="gi-setting-row">
                <span>群聊触发私聊</span>
                <div class="toggle gi-pm-trigger-toggle${g.allowPrivateTrigger ? ' on' : ''}"></div>
              </div>
              <div class="text-hint" style="margin-top:4px;">开启后，群里角色会更积极跳转到私聊补充信息。</div>
            </div>

            <div class="card-block">
              <div class="gi-setting-row">
                <span>调试：群操作/私聊联动</span>
                <div class="toggle gi-debug-toggle${debugEnabled ? ' on' : ''}"></div>
              </div>
              <div class="text-hint" style="margin-top:4px;">开启后，会在群里显示详细调试系统消息。</div>
            </div>

            <div class="card-block">
              <div class="gi-setting-row">
                <span>私聊联动强度</span>
                <select class="gi-private-followup-intensity" style="padding:6px 8px;border:1px solid var(--border);border-radius:8px;">
                  <option value="low" ${g.privateFollowupIntensity === 'low' ? 'selected' : ''}>低</option>
                  <option value="medium" ${g.privateFollowupIntensity === 'medium' ? 'selected' : ''}>中</option>
                  <option value="high" ${g.privateFollowupIntensity === 'high' ? 'selected' : ''}>高</option>
                </select>
              </div>
              <div class="text-hint" style="margin-top:4px;">影响“群聊后自动私聊补充”的触发概率与冷却时间。</div>
              <button type="button" class="btn btn-outline btn-sm gi-save-private-followup-intensity" style="margin-top:8px;width:100%;">保存联动强度</button>
            </div>

            <div style="display:flex;flex-direction:column;gap:8px;">
              <button type="button" class="btn btn-outline btn-sm gi-rebuild-roster">一键修复群成员</button>
              <button type="button" class="btn btn-outline btn-sm gi-set-admin">设置管理员</button>
              <button type="button" class="btn btn-outline btn-sm gi-set-owner">转让群主</button>
              <button type="button" class="btn btn-outline btn-sm gi-kick">踢出成员</button>
              <button type="button" class="btn btn-outline btn-sm gi-mute-one">禁言成员</button>
              <button type="button" class="btn btn-outline btn-sm gi-clear-messages">清空聊天记录</button>
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

    host.querySelector('.gi-avatar-change')?.addEventListener('click', async () => {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = 'image/*';
      picker.onchange = async () => {
        const file = picker.files?.[0];
        if (!file) return;
        g.avatar = await fileToDataUrl(file);
        await saveAndRefresh(g);
        await onUpdated();
      };
      picker.click();
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
      if (ids.length) g.allowPrivateTrigger = true;
      await saveAndRefresh(g);
      showToast(ids.length ? `已设置 ${ids.length} 位私聊联动成员` : '已清空成员限制（群内角色均可）');
    });
    host.querySelector('.gi-pm-trigger-toggle')?.addEventListener('click', async () => {
      g.allowPrivateTrigger = !g.allowPrivateTrigger;
      await saveAndRefresh(g);
      showToast(g.allowPrivateTrigger ? '已开启群聊触发私聊' : '已关闭群聊触发私聊');
    });
    host.querySelector('.gi-debug-toggle')?.addEventListener('click', async () => {
      const next = !debugEnabled;
      await db.put('settings', { key: 'aiOpsDebugEnabled', value: next });
      await renderPanel();
      showToast(next ? '已开启调试输出' : '已关闭调试输出');
    });
    host.querySelector('.gi-save-private-followup-intensity')?.addEventListener('click', async () => {
      const level = String(host.querySelector('.gi-private-followup-intensity')?.value || 'medium');
      g.privateFollowupIntensity = ['low', 'medium', 'high'].includes(level) ? level : 'medium';
      await saveAndRefresh(g);
      showToast(`私聊联动强度已设为：${g.privateFollowupIntensity === 'low' ? '低' : g.privateFollowupIntensity === 'high' ? '高' : '中'}`);
    });
    host.querySelector('.gi-rebuild-roster')?.addEventListener('click', async () => {
      const season = getState('currentUser')?.currentTimeline || 'S8';
      const groupName = String(g.name || '').trim() || String(chat.groupSettings?.name || '').trim();
      const actorId = String(g.owner || chat.groupSettings?.owner || chat.participants?.[0] || '').trim();
      const teamProfile = buildTeamGroupProfile(groupName, season);
      const periodProfile = await buildDebutSeasonGroupProfile(groupName, actorId);
      const rosterProfile = teamProfile || periodProfile;
      if (!rosterProfile) {
        showToast('当前群名不支持自动修复（仅战队群/期生群）');
        return;
      }
      const rebuilt = normalizeParticipantIds((rosterProfile.participants || []).filter((p) => p !== 'user'));
      if (!rebuilt.length) {
        showToast('修复失败：未匹配到有效成员');
        return;
      }
      chat.participants = rebuilt;
      chat.groupSettings = {
        ...(chat.groupSettings || {}),
        owner: rosterProfile.owner || chat.groupSettings?.owner || actorId || rebuilt[0] || '',
        admins: [...new Set([...(rosterProfile.admins || [])])],
      };
      await db.put('chats', chat);
      await renderPanel();
      await onUpdated();
      showToast(`已修复群成员：${rebuilt.length}人`);
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

    host.querySelector('.gi-clear-messages')?.addEventListener('click', async () => {
      const ok = window.confirm('确定清空本群全部聊天记录吗？该操作不可撤销。');
      if (!ok) return;
      const msgs = await db.getAllByIndex('messages', 'chatId', chatId);
      for (const m of msgs) {
        await db.del('messages', m.id);
      }
      chat.lastMessage = '';
      chat.lastActivity = await getVirtualNow((await db.get('settings', 'currentUserId'))?.value || '', Date.now());
      await db.put('chats', chat);
      showToast('已清空群聊记录');
      await onUpdated();
      await renderPanel();
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

  const normalizedParticipants = normalizeParticipantIds(chat.participants || []);
  if (JSON.stringify(normalizedParticipants) !== JSON.stringify(chat.participants || [])) {
    chat.participants = normalizedParticipants;
    await db.put('chats', chat);
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
  const chatPrefRow = await db.get('settings', `chatPrefs_${chatId}`);
  const chatPrefs = chatPrefRow?.value || {
    contextDepth: 200,
    autoSummary: false,
    autoSummaryFreq: 200,
    customSummaryPrompt: '',
    customGroupSummaryPrompt: '',
    linkedContextLimit: 100,
  };

  const title = await chatTitle(chat);

  container.classList.add('chat-page');
  if (chat.groupSettings?.wallpaper) {
    container.style.backgroundImage = `url("${chat.groupSettings.wallpaper}")`;
    container.style.backgroundSize = 'cover';
    container.style.backgroundPosition = 'center';
  } else {
    container.style.backgroundImage = '';
    container.style.backgroundSize = '';
    container.style.backgroundPosition = '';
  }
  container.innerHTML = `
    <header class="navbar chat-header-custom">
      <button type="button" class="navbar-btn group-back-btn" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">${escapeHtml(title)}</h1>
      <div style="display:flex;gap:4px;">
        <button type="button" class="navbar-btn group-memory-btn" aria-label="记忆与总结" title="自动总结、立即总结、上下文">${icon('message')}</button>
        <button type="button" class="navbar-btn group-wallpaper-btn" aria-label="壁纸">${icon('theme')}</button>
        <button type="button" class="navbar-btn group-menu-btn" aria-label="群管理">${icon('settings')}</button>
      </div>
    </header>
    <div class="chat-messages"></div>
    <div class="chat-tools-panel" style="display:none;">
      <div class="chat-tools-row">
        <button type="button" class="chat-tool-btn" data-tool="image"><span class="tool-icon">${icon('camera')}</span><span>图片</span></button>
        <button type="button" class="chat-tool-btn" data-tool="voice"><span class="tool-icon">${icon('voice')}</span><span>语音</span></button>
        <button type="button" class="chat-tool-btn" data-tool="emoji"><span class="tool-icon">${icon('sticker')}</span><span>表情</span></button>
        <button type="button" class="chat-tool-btn" data-tool="location"><span class="tool-icon">${icon('location')}</span><span>位置</span></button>
        <button type="button" class="chat-tool-btn" data-tool="ordershare"><span class="tool-icon">${icon('transfer')}</span><span>分享购物</span></button>
        <button type="button" class="chat-tool-btn" data-tool="dice"><span class="tool-icon">${icon('sparkle')}</span><span>骰子</span></button>
        <button type="button" class="chat-tool-btn" data-tool="vote"><span class="tool-icon">${icon('message')}</span><span>群投票</span></button>
      </div>
      <div class="chat-sticker-picker" style="display:none;padding:8px 12px;max-height:min(56vh,480px);overflow-y:auto;overflow-x:hidden;"></div>
    </div>
    <div class="reply-bar" style="display:none;padding:6px 12px;font-size:var(--font-sm);background:var(--bg-input);border-top:1px solid var(--border);color:var(--text-secondary);"></div>
    <div class="chat-action-bar chat-action-bar--icons" style="${observerMode ? 'display:none;' : ''}">
      <button type="button" class="chat-toolbar-icon-btn group-role-say-btn" aria-label="代演" title="以角色身份发一条">${icon('roleSay', 'chat-toolbar-svg')}</button>
      <button type="button" class="chat-toolbar-icon-btn group-advance-btn" aria-label="推进">${icon('arrowRight', 'chat-toolbar-svg')}</button>
      <button type="button" class="chat-toolbar-icon-btn group-reroll-btn" aria-label="重 roll">${icon('reroll', 'chat-toolbar-svg')}</button>
      <button type="button" class="chat-toolbar-icon-btn group-stop-btn" aria-label="中止">${icon('squareStop', 'chat-toolbar-svg')}</button>
      <button type="button" class="chat-toolbar-icon-btn group-select-btn" aria-label="多选">${icon('dotsFour', 'chat-toolbar-svg')}</button>
      <button type="button" class="btn btn-sm btn-outline group-forward-selected-btn" style="display:none;margin-left:4px;">转发已选</button>
      <button type="button" class="btn btn-sm btn-outline group-delete-selected-btn" style="display:none;margin-left:4px;">删除已选</button>
    </div>
    <footer class="chat-input-bar" style="${observerMode ? 'display:none;' : ''}">
      <button type="button" class="navbar-btn group-mention-btn" aria-label="@成员">@</button>
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
  const mentionBtn = container.querySelector('.group-mention-btn');
  const stickerPicker = container.querySelector('.chat-sticker-picker');
  const toolsToggle = container.querySelector('.chat-tools-toggle');
  const replyBar = container.querySelector('.reply-bar');
  const roleSayBtn = container.querySelector('.group-role-say-btn');
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
  let pendingSendAsCharacterId = null;

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
    const keepScroll = selecting;
    const prevTop = messagesEl.scrollTop;
    const prevBottomGap = messagesEl.scrollHeight - messagesEl.scrollTop;
    let list = await db.getAllByIndex('messages', 'chatId', chatId);
    list = [...list].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    messagesEl.innerHTML = '';
    for (const m of list) {
      if (m.deleted) continue;
      if (m.senderId && m.senderId !== 'user' && m.senderId !== 'system' && m.type === 'text' && !m.metadata?.relDeltaApplied) {
        const applied = await applyRelationDeltaFromMessage({
          userId: currentUser?.id || '',
          characterId: m.senderId,
          messageId: m.id,
          text: m.content || '',
          timestamp: m.timestamp || Date.now(),
        });
        if (applied?.checked) {
          const nextMeta = { ...(m.metadata || {}), relDeltaApplied: true };
          if (applied.delta) nextMeta.relDelta = applied.delta;
          m.metadata = nextMeta;
          await db.put('messages', m);
        }
      }
      const normalized = normalizeMessageForUi(m);
      if (normalized.type === 'system') {
        const sysRow = renderSystemHintRow(normalized);
        attachLongPress(sysRow, (cx, cy) => {
          openContextMenu(
            cx,
            cy,
            [
              { label: '复制', value: 'copy' },
              { label: '删除系统提示', value: 'delete' },
            ],
            async (action) => {
              if (action === 'copy') {
                const text = getMessageCopyText(normalized);
                if (!text) {
                  showToast('当前消息无可复制内容');
                  return;
                }
                try {
                  await navigator.clipboard.writeText(text);
                  showToast('已复制');
                } catch (_) {
                  showToast('复制失败');
                }
                return;
              }
              if (action !== 'delete') return;
              await db.del('messages', normalized.id);
              await recomputeChatLastMessagePreview(chatId);
              await loadAndRenderMessages();
            },
          );
        });
        messagesEl.appendChild(sysRow);
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
    const aiTurns = list.filter((m) => isAiRoundReplyMessage(m));
    lastAiMessageId = aiTurns[aiTurns.length - 1]?.id || null;
    lastAiRoundId = aiTurns[aiTurns.length - 1]?.metadata?.aiRoundId || '';
    if (!selecting) {
      scrollMessagesToBottom(messagesEl);
    } else if (keepScroll) {
      if (prevBottomGap <= 120) {
        messagesEl.scrollTop = Math.max(0, messagesEl.scrollHeight - prevBottomGap);
      } else {
        messagesEl.scrollTop = prevTop;
      }
    }
    return list;
  }

  function setReplyTo(msg) {
    replyTarget = msg;
    if (!msg) {
      replyBar.style.display = 'none';
      replyBar.textContent = '';
      return;
    }
    const rawPrev = msg.recalled ? '已撤回' : String(msg.content || '').slice(0, 40);
    const prev = normalizeUserPlaceholderInText(rawPrev, currentUser?.name || '');
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

  async function getStableNextTimestamp() {
    const [virtTs] = await allocateVirtualTimestamps(currentUser?.id || '', 1, 20000);
    const all = await db.getAllByIndex('messages', 'chatId', chatId);
    const maxTs = all.reduce((mx, m) => Math.max(mx, Number(m?.timestamp || 0)), 0);
    return Math.max(Number(virtTs || 0), maxTs + 1);
  }

  async function pickTargetChatId() {
    const uid = currentUser?.id || '';
    const chats = (await db.getAllByIndex('chats', 'userId', uid)).filter((c) => c.id !== chatId).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    if (!chats.length) return '';
    const slice = chats.slice(0, 20);
    const lines = await Promise.all(
      slice.map(async (c, i) => `${i + 1}. ${await formatChatPickerLabel(c, resolveName)}`),
    );
    const text = lines.join('\n');
    const idx = Number(window.prompt(`选择转发目标：\n${text}`, '1') || '1') - 1;
    const t = chats[Math.max(0, Math.min(chats.length - 1, idx))];
    return t?.id || '';
  }

  async function forwardBundleToChat(targetChatId, msgs, title = '聊天记录') {
    if (!targetChatId || !msgs?.length) return;
    const target = await db.get('chats', targetChatId);
    if (!target) return;
    const normalizedPick = msgs.map((m) => normalizeMessageForUi(m));
    const fromRow = chatId ? await db.get('chats', chatId) : null;
    const fromChatLabel = fromRow ? await formatChatPickerLabel(fromRow, resolveName) : '';
    const items = normalizedPick.map((m) => ({
      senderId: m.senderId,
      senderName: m.senderName || (m.senderId === 'user' ? (currentUser?.name || '我') : ''),
      type: m.type,
      content: String(m.content || '').slice(0, 280),
      timestamp: m.timestamp || 0,
    }));
    const summary = items.slice(0, 2).map((x) => `${x.senderName || x.senderId}:${x.content.slice(0, 14)}`).join(' / ');
    const bundle = createMessage({
      chatId: targetChatId,
      senderId: 'user',
      senderName: String(currentUser?.name || '').trim(),
      type: 'chatBundle',
      content: `[合并转发] ${title}`,
      metadata: { bundleTitle: title, bundleSummary: summary, items, fromChatId: chatId, fromChatLabel },
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
        { label: '复制', value: 'copy' },
        { label: '回复', value: 'reply' },
        { label: '撤回', value: 'recall' },
        { label: '删除', value: 'delete' },
        { label: '转发', value: 'forward' },
        { label: '编辑', value: 'edit' },
        { label: '表情回应', value: 'react' },
      ];
      openContextMenu(cx, cy, items, async (action) => {
        if (action === 'copy') {
          const text = getMessageCopyText(msg);
          if (!text) {
            showToast('当前消息无可复制内容');
            return;
          }
          try {
            await navigator.clipboard.writeText(text);
            showToast('已复制');
          } catch (_) {
            showToast('复制失败');
          }
          return;
        }
        if (action === 'reply') {
          if (observerMode) return;
          setReplyTo(msg);
          inputEl.focus();
        }
        if (action === 'recall') {
          if (msg.senderId !== 'user') return;
          const sender = msg.senderId === 'user' ? (currentUser?.name || '你') : (await resolveName(msg.senderId));
          const recallSnap = msg.content || '';
          msg.recalled = true;
          msg.metadata = { ...(msg.metadata || {}), recalledContent: recallSnap };
          await db.put('messages', msg);
          await db.put('messages', createMessage({
            chatId,
            senderId: 'system',
            type: 'system',
            content: `${sender} 撤回了一条消息`,
            metadata: { recalledContent: recallSnap },
          }));
          await recomputeChatLastMessagePreview(chatId);
          await loadAndRenderMessages();
        }
        if (action === 'delete') {
          await db.del('messages', msg.id);
          await recomputeChatLastMessagePreview(chatId);
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
      if (kind === 'textimg') {
        openTextimgModal(msg.metadata?.text || msg.content || '');
        return;
      }
      navigate('message-detail', { chatId, msgId: msg.id });
    });
    row.querySelectorAll('.vote-option-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (msg.metadata?.closed) return;
        const opt = String(btn.dataset.voteOpt || '').trim();
        if (!opt) return;
        const who = currentUser?.id || 'user';
        const votes = { ...(msg.metadata?.votes || {}) };
        const options = Array.isArray(msg.metadata?.options) ? msg.metadata.options : [];
        options.forEach((k) => {
          const arr = Array.isArray(votes[k]) ? votes[k].filter((x) => x !== who) : [];
          votes[k] = arr;
        });
        votes[opt] = [...new Set([...(votes[opt] || []), who])];
        msg.metadata = { ...(msg.metadata || {}), votes };
        await db.put('messages', msg);
        await loadAndRenderMessages();
      });
    });
    row.querySelector('.vote-end-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (msg.metadata?.closed) return;
      msg.metadata = { ...(msg.metadata || {}), closed: true };
      await db.put('messages', msg);
      await db.put('messages', createMessage({
        chatId,
        senderId: 'system',
        type: 'system',
        content: `投票「${msg.metadata?.title || '群投票'}」已结束`,
      }));
      await loadAndRenderMessages();
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
      const [name, snap, latestDelta] = await Promise.all([
        resolveName(msg.senderId),
        getRelationSnapshot(currentUser?.id || '', msg.senderId),
        getLatestRelationDelta(currentUser?.id || '', msg.senderId),
      ]);
      const deltaText = latestDelta?.delta
        ? `好感 ${latestDelta.delta.affection >= 0 ? '+' : ''}${latestDelta.delta.affection} / 欲望 ${latestDelta.delta.desire >= 0 ? '+' : ''}${latestDelta.delta.desire} / 关系 ${latestDelta.delta.bond >= 0 ? '+' : ''}${latestDelta.delta.bond}`
        : '本轮无明显变化';
      const host = document.getElementById('modal-container');
      if (!host) return;
      host.innerHTML = `
        <div class="modal-overlay" data-modal-overlay>
          <div class="modal-sheet" role="dialog" aria-modal="true" data-modal-sheet style="max-width:420px;">
            <div class="modal-header">
              <h3>${escapeHtml(name)} · 心声与关系</h3>
              <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">${icon('close')}</button>
            </div>
            <div class="modal-body">
              <div class="card-block" style="margin:6px 0 10px;">
                <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">当前数值</div>
                <div style="display:grid;grid-template-columns:64px 1fr 42px;gap:8px;align-items:center;">
                  <span style="font-size:12px;">好感</span><input type="range" min="0" max="100" value="${Number(snap?.affection || 0)}" disabled /><span>${Number(snap?.affection || 0)}</span>
                  <span style="font-size:12px;">欲望</span><input type="range" min="0" max="100" value="${Number(snap?.desire || 0)}" disabled /><span>${Number(snap?.desire || 0)}</span>
                  <span style="font-size:12px;">关系</span><input type="range" min="0" max="100" value="${Number(snap?.bond || 0)}" disabled /><span>${Number(snap?.bond || 0)}</span>
                </div>
                <div class="text-hint" style="margin-top:8px;">最近变化：${escapeHtml(deltaText)}</div>
              </div>
              <div class="card-block">
                <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">本条心声</div>
                <div style="white-space:pre-wrap;line-height:1.6;">${escapeHtml(inner.trim() || '（暂无心声）')}</div>
              </div>
            </div>
          </div>
        </div>
      `;
      host.classList.add('active');
      const close = () => {
        host.classList.remove('active');
        host.innerHTML = '';
      };
      host.querySelector('[data-modal-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
      host.querySelector('[data-modal-overlay]')?.addEventListener('click', close);
      host.querySelector('.modal-close-btn')?.addEventListener('click', close);
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
    const enabled = chat.groupSettings?.allowPrivateTrigger !== false || limitedIds.length > 0;
    if (!enabled) return;
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
      const contentText = String(it.content || '');
      const inviteIntent = /拉你了|邀请你|拉你进|加你进|进群|加入.*群|点击通过|点通过|点同意|同意一下|通过一下|拉了拉了|发你邀请|邀请发过去|点一下确认|确认就进|进去吧|进来吧|进群吧|来这边群/.test(contentText);
      if (inviteIntent) {
        const season = currentUser?.currentTimeline || 'S8';
        const recent = (await db.getAllByIndex('messages', 'chatId', chatId))
          .filter((m) => !m.deleted)
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
          .slice(0, 12)
          .map((m) => String(m.content || ''))
          .join(' ');
        const explicitInPm = extractExplicitRequestedGroupName(contentText, it.characterId, season);
        const inviterPinnedKey = `lastExplicitInviteGroup_${chatId}_${it.characterId}`;
        const inviterPinned = String((await db.get('settings', inviterPinnedKey))?.value || '').trim();
        const remembered = String(chat.groupSettings?.lastRequestedGroupName || '').trim();
        const rememberTs = Number(chat.groupSettings?.lastRequestedGroupAt || 0);
        const nowTs = await getVirtualNow(currentUser?.id || '', Date.now());
        const rememberedValid = remembered && (nowTs - rememberTs < 45 * 60 * 1000);
        const inferred = inferRequestedGroupNameFromText(`${contentText} ${recent}`, it.characterId, season);
        const weakInviteConfirm = /确认|通过|同意|进来|进去/.test(contentText);
        const groupName = explicitInPm
          || inviterPinned
          || ((rememberedValid && weakInviteConfirm) ? remembered : (rememberedValid ? remembered : inferred));
        const targetGroup = await ensureInviteTargetGroupForRequest({
          userId: currentUser?.id || '',
          inviterId: it.characterId,
          groupName,
          season,
        });
        const existsPending = (await db.getAllByIndex('messages', 'chatId', targetChat.id)).some((m) =>
          !m.deleted
          && m.type === 'groupInvite'
          && m.metadata?.inviteState === 'pending'
          && m.metadata?.targetChatId === targetGroup.id
          && m.metadata?.inviterId === it.characterId
        );
        if (!existsPending) {
          await db.put('messages', createMessage({
            chatId: targetChat.id,
            senderId: it.characterId,
            senderName: await resolveName(it.characterId),
            type: 'groupInvite',
            content: `邀请你加入群聊：${groupName}`,
            metadata: {
              targetChatId: targetGroup.id,
              groupName,
              inviterId: it.characterId,
              inviteState: 'pending',
              existingGroup: true,
              source: 'group-followup',
            },
          }));
          await emitPmLinkageDebug('PM触发补发邀请卡', { inviterId: it.characterId, groupName, targetChatId: targetChat.id });
        } else {
          await emitPmLinkageDebug('PM命中邀请语义但已存在待确认卡', { inviterId: it.characterId, groupName, targetChatId: targetChat.id });
        }
      } else {
        await emitPmLinkageDebug('PM已转私聊但未命中邀请语义', { inviterId: it.characterId, content: String(it.content || '').slice(0, 60) });
      }
      targetChat.lastMessage = it.content.slice(0, 80);
      targetChat.lastActivity = await getVirtualNow(currentUser?.id || '', Date.now());
      await db.put('chats', targetChat);
    }
  }

  async function emitPmLinkageDebug(line, extra = {}) {
    const on = await isAiOpsDebugEnabled();
    if (!on) return;
    const [ts] = await allocateVirtualTimestamps(currentUser?.id || '', 1, 20000);
    await db.put('messages', createMessage({
      chatId,
      senderId: 'system',
      type: 'system',
      timestamp: ts,
      content: `私聊联动调试：${line}`,
      metadata: { debug: 'pm-linkage', ...extra },
    }));
  }

  async function maybeRunGroupPrivateFollowupFallback(actorId, latestPublic) {
    const limitedIds = Array.isArray(chat.groupSettings?.linkagePrivateMemberIds)
      ? chat.groupSettings.linkagePrivateMemberIds
      : [];
    const enabled = chat.groupSettings?.allowPrivateTrigger !== false || limitedIds.length > 0;
    if (!enabled) {
      await emitPmLinkageDebug('fallback未执行：总开关关闭且无成员白名单');
      return;
    }
    if (!actorId || !latestPublic) {
      await emitPmLinkageDebug('fallback未执行：actor或文本为空', { actorId, latestPublic: String(latestPublic || '') });
      return;
    }
    if (!chat.participants.includes(actorId)) {
      await emitPmLinkageDebug('fallback未执行：actor不在当前群', { actorId });
      return;
    }
    if (limitedIds.length && !limitedIds.includes(actorId)) {
      await emitPmLinkageDebug('fallback未执行：actor不在可触发成员名单', { actorId, limitedIds });
      return;
    }

    const intensity = String(chat.groupSettings?.privateFollowupIntensity || 'medium');
    const cfg = intensity === 'high'
      ? { baseP: 0.68, mentionP: 0.88, cooldownMs: 4 * 60 * 1000 }
      : intensity === 'low'
        ? { baseP: 0.26, mentionP: 0.46, cooldownMs: 18 * 60 * 1000 }
        : { baseP: 0.48, mentionP: 0.72, cooldownMs: 12 * 60 * 1000 };
    const now = await getVirtualNow(currentUser?.id || '', Date.now());
    const cdKey = `groupPmFallbackCd_${chatId}_${actorId}`;
    const lastTs = Number((await db.get('settings', cdKey))?.value || 0);
    if (now - lastTs < cfg.cooldownMs) {
      await emitPmLinkageDebug('fallback未执行：冷却中', { actorId, leftMs: cfg.cooldownMs - (now - lastTs), intensity });
      return;
    }

    const text = String(latestPublic || '').trim();
    if (!text) {
      await emitPmLinkageDebug('fallback未执行：文本为空');
      return;
    }
    const hasMention = detectMentionedCharacterId(text, actorId) || '';
    const p = hasMention ? cfg.mentionP : cfg.baseP;
    const roll = Math.random();
    if (roll > p) {
      await emitPmLinkageDebug('fallback未执行：概率未命中', { actorId, p, roll, hasMention: !!hasMention });
      return;
    }

    const targetChat = await ensurePrivateChatWith(actorId);
    const mentionName = hasMention ? await resolveName(hasMention) : '';
    const content = hasMention
      ? `刚才群里那段我私下补一句：${text.slice(0, 38)}…`
      : `刚才群里那句我私下再说清楚：${text.slice(0, 42)}…`;
    const pm = createMessage({
      chatId: targetChat.id,
      senderId: actorId,
      senderName: await resolveName(actorId),
      type: 'text',
      content,
      metadata: {
        source: 'group-followup-auto',
        fromGroupChatId: chatId,
        followupAboutId: hasMention || '',
        followupAboutName: mentionName || '',
      },
    });
    await db.put('messages', pm);
    targetChat.lastMessage = content.slice(0, 80);
    targetChat.lastActivity = await getVirtualNow(currentUser?.id || '', Date.now());
    await db.put('chats', targetChat);
    await db.put('settings', { key: cdKey, value: now });
    await emitPmLinkageDebug('fallback已触发并发送私聊', { actorId, targetChatId: targetChat.id, hasMention: !!hasMention });
  }

  async function maybeHandleExplicitMentionInviteRequest(rawText = '') {
    const text = String(rawText || '').trim();
    if (!isExplicitMentionInviteRequest(text)) {
      await emitPmLinkageDebug('点名邀请未命中：文本不符合规则', { text: text.slice(0, 120) });
      return false;
    }
    const mentionNames = extractMentionNames(text);
    const members = (chat.participants || []).filter((id) => id && id !== 'user');
    const names = await Promise.all(members.map((id) => resolveName(id)));
    let inviterId = '';
    for (const mention of mentionNames) {
      const idx = names.findIndex((n) => String(n || '').trim() === mention);
      if (idx >= 0) {
        inviterId = members[idx];
        break;
      }
    }
    if (!inviterId) {
      await emitPmLinkageDebug('点名邀请未命中：@成员不在本群', { mentionNames });
      return false;
    }
    const season = currentUser?.currentTimeline || 'S8';
    const groupName = inferRequestedGroupNameFromText(text, inviterId, season);
    await db.put('settings', { key: `lastExplicitInviteGroup_${chatId}_${inviterId}`, value: groupName });
    const targetGroup = await ensureInviteTargetGroupForRequest({
      userId: currentUser?.id || '',
      inviterId,
      groupName,
      season,
    });
    const dm = await ensurePrivateChatWith(inviterId);
    const dmMsgs = await db.getAllByIndex('messages', 'chatId', dm.id);
    const pending = dmMsgs.some((m) =>
      !m.deleted
      && m.type === 'groupInvite'
      && m.metadata?.inviteState === 'pending'
      && m.metadata?.targetChatId === targetGroup.id
      && m.metadata?.inviterId === inviterId
    );
    if (pending) {
      await emitPmLinkageDebug('点名邀请命中：已存在待确认邀请，直接跳转私聊', { inviterId, dmChatId: dm.id, groupName });
      return dm.id;
    }
    const inviterName = await resolveName(inviterId);
    const [t1, t2] = await allocateVirtualTimestamps(currentUser?.id || '', 2, 20000);
    await db.put('messages', createMessage({
      chatId: dm.id,
      senderId: inviterId,
      senderName: inviterName,
      type: 'text',
      timestamp: t1,
      content: `你刚在群里点我了，我来私聊发你邀请：${groupName}`,
      metadata: { source: 'explicit-mention-invite', fromGroupChatId: chatId },
    }));
    await db.put('messages', createMessage({
      chatId: dm.id,
      senderId: inviterId,
      senderName: inviterName,
      type: 'groupInvite',
      timestamp: t2,
      content: `邀请你加入群聊：${groupName}`,
      metadata: {
        targetChatId: targetGroup.id,
        groupName,
        inviterId,
        inviteState: 'pending',
        existingGroup: true,
      },
    }));
    dm.lastMessage = `[邀请] ${groupName}`;
    dm.lastActivity = await getVirtualNow(currentUser?.id || '', Date.now());
    await db.put('chats', dm);
    await db.put('messages', createMessage({
      chatId,
      senderId: 'system',
      type: 'system',
      timestamp: t2 + 1,
      content: `${inviterName} 已按你的@指令私聊发起「${groupName}」邀请`,
    }));
    await emitPmLinkageDebug('点名邀请命中：已由指定成员发私聊+邀请卡', { inviterId, dmChatId: dm.id, groupName });
    return dm.id;
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
    let payload = await messagesToApiPayload(
      chat,
      sortedForApi,
      speakingAsId,
      Math.max(0, Number(chatPrefs.linkedContextLimit ?? 100) || 100),
      String(chatPrefs.linkedContextScope || 'loose'),
      currentUser,
    );
    if (afterPersistUser === 'observer') {
      payload = [
        ...payload,
        { role: 'user', content: '[系统] 群聊继续，请作为你的角色自然接话，不要复述他人刚说过的话，可略作互动或推进话题。' },
      ];
    } else if (!sortedForApi.some((m) => isUserSideTurnMessage(m))) {
      payload = [
        ...payload,
        { role: 'user', content: '[系统] 当前群里无人发言，请你自然开一个符合场景和关系的话题，避免尴尬开场。' },
      ];
    }
    const lastUserMsg = [...sortedForApi].reverse().find((m) => isUserSideTurnMessage(m));
    const hardMentionInviteMode = isExplicitMentionInviteRequest(String(lastUserMsg?.content || ''));
    await saveAiDebugSnapshot(chatId, {
      phase: 'request',
      payload,
      lastUserText: String(lastUserMsg?.content || ''),
      aiSenderId: speakingAsId,
      hardMentionInviteMode,
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
    const [roundBaseTsRaw] = await allocateVirtualTimestamps(currentUser?.id || '', 1, 30000);
    const lastTs = Number((sortedForApi[sortedForApi.length - 1] || {}).timestamp || 0);
    const roundBaseTs = Math.max(roundBaseTsRaw || 0, lastTs + 1);
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
          const safePublic = stripLinkageStyleTags(stripAiSocialOpsTags(stripAiGroupOpsTags(publicT)));
          if (!publicT) {
            carryInner = mergedInner;
            continue;
          }
          if (!safePublic) continue;
          if (/\[\[\s*PM\s*:/i.test(safePublic)) {
            // 兜底：任何漏网 PM 控制行不进入群聊气泡
            continue;
          }
          if (isBrokenSpeakerFragment(safePublic)) continue;
          if (/^\[群备注[:：]/i.test(safePublic)) continue;
          const dice = parseDiceTag(safePublic);
          if (dice) {
            const item = createMessage({
              chatId,
              senderId: sid,
              senderName,
              type: 'dice',
              content: `d${dice.sides}=${dice.result}`,
              timestamp: nextTs(),
              metadata: { sides: dice.sides, result: dice.result, aiRoundId, ...(mergedInner ? { innerVoice: mergedInner } : {}) },
            });
            await db.put('messages', item);
            lastPersisted = item;
            lastPublic = `[骰子 d${dice.sides}=${dice.result}]`;
            continue;
          }
          const vote = parseVoteTag(safePublic);
          if (vote) {
            const item = createMessage({
              chatId,
              senderId: sid,
              senderName,
              type: 'vote',
              content: vote.title,
              timestamp: nextTs(),
              metadata: { title: vote.title, options: vote.options, votes: {}, closed: false, aiRoundId, ...(mergedInner ? { innerVoice: mergedInner } : {}) },
            });
            await db.put('messages', item);
            lastPersisted = item;
            lastPublic = `[群投票] ${vote.title}`;
            continue;
          }
          const mergeFm = safePublic.match(/^\[合并转发[:：]\s*([^\]]*)\]\s*(.*)$/);
          if (mergeFm) {
            const inBracket = (mergeFm[1] || '').trim();
            const rest = (mergeFm[2] || '').trim();
            const bundleTitle = inBracket || rest || '聊天记录';
            const itemBody = ((inBracket && rest ? rest : bundleTitle) || '').slice(0, 280);
            const fromRow = await db.get('chats', chatId);
            const fromChatLabel = fromRow ? await formatChatPickerLabel(fromRow, resolveName) : '';
            const ts = nextTs();
            const bundleItem = {
              senderId: sid,
              senderName,
              type: 'text',
              content: itemBody || bundleTitle,
              timestamp: ts - 1,
            };
            const bundle = createMessage({
              chatId,
              senderId: sid,
              senderName,
              type: 'chatBundle',
              content: `[合并转发] ${bundleTitle}`,
              timestamp: ts,
              metadata: {
                bundleTitle,
                bundleSummary: `${(itemBody || bundleTitle).slice(0, 18)}${(itemBody || bundleTitle).length > 18 ? '…' : ''} · 共1条`,
                items: [bundleItem],
                fromChatId: chatId,
                fromChatLabel,
                aiRoundId,
                ...(mergedInner ? { innerVoice: mergedInner } : {}),
              },
            });
            await db.put('messages', bundle);
            lastPersisted = bundle;
            lastPublic = `[合并转发] ${bundleTitle}`;
            continue;
          }
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
          const completedLines = latestCleaned.includes('\n')
            ? latestCleaned.slice(0, latestCleaned.lastIndexOf('\n') + 1)
            : '';
          const season = (getState('currentUser')?.currentTimeline || 'S8');
          const updateCurrentLine = () => {
            const allPieces = splitToBubbleTexts(mergeReplyTagContinuations(latestCleaned));
            const tailRaw = allPieces[allPieces.length - 1] || '...';
            if (bubbleEl) bubbleEl.textContent = stripLinkageStyleTags(tailRaw);
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
      if (await isAiOpsDebugEnabled()) {
        await db.put('messages', createMessage({
          chatId,
          senderId: 'system',
          type: 'system',
          content: `私聊联动调试：本轮提取PM=${pmParsed.privateItems.length}条`,
          metadata: { debug: 'pm-linkage-extract', samples: pmParsed.privateItems.slice(0, 2) },
        }));
      }
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
      if (pmParsed.privateItems.length) {
        await persistPrivateFollowups(pmParsed.privateItems.slice(0, 3));
      }
      if (!pmParsed.privateItems.length) {
        await maybeRunGroupPrivateFollowupFallback(speakingAsId, lastPublic || '');
      }
      if (chat.groupSettings?.allowAiGroupOps && !hardMentionInviteMode) {
        const season = currentUser?.currentTimeline || 'S8';
        const ops = parseAiGroupOps(cleaned);
        // 群聊场景禁用兜底意图拉群，避免“复读上一轮意图”导致拉错群/错发起人
        const inferredOps = [];
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
      const bpLogs = await applyGroupBlueprintTags(currentUser?.id || '', cleaned);
      if (bpLogs.length) {
        showToast(bpLogs[bpLogs.length - 1]);
      }
      if (!hardMentionInviteMode) {
        await maybeRunGroupMentionLinkage({
          userId: currentUser?.id || '',
          actorId: speakingAsId,
          latestPublic: lastPublic || '',
          sourceChat: chat,
          currentChatId: chatId,
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

  container.querySelector('.group-memory-btn')?.addEventListener('click', () => {
    navigate('chat-details', { chatId });
  });
  container.querySelector('.group-menu-btn')?.addEventListener('click', () => {
    openGroupModal(chat, chatId, loadAndRenderMessages);
  });
  container.querySelector('.group-wallpaper-btn')?.addEventListener('click', async () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/*';
    picker.onchange = async () => {
      const file = picker.files?.[0];
      if (!file) return;
      const dataUrl = await fileToDataUrl(file);
      chat.groupSettings = { ...(chat.groupSettings || {}), wallpaper: dataUrl };
      await db.put('chats', chat);
      await render(container, { chatId });
    };
    picker.click();
  });

  if (!observerMode) {
    mentionBtn?.addEventListener('click', async () => {
      const members = (chat.participants || []).filter((id) => id && id !== 'user');
      if (!members.length) return;
      const names = await Promise.all(members.map((id) => resolveName(id)));
      const options = names.map((n, i) => `${i + 1}. ${n}`).join('\n');
      const pick = Number(window.prompt(`选择要@的成员：\n${options}`, '1') || '1') - 1;
      const safeIdx = Math.max(0, Math.min(names.length - 1, pick));
      const name = names[safeIdx];
      if (!name) return;
      const curr = inputEl.value || '';
      inputEl.value = `${curr}${curr && !/\s$/.test(curr) ? ' ' : ''}@${name} `;
      inputEl.focus();
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
              .map((s) => {
                const disp = sanitizeStickerDisplayName(s.name || '表情');
                return `<button type="button" class="stk-pick" data-url="${escapeAttr(s.url)}" data-name="${escapeAttr(disp)}"><img class="stk-pick-img" src="${escapeAttr(s.url)}" alt="${escapeAttr(disp)}" loading="lazy" decoding="async" /><span class="stk-pick-label" title="${escapeAttr(disp)}">${escapeHtml(disp)}</span></button>`;
              })
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
          return;
        }
        if (kind === 'dice') {
          const d = Number(window.prompt('骰子面数', '6') || 6);
          const sides = Math.max(2, Math.min(100, d || 6));
          const result = 1 + Math.floor(Math.random() * sides);
          const ts = await getStableNextTimestamp();
          const msg = createMessage({
            chatId,
            senderId: 'user',
            type: 'dice',
            content: `d${sides}=${result}`,
            timestamp: ts,
            metadata: { sides, result },
          });
          await db.put('messages', msg);
          await persistChatPreview(`[骰子 d${sides}=${result}]`);
          await loadAndRenderMessages();
          return;
        }
        if (kind === 'vote') {
          const title = String(window.prompt('投票标题', '今晚训练后吃什么？') || '').trim();
          if (!title) return;
          const raw = String(window.prompt('选项（用 / 分隔）', '火锅/烧烤/夜宵') || '');
          const options = raw.split(/[\/／|]/).map((x) => x.trim()).filter(Boolean).slice(0, 8);
          if (options.length < 2) {
            showToast('至少需要两个选项');
            return;
          }
          const ts = await getStableNextTimestamp();
          const msg = createMessage({
            chatId,
            senderId: 'user',
            type: 'vote',
            content: title,
            timestamp: ts,
            metadata: { title, options, votes: {}, closed: false },
          });
          await db.put('messages', msg);
          await persistChatPreview(`[群投票] ${title}`);
          await loadAndRenderMessages();
          return;
        }
      });
    });
  }

  imageInput?.addEventListener('change', async () => {
    const file = imageInput.files?.[0];
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    const ts = await getStableNextTimestamp();
    const msg = createMessage({
      chatId,
      senderId: 'user',
      type: 'image',
      content: dataUrl,
      timestamp: ts,
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
    const season = currentUser?.currentTimeline || 'S8';
    const explicitReqGroup = extractExplicitRequestedGroupName(trimmed, '', season);
    if (explicitReqGroup) {
      chat.groupSettings = {
        ...(chat.groupSettings || {}),
        lastRequestedGroupName: explicitReqGroup,
        lastRequestedGroupAt: await getVirtualNow(currentUser?.id || '', Date.now()),
      };
      await db.put('chats', chat);
    }
    const ts = await getStableNextTimestamp();
    const sendAs = pendingSendAsCharacterId;
    if (sendAs) pendingSendAsCharacterId = null;
    const msg = createMessage({
      chatId,
      senderId: sendAs || 'user',
      senderName: sendAs ? await resolveName(sendAs) : '',
      type: 'text',
      content: trimmed,
      timestamp: ts,
      replyTo: replyTarget?.id || null,
      replyPreview: replyTarget
        ? replyTarget.recalled
          ? '[已撤回]'
          : String(replyTarget.content || '').slice(0, 80)
        : null,
      metadata: sendAs ? { userComposedAsCharacter: true } : {},
    });
    await db.put('messages', msg);
    setReplyTo(null);
    inputEl.value = '';
    await persistChatPreview(trimmed);
    await loadAndRenderMessages();
    const jumpedDmId = await maybeHandleExplicitMentionInviteRequest(trimmed);
    if (jumpedDmId) {
      await loadAndRenderMessages();
      navigate('chat-window', { chatId: jumpedDmId });
      return;
    }
    await emitPmLinkageDebug('点名邀请未跳转，进入常规群聊回合', { text: trimmed.slice(0, 120) });
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
    roleSayBtn?.addEventListener('click', async () => {
      const mlist = getAiMembers(chat);
      if (!mlist.length) {
        showToast('群内暂无可用角色');
        return;
      }
      const lines = await Promise.all(mlist.map(async (id, i) => `${i + 1}. ${await resolveName(id)}`));
      const idx = Number(window.prompt(`下一条消息以谁的身份发送？\n${lines.join('\n')}`, '1') || '1') - 1;
      const pick = mlist[Math.max(0, Math.min(mlist.length - 1, idx))];
      if (!pick) return;
      pendingSendAsCharacterId = pick;
      showToast(`下一条将以「${await resolveName(pick)}」发送，发送后恢复为自己`);
    });
    advanceBtn?.addEventListener('click', async () => {
      if (isStreaming) return;
      const allMessages = await db.getAllByIndex('messages', 'chatId', chatId);
      const sorted = [...allMessages].map(normalizeMessageForUi).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      const lastUserMsg = [...sorted].reverse().find((m) => isUserSideTurnMessage(m));
      if (lastUserMsg) {
        const latestAfterUser = sorted.filter((m) => !m.deleted && (m.timestamp || 0) > (lastUserMsg.timestamp || 0));
        if (latestAfterUser.some((m) => isAiRoundReplyMessage(m))) {
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
          const lastUser = [...allSorted].reverse().find((m) => isUserSideTurnMessage(m));
          if (lastUser) {
            const toDelete = allSorted.filter(
              (m) => isAiRoundReplyMessage(m) && (m.timestamp || 0) > (lastUser.timestamp || 0),
            );
            await Promise.all(toDelete.map((m) => db.del('messages', m.id)));
          } else if (latestAi) {
            await db.del('messages', latestAi.id);
          }
        }
        await recomputeChatLastMessagePreview(chatId);
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
      await recomputeChatLastMessagePreview(chatId);
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
