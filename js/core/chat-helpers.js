import { TEAMS } from '../data/teams.js';
import { CHARACTERS } from '../data/characters.js';
import * as db from './db.js';
import { createMessage } from '../models/chat.js';
import { sanitizeStickerDisplayName } from './sticker-sanitize.js';
import { getState } from './state.js';

export { sanitizeStickerDisplayName };

/** 私聊会话中对端角色 id（不含 user） */
export function getPrivateChatPartnerId(chat) {
  if (!chat || chat.type !== 'private') return '';
  const parts = chat.participants || [];
  return parts.find((p) => p && p !== 'user') || '';
}

/** 解析角色显示名（IndexedDB 覆盖静态表） */
export async function resolveChatParticipantName(id) {
  if (!id || id === 'user') return '我';
  const stored = await db.get('characters', id);
  if (stored?.name) return stored.name;
  const fromData = CHARACTERS.find((x) => x.id === id);
  return fromData?.name || id;
}

/**
 * 转发/分享时选择会话的列表文案（群名 / 私聊·对端名）
 * @param {(id: string) => Promise<string>|string} [resolveName] 默认 resolveChatParticipantName
 */
export async function formatChatPickerLabel(chat, resolveName) {
  const res = typeof resolveName === 'function' ? resolveName : resolveChatParticipantName;
  if (!chat) return '会话';
  if (chat.type === 'group') {
    const gn = String(chat.groupSettings?.name || '').trim();
    return gn || '群聊';
  }
  if (chat.type === 'private') {
    const pid = getPrivateChatPartnerId(chat);
    if (!pid) return '私聊';
    const nm = String(await res(pid)).trim();
    return `私聊 · ${nm || pid}`;
  }
  return String(chat.type || '会话');
}

/** 气泡内展示用：隐藏群跟进私聊里给用户看的「（关于某某）」等后缀 */
export function formatBubbleDisplayContent(msg) {
  const base = String(msg?.content || '');
  if (msg?.metadata?.source === 'group-followup-auto' || msg?.metadata?.followupAboutId) {
    return base.replace(/（关于[^）]+）\s*$/u, '').trim();
  }
  return base;
}

/** AI 输出 `[群备注:群名｜剧情推进｜跳转意图｜开场1｜开场2｜开场3]`（字段用全角竖线 ｜ 分隔，避免与正文半角|冲突） */
export function parseGroupBlueprintTags(rawText = '') {
  const text = String(rawText || '');
  const out = [];
  const re = /\[群备注[:：]\s*([^\]]+)\]/g;
  let m;
  while ((m = re.exec(text))) {
    const parts = String(m[1] || '').split(/｜/).map((s) => s.trim());
    if (!parts[0]) continue;
    out.push({
      groupName: parts[0],
      plotHint: parts[1] || '',
      jumpIntent: parts[2] || '',
      starters: parts.slice(3, 8).filter(Boolean),
    });
  }
  return out;
}

export function stripGroupBlueprintTags(text = '') {
  return String(text || '').replace(/\[群备注[:：]\s*[^\]]+\]/g, '').trim();
}

export async function applyGroupBlueprintTags(userId, rawText) {
  const tags = parseGroupBlueprintTags(rawText);
  if (!tags.length || !userId) return [];
  const userChats = await db.getAllByIndex('chats', 'userId', userId);
  const logs = [];
  for (const t of tags.slice(0, 5)) {
    const g = userChats.find((c) => c.type === 'group' && (c.groupSettings?.name || '') === t.groupName);
    if (!g) {
      logs.push(`群备注跳过：未找到「${t.groupName}」`);
      continue;
    }
    const gs = { ...(g.groupSettings || {}) };
    if (t.plotHint) {
      gs.plotDirective = gs.plotDirective ? `${String(gs.plotDirective).trim()}\n${t.plotHint}` : t.plotHint;
    }
    if (t.jumpIntent) gs.groupJumpIntent = t.jumpIntent;
    if (t.starters.length) gs.dialogueStarters = t.starters;
    g.groupSettings = gs;
    await db.put('chats', g);
    logs.push(`已更新群「${t.groupName}」剧情/开场备注`);
  }
  return logs;
}

/** 用户回合：真·用户消息，或用户点击「代演」发出的角色气泡 */
export function isUserSideTurnMessage(m) {
  if (!m || m.deleted) return false;
  if (m.senderId === 'user') return true;
  return !!m.metadata?.userComposedAsCharacter;
}

