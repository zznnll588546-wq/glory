import * as db from './db.js';
import { getState } from './state.js';
import { CHARACTERS, CHARACTER_MAP } from '../data/characters.js';
import { WORLD_BOOKS } from '../data/world-books.js';
import { PROMPTS } from '../data/prompts.js';
import { AU_PRESETS } from '../data/au-presets.js';
import {
  formatMessageForContext as formatMessageForContextHelper,
  getCharacterStateForSeason,
  getDisplayTeamName,
} from './chat-helpers.js';
import { getVirtualNow } from './virtual-time.js';
import { MEMORY_TYPES } from '../models/memory.js';
const USER_RELATION_KEY = 'userRelationConfig';

function formatMemoryTypeLabel(t) {
  return MEMORY_TYPES[t] || t || '条目';
}

async function loadChatPrefsLite(chatId) {
  if (!chatId) return { contextDepth: 200 };
  const row = await db.get('settings', `chatPrefs_${chatId}`);
  return row?.value || { contextDepth: 200 };
}

/** 用于记忆块与会话锚点的中文来源标签 */
function formatChatSourceLabel(chat) {
  if (!chat) return '未知会话';
  const parts = chat.participants || [];
  const userPresent = parts.includes('user');
  if (chat.type === 'private') {
    const pid = parts.find((p) => p && p !== 'user');
    const name = pid ? (CHARACTER_MAP[pid]?.name || pid) : '对方';
    return userPresent ? `私聊（用户 ↔ ${name}）` : `私聊（无用户账号在场 · ${name}）`;
  }
  if (chat.type === 'group') {
    const gn = String(chat.groupSettings?.name || '').trim() || '未命名群聊';
    const observerLike = !!chat.groupSettings?.isObserverMode || !userPresent;
    if (observerLike) return `群聊「${gn}」（旁观 / 无用户账号在场）`;
    return `群聊「${gn}」（用户在场）`;
  }
  return `会话「${chat.id}」`;
}

/**
 * 强约束：当前 API 请求的「对话窗口」是哪一种（私聊/有用户群聊/无用户群聊），
 * 并与紧随其后的 user/assistant 消息记录严格对应。
 */
function buildChatSceneDirectives(chat, user, characterIds = []) {
  const uname = user?.name || '用户';
  const label = formatChatSourceLabel(chat);
  const ids = (characterIds || []).filter((x) => x && x !== 'user');
  const roster = ids.length ? ids.map((id) => CHARACTER_MAP[id]?.name || id).join('、') : '（按会话成员）';

  if (!chat?.id) {
    return `[当前对话窗口 · 场景锚定]
未解析到会话存档：仍按「线上聊天」演绎，但不要假设群聊/私聊，除非文本自证。`;
  }

  const partsList = chat.participants || [];
  const userPresent = partsList.includes('user');
  const isGroup = chat.type === 'group';
  const observerLike = isGroup && (!!chat.groupSettings?.isObserverMode || !userPresent);

  let body = `[当前对话窗口 · 场景锚定 · 最高优先级]
本会话标识：${label}
本轮参与建模的角色（节选）：${roster}

[与下方消息记录的关系]
- 紧随本说明之后、在 API 消息数组中出现的 user/assistant 轮次，全部且仅来自上述「本会话」聊天记录；不得把其误读为其它群、其它私聊窗口或公开论坛。
- 不要把「本会话」里的用户发言挪用到未在场的旁听者口中；不要在无依据时假设群成员已知晓另一私聊里的细节。

`;

  if (!isGroup && userPresent) {
    body += `[私聊（用户在场）· 演绎规范]
- 这是与用户「${uname}」一对一私聊（类微信私聊窗口），对方就是正在打字回复你的真人用户。
- 语气与信息尺度按「两人之间」处理：可更直接、更私密，但不要突然改成群聊口吻（例如「各位」「群里说下」），除非剧情明确要转发/拉群。
- 引用回忆时：优先承接「本私聊」内已发生内容；若使用下方 [上下文记忆] 中标注为其它会话的条目，必须给出合理获知路径（对方向你提过、公开事件、群公告等），禁止凭空全知另一私聊未公开细节。
`;
  } else if (isGroup && userPresent && !observerLike) {
    const gn = String(chat.groupSettings?.name || '').trim() || '本群';
    body += `[群聊（用户在场）· 演绎规范]
- 当前为群聊「${gn}」，用户「${uname}」在群内，消息列表是群聊公屏记录。
- 输出要像多人同屏：允许互相接话、岔开、忽略、点名；不要写成只有两个人私聊而把其他人当空气（除非当下剧情冷场）。
- 私聊侧信息预设群友「未听见」：不要默认全员知晓用户与某角色私聊内容，除非已在剧情里公开、转述或截图。
- 引用记忆时：标注为「当前群聊」来源的可直接作共同背景；标注为「其它私聊」的仅作你个人所知，公屏发言时要符合信息边界。
`;
  } else if (isGroup && observerLike) {
    const gn = String(chat.groupSettings?.name || '').trim() || '本群';
    body += `[群聊（旁观 / 无用户账号在场）· 演绎规范]
- 当前为群聊「${gn}」，但用户账号不在此会话成员中，和/或处于旁观模式：消息列表主要是角色之间互动。
- 不要虚构用户「${uname}」在本窗口打字、抢麦、发图，除非历史记录里确有 user 消息或系统明确插入。
- 以角色群像为主；用户若在剧情上「在场」，应通过叙事说明其如何出现，而不是默认微信群里多了一个 user 气泡。
`;
  } else if (!userPresent && chat.type === 'private') {
    body += `[私聊（无用户账号在场）· 演绎规范]
- 此会话为用户与某一角色之外的私聊窗口变体（用户未加入参与者列表）：不要假设用户正在本窗口发言。
- 按记录中实际出现的发言者演绎即可。
`;
  }

  body += `[上下文记忆块约定]
- 下方若出现 [上下文记忆 · 按来源会话分类]，不同「=== 来源：… ===」之间禁止混读为同一场景；续写时默认只与「标记为当前会话」块无缝衔接。
`;
  return body;
}

