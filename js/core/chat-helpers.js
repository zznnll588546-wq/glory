import { TEAMS } from '../data/teams.js';
import * as db from './db.js';
import { createMessage } from '../models/chat.js';

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

/** 表情包名称与 AI 关键词的匹配分（越高越贴切） */
function scoreStickerMatch(sticker, keyword) {
  const k = String(keyword || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  const n = String(sticker.name || '')
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
      stickerName: found.name || keyword,
      url: found.url,
      packName: found.pack || '',
    },
  });
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
    if (!msg.metadata.url) msg.metadata.url = content;
  }

  return { ...msg, type, content };
}

export function formatMessageForContext(message) {
  const msg = normalizeMessageForUi(message);
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
  }

  if (msg.replyPreview) {
    text = `[回复: "${msg.replyPreview}"] ${text}`;
  }

  if (msg.senderName && msg.senderId !== 'user') {
    text = `[${msg.senderName}]: ${text}`;
  }

  return text;
}

/** 注入系统提示：本地表情包「名称」列表，供 AI 写 [表情包:精确名称] */
export async function buildStickerAliasPromptSection(maxNames = 280) {
  const packs = await db.getAll('stickerPacks');
  const names = [];
  for (const p of packs) {
    for (const s of p.stickers || []) {
      const n = String(s.name || '').trim();
      if (n) names.push(n);
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

function stripInnerVoiceTagsToBucket(raw, innerParts) {
  return String(raw || '').replace(new RegExp(INNER_VOICE_SOURCE, 'gi'), (_, g1) => {
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
  publicText = stripMimickedContextPrefixes(publicText);
  publicText = stripInnerVoiceTagsToBucket(publicText, innerParts);
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
 * 按换行与句末标点拆成多条气泡文本，保持原文先后顺序
 */
export function splitToBubbleTexts(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (ATOMIC_LINE_PREFIX.test(t)) {
      out.push(t);
      continue;
    }
    const parts = t.split(/(?<=[。！？])/);
    for (const p of parts) {
      const s = p.trim();
      if (s && !/^[.…⋯.]+[?？!！。]*$/.test(s)) out.push(s);
    }
  }
  return out;
}

/** 同一轮连续多条 db.put 时避免 timestamp 完全相同导致排序乱序 */
export function createMessageTimestampAllocator() {
  const base = Date.now();
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
        <span class="order-share-sub">订单分享</span>
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
        <span class="order-share-hint">演示卡片 · 非真实链接</span>
      </div>
    </div>`;
}
