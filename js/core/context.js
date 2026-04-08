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
const USER_RELATION_KEY = 'userRelationConfig';

export async function assembleContext(chatId, characterIds, userMessage) {
  const user = getState('currentUser') || await loadCurrentUser();
  const season = user?.currentTimeline || 'S8';

  const recentMessages = await getRecentMessages(chatId, 50);
  const worldBookSelectiveBlob = [userMessage, ...recentMessages.slice(-20).map((m) => m.content)]
    .filter(Boolean)
    .join('\n');

  const systemParts = [];

  systemParts.push(await buildWorldContext(season, user, worldBookSelectiveBlob));
  systemParts.push(buildCharacterCards(characterIds, season));
  systemParts.push(buildUserCard(user));
  systemParts.push(await buildAUContext(user));
  systemParts.push(await buildUserRelationContext(user));
  systemParts.push(await buildVirtualTimeContext(user));
  systemParts.push(await buildPresetContext());
  systemParts.push(await buildMemoryContext(chatId, characterIds));
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
async function getMergedWorldBooksForSeason(season, user) {
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

async function buildAUContext(user) {
  if (!user) return '';
  const parts = [];
  if (user.auPreset && user.auPreset !== 'au-custom') {
    const preset = AU_PRESETS.find(a => a.id === user.auPreset);
    if (preset && preset.worldBookOverlay) {
      parts.push(preset.worldBookOverlay);
    }
  }
  if (user.auCustom) {
    parts.push(`[自定义AU设定]\n${user.auCustom}`);
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

async function buildMemoryContext(chatId, characterIds) {
  if (!chatId) return '';

  const user = getState('currentUser') || await loadCurrentUser();
  const currentUserId = user?.id || '';

  const allMemories = await db.getAllByIndex('memories', 'chatId', chatId);
  if (allMemories.length === 0) return '';

  const cidSet = new Set(characterIds || []);
  const filtered = allMemories
    .filter((m) => {
      if (m.userId && m.userId !== currentUserId) return false;
      if (!m.characterId || m.characterId === '') return true;
      return cidSet.size === 0 || cidSet.has(m.characterId);
    })
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .slice(-20);

  if (filtered.length === 0) return '';

  let ctx = '[以下为过往经历中自然沉淀的印象，请在合适时自然带入对话，切勿刻意复述或强调]\n';
  for (const mem of filtered) {
    ctx += `- [${mem.type}] ${mem.content}\n`;
  }
  return ctx;
}

async function getRecentMessages(chatId, limit = 50) {
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

  return deduped.map(m => ({
    role: m.senderId === 'user' ? 'user' : 'assistant',
    content: formatMessageForContext(m),
  }));
}

function formatMessageForContext(msg) {
  return formatMessageForContextHelper(msg);
}

export async function assembleNovelContext(sceneContext, novelText, options = {}) {
  const user = getState('currentUser') || (await loadCurrentUser());
  const season = user?.currentTimeline || 'S8';
  const { chatId, characterIds = [], wordMin = 200, wordMax = 450 } = options;

  const selectiveBlob = [sceneContext, novelText || ''].filter(Boolean).join('\n').slice(-12000);

  const parts = [];
  parts.push(await buildWorldContext(season, user, selectiveBlob));
  parts.push(buildCharacterCards(characterIds, season));
  parts.push(buildUserCard(user));
  parts.push(await buildAUContext(user));
  parts.push(await buildPresetContext());
  parts.push(await buildMemoryContext(chatId, characterIds));

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
    const recent = await getRecentMessages(chatId, 30);
    if (recent.length) {
      const lines = recent.map((m) => `${m.role === 'user' ? '用户' : '对话方'}：${String(m.content || '').slice(0, 200)}`);
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