export async function assembleContext(chatId, characterIds, userMessage) {
  const user = getState('currentUser') || await loadCurrentUser();
  const season = user?.currentTimeline || 'S8';
  const chat = chatId ? await db.get('chats', chatId) : null;
  const chatPrefs = await loadChatPrefsLite(chatId);
  const contextDepth = Math.max(20, Math.min(800, Number(chatPrefs.contextDepth || 200)));

  const recentMessages = await getRecentMessages(chatId, contextDepth, user);
  const worldBookSelectiveBlob = [userMessage, ...recentMessages.slice(-20).map((m) => m.content)]
    .filter(Boolean)
    .join('\n');

  const systemParts = [];

  systemParts.push(await buildWorldContext(season, user, worldBookSelectiveBlob));
  systemParts.push(buildCharacterCards(characterIds, season));
  systemParts.push(buildUserCard(user));
  systemParts.push(buildChatSceneDirectives(chat, user, characterIds));
  systemParts.push(await buildAUContext(user));
  systemParts.push(await buildUserRelationContext(user));
  systemParts.push(await buildVirtualTimeContext(user));
  systemParts.push(await buildPresetContext());
  systemParts.push(await buildLayeredMemoryContext(chat, characterIds, user, chatId));
  systemParts.push(buildRoleplayDirectives());

  const systemPrompt = systemParts.filter(Boolean).join('\n\n---\n\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    ...recentMessages,
  ];

  if (userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }

  return messages;
}

async function buildVirtualTimeContext(user) {
  const userId = user?.id || '';
  const now = await getVirtualNow(userId, Date.now());
  const iso = new Date(now).toISOString().replace('T', ' ').slice(0, 16);
  return `[世界内时间]\n当前世界时间以存档日程为准：${iso}\n规则：所有“今天/明天/昨晚/本周”等时间表达，优先基于该世界时间推断，不要按现实系统时间臆测。\n补充：遇到“差一点/一点点/发晕一点才想起”这类口语，默认是程度表达，不要误判为“凌晨一点”。`;
}

export async function estimateChatTokens(chatId, characterIds = [], depth = 120) {
  const messages = await assembleContext(chatId, characterIds, '');
  const limited = limitMessagesByDepth(messages, depth);
  const totalChars = limited.reduce((sum, m) => sum + String(m.content || '').length, 0);
  return {
    estimatedInputTokens: Math.max(1, Math.ceil(totalChars / 2.2)),
    sampledMessages: limited.length,
    sampledChars: totalChars,
  };
}

async function getHiddenWorldBookIds() {
  const row = await db.get('settings', 'worldBookHiddenIds');
  const v = row?.value;
  return new Set(Array.isArray(v) ? v : []);
}

function seasonMatchesWorldBook(wbSeason, season) {
  const s = wbSeason == null || wbSeason === '' ? 'all' : String(wbSeason);
  if (s === 'all') return true;
  return s.split(',').map((x) => x.trim()).includes(season);
}

