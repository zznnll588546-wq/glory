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
  parseLinkageStyleFromAiText,
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
  const virtualNow = await getVirtualNow(currentUser?.id || '', Date.now());
  const vh = new Date(virtualNow).getHours();
  const vhm = `${String(vh).padStart(2, '0')}:${String(new Date(virtualNow).getMinutes()).padStart(2, '0')}`;
  let prompt = `你是角色「${displayName}」，当前赛季${season}。${identityLine ? `身份：${identityLine}。` : ''}\n性格与设定：${personality}\n说话风格：${speech}\n请严格保持角色口吻，使用「${displayName}」作为自称依据，用中文回复。严禁使用${season}之后才存在的身份或称呼。
当前世界时间（非现实系统时间）为：${vhm}。时间判断必须以该时间为准，白天时不要写“深夜/这么晚还不睡”等错时表达。
当用户出现“发晕一点才想起来/差一点忘了”这类口语时，不要擅自解释为具体钟点（如“凌晨一点”）。
输出格式要求：
1) 先输出对用户可见的聊天发言（自然口语，避免书面连接词堆砌）；禁止在正文前加 [角色名]: 或 [你的名字]: 这类前缀（界面已显示头像与昵称）
2) 若需要，可在末尾单独一行：[心声] xxx 或 [心声]: xxx（简短心理状态）；不要整段贴在同一行里当正文
3) 心声不要泄露规则、不要展开推理过程
4) 引用回复必须把 [回复:消息片段] 与正文写在同一行，禁止单独一行只写 [回复:…] 再在下一行写台词（否则会显示成两条消息）
5) 表情包：可按情绪自然使用，不要为了凑格式频繁刷表情；需要时单独一行 [表情包:名称]，名称与列表完全一致；若列表为空再考虑带图 URL 的完整行。发照片/截图时请单独一行只写完整图片地址（http(s) 或以 data:image 开头的 base64），不要夹在句子里，以便界面按图片展示
6) 分享下单/外卖/礼物为低频行为：仅在剧情非常合适时偶尔使用，且单独一行 [分享购物:平台|商品名|价格|短备注]；若无明显触发条件，本轮不要输出该标签。
7) 积极使用“引用回复”：接用户上一句、澄清误会、回应具体内容时优先写 [回复:消息片段] 你的发言（同一行）。回复对象可以是用户，也可以是你自己上一条。`;
  prompt += '\n[骰子机制] 需要随机判定时，优先单独一行输出 [骰子:d6=点数] 或 [骰子:d20=点数]（先决定点数再续写，保证同轮连贯）；若只写 [骰子:d6] 则系统自动掷骰。后续请按点数继续剧情。';
  prompt += '\n[合并转发] 需要以卡片形式转发记录时，可单独一行 [合并转发:标题] 或 [合并转发] 标题；会记为你的气泡并标注来源本会话。';
  prompt += '\n[群备注] 拉群或创建群成功后，可单独一行 [群备注:群名｜剧情推进提示｜跳转角色意图｜开场对白1｜对白2｜对白3]（全角｜分隔；群名须与目标群一致；该行勿当对白），用于写入该群的剧情与开场方向。';
  prompt += '\n[关系边界] 对成年人关系禁止家长式说教与管教：默认禁止命令口吻纠正作息/饮食/姿势等小事；优先使用陪伴、玩笑、邀请、协商。';
  const stickerHints = await buildStickerAliasPromptSection();
  if (stickerHints) {
    prompt += stickerHints;
  }
  if (chat.groupSettings?.allowAiOfflineInvite) {
    prompt +=
      '\n7) 本会话已开启「线下邀约」：时机合适时可提议见面；请单独用一条短消息只写一行：[线下邀约:地点或事由简述]（不要夹在同一行长句里）。';
  }
  if (chat.groupSettings?.allowAiGroupOps) {
    prompt +=
      '\n8) 本会话已开启「AI群管理权限」：你可以在单独一行输出 [群操作:动作|参数A|参数B] 控制事件。动作仅限：创建群、邀请入群、禁言、解除禁言。示例：[群操作:创建群|训练复盘群|huangshaotian,wangjiexi]。若要创建“无用户小群”，可写动作为“创建群无用户”或在参数B追加 nouser。控制行不要夹杂其他正文。';
    prompt += '\n8.1) 当你明确表达“拉你进群/进战队群/进职业群”时，必须输出对应[群操作:...]标签，避免只写普通对白。';
    prompt += '\n9) 允许你偶尔“合并转发聊天记录”：可以自然提到“我转你看下”，并以少量摘要代替长篇复述，避免频繁刷屏。';
    prompt += '\n10) 允许你自行发起“后台关系网群/二人小窗（无用户）”来筹备惊喜、吐槽、吃醋、炫耀或临时协作；人物选择可基于关系网，也可按当轮情节临场决定。';
    prompt += '\n11) 社交联动要先思考意图：本轮是否“想吐槽/想分享/想通知/想找第三方求证”。若是，请单独输出1-2行控制标签：[社交联动:动作|目标|内容|参数]。动作可用：发言/错发/跳群。目标可用群名、群ID，或 私聊:角色ID；目标群必须是你（当前角色）也在成员列表中的群。内容必须是你真正想对目标对象说的话（不是机械复述给用户的话）。参数可写：邀请user/撤回/无用户。若无需参数可只写三段：[社交联动:发言|群名|要对群里说的话]；群名可与实际群聊差「群」字（如蓝雨战队≈蓝雨战队群），系统会模糊匹配。';
  }
  if (chat.groupSettings?.allowSocialLinkage !== false && chat.groupSettings?.linkageMode === 'auto') {
    prompt +=
      '\n[跨窗联动·自动模式]\n本会话「联动类型」为自动：请根据当轮剧情与语气，在**本轮回复末尾**单独一行输出且仅一行，二选一：[联动风格:通知]（偏往其他群传话、补充话题、日常感错发等）或 [联动风格:吐槽]（偏关系网小群泄愤、炫耀式转发等）。该行由系统读取，**不会展示给用户**。若当轮完全不需要任何跨窗侧写，可不要写这一行；未写时按「通知」向处理。';
  }
  if (chat.blocked) {
    prompt += '\n注意：用户已将你拉黑。你发送的消息对方会看到但标记为已拉黑状态。请自然地表现出被拉黑后的反应，可以困惑、失落或者假装不在意，取决于你的性格。';
  }
  return prompt;
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
    });
  }
  return out;
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

