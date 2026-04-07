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

  return [...byId.values()]
    .filter((e) => {
      if (hidden.has(e.id)) return false;
      if (e.enabled === false) return false;
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

  let systemPrompt = `[当前时间线: ${season}]\n\n`;

  const novelPreset = await db.get('settings', 'preset_cinematic_filler');
  if (novelPreset?.value?.content) {
    systemPrompt += novelPreset.value.content + '\n\n';
  } else if (PROMPTS.cinematic_filler) {
    systemPrompt += PROMPTS.cinematic_filler.content + '\n\n';
  }

  const novelModePreset = await db.get('settings', 'preset_novel_mode');
  if (novelModePreset?.value?.content) {
    systemPrompt += novelModePreset.value.content + '\n\n';
  } else if (PROMPTS.novel_mode) {
    systemPrompt += PROMPTS.novel_mode.content + '\n\n';
  }

  if (sceneContext) {
    systemPrompt += `[当前场景设定]\n${sceneContext}\n\n`;
  }

  if (characterIds.length) {
    systemPrompt += `[线下同行角色ID] ${characterIds.join('、')}\n`;
    systemPrompt += buildCharacterCards(characterIds, season) + '\n\n';
  }

  if (chatId) {
    const recent = await getRecentMessages(chatId, 30);
    if (recent.length) {
      const lines = recent.map((m) => `${m.role === 'user' ? '用户' : '对话方'}：${String(m.content || '').slice(0, 200)}`);
      systemPrompt += `[来自线上聊天的近期片段（供衔接线下，勿逐句复述）]\n${lines.join('\n')}\n\n`;
    }
  }

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
- 回复前进行内部润色检查（不外显）：情绪->处境->策略->现实检查；若过于完美需打散重组，加入犹豫与生活粗糙感`;
}

function limitMessagesByDepth(messages, depth) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const first = messages[0];
  const rest = messages.slice(1);
  const sampled = rest.slice(-Math.max(1, depth));
  return [first, ...sampled];
}