/** 与 SillyTavern 类似：selective 且有关键词时，仅当对话文本命中其一才注入 */
function selectiveMatchesWorldBook(wb, textBlob) {
  if (!wb || !wb.selective) return true;
  const keys = wb.keys || [];
  if (!keys.length) return true;
  const lower = String(textBlob || '').toLowerCase();
  return keys.some((k) => lower.includes(String(k).toLowerCase()));
}

/**
 * 合并 IndexedDB 与内置种子（与世界书页逻辑一致），按赛季与用户过滤；尊重隐藏与 enabled。
 */
export async function getMergedWorldBooksForSeason(season, user) {
  const hidden = await getHiddenWorldBookIds();
  const stored = await db.getAll('worldBooks');
  const userId = user?.id || null;

  const byId = new Map(stored.map((e) => [e.id, { ...e }]));
  for (const seed of WORLD_BOOKS) {
    if (!byId.has(seed.id)) {
      byId.set(seed.id, { ...seed });
    }
  }

  const all = [...byId.values()];
  const groupEnabledMap = new Map();
  const bookEnabledMap = new Map();
  for (const e of all) {
    if (e?.kind === 'group') {
      groupEnabledMap.set(e.id, e.enabled !== false);
      if (e.isBookRoot) {
        bookEnabledMap.set(e.id, e.enabled !== false);
      }
    }
  }

  return all
    .filter((e) => {
      if (e?.kind === 'group') return false;
      if (hidden.has(e.id)) return false;
      if (e.enabled === false) return false;
      if (e.groupId && groupEnabledMap.has(e.groupId) && groupEnabledMap.get(e.groupId) === false) return false;
      if (e.bookId && bookEnabledMap.has(e.bookId) && bookEnabledMap.get(e.bookId) === false) return false;
      if (e.userId && userId && e.userId !== userId) return false;
      if (e.userId && !userId) return false;
      if (!seasonMatchesWorldBook(e.season, season)) return false;
      return true;
    })
    .sort(
      (a, b) =>
        (a.position ?? 0) - (b.position ?? 0) ||
        String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN')
    );
}

async function buildWorldContext(season, user, textForSelective = '') {
  const worldBooks = await getMergedWorldBooksForSeason(season, user);
  const constantBooks = worldBooks.filter((wb) => wb.constant);
  const relevantBooks = worldBooks
    .filter((wb) => !wb.constant)
    .filter((wb) => selectiveMatchesWorldBook(wb, textForSelective));

  let ctx = `[当前时间线: ${season}]\n[绝对规则] 严禁引用当前赛季(${season})之后发生的任何事件、身份变动、转会、退役或剧情信息。所有角色的称呼、账号卡、所属战队必须严格匹配${season}时期的状态。\n\n`;
  for (const wb of constantBooks) {
    ctx += String(wb.content || '').replace('{currentSeason}', season) + '\n\n';
  }

  const overrides = user?.worldLineOverrides || {};
  if (Object.keys(overrides).length > 0) {
    ctx += '\n[用户自定义世界线覆盖]\n';
    for (const [key, val] of Object.entries(overrides)) {
      if (val) ctx += `${key}: ${val}\n`;
    }
  }

  for (const wb of relevantBooks) {
    ctx += String(wb.content || '') + '\n\n';
  }

  return ctx;
}

async function getUserRelationBundle(userId) {
  if (!userId) return { profile: {}, relations: {} };
  const row = await db.get('settings', USER_RELATION_KEY);
  const byUserId = row?.value?.byUserId || {};
  const pack = byUserId[userId] || {};
  return {
    profile: pack.profile || {},
    relations: pack.relations || {},
  };
}