function stripAiGroupOpsTags(text = '') {
  return String(text || '').replace(/\[群操作[:：]\s*[^\]]+\]/g, '').trim();
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

function inferGroupOpsFromIntent(text = '', actorId = '', season = 'S8', userHint = '') {
  const t = String(text || '');
  const u = String(userHint || '');
  const all = `${u}\n${t}`;
  if (!all || /\[群操作[:：]/.test(t)) return [];
  if (!/(拉我进|拉我入|带我进|加我进|我想进群|让我进群)/.test(u)) return [];
  if (/(已经|刚刚|刚才|难怪|之前|都在|进过)/.test(t) && !/(我来拉|这就拉|马上拉|我邀请你)/.test(t)) return [];
  const actor = CHARACTERS.find((c) => c.id === actorId);
  const state = actor ? getCharacterStateForSeason(actor, season) : null;
  const teamName = state?.team ? getDisplayTeamName(state.team) : '';
  let groupName = `${teamName || '战队'}战队群`;
  if (/职业群/.test(all)) groupName = '职业选手群';
  else if (parsePeriodToSeason(all)) groupName = `${parsePeriodToSeason(all).replace('S', '')}期生交流群`;
  else if (/同期群|同期生群/.test(all)) groupName = '同期选手群';
  else if (/训练群/.test(all)) groupName = `${teamName || '战队'}训练群`;
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

function normalizeSeasonTag(raw = '') {
  const m = String(raw || '').trim().match(/^S?(\d{1,2})$/i);
  return m ? `S${Number(m[1])}` : '';
}

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
    const members = [...new Set(fixed.filter(Boolean))];
    return {
      season,
      participants: [...new Set(['user', ...members])],
      owner: actorId || members[0] || '',
      admins: [],
    };
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
      page: 'chat-window',
    },
  });
}