/** 算「AI/角色自动接话」：排除用户本人与代发气泡，排除系统 */
export function isAiRoundReplyMessage(m) {
  if (!m || m.deleted || m.recalled) return false;
  if (m.senderId === 'system') return false;
  if (m.senderId === 'user') return false;
  if (m.metadata?.userComposedAsCharacter) return false;
  return true;
}

function _scoreGroupNameMatch(spec, groupName) {
  const s = String(spec || '').trim();
  const gn = String(groupName || '').trim();
  if (!s || !gn) return 0;
  const normalize = (t) => String(t || '').replace(/\s+/g, '').toLowerCase();
  const ns = normalize(s);
  const ng = normalize(gn);
  if (gn === s) return 100;
  if (ng === ns) return 98;
  if (gn === `${s}群` || s === `${gn}群`) return 93;
  if (gn.startsWith(s) || s.startsWith(gn)) return 82;
  if (gn.includes(s) || s.includes(gn)) return 68;
  if (ns.length >= 2 && (ng.includes(ns) || ns.includes(ng))) return 58;
  return 0;
}

/** 在指定角色参与的群中，按群名模糊匹配（如「蓝雨战队」↔「蓝雨战队群」） */
export function matchGroupChatForSocialLinkage(userChats, targetSpec, actorId) {
  const spec = String(targetSpec || '').trim();
  if (!spec || !actorId) return null;
  const groups = (userChats || []).filter(
    (c) => c?.type === 'group' && (c.participants || []).includes(actorId),
  );
  const byId = groups.find((c) => c.id === spec);
  if (byId) return byId;
  const byExact = groups.find((c) => String(c.groupSettings?.name || '').trim() === spec);
  if (byExact) return byExact;
  let best = null;
  let bestSc = 0;
  for (const c of groups) {
    const gn = String(c.groupSettings?.name || '').trim();
    const sc = _scoreGroupNameMatch(spec, gn);
    if (sc > bestSc) {
      bestSc = sc;
      best = c;
    }
  }
  return bestSc >= 58 ? best : null;
}

/** 不限成员，仅按群名片模糊匹配（用于判断「群存在但当前角色不在群内」） */
export function findGroupChatLooseName(userChats, targetSpec) {
  const spec = String(targetSpec || '').trim();
  if (!spec) return null;
  const groups = (userChats || []).filter((c) => c?.type === 'group');
  const byId = groups.find((c) => c.id === spec);
  if (byId) return byId;
  const byExact = groups.find((c) => String(c.groupSettings?.name || '').trim() === spec);
  if (byExact) return byExact;
  let best = null;
  let bestSc = 0;
  for (const c of groups) {
    const gn = String(c.groupSettings?.name || '').trim();
    const sc = _scoreGroupNameMatch(spec, gn);
    if (sc > bestSc) {
      bestSc = sc;
      best = c;
    }
  }
  return bestSc >= 58 ? best : null;
}

/**
 * 解析 [社交联动:动作|目标|内容] 或四段 […|内容|附加]；内容中可含半角 |
 * 第三段起至倒数第二段合并为 content（四段及以上时末段为 extra）
 */
export function parseAiSocialOps(rawText = '') {
  const text = String(rawText || '');
  const out = [];
  const re = /\[社交联动[:：]\s*([^\]]+)\]/g;
  let m;
  while ((m = re.exec(text))) {
    const parts = String(m[1] || '').split('|').map((p) => p.trim());
    if (parts.length < 3 || !parts[0]) continue;
    const action = parts[0] || '';
    const target = parts[1] || '';
    let content;
    let extra;
    if (parts.length === 3) {
      content = parts[2];
      extra = '';
    } else {
      extra = parts[parts.length - 1] || '';
      content = parts.slice(2, -1).join('|').trim();
    }
    if (!content) continue;
    out.push({ action, target, content, extra });
  }
  return out;
}

export function stripAiSocialOpsTags(text = '') {
  return String(text || '').replace(/\[社交联动[:：]\s*[^\]]+\]/g, '').trim();
}

/** 从整段 AI 原文取最后一次 [联动风格:通知|吐槽] → notify | rant */
export function parseLinkageStyleFromAiText(text = '') {
  const raw = String(text || '');
  const re = /\[联动风格[:：]\s*(通知|吐槽)\s*\]/g;
  let last = null;
  let m;
  while ((m = re.exec(raw))) {
    last = m[1] === '吐槽' ? 'rant' : 'notify';
  }
  return last;
}