async function buildUserRelationContext(user) {
  if (!user?.id) return '';
  const pack = await getUserRelationBundle(user.id);
  const profile = pack.profile || {};
  const relations = pack.relations || {};
  const tags = Array.isArray(profile.tags) ? profile.tags.filter(Boolean).slice(0, 6) : [];
  const attr = profile.attributes || {};
  const keys = Object.keys(relations).slice(0, 24);
  const rank = keys
    .map((cid) => {
      const r = relations[cid] || {};
      const name = CHARACTER_MAP[cid]?.name || cid;
      const a = Number(r.affection || 0);
      const d = Number(r.desire || 0);
      const b = Number(r.bond || 0);
      return { name, a, d, b, score: a + b + d * 0.5, known: r.known === true };
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, 8);
  const lines = rank.map((r) => `${r.name}: 好感${r.a}/欲望${r.d}/关系${r.b}${r.known ? '' : '（未结识）'}`);
  const mode = String(profile.spotlightMode || 'normal');
  const thresholds = profile.behaviorThresholds || {};
  const highTh = Math.max(0, Math.min(100, Number(thresholds.high ?? 70)));
  const lowTh = Math.max(0, Math.min(100, Number(thresholds.low ?? 35)));
  const modeDirective =
    mode === 'charm'
      ? `[- 关系模式: 万人迷]
- 所有合适年龄且外表出众角色都可能将注意力投向用户，但表达方式必须符合其性格、身份、社会关系与处境
- 即使倾慕也有差异：克制守礼、暗自竞争、吃醋嘴硬、冷眼旁观、试探撬墙角皆可
- 导向允许多人暧昧与复杂关系并存，但角色首先是“他们自己”而非恋爱工具人`
      : mode === 'dislike'
      ? `[- 关系模式: 万人嫌]
- 角色可对用户有偏见/误读/抵触，但应以现实社交方式表达：客气疏离、阴阳内敛、减少投入
- 禁止极端羞辱与无因失控；冲突应有情境依据并保留体面边界`
      : mode === 'lowkey'
      ? `[- 关系模式: 小透明]
- 多数角色对用户初期注意力有限，关系推进靠长期互动和事件积累，不要突然强关注`
      : `[- 关系模式: 普通]
- 按人物关系网自然推进，多视角观察用户，不把所有剧情都收束为单线恋爱`;
  const keyRoleDirectives = `[关键角色/群像细化]
- 黄少天：可外热内冷；不熟时看似话多但保持距离与试探，互动可能在表层打转
- 老一辈/前辈选手：对后辈普遍更宽容，批评更偏指导性，较少幼稚化对抗
- 首发/位置竞争关系：存在竞争时优先体现职业理性与资源博弈，不要直接人身攻击
- 伪群像原则：角色之间也要彼此互动、互相评价与联动，不可把所有人写成围着用户转的孤岛
- 修罗场表达：可有“朋友+同事+情感冲突”三角张力，但需顾及团队氛围、职业名誉与个人边界`;
  const matrixDirective = `[行为策略矩阵]
- 档位判定：高档(好感>=${highTh} 或 关系>=${highTh})；低档(好感<=${lowTh} 且 关系<=${lowTh})；其余中档
- 私聊：高档=更主动更温和；中档=自然礼貌；低档=克制、简短、疏离但保持体面
- 群聊：高档=愿接话与维护；中档=公事公办；低档=减少点名互动，避免公开羞辱
- 微博/论坛：高档=轻维护/友好互动；中档=中立观望；低档=谨慎表达分歧，禁止人身攻击
- 对讨厌对象的成熟表达：可以冷处理、延迟回应、减少私下投入，但不得霸凌或威胁`;
  const apm = Number(attr.handSpeedApm || attr.handSpeed || 320);
  return `[与用户关系进度（按当前存档隔离）]
用户标签: ${(tags.join('、') || '无')}
用户属性: 手速APM${apm} 外貌${Number(attr.appearance || 0)} 人缘${Number(attr.popularity || 0)} 作风${Number(attr.style || 0)} 天赋${Number(attr.talent || 0)}
用户背景: 出身${profile.hometown || '未知'} 出道赛季${profile.debutSeason || '未知'} 初始人设${profile.initialPersona || '普通'}
关系榜(节选):
${lines.join('\n') || '暂无关系数据'}
规则:
- 三条数值语义：好感=真实心理好感，欲望=爱欲驱动，关系=当前现实关系
- 未结识角色默认不要表现为熟络；仅在合理事件后升级关系
- 互动频率和语气应受三条数值影响，且必须符合角色性格
- 若你判断本轮应出现明确数值变化，可在文本中附一段简短标记（任意位置均可）：
  [关系变动: 好感+N 欲望+N 关系+N]
  仅在有明确推进/冲突时使用；小波动可不写。N 可为小数，可正可负
- 成熟社交边界：即使低好感/看不顺眼，也应优先维持基本礼貌与职业体面；可冷淡、疏离、减少主动，但禁止霸凌、羞辱、威胁、失控攻击
- 冲突表达应节制且具体：通过观点分歧、语气距离、回应延迟体现，不要使用夸张暴走或超雄化行为
${modeDirective}
${matrixDirective}
${keyRoleDirectives}`;
}

function buildCharacterCards(characterIds, season) {
  if (!characterIds || characterIds.length === 0) return '';
  const cards = [];
  for (const cid of characterIds) {
    if (cid === 'user') continue;
    const char = CHARACTER_MAP[cid];
    if (!char) continue;
    const state = getCharacterStateForSeason(char, season);
    const displayName = state.publicName || char.name;
    cards.push(`[角色卡: ${displayName}]
真名: ${char.realName}
当前赛季公开称呼: ${displayName}
账号卡: ${state.card || '无'}
职业: ${state.class || '无'}
战队: ${getDisplayTeamName(state.team)}
身份: ${state.role || '无'}
状态: ${state.status || '未知'}
性格: ${char.personality}
说话风格: ${char.speechStyle}
别名: ${(char.aliases || []).join(', ')}
规则: 你必须严格使用上面列出的"当前赛季公开称呼"和"账号卡"作为自己的身份。严禁引用${season}之后发生的任何事件、身份变动、转会或退役信息。`);
  }
  return cards.join('\n\n');
}

function buildUserCard(user) {
  if (!user) return '';
  return `[用户角色卡]
名称: ${user.name}
简介: ${user.bio || '无'}
所属俱乐部: ${user.selectedTeam || '无'}`;
}

async function appendAuBoundWorldBookChunks(user, season) {
  const ids = Array.isArray(user?.auBoundWorldBookIds) ? [...new Set(user.auBoundWorldBookIds.filter(Boolean))] : [];
  if (!ids.length) return [];
  const merged = await getMergedWorldBooksForSeason(season, user);
  const map = new Map(merged.map((e) => [e.id, e]));
  const chunks = [];
  for (const id of ids) {
    const wb = map.get(id);
    if (!wb || wb.enabled === false) continue;
    const body = String(wb.content || '').trim();
    if (!body) continue;
    chunks.push(`[AU绑定世界书 · ${wb.name || id}]\n${body}`);
  }
  return chunks;
}

async function buildAUContext(user) {
  if (!user) return '';
  const parts = [];
  const season = user.currentTimeline || 'S8';
  if (user.auPreset && user.auPreset !== 'au-custom') {
    const preset = AU_PRESETS.find(a => a.id === user.auPreset);
    if (preset && preset.worldBookOverlay) {
      parts.push(preset.worldBookOverlay);
    }
  }
  if (user.auCustom) {
    parts.push(`[自定义AU设定]\n${user.auCustom}`);
  }
  const boundChunks = await appendAuBoundWorldBookChunks(user, season);
  for (const c of boundChunks) {
    parts.push(c);
  }
  const wlo = user.worldLineOverrides || {};
  const wloLines = [];
  if (wlo.championSeason || wlo.championTeam) {
    wloLines.push(`冠军覆盖：${wlo.championSeason || '某赛季'} 由 ${wlo.championTeam || '（未指定战队）'} 夺冠`);
  }
  if (wlo.season9Champion) {
    wloLines.push(`第九赛季冠军：${wlo.season9Champion}`);
  }
  if (wlo.suMuQiuAlive === true) {
    const roleText = wlo.suMuQiuRole === 'player'
      ? '并以嘉世选手身份出现'
      : wlo.suMuQiuRole === 'staff'
        ? '并以嘉世技术人员身份出现'
        : '（身份待剧情确定）';
    wloLines.push(`苏沐秋存活，${roleText}`);
  } else if (wlo.suMuQiuAlive === false) {
    wloLines.push('苏沐秋未存活（沿原线）');
  }
  if (wlo.yeXiuStayedInJiashi) {
    wloLines.push('叶修留在嘉世线：不触发离队创业分支');
  }
  if (wlo.jiashiNeverCollapsed) {
    wloLines.push('嘉世未倒闭：默认不建立兴欣战队线');
  }
  if (wlo.sunZhepingNeverRetired) {
    wloLines.push('孙哲平未退役：持续以职业选手身份活跃');
  }
  if (wlo.specialDetails) {
    wloLines.push(`特殊细节：${String(wlo.specialDetails)}`);
  }
  if (wloLines.length) {
    parts.push(`[虚拟世界线覆盖]\n${wloLines.map((x) => `- ${x}`).join('\n')}\n规则：将以上覆盖视为当前存档事实，所有对话、社交与剧情生成必须遵守。`);
  }
  return parts.join('\n\n');
}

async function buildPresetContext() {
  const parts = [];
  const chatPreset = await db.get('settings', 'preset_online_chat');
  if (chatPreset?.value?.content) {
    parts.push(chatPreset.value.content);
  } else if (PROMPTS.online_chat) {
    parts.push(PROMPTS.online_chat.content);
  }

  const behavioralPreset = await db.get('settings', 'preset_behavioral_patch');
  if (behavioralPreset?.value?.content) {
    parts.push(behavioralPreset.value.content);
  } else if (PROMPTS.behavioral_patch) {
    parts.push(PROMPTS.behavioral_patch.content);
  }

  const boundaryPreset = await db.get('settings', 'preset_adult_boundaries');
  if (boundaryPreset?.value?.content) {
    parts.push(boundaryPreset.value.content);
  } else if (PROMPTS.adult_boundaries) {
    parts.push(PROMPTS.adult_boundaries.content);
  }

  const continuityPreset = await db.get('settings', 'preset_narrative_continuity');
  if (continuityPreset?.value?.content) {
    parts.push(continuityPreset.value.content);
  } else if (PROMPTS.narrative_continuity) {
    parts.push(PROMPTS.narrative_continuity.content);
  }

  return parts.join('\n\n');
}

function filterMemoriesForContext(memories, currentUserId, cidSet) {
  return memories.filter((m) => {
    if (m.userId && m.userId !== currentUserId) return false;
    if (!m.characterId || m.characterId === '') return true;
    return cidSet.size === 0 || cidSet.has(m.characterId);
  });
}

/**
 * 按「来源会话」分块注入记忆：当前会话 + 同用户下其它私聊/群聊的少量近期沉淀，避免混读。
 * @param {string} [fallbackChatId] 当 chat 记录缺失时仍用该 id 拉取本会话记忆
 */
async function buildLayeredMemoryContext(chat, characterIds, user, fallbackChatId = '') {
  const currentChatId = chat?.id || String(fallbackChatId || '').trim();
  if (!currentChatId) return '';

  const currentUserId = user?.id || '';
  const cidSet = new Set(characterIds || []);

  async function sliceForChat(chatId, limit) {
    const all = await db.getAllByIndex('memories', 'chatId', chatId);
    const filtered = filterMemoriesForContext(all, currentUserId, cidSet)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      .slice(-limit);
    return filtered;
  }

  const currentLabel = chat ? formatChatSourceLabel(chat) : `会话「${currentChatId}」（未能加载会话元数据 · 记忆仍按此会话归属）`;
  const currentSlice = await sliceForChat(currentChatId, 22);

  const header =
    '[上下文记忆 · 按来源会话分类]\n' +
    '规则：每个「=== 来源：… ===」块对应不同聊天窗口沉淀的记忆。写作时默认只与「（当前 API 正在续写的会话）」块无缝延续；引用「非当前会话」块须有合理获知路径，禁止角色无依据全知另一私聊未公开内容。若出现「与当前群/窗有共同角色」的跨窗记忆块，共同在场的角色可以合理记得在彼处聊过的事（用户提起时更要接住话题）。自然融入，不要机械复述清单。\n';

  let ctx = header;
  const seen = new Set();
  const pushMemoryLine = (mem) => {
    const raw = String(mem?.content || '').trim();
    if (!raw) return '';
    const key = raw.replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(key)) return '';
    seen.add(key);
    return `- [${formatMemoryTypeLabel(mem.type)}] ${raw}\n`;
  };
  ctx += `\n=== 来源：${currentLabel}（当前 API 正在续写的会话）===\n`;
  if (!currentSlice.length) {
    ctx += '（本会话暂无沉淀记忆）\n';
  } else {
    for (const mem of currentSlice) {
      ctx += pushMemoryLine(mem);
    }
  }

  if (!currentUserId) return ctx;

  const allChats = await db.getAllByIndex('chats', 'userId', currentUserId);

  function chatSharesAnyAiMember(other) {
    if (!cidSet.size || !Array.isArray(other?.participants)) return false;
    return other.participants.some((p) => p && p !== 'user' && cidSet.has(p));
  }

  const siblingChats = allChats
    .filter(
      (c) =>
        c.id !== currentChatId
        && Array.isArray(c.participants)
        && c.participants.includes('user')
        && (c.type === 'group' || c.type === 'private')
        && chatSharesAnyAiMember(c),
    )
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
    .slice(0, 5);

  const siblingIds = new Set(siblingChats.map((c) => c.id));

  if (siblingChats.length && cidSet.size > 0) {
    ctx +=
      '\n=== 来源：其它会话 · 与当前窗口有「共同 AI 角色」（跨群/跨窗记忆 · 可衔接话题）===\n' +
      '说明：下列记忆来自另一群聊或私聊，但其中至少有一名角色也在当前窗口参与者中。用户若在群里提起「在别的群/私聊说过的事」，这些角色应能自然承接；勿写成完全失忆，也不要编造未发生的细节。\n';
    for (const oc of siblingChats) {
      const slice = await sliceForChat(oc.id, 8);
      if (!slice.length) continue;
      const lab = formatChatSourceLabel(oc);
      ctx += `\n--- ${lab} ---\n`;
      for (const mem of slice) {
        ctx += pushMemoryLine(mem);
      }
    }
  }

  const others = allChats
    .filter(
      (c) =>
        c.id !== currentChatId
        && Array.isArray(c.participants)
        && c.participants.includes('user')
        && !siblingIds.has(c.id),
    )
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
    .slice(0, 6);

  for (const oc of others) {
    const slice = await sliceForChat(oc.id, 4);
    if (!slice.length) continue;
    const lab = formatChatSourceLabel(oc);
    ctx += `\n=== 来源：${lab}（非当前会话 · 仅供参考）===\n`;
    for (const mem of slice) {
      ctx += pushMemoryLine(mem);
    }
  }

  // 线下总结记忆单列，确保可注入（同样经过去重）
  const offlines = (await db.getAll('memories'))
    .filter((m) => (!m.userId || m.userId === currentUserId) && m.source === 'offline-summary')
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .slice(-10);
  if (offlines.length) {
    ctx += '\n=== 来源：线下相遇总结记忆（跨会话）===\n';
    for (const mem of offlines) {
      const line = pushMemoryLine(mem);
      if (line) ctx += line;
    }
  }

  return ctx;
}