async function executeAiGroupOps({ ops = [], actorId = '', sourceChat = null, currentUserId = '' }) {
  if (!ops.length || !currentUserId) return [];
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
      const idsRaw = parseMemberTokens(op.argB).filter((x) => !/^(!?user|-user|nouser)$/i.test(x));
      const ids = [];
      for (const raw of idsRaw) {
        const id = await resolveCharacterIdFlexible(raw);
        if (id && id !== 'user') ids.push(id);
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
        ? [...new Set(['user', actorId, ...ids].filter(Boolean))]
        : [...new Set([actorId, ...ids].filter(Boolean))];
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
        if (includeUser && sourceChat?.id && !alreadyIn) {
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
            logs.push(`已在已有群「${parsed.name}」发起邀请`);
          } else {
            logs.push(`已存在待确认邀请「${parsed.name}」`);
          }
        } else if (includeUser && alreadyIn) {
          logs.push(`你已在已有群「${parsed.name}」中`);
        } else {
          logs.push(`沿用已有群「${parsed.name}」`);
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
        await db.put('messages', createMessage({ chatId: chat.id, senderId: 'system', type: 'system', content: `群已创建：${parsed.name || '新群聊'}（发起人：${await resolveName(actorId)}）` }));
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
            },
          }));
          await lockTier(parsed.name, parsed.name || chat.groupSettings?.name || '');
        }
      }
      if (!includeUser) {
        chat.lastMessage = '（无用户小群已建立）';
        chat.lastActivity = await getVirtualNow(currentUserId || '', Date.now());
        await db.put('chats', chat);
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
        // 用户邀请已处理，继续处理其他被邀请成员
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
        await db.put('messages', createMessage({ chatId: target.id, senderId: 'system', type: 'system', content: `${await resolveName(actorId)} 邀请 ${await resolveName(id)} 入群` }));
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
      await db.put('messages', createMessage({ chatId: target.id, senderId: 'system', type: 'system', content: `${await resolveName(actorId)} ${act.includes('解除') ? '解除禁言' : '禁言'}了 ${await resolveName(id)}` }));
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
  if (!ops.length || !actorId || !currentUserId) return [];
  const logs = [];
  const userChats = await db.getAllByIndex('chats', 'userId', currentUserId);
  for (const op of ops.slice(0, 3)) {
    const act = op.action;
    const targetSpec = op.target;
    const content = op.content;
    const extra = op.extra;
    const includeUser = /邀请|含user|includeUser|withUser|拉你/i.test(extra);
    const needRecall = /撤回|recall|错发/i.test(extra) || act.includes('错发');
    if (!content) continue;

    if (targetSpec.startsWith('私聊:')) {
      const targetId = await resolveCharacterIdFlexible(targetSpec.slice('私聊:'.length));
      if (!targetId || targetId === 'user') continue;
      const dm = await ensurePrivateChatWith(currentUserId, targetId);
      const msg = createMessage({
        chatId: dm.id,
        senderId: actorId,
        senderName: await resolveName(actorId),
        type: 'text',
        content,
        metadata: { aiSocialOp: true, fromChatId: sourceChat?.id || '' },
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
        participants: includeUser ? participants.filter((x) => x !== 'user') : participants,
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
      metadata: { aiSocialOp: true, fromChatId: sourceChat?.id || '' },
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

async function ensurePrivateChatWith(userId, characterId) {
  const all = await db.getAllByIndex('chats', 'userId', userId);
  let c = all.find((x) => x.type === 'private' && (x.participants || []).includes('user') && (x.participants || []).includes(characterId));
  if (c) return c;
  c = createChat({
    type: 'private',
    userId,
    participants: ['user', characterId],
  });
  await db.put('chats', c);
  return c;
}

async function ensureShadowGroup(userId, actorId) {
  const storedActor = await db.get('characters', actorId);
  const base = CHARACTERS.find((c) => c.id === actorId);
  const actor = { ...(base || {}), ...(storedActor || {}) };
  const relKeys = Object.keys(actor.relationships || {}).slice(0, 8);
  const pool = relKeys.filter((id) => id !== 'user' && id !== actorId);
  if (!pool.length) return null;
  const picked = pool.slice(0, 2);
  const participants = [...new Set([actorId, ...picked])];
  const all = await db.getAllByIndex('chats', 'userId', userId);
  const same = all.find((c) => c.type === 'group'
    && !(c.participants || []).includes('user')
    && participants.every((id) => (c.participants || []).includes(id))
    && (c.participants || []).length === participants.length);
  if (same) return same;
  const g = createChat({
    type: 'group',
    userId,
    participants,
    groupSettings: {
      name: `${await resolveName(actorId)}的小群`,
      avatar: null,
      owner: actorId,
      admins: [actorId],
      announcement: '',
      muted: [],
      allMuted: false,
      isObserverMode: true,
      plotDirective: '关系网小群（角色不知道用户可见）',
      allowPrivateTrigger: false,
      allowSocialLinkage: true,
      allowWrongSend: true,
      allowPrivateMentionLinkage: true,
      allowAiOfflineInvite: false,
      allowAiGroupOps: true,
      useCustomLinkageTargets: false,
      linkageTargetGroupIds: [],
      linkagePrivateMemberIds: [],
      groupThemeTags: ['关系网'],
    },
  });
  await db.put('chats', g);
  return g;
}

async function maybeRunPrivateSocialLinkage({
  userId,
  actorId,
  latestPublic,
  currentChatId,
  sourceChat = null,
  aiLinkageStyleHint = null,
}) {
  if (!userId || !actorId || !latestPublic) return;
  await cleanupPresetBackgroundGroups(userId);
  if (Math.random() > 0.2) return;
  const useCustomTargets = !!sourceChat?.groupSettings?.useCustomLinkageTargets;
  const preferredGroupIds = Array.isArray(sourceChat?.groupSettings?.linkageTargetGroupIds)
    ? sourceChat.groupSettings.linkageTargetGroupIds
    : [];
  const allUserChats = await db.getAllByIndex('chats', 'userId', userId);
  const preferredGroups = useCustomTargets
    ? allUserChats.filter((c) => c.type === 'group' && preferredGroupIds.includes(c.id) && c.id !== currentChatId)
    : [];
  let linkageMode = String(sourceChat?.groupSettings?.linkageMode || 'notify');
  if (linkageMode === 'auto') {
    linkageMode = aiLinkageStyleHint === 'rant' ? 'rant' : 'notify';
  }
  const normalizedLatest = String(latestPublic || '').replace(/\s+/g, ' ').trim();
  const withActor = (groups) => groups.filter((c) => (c.participants || []).includes(actorId));
  const shouldShadow = linkageMode === 'rant' && Math.random() < 0.5;
  let shadow = null;
  if (shouldShadow) {
    shadow = await ensureShadowGroup(userId, actorId);
  }
  const shadowText = normalizedLatest.slice(0, 80);
  if (shadow && shadowText) {
    const isShowoff = Math.random() < 0.36;
    await db.put('messages', createMessage({
      chatId: shadow.id,
      senderId: actorId,
      senderName: await resolveName(actorId),
      type: 'text',
      content: shadowText,
      metadata: { shadowGroup: true, shadowMode: isShowoff ? 'showoff' : 'rant' },
    }));
    const shadowTags = shadow.groupSettings?.groupThemeTags || [];
    shadow.groupSettings = {
      ...(shadow.groupSettings || {}),
      groupThemeTags: [...new Set([...shadowTags, isShowoff ? '秀恩爱' : '吐槽'])].slice(0, 6),
    };
    await db.put('chats', shadow);
  }
  if (shadow && Math.random() < 0.42) {
    const isShowoff = Math.random() < 0.36;
    const fromSrc = currentChatId ? await db.get('chats', currentChatId) : null;
    const fromChatLabel = fromSrc ? await formatChatPickerLabel(fromSrc, resolveName) : '';
    const bundle = createMessage({
      chatId: shadow.id,
      senderId: actorId,
      senderName: await resolveName(actorId),
      type: 'chatBundle',
      content: '[合并转发] 片段',
      metadata: {
        bundleTitle: isShowoff ? '秀恩爱转发' : '吐槽转发',
        bundleSummary: `${isShowoff ? '转发炫耀' : '转发吐槽'} · 共2条`,
        items: [
          { senderId: actorId, senderName: await resolveName(actorId), type: 'text', content: shadowText, timestamp: (await getVirtualNow(userId || '', Date.now())) - 8000 },
        ],
        fromChatId: currentChatId,
        fromChatLabel,
      },
    });
    await db.put('messages', bundle);
  }
  if (shadow && shadowText) {
    shadow.lastMessage = shadowText;
    shadow.lastActivity = await getVirtualNow(userId || '', Date.now());
    await db.put('chats', shadow);
  }

  // 私聊联动到“已知群”（角色也知道）：更偏新话题/通知
  if (linkageMode === 'notify' && Math.random() < 0.28) {
    const pool = withActor(
      preferredGroups.length
        ? preferredGroups
        : allUserChats.filter((c) => c.type === 'group' && (c.participants || []).includes('user') && c.id !== currentChatId),
    );
    const targetGroup = pool[0];
    if (targetGroup) {
      const notice = createMessage({
        chatId: targetGroup.id,
        senderId: actorId,
        senderName: await resolveName(actorId),
        type: 'text',
        content: `在这边补充个话题：${latestPublic.slice(0, 24)}...`,
        metadata: { socialLinkage: true, topicNotice: true, fromChatId: currentChatId },
      });
      await db.put('messages', notice);
      targetGroup.lastMessage = notice.content.slice(0, 80);
      targetGroup.lastActivity = await getVirtualNow(userId || '', Date.now());
      await db.put('chats', targetGroup);
    }
  }

  // 错发到有 user 的群
  if (linkageMode === 'notify' && Math.random() < 0.22) {
    const pool = withActor(
      preferredGroups.length
        ? preferredGroups
        : allUserChats.filter((c) => c.type === 'group' && (c.participants || []).includes('user') && c.id !== currentChatId),
    );
    const targetGroup = pool[0];
    if (targetGroup) {
      const wrong = createMessage({
        chatId: targetGroup.id,
        senderId: actorId,
        senderName: await resolveName(actorId),
        type: 'text',
        content: `发错了：${latestPublic.slice(0, 26)}...`,
        metadata: { wrongSend: true },
      });
      await db.put('messages', wrong);
      if (Math.random() < 0.65) {
        wrong.recalled = true;
        wrong.metadata = { ...(wrong.metadata || {}), recalledContent: wrong.content };
        await db.put('messages', wrong);
        await db.put('messages', createMessage({
          chatId: targetGroup.id,
          senderId: 'system',
          type: 'system',
          content: `${await resolveName(actorId)} 飞速撤回了一条消息`,
          metadata: { recalledContent: wrong.content },
        }));
      }
      targetGroup.lastMessage = '[错发消息]';
      targetGroup.lastActivity = await getVirtualNow(userId || '', Date.now());
      await db.put('chats', targetGroup);
    }
  }

  // 错发给 user 私聊
  if (linkageMode === 'notify' && Math.random() < 0.18) {
    const wrongDm = createMessage({
      chatId: currentChatId,
      senderId: actorId,
      senderName: await resolveName(actorId),
      type: 'text',
      content: `（发错了）${latestPublic.slice(0, 24)}...`,
      metadata: { wrongSendToUser: true },
    });
    await db.put('messages', wrongDm);
    if (Math.random() < 0.72) {
      wrongDm.recalled = true;
      wrongDm.metadata = { ...(wrongDm.metadata || {}), recalledContent: wrongDm.content };
      await db.put('messages', wrongDm);
      await db.put('messages', createMessage({
        chatId: currentChatId,
        senderId: 'system',
        type: 'system',
        content: `${await resolveName(actorId)} 撤回了一条消息`,
      }));
    }
  }

  // 小报告
  if (shadow && Math.random() < 0.28) {
    const friend = (shadow.participants || []).find((id) => id !== actorId);
    if (friend) {
      const dm = await ensurePrivateChatWith(userId, friend);
      const report = `刚在小群看到一点八卦，和${await resolveName(actorId)}有关，你自己留意下`;
      await db.put('messages', createMessage({
        chatId: dm.id,
        senderId: friend,
        senderName: await resolveName(friend),
        type: 'text',
        content: report,
        metadata: { whistleblower: true, sourceGroupId: shadow.id },
      }));
      dm.lastMessage = report.slice(0, 80);
      dm.lastActivity = await getVirtualNow(userId || '', Date.now());
      await db.put('chats', dm);
    }
  }
}

function detectMentionedCharacterId(text = '', actorId = '') {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  let best = { id: '', idx: Infinity };
  for (const c of CHARACTERS) {
    if (!c?.id || c.id === actorId || c.id === 'user') continue;
    const names = [c.name, c.realName, ...(c.aliases || [])].filter(Boolean);
    for (const n of names) {
      const i = raw.indexOf(String(n));
      if (i >= 0 && i < best.idx) best = { id: c.id, idx: i };
    }
  }
  return best.id;
}

async function maybeRunPrivateMentionLinkage({ userId, actorId, latestPublic, currentChatId, sourceChat = null }) {
  if (!userId || !actorId || !latestPublic) return;
  if (sourceChat?.groupSettings?.allowPrivateMentionLinkage === false) return;
  const targetId = detectMentionedCharacterId(latestPublic, actorId);
  if (!targetId) return;
  if (Math.random() > 0.62) return;
  const dm = await ensurePrivateChatWith(userId, targetId);
  const content = `${await resolveName(actorId)}刚提到你：${String(latestPublic).slice(0, 30)}… 你怎么看？`;
  await db.put('messages', createMessage({
    chatId: dm.id,
    senderId: targetId,
    senderName: await resolveName(targetId),
    type: 'text',
    content,
    metadata: { mentionLinkage: true, fromCharacterId: actorId, fromChatId: currentChatId },
  }));
  dm.lastMessage = content.slice(0, 80);
  dm.lastActivity = await getVirtualNow(userId || '', Date.now());
  await db.put('chats', dm);

  if (sourceChat?.groupSettings?.allowAiGroupOps && Math.random() < 0.33) {
    const g = createChat({
      type: 'group',
      userId,
      participants: [actorId, targetId],
      groupSettings: {
        name: `${await resolveName(actorId)}x${await resolveName(targetId)}临时群`,
        avatar: null,
        owner: actorId,
        admins: [actorId],
        announcement: '',
        muted: [],
        allMuted: false,
        isObserverMode: false,
        plotDirective: '私聊提及触发的临时拉群',
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
        groupThemeTags: ['临时', '提及联动'],
      },
    });
    await db.put('chats', g);
    await db.put('messages', createMessage({
      chatId: currentChatId,
      senderId: actorId,
      senderName: await resolveName(actorId),
      type: 'groupInvite',
      content: `邀请你加入群聊：${g.groupSettings?.name || '临时群'}`,
      metadata: { targetChatId: g.id, groupName: g.groupSettings?.name || '临时群', inviterId: actorId, inviteState: 'pending' },
    }));
  }
}

async function messagesToApiPayload(chat, sortedMessages, viewerUser = null) {
  const uname = String(viewerUser?.name || '').trim() || '我';
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
      content: `以下是刚转发过来的聊天片段（「转自」为原会话名），仅基于这些片段与正文接话：\n${text}`,
    });
  }
  const replyCandidates = [...(sortedMessages || [])]
    .filter((m) => !m.deleted && !m.recalled && m.type !== 'system')
    .slice(-8)
    .map((m) => {
      const who = m.senderId === 'user' ? uname : (m.senderName || '对方');
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
  if (msg.metadata?.offlineInvite) {
    return `
      <div class="offline-invite-card chat-card" data-card-type="offline-invite">
        <div class="link-card-title">线下邀约</div>
        <div class="link-card-desc">${escapeHtml(msg.metadata?.note || msg.content || '')}</div>
        <button type="button" class="btn btn-primary btn-sm offline-invite-go" style="margin-top:8px;width:100%;">进入线下场景</button>
      </div>`;
  }
  if (msg.type === 'image' && msg.content) {
    return `<div class="chat-sticker-slot"><div class="chat-sticker"><img src="${escapeAttr(msg.content)}" alt="图片" /></div></div>`;
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

function renderMessageRow(msg, senderAvatarMarkup = '', isBlocked = false) {
  const row = document.createElement('div');
  row.className = 'bubble-row' + (msg.senderId === 'user' ? ' self' : '');
  row.dataset.msgId = msg.id;
  const blockedMark = (isBlocked && msg.senderId !== 'user') ? '<span class="blocked-indicator">!</span>' : '';
  const media = isMediaBubbleMsg(msg);
  const mainlineClass = media ? 'bubble-mainline bubble-mainline--media' : 'bubble-mainline';
  row.innerHTML = `
    <div class="bubble-avatar-slot">
      <div class="avatar avatar-sm">${senderAvatarMarkup}</div>
    </div>
    <div class="bubble-wrap">
      <div class="${mainlineClass}">${bubbleInnerHtml(msg)}${blockedMark}</div>
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
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
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
        chat.lastActivity = await getVirtualNow(currentUser?.id || '', Date.now());
        await db.put('chats', chat);
      } else if (act === 'delete-ai') {
        const list = await db.getAllByIndex('messages', 'chatId', chatId);
        const aiMsg = [...list].reverse().find((m) => m.senderId !== 'user' && !m.deleted);
        if (aiMsg) await db.del('messages', aiMsg.id);
        await recomputeChatLastMessagePreview(chatId);
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
      <button type="button" class="navbar-btn chat-back-btn" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">${escapeHtml(title)}</h1>
      <div style="display:flex;gap:4px;">
        <button type="button" class="navbar-btn chat-wallpaper-btn" aria-label="壁纸">${icon('theme')}</button>
        <button type="button" class="navbar-btn chat-menu-btn" aria-label="菜单">${icon('more')}</button>
      </div>
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
        <button type="button" class="chat-tool-btn" data-tool="dice"><span class="tool-icon">${icon('sparkle')}</span><span>骰子</span></button>
      </div>
      <div class="chat-sticker-picker" style="display:none;padding:8px 12px;max-height:min(56vh,480px);overflow-y:auto;overflow-x:hidden;"></div>
    </div>
    <div class="reply-bar" style="display:none;padding:6px 12px;font-size:var(--font-sm);background:var(--bg-input);border-top:1px solid var(--border);color:var(--text-secondary);"></div>
    <div class="chat-action-bar chat-action-bar--icons">
      <button type="button" class="chat-toolbar-icon-btn chat-role-say-btn" aria-label="代演" title="以对方角色身份发一条">${icon('roleSay', 'chat-toolbar-svg')}</button>
      <button type="button" class="chat-toolbar-icon-btn chat-advance-btn" aria-label="推进">${icon('arrowRight', 'chat-toolbar-svg')}</button>
      <button type="button" class="chat-toolbar-icon-btn chat-reroll-btn" aria-label="重 roll">${icon('reroll', 'chat-toolbar-svg')}</button>
      <button type="button" class="chat-toolbar-icon-btn chat-stop-btn" aria-label="中止">${icon('squareStop', 'chat-toolbar-svg')}</button>
      <button type="button" class="chat-toolbar-icon-btn chat-select-btn" aria-label="多选">${icon('dotsFour', 'chat-toolbar-svg')}</button>
      <button type="button" class="btn btn-sm btn-outline chat-forward-selected-btn" style="display:none;margin-left:4px;">转发已选</button>
      <button type="button" class="btn btn-sm btn-outline chat-delete-selected-btn" style="display:none;margin-left:4px;">删除已选</button>
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
  const roleSayBtn = container.querySelector('.chat-role-say-btn');
  const advanceBtn = container.querySelector('.chat-advance-btn');
  const rerollBtn = container.querySelector('.chat-reroll-btn');
  const stopBtn = container.querySelector('.chat-stop-btn');
  const selectBtn = container.querySelector('.chat-select-btn');
  const forwardSelectedBtn = container.querySelector('.chat-forward-selected-btn');
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
    const el = messagesEl;
    const distBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const wasNearBottom = distBottom < 200;
    const prevTop = el.scrollTop;
    const prevBottomGap = el.scrollHeight - el.scrollTop;
    let list = await db.getAllByIndex('messages', 'chatId', chatId);
    list = [...list].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    el.innerHTML = '';
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
        el.appendChild(sysRow);
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
      el.appendChild(row);
      bindRow(row, normalized);
      bindAvatarInnerVoice(row, normalized, chatId);
    }
    const userTurns = list.filter((m) => isUserSideTurnMessage(m));
    lastUserTurnId = userTurns[userTurns.length - 1]?.id || null;
    const aiTurns = list.filter((m) => isAiRoundReplyMessage(m));
    lastAiMessageId = aiTurns[aiTurns.length - 1]?.id || null;
    lastAiRoundId = aiTurns[aiTurns.length - 1]?.metadata?.aiRoundId || '';
    if (!selecting) {
      if (wasNearBottom) {
        scrollMessagesToBottom(el);
      } else {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const h = el.scrollHeight;
            el.scrollTop = Math.max(0, h - prevBottomGap);
          });
        });
      }
    } else if (keepScroll) {
      if (prevBottomGap <= 120) {
        el.scrollTop = Math.max(0, el.scrollHeight - prevBottomGap);
      } else {
        el.scrollTop = prevTop;
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
      metadata: {
        bundleTitle: title,
        bundleSummary: summary,
        items,
        fromChatId: chatId,
        fromChatLabel,
      },
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
      if (kind === 'textimg') {
        openTextimgModal(msg.metadata?.text || msg.content || '');
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
      const goal = String(msg.metadata?.linkageGoal || '').trim();
      await db.put('messages', createMessage({
        chatId: target.id,
        senderId: 'system',
        type: 'system',
        content: `${await resolveName(msg.metadata?.inviterId)} 邀请 ${me} 加入群聊${goal ? `（延续话题：${goal.slice(0, 28)}）` : ''}`,
      }));
      await db.put('messages', createMessage({
        chatId,
        senderId: 'system',
        type: 'system',
        content: `${me} 已加入「${target.groupSettings?.name || '群聊'}」${goal ? `，请按“${goal.slice(0, 24)}”继续` : ''}`,
        metadata: { linkageGoal: goal, linkedTargetChatId: target.id },
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

  await loadAndRenderMessages();

  container.querySelector('.chat-back-btn')?.addEventListener('click', () => back());
  container.querySelector('.chat-menu-btn')?.addEventListener('click', () => {
    navigate('chat-details', { chatId });
  });
  container.querySelector('.chat-wallpaper-btn')?.addEventListener('click', async () => {
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
    });
  });

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
    if (!trimmed || isStreaming) return;
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

  async function requestAiReply({ reroll = false } = {}) {
    await cleanupPresetBackgroundGroups(currentUser?.id || '');
    if (isStreaming) return;
    const allMessages = await db.getAllByIndex('messages', 'chatId', chatId);
    const sorted = [...allMessages].map(normalizeMessageForUi).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const lastUserMsg = [...sorted].reverse().find((m) => isUserSideTurnMessage(m));
    const noUserMessageYet = !lastUserMsg;

    if (!reroll && !noUserMessageYet) {
      const latestAfterUser = sorted.filter((m) => !m.deleted && (m.timestamp || 0) > (lastUserMsg.timestamp || 0));
      if (latestAfterUser.some((m) => isAiRoundReplyMessage(m))) {
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
        const toDelete = scope.filter(
          (m) => isAiRoundReplyMessage(m) && (m.timestamp || 0) > (lastUserMsg.timestamp || 0),
        );
        await Promise.all(toDelete.map((m) => db.del('messages', m.id)));
      } else if (latestAi) {
        await db.del('messages', latestAi.id);
      }
      await recomputeChatLastMessagePreview(chatId);
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
    const [roundBaseTsRaw] = await allocateVirtualTimestamps(currentUser?.id || '', 1, 30000);
    const lastTs = Number((sortedForApi[sortedForApi.length - 1] || {}).timestamp || 0);
    const roundBaseTs = Math.max(roundBaseTsRaw || 0, lastTs + 1);
    const aiRoundId = `air_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const payload = await messagesToApiPayload(chat, sortedForApi, currentUser);
    if (noUserMessageYet) {
      payload.push({
        role: 'user',
        content: '[系统] 当前还没有用户发言。请你以生活化、符合设定的方式主动开一个自然话题，不要尬聊。',
      });
    }
    await saveAiDebugSnapshot(chatId, {
      phase: 'request',
      payload,
      lastUserText: String(lastUserMsg?.content || ''),
      aiSenderId,
    });

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
    let latestCleaned = '';
    let processedPieceCount = 0;
    let persistQueue = Promise.resolve();
    const nextTs = createMessageTimestampAllocator(roundBaseTs);
    let lastPublic = '…';
    let lastPersisted = null;
    let carryInner = '';
    let aiMsgDeleted = false;
    const persistPiecesIncrementally = async (piecesToPersist) => {
      const senderName = await resolveName(aiSenderId);
      if (piecesToPersist.length && !aiMsgDeleted) {
        await db.del('messages', aiMsg.id);
        aiMsgDeleted = true;
      }
      for (const piece of piecesToPersist) {
        const parsed = splitPublicAndInnerVoice(piece);
        const mergedInner = [carryInner, parsed.innerVoice].filter(Boolean).join('；');
        carryInner = '';
        const publicT = (parsed.publicText || '').trim();
        const safePublic = stripLinkageStyleTags(stripAiSocialOpsTags(stripAiGroupOpsTags(publicT)));
        if (!publicT) {
          carryInner = mergedInner;
          continue;
        }
        if (!safePublic) continue;
        if (/^\[群备注[:：]/i.test(safePublic)) continue;
        const dice = parseDiceTag(safePublic);
        if (dice) {
          const diceMsg = createMessage({
            chatId,
            senderId: aiSenderId,
            senderName,
            type: 'dice',
            content: `d${dice.sides}=${dice.result}`,
            timestamp: nextTs(),
            metadata: { sides: dice.sides, result: dice.result, aiRoundId, ...(mergedInner ? { innerVoice: mergedInner } : {}) },
          });
          await db.put('messages', diceMsg);
          lastPersisted = diceMsg;
          lastPublic = `[骰子 d${dice.sides}=${dice.result}]`;
          lastAiMessageId = diceMsg.id;
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
            senderId: aiSenderId,
            senderName,
            type: 'text',
            content: itemBody || bundleTitle,
            timestamp: ts - 1,
          };
          const bundle = createMessage({
            chatId,
            senderId: aiSenderId,
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
          lastAiMessageId = bundle.id;
          continue;
        }
        const replyParsed = parseReplyInline(safePublic);
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
            lastPersisted = invMsg;
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
          lastPersisted = invMsg;
          lastAiMessageId = invMsg.id;
        }
      }
      await loadAndRenderMessages();
    };
    try {
      await chatStream(
        payload,
        (_delta, acc) => {
          full = acc;
          latestCleaned = mergeReplyTagContinuations(stripThinkingBlocks(full || ''));
          const completedPieces = splitToBubbleTexts(latestCleaned, { onlyCompleted: true });
          persistQueue = persistQueue.then(async () => {
            if (completedPieces.length > processedPieceCount) {
              const fresh = completedPieces.slice(processedPieceCount);
              processedPieceCount = completedPieces.length;
              await persistPiecesIncrementally(fresh);
            }
            const allPieces = splitToBubbleTexts(latestCleaned);
            const tailRaw = allPieces[allPieces.length - 1] || latestCleaned || '';
            if (bubbleEl) bubbleEl.textContent = stripLinkageStyleTags(tailRaw);
          });
          if (!selecting) scrollMessagesToBottom(messagesEl);
        },
        { signal: currentAbortController.signal }
      );
      await persistQueue;
      const cleaned = latestCleaned || mergeReplyTagContinuations(stripThinkingBlocks(full || '...'));
      const pieces = splitToBubbleTexts(cleaned);
      const remainPieces = pieces.slice(processedPieceCount);
      await persistPiecesIncrementally(remainPieces);
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
      let hadGroupOps = false;
      let hadSocialOps = false;
      if (chat.groupSettings?.allowAiGroupOps) {
        const season = currentUser?.currentTimeline || 'S8';
        const ops = parseAiGroupOps(cleaned);
        const inferredOps = ops.length
          ? []
          : inferGroupOpsFromIntent(cleaned, aiSenderId, season, String(lastUserMsg?.content || ''));
        const debugOn = await isAiOpsDebugEnabled();
        const logs = await executeAiGroupOps({
          ops: [...ops, ...inferredOps],
          actorId: aiSenderId,
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
          hadGroupOps = true;
          await db.put('messages', createMessage({
            chatId,
            senderId: 'system',
            type: 'system',
            content: `AI 群管理动作：${logs.join('；')}`,
          }));
          showToast(`AI 群动作已执行：${logs[0]}`);
        }
        await saveAiDebugSnapshot(chatId, {
          phase: 'after-ops',
          raw: full,
          cleaned,
          taggedOps: ops,
          inferredOps,
          opLogs: logs,
        });
        const socialOps = parseAiSocialOps(cleaned);
        const socialLogs = await executeAiSocialOps({
          ops: socialOps,
          actorId: aiSenderId,
          sourceChat: chat,
          currentUserId: currentUser?.id || '',
        });
        if (socialLogs.length) {
          hadSocialOps = true;
          await db.put('messages', createMessage({
            chatId,
            senderId: 'system',
            type: 'system',
            content: `AI 社交联动：${socialLogs.join('；')}`,
          }));
        }
      }
      const bpLogs = await applyGroupBlueprintTags(currentUser?.id || '', cleaned);
      if (bpLogs.length) {
        showToast(bpLogs[bpLogs.length - 1]);
      }
      if (!hadGroupOps && !hadSocialOps && chat.groupSettings?.allowSocialLinkage !== false) {
        await maybeRunPrivateSocialLinkage({
          userId: currentUser?.id || '',
          actorId: aiSenderId,
          latestPublic: lastPublic || '',
          currentChatId: chatId,
          sourceChat: chat,
          aiLinkageStyleHint: parseLinkageStyleFromAiText(cleaned),
        });
      }
      await maybeRunPrivateMentionLinkage({
        userId: currentUser?.id || '',
        actorId: aiSenderId,
        latestPublic: lastPublic || '',
        currentChatId: chatId,
        sourceChat: chat,
      });
      await loadAndRenderMessages();
    } catch (e) {
      if (String(e?.name || '').toLowerCase().includes('abort')) {
        await persistQueue;
        const cleaned = latestCleaned || stripThinkingBlocks(full || '');
        if (cleaned) {
          const pieces = splitToBubbleTexts(cleaned);
          const remainPieces = pieces.slice(processedPieceCount);
          await persistPiecesIncrementally(remainPieces);
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
      if (!selecting) scrollMessagesToBottom(messagesEl);
    }
  }

  sendBtn.addEventListener('click', () => sendUserText(inputEl.value));
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendUserText(inputEl.value);
    }
  });
  roleSayBtn?.addEventListener('click', async () => {
    if (!aiSenderId || aiSenderId === 'assistant') {
      showToast('当前会话无固定角色');
      return;
    }
    pendingSendAsCharacterId = aiSenderId;
    showToast(`下一条将以「${await resolveName(aiSenderId)}」身份发送，发送后恢复为自己`);
  });
  advanceBtn.addEventListener('click', () => requestAiReply({ reroll: false }));
  rerollBtn.addEventListener('click', () => requestAiReply({ reroll: true }));
  stopBtn.addEventListener('click', () => {
    if (currentAbortController) currentAbortController.abort();
  });
  selectBtn.addEventListener('click', async () => {
    selecting = !selecting;
    selectedIds.clear();
    forwardSelectedBtn.style.display = selecting ? 'inline-flex' : 'none';
    deleteSelectedBtn.style.display = selecting ? 'inline-flex' : 'none';
    await loadAndRenderMessages();
  });
  forwardSelectedBtn.addEventListener('click', async () => {
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
  deleteSelectedBtn.addEventListener('click', async () => {
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