export function stripLinkageStyleTags(text = '') {
  return String(text || '')
    .replace(/\[联动风格[:：]\s*(?:通知|吐槽)\s*\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const SEASON_ORDER = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11'];

function seasonIndex(season) {
  const idx = SEASON_ORDER.indexOf(season);
  return idx === -1 ? SEASON_ORDER.indexOf('S8') : idx;
}

export function isSeasonBefore(currentSeason, compareSeason) {
  return seasonIndex(currentSeason) < seasonIndex(compareSeason);
}

export function getDisplayTeamName(teamId) {
  return TEAMS[teamId]?.name || teamId || '无';
}

export function getCharacterStateForSeason(character, season) {
  if (!character) return _notDebutedState(character);
  const states = character.timelineStates;
  if (!states || typeof states !== 'object') return _notDebutedState(character);

  const exact = states[season];
  if (exact) return exact;

  if (character.debutSeason && isSeasonBefore(season, character.debutSeason)) {
    return _notDebutedState(character);
  }

  const currentIdx = seasonIndex(season);
  for (let i = currentIdx - 1; i >= 0; i--) {
    const prev = states[SEASON_ORDER[i]];
    if (prev) return prev;
  }
  for (let i = currentIdx + 1; i < SEASON_ORDER.length; i++) {
    const next = states[SEASON_ORDER[i]];
    if (next) return next;
  }

  return _notDebutedState(character);
}

function _notDebutedState(character) {
  return {
    team: null,
    card: null,
    class: null,
    role: '未正式出道',
    publicName: character?.name || '未知',
    status: '当前时间线尚未正式出道或无对应状态，禁止引用未来剧情',
  };
}

/**
 * 批量导入一行：名称 +（全角/半角冒号或空格）+ URL，或仅一行 URL。
 * 使用 exec 定位 URL，避免 match(/g) 丢失 index 导致整行当名称。
 */
export function parseStickerImportLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  const re = /https?:\/\/[^\s]+/i;
  const m = re.exec(trimmed);
  if (!m) return null;
  const url = m[0].replace(/[)\].,;]+$/g, '').trim();
  let name = trimmed.slice(0, m.index).trim();
  name = name.replace(/[：:]\s*$/u, '').trim();
  if (/https?:/i.test(name)) {
    name = name.replace(/[：:]\s*https?:\/\/.*$/i, '').trim();
    name = name.replace(/[：:]\s*$/u, '').trim();
  }
  if (!name) name = '表情';
  return { name, url };
}

/** 从一行里抽出 [表情包:名] … 中的可展示图片 URL（支持 http(s) / data:image） */
export function parseStickerTagLine(content) {
  const s = String(content || '').trim();
  const head = s.match(/^\[表情包[:：]\s*([^\]]+)\]/);
  if (!head) return null;
  const name = head[1].trim();
  const tail = s.slice(head[0].length);
  const urlM = tail.match(/(?:https?:\/\/[^\s\]\)]+|data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+)/i);
  if (!urlM) return null;
  let url = urlM[0];
  if (/[)\].,;]+$/.test(url)) url = url.replace(/[)\].,;]+$/, '');
  return { name, url };
}

/**
 * 整段内容仅为一张图 URL（角色/用户单独一行贴图）时解析为图片消息，避免落在纯文本气泡里。
 * 支持常见图床域名或无扩展名的图片路径（querystring 前判断）。
 */
