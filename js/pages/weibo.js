import { navigate, back } from '../core/router.js';
import * as db from '../core/db.js';
import { createMessage } from '../models/chat.js';
import { chat as apiChat, resolveGenerationMaxTokens } from '../core/api.js';
import { getState } from '../core/state.js';
import { CHARACTERS } from '../data/characters.js';
import { showToast } from '../components/toast.js';
import { getCharacterStateForSeason } from '../core/chat-helpers.js';
import { buildWeiboAiSystemPrompt } from '../core/context.js';
import { getVirtualNow } from '../core/virtual-time.js';

const SOCIAL_LINK_KEY = 'socialLinkConfig';
const USER_RELATION_KEY = 'userRelationConfig';
const DEFAULT_SOCIAL_LINK = {
  autoLinkChance: 0.35,
  wrongSendChance: 0.22,
  recallChance: 0.55,
};

async function loadUserRelationPack(userId) {
  if (!userId) return { profile: {}, relations: {} };
  const row = await db.get('settings', USER_RELATION_KEY);
  const byUserId = row?.value?.byUserId || {};
  const pack = byUserId[userId] || {};
  return { profile: pack.profile || {}, relations: pack.relations || {} };
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function getCurrentUserId() {
  const row = await db.get('settings', 'currentUserId');
  return row?.value ?? null;
}

async function getCurrentUser() {
  const uid = await getCurrentUserId();
  if (!uid) return null;
  return db.get('users', uid);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function resolveName(id) {
  if (!id || id === 'user') return '我';
  const c = await db.get('characters', id);
  if (c?.name) return c.name;
  const d = CHARACTERS.find((x) => x.id === id);
  return d?.name || id;
}

async function normalizeAuthorIdentity(authorIdRaw, authorNameRaw) {
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

function openGlobalModal(innerHtml) {
  const host = document.getElementById('modal-container');
  if (!host) return { close: () => {} };
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-modal-overlay>
      <div class="modal-sheet" role="dialog" aria-modal="true" data-modal-sheet>
        ${innerHtml}
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-modal-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-modal-overlay]')?.addEventListener('click', close);
  return { close, root: host };
}

function renderImagesGrid(images) {
  if (!Array.isArray(images) || !images.length) return '';
  const cells = images
    .slice(0, 9)
    .map(
      (src) =>
        `<div class="weibo-img-cell"><img src="${escapeAttr(src)}" alt="" loading="lazy" /></div>`
    )
    .join('');
  return `<div class="weibo-images">${cells}</div>`;
}

async function resolveAuthorAvatar(authorId, authorName, explicitAvatar) {
  if (explicitAvatar) return explicitAvatar;
  if (authorId) {
    const user = await db.get('users', authorId);
    if (user?.avatar) return user.avatar;
    const ch = await db.get('characters', authorId);
    if (ch?.avatar) return ch.avatar;
  }
  if (authorName) {
    const allChars = await db.getAll('characters');
    const found = allChars.find((c) =>
      c.id === authorName ||
      c.name === authorName ||
      c.realName === authorName ||
      c.customNickname === authorName ||
      (c.aliases || []).includes(authorName)
    );
    if (found?.avatar) return found.avatar;
  }
  return '';
}

async function getUserChats(userId) {
  if (!userId) return [];
  return (await db.getAllByIndex('chats', 'userId', userId))
    .filter((c) => (c.groupSettings?.allowSocialLinkage ?? true))
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
}

async function getSocialLinkConfig() {
  const row = await db.get('settings', SOCIAL_LINK_KEY);
  return { ...DEFAULT_SOCIAL_LINK, ...(row?.value || {}) };
}

async function collectRoleplayContextForWeibo(userId, season) {
  const chats = await getUserChats(userId);
  const charMap = new Map();
  for (const c of CHARACTERS) charMap.set(c.id, c);
  const storedChars = await db.getAll('characters');
  for (const c of storedChars) charMap.set(c.id, { ...(charMap.get(c.id) || {}), ...c });
  const relationLines = [];
  for (const ch of charMap.values()) {
    if (!ch?.id || !ch.relationships) continue;
    const pairs = Object.entries(ch.relationships).slice(0, 3);
    if (!pairs.length) continue;
    const desc = pairs
      .map(([rid, rel]) => {
        const target = charMap.get(rid);
        const tname = target?.name || rid;
        return `${tname}:${String(rel || '').slice(0, 18)}`;
      })
      .join('；');
    const state = getCharacterStateForSeason(ch, season);
    relationLines.push(`${state.publicName || ch.name || ch.id}(${state.team || '无队'})=>${desc}`);
    if (relationLines.length >= 14) break;
  }
  const snippets = [];
  for (const chat of chats.slice(0, 10)) {
    const msgs = await db.getAllByIndex('messages', 'chatId', chat.id);
    const latest = [...msgs]
      .filter((m) => !m.deleted && !m.recalled && m.senderId !== 'user' && m.type === 'text' && String(m.content || '').trim())
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 2);
    for (const m of latest) {
      const name = (await resolveName(m.senderId)) || m.senderName || m.senderId;
      snippets.push(`[${name}] ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 70)}`);
      if (snippets.length >= 18) break;
    }
    if (snippets.length >= 18) break;
  }
  return { relationLines, snippets };
}

function pickRandom(list) {
  if (!list?.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const body = fenceMatch ? fenceMatch[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1).trim();
}

/** 热搜/新闻条目标签里混入的引号、逗号等 */
function cleanTopicCell(s) {
  let t = String(s ?? '').trim();
  t = t.replace(/^[\s\["'`「【\[]+/, '');
  t = t.replace(/[\s"',」】\],]+$/g, '');
  t = t.replace(/^"+|"+$/g, '');
  t = t.replace(/,$/, '').trim();
  return t;
}

function normalizeWeiboPayloadObject(obj) {
  const base = obj && typeof obj === 'object' ? obj : {};
  const trending = Array.isArray(base.trending) ? base.trending.map(cleanTopicCell).filter(Boolean) : [];
  const news = Array.isArray(base.news) ? base.news.map(cleanTopicCell).filter(Boolean) : [];
  return { ...base, trending, news };
}

async function parseWeiboJsonWithRepair(raw) {
  const first = extractJsonObject(raw);
  if (!first) throw new Error('模型返回中未找到JSON对象');
  const repairCap = await resolveGenerationMaxTokens(4096);
  try {
    return normalizeWeiboPayloadObject(JSON.parse(first));
  } catch (_) {
    const fixed = await apiChat(
      [
        { role: 'system', content: '你是JSON修复器。只输出一个合法JSON对象，不要解释。' },
        { role: 'user', content: `请把下面内容修复为严格合法JSON，保留原字段语义：\n${first}` },
      ],
      { temperature: 0, maxTokens: repairCap }
    );
    const second = extractJsonObject(fixed);
    if (!second) throw new Error('JSON修复失败');
    return normalizeWeiboPayloadObject(JSON.parse(second));
  }
}

function parseWeiboTextFallback(raw) {
  const text = String(raw || '').replace(/\r/g, '').trim();
  const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
  const out = { trending: [], news: [], posts: [] };
  let mode = '';
  for (const line of lines) {
    if (/热搜|trending/i.test(line)) {
      mode = 'trending';
      continue;
    }
    if (/新闻|news/i.test(line)) {
      mode = 'news';
      continue;
    }
    if (/微博|posts?|动态/i.test(line)) {
      mode = 'posts';
      continue;
    }
    if (mode === 'trending') {
      const item = cleanTopicCell(line.replace(/^[#\-\d\.\)\s]+/, '').trim());
      if (item) out.trending.push(item);
      continue;
    }
    if (mode === 'news') {
      const item = cleanTopicCell(line.replace(/^[#\-\d\.\)\s]+/, '').trim());
      if (item) out.news.push(item);
      continue;
    }
    if (mode === 'posts') {
      // 支持：黄少天：内容 / [黄少天] 内容 / 作者-内容
      const m = line.match(/^(?:\[(.+?)\]|(.+?))[：:\-]\s*(.+)$/);
      if (m) {
        const authorName = (m[1] || m[2] || '').trim();
        const content = (m[3] || '').trim();
        if (content) out.posts.push({ authorId: authorName, authorName: authorName || '匿名用户', content, fans: 0 });
      } else {
        const content = line.replace(/^[#\-\d\.\)\s]+/, '').trim();
        if (content) out.posts.push({ authorId: 'npc', authorName: '匿名用户', content, fans: 0 });
      }
    }
  }
  return out;
}

async function parseWeiboPayload(raw) {
  const t = String(raw || '').trim();
  if (!t.includes('{')) {
    const fb = parseWeiboTextFallback(raw);
    if ((fb.posts || []).length || (fb.trending || []).length) return normalizeWeiboPayloadObject(fb);
  }
  try {
    return await parseWeiboJsonWithRepair(raw);
  } catch (_) {
    return normalizeWeiboPayloadObject(parseWeiboTextFallback(raw));
  }
}

function normalizePostFromAi(item = {}) {
  const hotComments = Array.isArray(item.hotComments)
    ? item.hotComments.slice(0, 6).map((c) => ({
        author: String(c.author || '吃瓜网友'),
        content: String(c.content || '').trim(),
        likes: Number(c.likes || 0),
      })).filter((x) => x.content)
    : [];
  const safeTags = Array.isArray(item.tags)
    ? item.tags.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 4)
    : [];
  return {
    content: String(item.content || '').trim(),
    tags: safeTags,
    reposts: Math.max(0, Number(item.reposts || 0)),
    comments: Math.max(0, Number(item.comments || hotComments.length || 0)),
    likes: Math.max(0, Number(item.likes || 0)),
    hotComments,
  };
}

async function findOrCreatePrivateChat(userId, actorId) {
  if (!userId || !actorId) return null;
  const staticHit = CHARACTERS.find((c) => c.id === actorId);
  const storedHit = await db.get('characters', actorId);
  if (!staticHit && !storedHit) return null;
  const all = await getUserChats(userId);
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
    lastActivity: await getVirtualNow(userId || '', Date.now()),
    unread: 0,
    autoActive: false,
    autoInterval: 300000,
    pinned: false,
  };
  await db.put('chats', chat);
  return chat;
}

async function maybeLinkToChatAfterGenerate({ userId, post, actorId, actorName }) {
  try {
  const socialCfg = await getSocialLinkConfig();
  const all = await getUserChats(userId);
  if (!all.length) return;
  const nowTs = await getVirtualNow(userId || '', Date.now());
  const relPack = await loadUserRelationPack(userId);
  const rel = actorId ? relPack.relations?.[actorId] : null;
  const relBoost = rel
    ? Math.max(0.4, Math.min(1.4, (Number(rel.affection || 0) + Number(rel.bond || 0) + Number(rel.desire || 0) * 0.5) / 160))
    : 1;
  if (Math.random() > Number(socialCfg.autoLinkChance ?? DEFAULT_SOCIAL_LINK.autoLinkChance) * relBoost) return;
  const groups = all.filter((c) => c.type === 'group');
  const intended = (actorId ? (await findOrCreatePrivateChat(userId, actorId)) : null) || pickRandom(groups) || pickRandom(all);
  if (!intended) return;
  const wrongPool = all.filter((c) => c.id !== intended.id);
  const wrongTarget = pickRandom(wrongPool) || intended;
  const wrongMode = Math.random();
  const allowWrong = (intended.groupSettings?.allowWrongSend ?? true) || (wrongTarget.groupSettings?.allowWrongSend ?? true);
  const isWrongSend = allowWrong && Math.random() < Number(socialCfg.wrongSendChance ?? DEFAULT_SOCIAL_LINK.wrongSendChance);
  const target = isWrongSend ? wrongTarget : intended;
  const linkMessage = createMessage({
    chatId: target.id,
    senderId: actorId || 'npc',
    senderName: actorName || '路人',
    type: 'link',
    content: `weibo://${post.id}`,
    metadata: {
      title: `微博：${post.authorName || actorName || '用户'}`,
      desc: (post.content || '').slice(0, 80),
      source: '微博',
      autoLinked: true,
      wrongChat: isWrongSend,
    },
  });
  await db.put('messages', linkMessage);
  target.lastMessage = '[微博分享]';
  target.lastActivity = nowTs;
  await db.put('chats', target);
  if (!isWrongSend) return;
  if (wrongMode < Number(socialCfg.recallChance ?? DEFAULT_SOCIAL_LINK.recallChance)) {
    linkMessage.recalled = true;
    linkMessage.metadata = { ...(linkMessage.metadata || {}), recalledContent: linkMessage.content };
    await db.put('messages', linkMessage);
    await db.put('messages', createMessage({
      chatId: target.id,
      senderId: 'system',
      type: 'system',
      content: `${actorName || '某人'} 撤回了一条发错群的链接（有人已看到）`,
      metadata: { recalledContent: `weibo://${post.id}` },
    }));
  } else {
    await db.put('messages', createMessage({
      chatId: target.id,
      senderId: actorId || 'npc',
      senderName: actorName || '路人',
      type: 'text',
      content: '靠 发错了……算了来不及撤回了。',
      metadata: { autoLinked: true, wrongChat: true, recallExpired: true },
    }));
  }
  if (target.type === 'group') {
    const memberIds = (target.participants || []).filter((id) => id && id !== 'user').slice(0, 6);
    const roastLines = ['笑死，发错了？', '我看到了，撤回没用。', '这波属于公开处刑。', '你继续，我当没看见（假的）'];
    const pickCount = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < pickCount; i++) {
      const sid = memberIds[i % memberIds.length] || 'npc';
      await db.put('messages', createMessage({
        chatId: target.id,
        senderId: sid,
        senderName: await resolveName(sid),
        type: 'text',
        content: roastLines[Math.floor(Math.random() * roastLines.length)],
        metadata: { wrongSendFollowup: true },
      }));
    }
  }
  } catch (e) {
    console.warn('maybeLinkToChatAfterGenerate', e);
  }
}

export default async function render(container) {
  const user = await getCurrentUser();
  const season = getState('currentUser')?.currentTimeline || 'S8';
  const posts = (await db.getAll('weiboPosts')).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const metaRow = await db.get('settings', 'weiboMeta');
  const meta = metaRow?.value || {
    trending: [],
    news: [],
    followingIds: [],
    profiles: {},
    weiboWorldBookId: '',
    homeBg: '',
  };
  meta.profiles = meta.profiles || {};
  meta.profiles.glory_league_official = {
    fans: 3200000,
    bio: '荣耀职业联盟官方账号｜赛程公告｜规则说明｜全明星与奖项公示',
    ...(meta.profiles.glory_league_official || {}),
  };
  const followingSet = new Set(meta.followingIds || []);
  const virtualNow = await getVirtualNow(user?.id || '', Date.now());

  const trendHtml = `
    <div class="card-block" style="margin:10px 12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong>微博热搜</strong>
        <span class="text-hint">${season}</span>
      </div>
      <div style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;">
        ${(meta.trending || []).slice(0, 6).map((x, i) => `<div style="display:flex;gap:8px;font-size:13px;"><span style="color:#ff7a45;">${i + 1}</span><span>${escapeHtml(x)}</span></div>`).join('') || '<div class="text-hint">暂无热搜，点击⚡生成</div>'}
      </div>
      <div style="margin-top:8px;font-size:12px;color:#6f8cab;">${(meta.news || []).slice(0, 3).map((n) => `• ${escapeHtml(n)}`).join('<br/>')}</div>
    </div>
  `;
  const adHtml = `
    <div class="card-block" style="margin:0 12px 10px;background:linear-gradient(135deg,#fffaf0,#fff);">
      <div style="font-size:11px;color:#b88c2a;margin-bottom:4px;">广告</div>
      <div style="font-weight:600;">${escapeHtml(season)} 赛季联名推荐：${escapeHtml(season === 'S10' ? '兴欣周边限时折扣' : '职业选手同款外设礼盒')}</div>
    </div>`;

  let listHtml = `<div class="placeholder-page" style="padding:48px 16px;min-height:auto;"><div class="placeholder-text">还没有微博动态</div></div>`;
  if (posts.length) {
    const chunks = [];
    for (const p of posts) {
      const name = escapeHtml(p.authorName || '用户');
      const timeMeta = formatTime(p.timestamp || 0);
      const avatarUrl = await resolveAuthorAvatar(p.authorId, p.authorName, p.avatar);
      const avatar = avatarUrl
        ? `<img src="${escapeAttr(avatarUrl)}" alt="" class="weibo-avatar-img" />`
        : `<span class="weibo-avatar-fallback">👤</span>`;
      const profile = meta.profiles?.[p.authorId || p.authorName] || {};
      const fans = profile.fans || p.fans || 0;
      const followed = followingSet.has(p.authorId || p.authorName);
      chunks.push(`
        <article class="weibo-post card-block" data-post-id="${escapeAttr(p.id)}">
          <header class="weibo-post-header">
            <button type="button" class="weibo-avatar weibo-profile-link" data-author-id="${escapeAttr(p.authorId || '')}" data-author-name="${escapeAttr(p.authorName || '')}" aria-label="作者主页">${avatar}</button>
            <div class="weibo-post-headtext">
              <button type="button" class="weibo-post-name weibo-profile-link" data-author-id="${escapeAttr(p.authorId || '')}" data-author-name="${escapeAttr(p.authorName || '')}">${name}</button>
              <div class="weibo-post-meta">${escapeHtml(timeMeta)} · 粉丝 ${Number(fans).toLocaleString('zh-CN')}</div>
            </div>
          </header>
          <div class="weibo-post-content">${escapeHtml(p.content || '')}</div>
          ${renderImagesGrid(p.images)}
          <div class="weibo-actions">
            <button type="button" class="weibo-action-btn" data-act="repost">转发 ${Number(p.reposts) || 0}</button>
            <button type="button" class="weibo-action-btn" data-act="comment">评论 ${Number(p.comments) || 0}</button>
            <button type="button" class="weibo-action-btn" data-act="like">点赞 ${Number(p.likes) || 0}</button>
            <button type="button" class="weibo-action-btn" data-act="follow">${followed ? '已关注' : '+关注'}</button>
            <button type="button" class="weibo-action-btn" data-act="chat-share">转到聊天</button>
            <button type="button" class="weibo-action-btn weibo-ai-btn" data-act="ai">AI生成</button>
          </div>
        </article>`);
    }
    listHtml = chunks.join('');
  }

  container.classList.add('weibo-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn weibo-back" aria-label="返回">‹</button>
      <h1 class="navbar-title">微博</h1>
      <div style="display:flex;gap:6px;">
        <button type="button" class="navbar-btn weibo-my-home" aria-label="我的主页">我</button>
        <button type="button" class="navbar-btn weibo-generate" aria-label="生成">⚡</button>
        <button type="button" class="navbar-btn weibo-config" aria-label="设置">⚙</button>
        <button type="button" class="navbar-btn weibo-compose" aria-label="发微博">+</button>
      </div>
    </header>
    <div class="page-scroll weibo-feed" style="${meta.homeBg ? `background-image:url('${escapeAttr(meta.homeBg)}');background-size:cover;background-attachment:fixed;` : ''}">
      <div class="card-block" style="margin:10px 12px;">
        <div style="display:flex;align-items:center;gap:8px;border:1px solid #e0d3a8;border-radius:999px;padding:8px 12px;">
          <input type="search" class="weibo-search-input" placeholder="大家正在搜：WIEA取消" style="border:none;outline:none;background:transparent;flex:1;font-size:14px;" />
          <button type="button" class="btn btn-sm btn-outline weibo-search-btn">搜索</button>
        </div>
      </div>
      ${trendHtml}
      ${adHtml}
      <div class="card-block" style="margin:0 12px 10px;display:flex;justify-content:space-between;align-items:center;">
        <strong>热点</strong>
        <button type="button" class="btn btn-sm btn-outline weibo-refresh">下拉刷新</button>
      </div>
      ${listHtml}
    </div>
    <div class="weibo-busy-overlay" aria-hidden="true" style="display:none;position:fixed;inset:0;z-index:200;background:rgba(255,255,255,0.82);backdrop-filter:blur(6px);flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;">
      <div style="font-size:32px;line-height:1;">⚡</div>
      <div style="font-weight:700;font-size:16px;color:var(--deep-blue);">正在生成热搜与微博动态</div>
      <div class="text-hint" style="font-size:12px;text-align:center;max-width:280px;line-height:1.5;">已使用你在「设置 → API」里配置的最大输出长度，模型跑完前请勿重复点击</div>
    </div>
  `;

  container.querySelector('.weibo-back')?.addEventListener('click', () => back());
  container.querySelector('.weibo-my-home')?.addEventListener('click', () => {
    if (!user) return;
    navigate('weibo-profile', {
      authorId: user.id || '',
      authorName: user.name || '旅行者',
      from: 'me',
    });
  });

  container.querySelector('.weibo-config')?.addEventListener('click', () => {
    const wbHint = meta.weiboWorldBookId || '';
    const { close, root } = openGlobalModal(`
      <div class="modal-header"><h3>微博账号设置</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
      <div class="modal-body">
        <input class="form-input wb-profile-key" placeholder="角色ID或名字" />
        <input class="form-input wb-profile-fans" placeholder="粉丝数" style="margin-top:8px;" />
        <textarea class="form-input wb-profile-bio" rows="3" placeholder="简介" style="margin-top:8px;"></textarea>
        <input class="form-input wb-weibo-worldbook" placeholder="微博专用世界书ID（可空）" value="${escapeAttr(wbHint)}" style="margin-top:8px;" />
        <input type="file" class="wb-home-bg-file" accept="image/*" style="margin-top:8px;" />
        <button type="button" class="btn btn-primary wb-profile-save" style="margin-top:10px;width:100%;">保存</button>
      </div>
    `);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    root.querySelector('.wb-profile-save')?.addEventListener('click', async () => {
      const key = (root.querySelector('.wb-profile-key')?.value || '').trim();
      if (!key) return;
      const fans = Number(root.querySelector('.wb-profile-fans')?.value || '0');
      const bio = (root.querySelector('.wb-profile-bio')?.value || '').trim();
      const wbBind = (root.querySelector('.wb-weibo-worldbook')?.value || '').trim();
      const bgFile = root.querySelector('.wb-home-bg-file')?.files?.[0];
      meta.profiles = meta.profiles || {};
      meta.profiles[key] = { ...(meta.profiles[key] || {}), fans, bio };
      meta.weiboWorldBookId = wbBind;
      if (bgFile) {
        try {
          meta.homeBg = await fileToDataUrl(bgFile);
        } catch (_) {}
      }
      await db.put('settings', { key: 'weiboMeta', value: meta });
      close();
      await render(container);
    });
  });

  const busyOverlay = () => container.querySelector('.weibo-busy-overlay');
  const setWeiboBusy = (on) => {
    const el = busyOverlay();
    const btn = container.querySelector('.weibo-generate');
    if (el) {
      el.style.display = on ? 'flex' : 'none';
      el.setAttribute('aria-hidden', on ? 'false' : 'true');
    }
    if (btn) btn.disabled = !!on;
  };

  container.querySelector('.weibo-generate')?.addEventListener('click', async () => {
    const roleplayCtx = await collectRoleplayContextForWeibo(user?.id || '', season);
    const refChars = CHARACTERS.slice(0, 18).map((c) => c.name).join('、');
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const systemPrompt = await buildWeiboAiSystemPrompt(user, season, {
      worldBookId: meta.weiboWorldBookId || '',
      referenceNotes: roleplayCtx.snippets.join('\n'),
    });
    const prompt = [
      `当前年月:${ym}，赛季:${season}`,
      `用户:${user?.name || '旅行者'}，角色池:${refChars}`,
      roleplayCtx.relationLines.length ? `关系摘要:\n${roleplayCtx.relationLines.join('\n')}` : '关系摘要:暂无',
      '请生成更贴近真实微博生态的内容：热搜、争议、辟谣、生活、营销、二次元、体育、娱乐混合。',
      '可适当包含“荣耀联盟官号”（authorId=glory_league_official, authorName=荣耀联盟官号）发布的赛程公告、规则说明、处罚通报、全明星投票、辟谣声明。',
      '热搜只要6条，均用 #xxx# 形式。可含赛程/绯闻/知情人爆料/路人拍到/现实新闻影子，但不要直接泄露聊天原文。',
      '帖子不要全部围绕user；角色行为应符合人设，口吻差异明显。',
      '每条微博带 3 条左右热门评论（带点赞数）。',
      '必须只输出1个JSON对象，不允许解释。',
      'JSON Schema:',
      '{"trending":["#话题#"],"news":["简讯"],"posts":[{"authorId":"id","authorName":"name","content":"text","tags":["#tag#"],"fans":12345,"reposts":1,"comments":2,"likes":3,"hotComments":[{"author":"路人A","content":"评论","likes":99}]}]}',
    ].join('\n');
    const genCap = await resolveGenerationMaxTokens(4096);
    setWeiboBusy(true);
    showToast(`开始生成（max_tokens≈${genCap}）…`);
    try {
      const raw = await apiChat(
        [{ role: 'system', content: `${systemPrompt}\n\n只输出合法JSON，不要解释。` }, { role: 'user', content: prompt }],
        { temperature: 0.9, maxTokens: genCap }
      );
      if (!String(raw || '').trim()) {
        throw new Error('接口返回内容为空，请检查模型是否把结果放在非 message.content 字段，或增大 max_tokens');
      }
      if (raw.trim() === prompt.trim()) {
        throw new Error('接口返回疑似回显请求内容，请检查API地址/模型/鉴权');
      }
      const parsed = await parseWeiboPayload(raw);
      meta.trending = (parsed.trending || []).slice(0, 6).map((x) => {
        const s = String(x || '').trim();
        if (!s) return '';
        if (/^#.+#$/.test(s)) return s;
        return `#${s.replace(/^#|#$/g, '')}#`;
      }).filter(Boolean);
      meta.news = parsed.news || [];
      meta.profiles = meta.profiles || {};
      let inserted = 0;
      for (const p of parsed.posts || []) {
        const normalized = normalizePostFromAi(p);
        const author = await normalizeAuthorIdentity(p.authorId, p.authorName);
        const post = {
          id: 'weibo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
          authorId: author.id || '',
          authorName: author.name || '匿名用户',
          avatar: null,
          content: normalized.content || '',
          images: [],
          timestamp: virtualNow - Math.floor(Math.random() * 3600_000),
          reposts: normalized.reposts,
          comments: normalized.comments,
          likes: normalized.likes,
          fans: p.fans || 0,
          commentList: normalized.hotComments.map((c) => ({ author: c.author, content: c.content, likes: c.likes, timestamp: virtualNow - Math.floor(Math.random() * 400000) })),
        };
        if (post.authorId) meta.profiles[post.authorId] = { ...(meta.profiles[post.authorId] || {}), fans: post.fans };
        await db.put('weiboPosts', post);
        inserted += 1;
        await maybeLinkToChatAfterGenerate({
          userId: user?.id || '',
          post,
          actorId: post.authorId || '',
          actorName: post.authorName,
        });
      }
      // 兜底：完全没解析出帖子时，至少塞一条，避免前端“看起来没更新”
      if (!inserted) {
        const fallbackPost = {
          id: 'weibo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
          authorId: 'npc',
          authorName: '热搜小编',
          avatar: null,
          content: String(raw || '').replace(/\s+/g, ' ').slice(0, 120) || '（本次生成为空）',
          images: [],
          timestamp: virtualNow,
          reposts: 0,
          comments: 0,
          likes: 0,
          fans: 0,
          commentList: [],
        };
        await db.put('weiboPosts', fallbackPost);
        inserted = 1;
      }
      await db.put('settings', { key: 'weiboMeta', value: meta });
      await render(container);
      showToast(`微博内容已更新（新增${inserted}条）`);
    } catch (e) {
      showToast(`微博生成失败：${e?.message || '未知错误'}`);
    } finally {
      setWeiboBusy(false);
    }
  });

  container.querySelector('.weibo-compose')?.addEventListener('click', () => {
    const { close, root } = openGlobalModal(`
      <div class="modal-header">
        <h3>发微博</h3>
        <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">
        <textarea class="form-input weibo-compose-text" rows="6" placeholder="分享新鲜事…"></textarea>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
          <button type="button" class="btn btn-outline weibo-compose-ai">AI生成</button>
          <button type="button" class="btn btn-primary weibo-compose-submit">发布</button>
        </div>
      </div>
    `);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    root.querySelector('.weibo-compose-ai')?.addEventListener('click', () => {
      alert('coming soon');
    });
    root.querySelector('.weibo-compose-submit')?.addEventListener('click', async () => {
      const ta = root.querySelector('.weibo-compose-text');
      const text = (ta?.value || '').trim();
      if (!text) return;
      const post = {
        id: 'weibo_' + Date.now(),
        authorId: user?.id || 'guest',
        authorName: user?.name || '旅行者',
        avatar: user?.avatar || null,
        content: text,
        images: [],
        timestamp: virtualNow,
        reposts: 0,
        comments: 0,
        likes: 0,
      };
      await db.put('weiboPosts', post);
      close();
      await render(container);
    });
  });

  container.querySelectorAll('.weibo-ai-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      alert('coming soon');
    });
  });
  container.querySelector('.weibo-refresh')?.addEventListener('click', () => {
    container.querySelector('.weibo-generate')?.click();
  });
  container.querySelector('.weibo-search-btn')?.addEventListener('click', () => {
    const q = (container.querySelector('.weibo-search-input')?.value || '').trim();
    if (!q) return;
    showToast(`已搜索：${q}`);
  });

  container.querySelectorAll('.weibo-post').forEach((postEl) => {
    postEl.querySelectorAll('.weibo-profile-link').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigate('weibo-profile', {
          authorId: btn.dataset.authorId || '',
          authorName: btn.dataset.authorName || '用户',
        });
      });
    });
    postEl.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      navigate('weibo-detail', { postId: postEl.dataset.postId });
    });
    postEl.querySelector('[data-act="follow"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const post = posts.find((p) => p.id === postEl.dataset.postId);
      if (!post) return;
      const key = post.authorId || post.authorName;
      const set = new Set(meta.followingIds || []);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      meta.followingIds = [...set];
      await db.put('settings', { key: 'weiboMeta', value: meta });
      await render(container);
    });
    postEl.querySelector('[data-act="comment"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const post = posts.find((p) => p.id === postEl.dataset.postId);
      if (!post) return;
      const list = post.commentList || [];
      const { close, root } = openGlobalModal(`
        <div class="modal-header"><h3>评论</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
        <div class="modal-body">
          <div style="max-height:240px;overflow:auto;">${list.map((c) => `<div style="padding:8px 0;border-bottom:1px solid var(--border);"><strong>${escapeHtml(c.author || '匿名')}</strong><div>${escapeHtml(c.content || '')}</div></div>`).join('') || '<div class="text-hint">暂无评论</div>'}</div>
          <textarea class="form-input wb-comment" rows="3" placeholder="写评论..." style="margin-top:8px;"></textarea>
          <button type="button" class="btn btn-primary wb-comment-send" style="margin-top:8px;width:100%;">发送</button>
        </div>
      `);
      root.querySelector('.modal-close-btn')?.addEventListener('click', close);
      root.querySelector('.wb-comment-send')?.addEventListener('click', async () => {
        const text = (root.querySelector('.wb-comment')?.value || '').trim();
        if (!text) return;
        const nowTs = await getVirtualNow(user?.id || '', Date.now());
        post.commentList = [...(post.commentList || []), { author: user?.name || '旅行者', content: text, timestamp: nowTs }];
        post.comments = post.commentList.length;
        await db.put('weiboPosts', post);
        close();
        await render(container);
      });
    });
    postEl.querySelector('[data-act="chat-share"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const post = posts.find((p) => p.id === postEl.dataset.postId);
      if (!post) return;
      const uid = await getCurrentUserId();
      const chats = (await db.getAllByIndex('chats', 'userId', uid || '')).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
      if (!chats.length) return;
      const { close, root } = openGlobalModal(`
        <div class="modal-header"><h3>转发到聊天</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
        <div class="modal-body" style="max-height:58vh;overflow:auto;">
          ${chats.slice(0, 30).map((c) => {
            const nm = c.type === 'group' ? (c.groupSettings?.name || '群聊') : (c.participants || []).filter((x) => x !== 'user')[0] || '私聊';
            return `<button type="button" class="btn btn-outline wb-chat-pick" data-chat-id="${escapeAttr(c.id)}" style="width:100%;margin-bottom:8px;text-align:left;">${escapeHtml(nm)} · ${c.type === 'group' ? '群聊' : '私聊'}</button>`;
          }).join('')}
        </div>
      `);
      root.querySelector('.modal-close-btn')?.addEventListener('click', close);
      root.querySelectorAll('.wb-chat-pick').forEach((pick) => {
        pick.addEventListener('click', async () => {
          const target = chats.find((c) => c.id === pick.dataset.chatId);
          if (!target) return;
          const linkMsg = createMessage({
            chatId: target.id,
            senderId: 'user',
            type: 'link',
            content: `weibo://${post.id}`,
            metadata: {
              title: `微博：${post.authorName || '用户'}`,
              desc: (post.content || '').slice(0, 80),
              source: '微博',
            },
          });
          await db.put('messages', linkMsg);
          target.lastMessage = '[微博分享]';
          target.lastActivity = await getVirtualNow(user?.id || '', Date.now());
          await db.put('chats', target);
          close();
          showToast('已转发到聊天');
        });
      });
    });
  });

  void navigate;
}