async function getRecentMessages(chatId, limit = 50, userForLabel = null) {
  const allMessages = await db.getAllByIndex('messages', 'chatId', chatId);
  const sorted = allMessages
    .filter(m => !m.deleted && !m.recalled)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-limit);
  const deduped = [];
  const seen = new Set();
  for (const m of sorted) {
    const key = `${m.senderId}|${m.type}|${(m.content || '').trim()}|${m.replyTo || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
  }

  const uName = String(userForLabel?.name || '').trim();
  return deduped.map(m => ({
    role: m.senderId === 'user' ? 'user' : 'assistant',
    content: formatMessageForContextHelper(m, uName),
  }));
}

export async function assembleNovelContext(sceneContext, novelText, options = {}) {
  const user = getState('currentUser') || (await loadCurrentUser());
  const season = user?.currentTimeline || 'S8';
  const { chatId, characterIds = [], wordMin = 200, wordMax = 450 } = options;
  const chat = chatId ? await db.get('chats', chatId) : null;

  const selectiveBlob = [sceneContext, novelText || ''].filter(Boolean).join('\n').slice(-12000);

  const parts = [];
  parts.push(await buildWorldContext(season, user, selectiveBlob));
  parts.push(buildCharacterCards(characterIds, season));
  parts.push(buildUserCard(user));
  parts.push(buildChatSceneDirectives(chat, user, characterIds));
  parts.push(await buildAUContext(user));
  parts.push(await buildPresetContext());
  parts.push(await buildLayeredMemoryContext(chat, characterIds, user, chatId || ''));

  const novelPreset = await db.get('settings', 'preset_cinematic_filler');
  if (novelPreset?.value?.content) {
    parts.push(novelPreset.value.content);
  } else if (PROMPTS.cinematic_filler) {
    parts.push(PROMPTS.cinematic_filler.content);
  }

  const novelModePreset = await db.get('settings', 'preset_novel_mode');
  if (novelModePreset?.value?.content) {
    parts.push(novelModePreset.value.content);
  } else if (PROMPTS.novel_mode) {
    parts.push(PROMPTS.novel_mode.content);
  }

  if (sceneContext) {
    parts.push(`[当前场景设定]\n${sceneContext}`);
  }

  if (characterIds.length) {
    parts.push(`[线下同行角色ID] ${characterIds.join('、')}`);
  }

  if (chatId) {
    const recent = await getRecentMessages(chatId, 30, user);
    if (recent.length) {
      const uname = String(user?.name || '').trim() || '我';
      const lines = recent.map((m) => `${m.role === 'user' ? uname : '对话方'}：${String(m.content || '').slice(0, 200)}`);
      parts.push(`[来自线上聊天的近期片段（供衔接线下，勿逐句复述）]\n${lines.join('\n')}`);
    }
  }

  const systemPrompt = parts.filter(Boolean).join('\n\n---\n\n');

  const messages = [{ role: 'system', content: systemPrompt }];

  if (novelText) {
    messages.push({ role: 'assistant', content: novelText });
  }

  messages.push({
    role: 'user',
    content: `请继续推进剧情。本次新增篇幅控制在约 ${wordMin}～${wordMax} 字，第三人称小说正文，不要输出标题或旁白式说明。`,
  });

  return messages;
}

async function resolveWorldBookEntryById(id) {
  if (!id) return null;
  const stored = await db.get('worldBooks', id);
  if (stored) return stored;
  return WORLD_BOOKS.find((w) => w.id === id) || null;
}

/**
 * 论坛 AI 生成：与聊天一致叠加时间线世界书、用户卡、AU、各预设，并追加微博/论坛预设与可选绑定世界书全文。
 */
export async function buildForumAiSystemPrompt(user, season, options = {}) {
  const { worldBookId = null, referenceNotes = '' } = options;
  const parts = [];
  if (user) {
    parts.push(await buildWorldContext(season, user, String(referenceNotes || '')));
    parts.push(buildUserCard(user));
    parts.push(await buildAUContext(user));
    parts.push(await buildUserRelationContext(user));
  } else {
    parts.push(`[当前时间线: ${season}]\n（未选择用户档案：仅使用下方全局与绑定世界书，无个人用户卡）`);
  }
  parts.push(await buildPresetContext());

  const wfSetting = await db.get('settings', 'preset_weibo_forum');
  if (wfSetting?.value?.content) {
    parts.push(wfSetting.value.content);
  } else if (PROMPTS.weibo_forum) {
    parts.push(PROMPTS.weibo_forum.content);
  }

  if (worldBookId) {
    const wb = await resolveWorldBookEntryById(worldBookId);
    if (wb) {
      const nm = wb.name || worldBookId;
      const k =
        Array.isArray(wb.keys) && wb.keys.length ? ` · 关键词：${wb.keys.slice(0, 16).join('、')}` : '';
      parts.push(`[论坛版块绑定世界书 · 生成须与此设定一致]\n《${nm}》${k}\n\n${String(wb.content || '').trim()}`);
    }
  }

  if (String(referenceNotes || '').trim()) {
    parts.push(`[用户本次补充参考]\n${String(referenceNotes).trim()}`);
  }

  return parts.filter(Boolean).join('\n\n---\n\n');
}

/**
 * 微博 AI 生成：叠加时间线世界书、用户卡、AU、预设，并支持微博专用世界书绑定。
 */
export async function buildWeiboAiSystemPrompt(user, season, options = {}) {
  const { worldBookId = null, referenceNotes = '' } = options;
  const parts = [];
  if (user) {
    parts.push(await buildWorldContext(season, user, String(referenceNotes || '')));
    parts.push(buildUserCard(user));
    parts.push(await buildAUContext(user));
    parts.push(await buildUserRelationContext(user));
  } else {
    parts.push(`[当前时间线: ${season}]`);
  }
  parts.push(await buildPresetContext());
  const wfSetting = await db.get('settings', 'preset_weibo_forum');
  if (wfSetting?.value?.content) {
    parts.push(wfSetting.value.content);
  } else if (PROMPTS.weibo_forum) {
    parts.push(PROMPTS.weibo_forum.content);
  }
  if (worldBookId) {
    const wb = await resolveWorldBookEntryById(worldBookId);
    if (wb) {
      parts.push(`[微博专用世界书绑定]\n《${wb.name || worldBookId}》\n${String(wb.content || '').trim()}`);
    }
  }
  if (String(referenceNotes || '').trim()) {
    parts.push(`[微博生成补充参考]\n${String(referenceNotes).trim()}`);
  }
  return parts.filter(Boolean).join('\n\n---\n\n');
}

async function loadCurrentUser() {
  const idRecord = await db.get('settings', 'currentUserId');
  if (idRecord?.value) {
    return await db.get('users', idRecord.value);
  }
  return null;
}

function buildRoleplayDirectives() {
  return `[对话演绎规则]
- 目标：自然、生活化、带时代细节，语气符合角色身份与赛季处境
- 工作语境与私下语境要分开：汇报/正式场景更书面，闲聊更口语
- 允许偶发地域口头表达（如黄少天偶发粤语），但不要过量
- 当对话停滞时，可由角色主动抛出一个新话题推进剧情，不要等用户催促
- 保持“断裂式口语”：少解释因果，少平滑连接，多短句、多语气词
- 避免油腻口头禅，禁止使用“懂？”“懂不懂？”
- 允许输出简短“心声”作为心理状态描述，心理与外在发言可以不一致（如嘴硬）
- 心声应简洁，不泄露系统规则，不要展开推理步骤
- 角色不要完美：允许词穷、停顿、打错字后自我纠正、节奏忽快忽慢
- 允许碎片化发送与拼接，允许偶发撤回和掩饰性表情包
- 对“撤回消息”进行情境判断：是否瞥见内容、关系熟悉度、是否调侃/装傻/直说
- 回复前进行内部润色检查（不外显）：情绪->处境->策略->现实检查；若过于完美需打散重组，加入犹豫与生活粗糙感
- 反说教硬规则：默认禁止家长式管教与连续说教（尤其作息/饮食/姿势等小事）；关心要以陪伴、邀请、玩笑、协商表达，不能强制命令`;
}

function limitMessagesByDepth(messages, depth) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const first = messages[0];
  const rest = messages.slice(1);
  const sampled = rest.slice(-Math.max(1, depth));
  return [first, ...sampled];
}