export function parseStandaloneShareImageUrl(text) {
  const raw = String(text || '').trim();
  if (!raw || /[\r\n]/.test(raw)) return null;
  let t = raw.replace(/^\[[^\]]+\]\s+(?=https?:\/\/)/i, '').trim();
  t = t
    .replace(/^[『「〔（(]+/u, '')
    .replace(/[」』〕）)]+$/u, '')
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .trim();
  t = t.replace(/^[（(]\s*/, '').replace(/\s*[）)]$/, '').trim();
  if (/^data:image\/[^;\s]+;base64,/i.test(t)) {
    return /\s/.test(t) ? null : t;
  }
  if (!/^https?:\/\//i.test(t)) return null;
  const url = t.replace(/[，,。.!！?？);；、]+$/u, '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  let path = '';
  let host = '';
  try {
    const u = new URL(url);
    path = u.pathname.toLowerCase();
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  const extOk =
    /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(path) || /\.(png|jpe?g|gif|webp)(?=\?)/i.test(path);
  const hostOk =
    /postimg|imgur|ibb\.|wikimedia|pixiv|imgbb|photobucket|cloudinary|qpic|picsum|unsplash|placeholder|cdnpix|imagekit|amazonaws|aliyuncs/i.test(
      host,
    );
  if (extOk || hostOk) return url;
  return null;
}

/** 表情包名称与 AI 关键词的匹配分（越高越贴切） */
function scoreStickerMatch(sticker, keyword) {
  const k = String(keyword || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  const n = String(sanitizeStickerDisplayName(sticker.name) || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  if (!k || !n) return 0;
  if (n === k) return 100;
  if (n.includes(k)) return 85;
  if (k.includes(n) && n.length >= 2) return 70;
  for (let len = Math.min(6, k.length, n.length); len >= 2; len--) {
    for (let i = 0; i + len <= k.length; i++) {
      if (n.includes(k.slice(i, i + len))) return 45 + len;
    }
  }
  return 0;
}

function pickStickerFromPool(pool, salt) {
  if (!pool?.length) return null;
  const s = String(salt || '') + '_' + pool.length + '_' + (pool[0]?.url || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  const idx = Math.abs(h) % pool.length;
  return pool[idx];
}

export async function resolveStickerMessage(text, chatId, senderId, senderName) {
  const trimmed = String(text || '').trim();
  const parsed = parseStickerTagLine(trimmed);
  if (parsed) {
    return createMessage({
      chatId,
      senderId,
      senderName,
      type: 'sticker',
      content: parsed.url,
      metadata: { stickerName: parsed.name, url: parsed.url, packName: '' },
    });
  }
  const m = trimmed.match(/^\[表情包[:：]\s*([^\]]+)\]\s*$/);
  if (!m) return null;
  const keyword = m[1].trim();
  const packs = await db.getAll('stickerPacks');
  const all = packs.flatMap((p) => (p.stickers || []).map((s) => ({ ...s, pack: p.name })));
  if (!all.length) return null;

  const scored = all
    .map((s) => ({ s, sc: scoreStickerMatch(s, keyword) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc);

  let pool;
  if (scored.length) {
    const best = scored[0].sc;
    pool = scored.filter((x) => x.sc === best).map((x) => x.s);
  } else {
    pool = [...all];
  }

  const salt = `${keyword}|${chatId}|${senderId}|${senderName}|${performance.now()}|${Math.random()}`;
  const found = pickStickerFromPool(pool, salt);
  if (!found) return null;

  return createMessage({
    chatId,
    senderId,
    senderName,
    type: 'sticker',
    content: found.url,
    metadata: {
      stickerName: sanitizeStickerDisplayName(found.name || keyword),
      url: found.url,
      packName: found.pack || '',
    },
  });
}

/** 将提示词/快照里的占位「用户：」替换为当前档案昵称，减少换档后模型误读 */
export function normalizeUserPlaceholderInText(text, currentUserName) {
  const label = String(currentUserName ?? '').trim() || '我';
  const s = String(text ?? '');
  if (!s) return s;
  let out = s.replace(/(^|[\r\n])用户\s*[:：]\s*/gm, `$1${label}：`);
  out = out.replace(/"用户\s*[:：]\s*/g, `"${label}：`);
  return out;
}

export function normalizeMessageForUi(message) {
  const msg = { ...message, metadata: { ...(message?.metadata || {}) } };
  let type = msg.type || 'text';
  let content = String(msg.content || '');

  if (type === 'red-packet') type = 'redpacket';

  if (type === 'orderShare') {
    msg.metadata.orderPlatform = msg.metadata.orderPlatform || '购物';
    msg.metadata.orderTitle = msg.metadata.orderTitle || String(msg.content || '').trim() || '商品';
    msg.metadata.orderPrice = msg.metadata.orderPrice || '';
    msg.metadata.orderNote = msg.metadata.orderNote || '';
    content = msg.metadata.orderTitle;
    return { ...msg, type, content };
  }

  if (type === 'text') {
    let m = content.match(/^\[语音消息(?:\s+([0-9:]+))?\]$/);
    if (m) {
      type = 'voice';
      msg.metadata.duration = msg.metadata.duration || m[1] || '0:03';
      content = '[语音消息]';
    }

    m = content.match(/^\[位置\]\s*(.+)$/);
    if (m) {
      type = 'location';
      msg.metadata.title = msg.metadata.title || '位置共享';
      msg.metadata.locationName = msg.metadata.locationName || m[1].trim();
      content = m[1].trim();
    }

    m = content.match(/^\[链接\]\s*(.+)$/);
    if (m) {
      type = 'link';
      msg.metadata.title = msg.metadata.title || '分享链接';
      msg.metadata.desc = msg.metadata.desc || m[1].trim();
      msg.metadata.description = msg.metadata.description || msg.metadata.desc;
      msg.metadata.source = msg.metadata.source || '站外分享';
      content = m[1].trim();
    }

    m = content.match(/^\[红包\]\s*(.*)$/);
    if (m) {
      type = 'redpacket';
      msg.metadata.title = msg.metadata.title || 'QQ红包';
      msg.metadata.greeting = msg.metadata.greeting || m[1].trim() || '恭喜发财';
      content = m[1].trim() || '恭喜发财';
    }

    m = content.match(/^\[转账\]\s*(.*)$/);
    if (m) {
      type = 'transfer';
      msg.metadata.title = msg.metadata.title || '转账';
      msg.metadata.amount = msg.metadata.amount || m[1].trim() || '¥0.01';
      content = m[1].trim() || '¥0.01';
    }

    m = content.match(/^\[文字图\]\s*(.*)$/);
    if (m) {
      type = 'textimg';
      content = m[1].trim() || '未命名文字图';
    }
    m = content.match(/^\[骰子[:：]?\s*(d?\d+)?\]$/i);
    if (m) {
      type = 'dice';
      const raw = String(m[1] || 'd6').toLowerCase();
      const sides = Math.max(2, Math.min(100, Number(raw.replace(/^d/, '')) || 6));
      msg.metadata.sides = msg.metadata.sides || sides;
      msg.metadata.result = msg.metadata.result || 0;
      content = `d${msg.metadata.sides}=${msg.metadata.result}`;
    }

    m = content.match(/^\[分享购物[:：]\s*([^\]]+)\]$/);
    if (m) {
      const raw = m[1].trim();
      const parts = raw.split(/[｜|]/).map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        type = 'orderShare';
        msg.metadata.orderPlatform = parts[0] || '';
        msg.metadata.orderTitle = parts[1] || '';
        msg.metadata.orderPrice = parts[2] || '';
        msg.metadata.orderNote = parts.slice(3).join(' ') || '';
        content = msg.metadata.orderTitle || '分享购物';
      }
    }

    const st = parseStickerTagLine(content);
    if (st && st.url) {
      type = 'sticker';
      msg.metadata.stickerName = st.name;
      msg.metadata.url = st.url;
      content = st.url;
    }
    if (type === 'text') {
      const shareImg = parseStandaloneShareImageUrl(content);
      if (shareImg) {
        type = 'image';
        content = shareImg;
      }
    }
  }

  if (type === 'voice') {
    msg.metadata.duration = msg.metadata.duration || '0:03';
  }
  if (type === 'location') {
    msg.metadata.title = msg.metadata.title || '位置共享';
    msg.metadata.locationName = msg.metadata.locationName || content;
  }
  if (type === 'link') {
    msg.metadata.title = msg.metadata.title || '分享链接';
    msg.metadata.desc = msg.metadata.desc || content;
    msg.metadata.description = msg.metadata.description || msg.metadata.desc;
    msg.metadata.source = msg.metadata.source || '站外分享';
  }
  if (type === 'redpacket') {
    msg.metadata.title = msg.metadata.title || 'QQ红包';
    msg.metadata.greeting = msg.metadata.greeting || content || '恭喜发财';
  }
  if (type === 'transfer') {
    msg.metadata.title = msg.metadata.title || '转账';
    msg.metadata.amount = msg.metadata.amount || content || '¥0.01';
  }
  if (type === 'sticker') {
    if (!msg.metadata.stickerName) msg.metadata.stickerName = '表情';
    msg.metadata.stickerName = sanitizeStickerDisplayName(msg.metadata.stickerName);
    if (!msg.metadata.url) msg.metadata.url = content;
  }
  if (type === 'chatBundle') {
    msg.metadata.bundleTitle = msg.metadata.bundleTitle || '聊天记录';
    msg.metadata.bundleSummary = msg.metadata.bundleSummary || '';
    msg.metadata.items = Array.isArray(msg.metadata.items) ? msg.metadata.items : [];
  }
  if (type === 'dice') {
    const sides = Number(msg.metadata.sides || 6) || 6;
    const result = Number(msg.metadata.result || 0) || 0;
    msg.metadata.sides = sides;
    msg.metadata.result = result;
    content = content || `🎲 d${sides}=${result}`;
  }
  if (type === 'vote') {
    msg.metadata.title = msg.metadata.title || '群投票';
    msg.metadata.options = Array.isArray(msg.metadata.options) ? msg.metadata.options : [];
    msg.metadata.votes = msg.metadata.votes && typeof msg.metadata.votes === 'object' ? msg.metadata.votes : {};
    msg.metadata.closed = !!msg.metadata.closed;
  }

  return { ...msg, type, content };
}

export function formatMessageForContext(message, currentUserName) {
  const userLabel =
    currentUserName !== undefined
      ? String(currentUserName ?? '').trim()
      : String(getState('currentUser')?.name || '').trim();
  const labelForNorm = userLabel || '我';

  const msg = normalizeMessageForUi(message);
  if (msg.recalled) return '[已撤回]';
  let text = msg.content || '';

  if (msg.type === 'image') {
    text = '[图片]' + (msg.metadata?.description || '');
  } else if (msg.type === 'voice') {
    text = '[语音消息] ' + (msg.metadata?.duration || '0:03');
  } else if (msg.type === 'sticker') {
    text = '[表情包: ' + (msg.metadata?.stickerName || '表情') + ']';
  } else if (msg.type === 'location') {
    text = '[位置分享: ' + (msg.metadata?.locationName || msg.content || '某个位置') + ']';
  } else if (msg.type === 'link') {
    text = '[链接分享: ' + (msg.metadata?.title || '') + ' - ' + (msg.metadata?.description || msg.metadata?.desc || msg.content || '') + ']';
  } else if (msg.type === 'redpacket') {
    text = '[红包: ' + (msg.metadata?.greeting || msg.content || '恭喜发财') + ']';
  } else if (msg.type === 'transfer') {
    text = '[转账: ' + (msg.metadata?.amount || msg.content || '?') + ']';
  } else if (msg.type === 'textimg') {
    text = '[文字图] ' + (msg.content || '');
  } else if (msg.type === 'orderShare') {
    const pl = msg.metadata?.orderPlatform || '';
    const ti = msg.metadata?.orderTitle || '';
    const pr = msg.metadata?.orderPrice || '';
    const no = msg.metadata?.orderNote || '';
    text = `[分享购物:${pl}|${ti}|${pr}|${no}]`;
  } else if (msg.type === 'chatBundle') {
    const items = Array.isArray(msg.metadata?.items) ? msg.metadata.items : [];
    const sample = items
      .slice(0, 3)
      .map((x) => `${x.senderName || x.senderId || '某人'}:${String(x.content || '').slice(0, 20)}`)
      .join(' / ');
    const fromLab = String(msg.metadata?.fromChatLabel || '').trim();
    const fromSeg = fromLab ? `|转自「${fromLab}」` : '';
    text = `[合并转发:${msg.metadata?.bundleTitle || '聊天记录'}|共${items.length}条${fromSeg}${sample ? `|${sample}` : ''}]`;
  } else if (msg.type === 'dice') {
    text = `[骰子:d${msg.metadata?.sides || 6}=${msg.metadata?.result || 0}]`;
  } else if (msg.type === 'vote') {
    const opts = Array.isArray(msg.metadata?.options) ? msg.metadata.options : [];
    const votes = msg.metadata?.votes || {};
    const tally = opts
      .map((o) => `${o}:${Array.isArray(votes[o]) ? votes[o].length : 0}`)
      .join('、');
    text = `[群投票:${msg.metadata?.title || '投票'}|${tally}${msg.metadata?.closed ? '|已结束' : ''}]`;
  }

  if (msg.type === 'text' && msg.metadata?.followupAboutName) {
    text = `${text} [关联提及:${msg.metadata.followupAboutName}]`;
  }

  if (msg.replyPreview) {
    const rp = normalizeUserPlaceholderInText(msg.replyPreview, labelForNorm);
    text = `[回复: "${rp}"] ${text}`;
  }

  if (msg.senderName && msg.senderId !== 'user') {
    text = `[${msg.senderName}]: ${text}`;
  }

  text = normalizeUserPlaceholderInText(text, labelForNorm);

  return text;
}

/** 合并「单独一行的 [回复:片段]」与下一行正文，避免解析成两条气泡 */
export function mergeReplyTagContinuations(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const onlyReply = /^\[回复[：:]\s*[^\]]+\]\s*$/.test(t);
    if (onlyReply && i + 1 < lines.length) {
      const next = lines[i + 1].trim();
      if (next) {
        out.push(`${t} ${next}`.trim());
        i += 1;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

/** 按当前库内消息重算会话列表缩略文案（删除/撤回后避免残留旧预览） */
export async function recomputeChatLastMessagePreview(chatId) {
  const chat = await db.get('chats', chatId);
  if (!chat) return;
  const msgs = (await db.getAllByIndex('messages', 'chatId', chatId))
    .filter((m) => !m.deleted)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const last = msgs[msgs.length - 1];
  if (!last) {
    chat.lastMessage = '';
  } else {
    const norm = normalizeMessageForUi(last);
    const uName = getState('currentUser')?.name || '';
    chat.lastMessage = formatMessageForContext(norm, uName).replace(/\s+/g, ' ').slice(0, 80);
  }
  await db.put('chats', chat);
}

/** 注入系统提示：本地表情包「名称」列表，供 AI 写 [表情包:精确名称] */
export async function buildStickerAliasPromptSection(maxNames = 280) {
  const packs = await db.getAll('stickerPacks');
  const names = [];
  for (const p of packs) {
    for (const s of p.stickers || []) {
      names.push(sanitizeStickerDisplayName(s.name));
    }
  }
  const uniq = [...new Set(names)];
  if (!uniq.length) {
    return '';
  }
  const list = uniq.slice(0, maxNames);
  const more =
    uniq.length > maxNames
      ? `\n（还有 ${uniq.length - maxNames} 个未展开，仍可用 [表情包:名称] 精确匹配）`
      : '';
  return (
    `\n[用户表情包 · 共 ${uniq.length} 个]\n` +
    `强制：本轮输出中至少 1 行、建议 2 行及以上单独成行的 [表情包:名称]；名称必须与下列某一条完全一致（含「？！」等标点）。\n` +
    `导入格式一般为「名称：https://…」，你输出时只写名称、不要带链接（除非系统另有说明要带 URL）。\n` +
    `同一轮内不要重复使用同一张表情关键词；可换不同情绪条目。\n` +
    list.map((n) => `· ${n}`).join('\n') +
    more
  );
}

/** 去掉仿「上下文格式」的 [某某]： 行首前缀（私聊里模型常模仿 API 里的 [角色名]:） */
export function stripMimickedContextPrefixes(text) {
  return String(text || '')
    .replace(/^\[[^\]]+\][：:]\s*/gm, '')
    .trim();
}

/** 心声标签（含繁体 心聲）；用 source 每次 new RegExp，避免 /g 正则 lastIndex 导致偶发漏捕 */
const INNER_VOICE_SOURCE =
  '(?:\\[|［|【)\\s*(?:心声|心聲)\\s*(?:\\]|］|】)\\s*(?:[：:﹕]\\s*)?([^\\n\\r]*)';
const INNER_VOICE_PAREN_SOURCE =
  '(?:\\(|（)\\s*(?:心声|心聲)\\s*(?:[：:﹕]\\s*)?([^\\)）\\n\\r]*)(?:\\)|）)';

function stripInnerVoiceTagsToBucket(raw, innerParts) {
  return String(raw || '').replace(new RegExp(INNER_VOICE_SOURCE, 'gi'), (_, g1) => {
    const t = String(g1 || '').trim();
    if (t) innerParts.push(t);
    return '';
  });
}

function stripParenInnerVoiceToBucket(raw, innerParts) {
  return String(raw || '').replace(new RegExp(INNER_VOICE_PAREN_SOURCE, 'gi'), (_, g1) => {
    const t = String(g1 || '').trim();
    if (t) innerParts.push(t);
    return '';
  });
}

/**
 * 拆出 [心声]/【心声】等（支持全角括号、行内/独行、多段），并剥离行首 [角色名]:
 * 仅心声的片段会得到空的 publicText，由调用方跳过气泡并把 inner 合并到上一条。
 */
export function splitPublicAndInnerVoice(text) {
  const raw = String(text || '');
  const innerParts = [];
  let publicText = stripInnerVoiceTagsToBucket(raw, innerParts);
  publicText = stripParenInnerVoiceToBucket(publicText, innerParts);
  publicText = stripMimickedContextPrefixes(publicText);
  publicText = stripInnerVoiceTagsToBucket(publicText, innerParts);
  publicText = stripParenInnerVoiceToBucket(publicText, innerParts);
  publicText = publicText
    .replace(new RegExp(`^\\s*(?:\\[|［|【)\\s*(?:心声|心聲)\\s*(?:\\]|］|】)\\s*$`, 'gim'), '')
    .trim();
  return { publicText: publicText.trim(), innerVoice: innerParts.join('；') };
}

/** 点击头像时汇总心声：当前条 metadata + 同轮(aiRoundId)同角色其它条 + 正文中仍可解析的残留 */
export async function collectInnerVoicesForMessage(msg, chatId) {
  if (!msg || msg.senderId === 'user' || !chatId) return '';
  const mergeUnique = (chunks) => {
    const seen = new Set();
    const out = [];
    for (const ch of chunks) {
      for (const seg of String(ch || '')
        .split(/[；;]/)
        .map((x) => x.trim())
        .filter(Boolean)) {
        if (!seen.has(seg)) {
          seen.add(seg);
          out.push(seg);
        }
      }
    }
    return out.join('；');
  };
  const fromMeta = (m) => String(m?.metadata?.innerVoice || '').trim();
  const fromContent = (m) => splitPublicAndInnerVoice(String(m?.content || '')).innerVoice.trim();
  const round = msg.metadata?.aiRoundId;
  if (!round) {
    return mergeUnique([fromMeta(msg), fromContent(msg)]);
  }
  const all = await db.getAllByIndex('messages', 'chatId', chatId);
  const parts = [];
  for (const m of all) {
    if (m.deleted || m.recalled || m.senderId !== msg.senderId || m.metadata?.aiRoundId !== round) continue;
    const d = fromMeta(m);
    if (d) parts.push(d);
    const c = fromContent(m);
    if (c) parts.push(c);
  }
  return mergeUnique(parts);
}

/** 含表情包/卡片等的一行不再按句读切分，避免 ? 等符号打乱顺序或拆坏标签 */
const ATOMIC_LINE_PREFIX = /^\[((?:表情包|分享购物|回复|线下邀约)[:：])/;

/**
 * 按行拆成多条气泡文本，保持原文先后顺序。
 * - 默认返回所有段（含最后一行未结束段）
 * - onlyCompleted=true 时，仅返回已完整结束（以换行结束）的段
 */
export function splitToBubbleTexts(text, options = {}) {
  const onlyCompleted = !!options.onlyCompleted;
  const rawText = String(text || '');
  const endsWithNewline = /\r?\n$/.test(rawText);
  const lines = rawText.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (onlyCompleted && i === lines.length - 1 && !endsWithNewline) continue;
    const line = lines[i];
    const t = line.trim();
    if (!t) continue;
    if (ATOMIC_LINE_PREFIX.test(t)) {
      out.push(t);
      continue;
    }
    if (!/^[.…⋯.]+[?？!！。]*$/.test(t)) out.push(t);
  }
  return out;
}

/** 同一轮连续多条 db.put 时避免 timestamp 完全相同导致排序乱序 */
export function createMessageTimestampAllocator(baseTs = Date.now()) {
  const base = Number.isFinite(Number(baseTs)) ? Number(baseTs) : Date.now();
  let n = 0;
  return () => base + n++;
}

/** 从气泡文本中拆出 [线下邀约:…] 标签 */
export function extractOfflineInvite(text) {
  const raw = String(text || '');
  const m = raw.match(/\[线下邀约[:：]\s*([^\]]+)\]/);
  if (!m) return { text: raw.trim(), note: '' };
  const stripped = raw.replace(/\[线下邀约[:：]\s*[^\]]+\]/g, '').trim();
  return { text: stripped || '…', note: (m[1] || '').trim() };
}

/** 购物/外卖分享卡片：平台关键字 → 皮肤 */
export function orderShareThemeClass(platform) {
  const p = String(platform || '').toLowerCase();
  if (/淘宝|天猫/.test(p)) return 'taobao';
  if (/美团|饿了么|外卖/.test(p)) return 'meituan';
  if (/京东/.test(p)) return 'jd';
  if (/拼/.test(p)) return 'pdd';
  return 'generic';
}

/** 聊天气泡内「淘宝/美团」风格订单卡片 HTML（需配合 CSS .order-share-card） */
export function orderShareCardHtml(msg, escapeHtmlFn) {
  const esc = escapeHtmlFn || ((s) => String(s ?? ''));
  const plat = msg.metadata?.orderPlatform || '购物';
  const title = msg.metadata?.orderTitle || msg.content || '商品';
  const price = msg.metadata?.orderPrice || '';
  const note = msg.metadata?.orderNote || '';
  const theme = orderShareThemeClass(plat);
  const priceRow = price
    ? `<div class="order-share-price"><span class="order-share-price-label">实付款</span><span class="order-share-price-num">${esc(price)}</span></div>`
    : '';
  const noteRow = note ? `<div class="order-share-note">${esc(note)}</div>` : '';
  return `
    <div class="order-share-card chat-card order-share-card--${theme}" data-card-type="order-share">
      <div class="order-share-header">
        <span class="order-share-brand">${esc(plat)}</span>
        <span class="order-share-sub"></span>
      </div>
      <div class="order-share-body">
        <div class="order-share-thumb" aria-hidden="true"></div>
        <div class="order-share-main">
          <div class="order-share-title">${esc(title)}</div>
          ${priceRow}
          ${noteRow}
        </div>
      </div>
      <div class="order-share-footer">
        <span class="order-share-linkish">查看订单</span>
        <span class="order-share-hint"></span>
      </div>
    </div>`;
}
