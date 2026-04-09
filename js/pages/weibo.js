import { navigate, back } from '../core/router.js';
import * as db from '../core/db.js';
import { createMessage } from '../models/chat.js';
import { chat as apiChat, resolveGenerationMaxTokens } from '../core/api.js';
import { getState } from '../core/state.js';
import { CHARACTERS } from '../data/characters.js';
import { showToast } from '../components/toast.js';
import { icon } from '../components/svg-icons.js';
import { getCharacterStateForSeason } from '../core/chat-helpers.js';
import { buildWeiboAiSystemPrompt } from '../core/context.js';
import { getVirtualNow } from '../core/virtual-time.js';
import {
  getUserChatsForRelay,
  normalizeAuthorIdentity,
  applyGeneratedChatShares,
} from '../core/social-chat-relay.js';


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

function hashCode(s) {
  let h = 0;
  const t = String(s || '');
  for (let i = 0; i < t.length; i += 1) h = (h << 5) - h + t.charCodeAt(i);
  return Math.abs(h);
}

function seededNoise(seed, min = 0, max = 1) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  const n = x - Math.floor(x);
  return min + (max - min) * n;
}

function formatSocialCount(v) {
  const n = Math.max(0, Number(v) || 0);
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.floor(n));
}

function getWeiboDmKey(ownerUserId, profileKey) {
  return `weiboDmBox_${ownerUserId}_${profileKey}`;
}

function formatMentionName(name) {
  const n = String(name || '').trim();
  if (!n) return '@匿名用户';
  return n.startsWith('@') ? n : `@${n}`;
}

function profileKeyForPost(post) {
  return String(post?.authorId || post?.authorName || '匿名用户');
}

function likedByMeInWeibo(post, user) {
  const uid = String(user?.id || '').trim();
  const uname = String(user?.name || '').trim();
  const list = Array.isArray(post?.metadata?.likedByUserIds) ? post.metadata.likedByUserIds : [];
  return list.includes(uid) || (!!uname && list.includes(uname));
}

async function pushWeiboDm({ ownerUserId, receiverKey, senderName, senderType, content, timestamp }) {
  const key = getWeiboDmKey(ownerUserId, receiverKey);
  const row = await db.get('settings', key);
  const list = Array.isArray(row?.value) ? row.value : [];
  const next = [...list, {
    id: `wb_dm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    senderName: String(senderName || '匿名用户'),
    senderType: String(senderType || '粉丝'),
    content: String(content || '').trim(),
    timestamp: Number(timestamp || Date.now()),
  }].slice(-120);
  await db.put('settings', { key, value: next });
}

function simulatePostMetrics(post) {
  const seed = hashCode(post?.id || post?.content || '');
  const baseLikes = Number(post?.likes || 0);
  const baseComments = Number(post?.comments || 0);
  const baseReposts = Number(post?.reposts || 0);
  const likes = Math.max(baseLikes, Math.floor(120 + seededNoise(seed + 1, 0, 9800)));
  const comments = Math.max(baseComments, Math.floor(16 + seededNoise(seed + 2, 0, 1800)));
  const reposts = Math.max(baseReposts, Math.floor(8 + seededNoise(seed + 3, 0, 1200)));
  return { likes, comments, reposts };
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

function getWeiboOwnerUserId(userId) {
  return userId || 'guest';
}

function getWeiboMetaKey(userId) {
  return `weiboMeta_${getWeiboOwnerUserId(userId)}`;
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

function renderHotCommentBlock(post) {
  const list = Array.isArray(post?.commentList) ? post.commentList : [];
  if (!list.length) return '';
  const first = list[0];
  const hotLike = Math.max(
    Number(first?.likes || 0),
    Math.floor(16 + seededNoise(hashCode(`${post?.id || ''}_hot0`), 0, 4200)),
  );
  const total = Math.max(list.length, Number(post?.comments || 0));
  return `
    <div class="weibo-hot-comments">
      <div class="weibo-hot-title">热评</div>
      <div class="weibo-hot-item">
        <span class="weibo-hot-author">${escapeHtml(first.author || '热评用户')}</span>
        <span class="weibo-hot-content">${escapeHtml(first.content || '')}</span>
        <span class="weibo-hot-like">${formatSocialCount(hotLike)}</span>
      </div>
      <button type="button" class="weibo-hot-more" data-act="comment">查看全部${formatSocialCount(total)}条评论 ></button>
    </div>
  `;
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

const getUserChats = getUserChatsForRelay;

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
  const relayGroupNames = chats
    .filter((c) => c.type === 'group' && (c.participants || []).includes('user'))
    .map((c) => String(c.groupSettings?.name || '').trim())
    .filter(Boolean)
    .slice(0, 16);
  return { relationLines, snippets, relayGroupNames };
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
    repostFromAuthorId: String(item.repostFromAuthorId || '').trim(),
    repostFromAuthorName: String(item.repostFromAuthorName || '').trim(),
    repostFromPostId: String(item.repostFromPostId || '').trim(),
    repostComment: String(item.repostComment || '').trim(),
    reposts: Math.max(0, Number(item.reposts || 0)),
    comments: Math.max(0, Number(item.comments || hotComments.length || 0)),
    likes: Math.max(0, Number(item.likes || 0)),
    hotComments,
  };
}

export default async function render(container) {
  const user = await getCurrentUser();
  const ownerUserId = getWeiboOwnerUserId(user?.id || '');
  const weiboMetaKey = getWeiboMetaKey(user?.id || '');
  const season = getState('currentUser')?.currentTimeline || 'S8';
  const allWeiboPosts = await db.getAll('weiboPosts');
  const legacyPosts = allWeiboPosts.filter((p) => !p?.ownerUserId);
  if (legacyPosts.length) {
    for (const p of legacyPosts) {
      await db.put('weiboPosts', { ...p, ownerUserId });
    }
  }
  const posts = (await db.getAll('weiboPosts'))
    .filter((p) => (p?.ownerUserId || '') === ownerUserId)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const metaRow = await db.get('settings', weiboMetaKey);
  const legacyMetaRow = metaRow ? null : await db.get('settings', 'weiboMeta');
  const meta = metaRow?.value || {
    trending: [],
    news: [],
    followingIds: [],
    profiles: {},
    weiboWorldBookId: '',
    homeBg: '',
  };
  if (!metaRow && legacyMetaRow?.value) {
    Object.assign(meta, legacyMetaRow.value);
    await db.put('settings', { key: weiboMetaKey, value: meta });
  }
  meta.profiles = meta.profiles || {};
  meta.profiles.glory_league_official = {
    fans: 3200000,
    bio: '荣耀职业联盟官方账号｜赛程公告｜规则说明｜全明星与奖项公示',
    ...(meta.profiles.glory_league_official || {}),
  };
  const virtualNow = await getVirtualNow(user?.id || '', 0);

  const trendHtml = `
    <div class="card-block" style="margin:10px 12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong>微博热搜</strong>
        <span class="text-hint">${season}</span>
      </div>
      <div style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;">
        ${(meta.trending || []).slice(0, 6).map((x, i) => {
          const topic = String(x || '').trim();
          return `<div style="display:flex;gap:8px;font-size:13px;align-items:baseline;"><span style="color:#ff7a45;flex-shrink:0;">${i + 1}</span><button type="button" class="weibo-trend-link" data-topic="${escapeAttr(topic)}">${escapeHtml(topic)}</button></div>`;
        }).join('') || '<div class="text-hint">暂无热搜，点击⚡生成</div>'}
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
      const sim = simulatePostMetrics(p);
      const liked = likedByMeInWeibo(p, user);
      const repostMeta = p?.metadata?.repostFrom;
      const repostBlock = repostMeta
        ? `<div class="weibo-repost-origin">转发 ${escapeHtml(formatMentionName(repostMeta.authorName || repostMeta.authorId))}${repostMeta.content ? `：${escapeHtml(String(repostMeta.content).slice(0, 88))}` : ''}</div>`
        : '';
      chunks.push(`
        <article class="weibo-post card-block" data-post-id="${escapeAttr(p.id)}">
          <header class="weibo-post-header">
            <button type="button" class="weibo-avatar weibo-profile-link" data-author-id="${escapeAttr(p.authorId || '')}" data-author-name="${escapeAttr(p.authorName || '')}" aria-label="作者主页">${avatar}</button>
            <div class="weibo-post-headtext">
              <button type="button" class="weibo-post-name weibo-profile-link" data-author-id="${escapeAttr(p.authorId || '')}" data-author-name="${escapeAttr(p.authorName || '')}">${name}<span class="weibo-v-badge">V</span></button>
              <div class="weibo-post-meta">${escapeHtml(timeMeta)} · 粉丝 ${escapeHtml(formatSocialCount(fans))}</div>
            </div>
          </header>
          ${repostBlock}
          <div class="weibo-post-content">${escapeHtml(p.content || '')}</div>
          ${renderImagesGrid(p.images)}
          ${renderHotCommentBlock({ ...p, comments: sim.comments })}
          <div class="weibo-actions">
            <button type="button" class="weibo-action-btn is-mini" data-act="repost" aria-label="转发">${icon('weiboRepost', 'weibo-act-svg')}<span>${formatSocialCount(sim.reposts)}</span></button>
            <button type="button" class="weibo-action-btn is-mini" data-act="comment" aria-label="评论">${icon('weiboComment', 'weibo-act-svg')}<span>${formatSocialCount(sim.comments)}</span></button>
            <button type="button" class="weibo-action-btn is-mini ${liked ? 'is-liked' : ''}" data-act="like" aria-label="点赞">${icon('weiboLike', 'weibo-act-svg')}<span>${liked ? '已赞' : formatSocialCount(sim.likes)}</span></button>
            <button type="button" class="weibo-action-btn is-mini" data-act="share" aria-label="分享">${icon('send', 'weibo-act-svg')}<span>分享</span></button>
            <button type="button" class="weibo-action-btn is-mini icon-only danger" data-act="delete" aria-label="删除">${icon('trash', 'weibo-act-svg')}</button>
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
      await db.put('settings', { key: weiboMetaKey, value: meta });
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

  const persistGeneratedPayload = async (parsed, opts = {}) => {
    const topicHint = String(opts.topicHint || '').trim();
    meta.trending = (parsed.trending || []).slice(0, 6).map((x) => {
      const s = String(x || '').trim();
      if (!s) return '';
      if (/^#.+#$/.test(s)) return s;
      return `#${s.replace(/^#|#$/g, '')}#`;
    }).filter(Boolean);
    if (topicHint && !meta.trending.some((x) => x.includes(topicHint))) {
      meta.trending = [`#${topicHint.replace(/^#|#$/g, '')}#`, ...meta.trending].slice(0, 6);
    }
    meta.news = parsed.news || [];
    meta.profiles = meta.profiles || {};
    let inserted = 0;
    const insertedPosts = [];
    for (const p of parsed.posts || []) {
      const normalized = normalizePostFromAi(p);
      const author = await normalizeAuthorIdentity(p.authorId, p.authorName);
      const postTs = virtualNow - Math.floor(Math.random() * 3600_000);
      const repostFromMeta = normalized.repostFromAuthorId || normalized.repostFromAuthorName
        ? {
            authorId: normalized.repostFromAuthorId || '',
            authorName: normalized.repostFromAuthorName || '',
            postId: normalized.repostFromPostId || '',
            content: normalized.repostComment || '',
          }
        : null;
      const post = {
        id: 'weibo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        ownerUserId,
        authorId: author.id || '',
        authorName: author.name || '匿名用户',
        avatar: null,
        content: normalized.content || '',
        tags: Array.isArray(p.tags) && p.tags.length ? p.tags : (normalized.tags || []),
        images: [],
        timestamp: postTs,
        reposts: normalized.reposts,
        comments: normalized.comments,
        likes: normalized.likes,
        fans: Number(p.fans || 0),
        metadata: repostFromMeta ? { repostFrom: repostFromMeta } : {},
        commentList: normalized.hotComments.map((c) => ({ author: c.author, content: c.content, likes: c.likes, timestamp: virtualNow - Math.floor(Math.random() * 400000) })),
      };
      if (post.authorId) meta.profiles[post.authorId] = { ...(meta.profiles[post.authorId] || {}), fans: Number(post.fans || 0) + seededNoise(hashCode(post.authorId), 0.1, 0.9) };
      await db.put('weiboPosts', post);
      insertedPosts.push(post);
      inserted += 1;
    }
    await applyGeneratedChatShares({
      userId: user?.id || '',
      chatShares: parsed.chatShares,
      relayItems: insertedPosts,
      virtualNow,
      relaySpec: {
        urlScheme: 'weibo',
        sourceLabel: '微博',
        lastMessagePreview: '[微博分享]',
        linkTitle: (post, fname) => `微博：${post.authorName || fname}`,
        linkDesc: (post) => post.content || '',
        extraLinkMetadata: () => ({ fromWeiboRelay: true }),
      },
    });
    const dms = Array.isArray(parsed?.dms) ? parsed.dms : [];
    for (const dm of dms.slice(0, 10)) {
      const receiverKey = String(dm?.receiverKey || '').trim();
      const fallbackReceiver = profileKeyForPost(pickRandom(insertedPosts) || {});
      const targetKey = receiverKey || fallbackReceiver || (user?.id || user?.name || 'user');
      await pushWeiboDm({
        ownerUserId,
        receiverKey: targetKey,
        senderName: String(dm?.senderName || '路人粉'),
        senderType: String(dm?.senderType || '粉丝'),
        content: String(dm?.content || '').trim(),
        timestamp: virtualNow - Math.floor(Math.random() * 1800_000),
      });
    }
    if (!inserted) {
      const fallbackPost = {
        id: 'weibo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        ownerUserId,
        authorId: 'npc',
        authorName: '热搜小编',
        avatar: null,
        content: topicHint ? `关于「${topicHint}」暂无明确定论，讨论持续升温。` : '（本次生成为空）',
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
    await db.put('settings', { key: weiboMetaKey, value: meta });
    return inserted;
  };

  container.querySelector('.weibo-generate')?.addEventListener('click', async () => {
    const roleplayCtx = await collectRoleplayContextForWeibo(user?.id || '', season);
    const refChars = CHARACTERS.slice(0, 18).map((c) => c.name).join('、');
    const virtualIso = new Date(virtualNow).toISOString().replace('T', ' ').slice(0, 16);
    const systemPrompt = await buildWeiboAiSystemPrompt(user, season, {
      worldBookId: meta.weiboWorldBookId || '',
      referenceNotes: roleplayCtx.snippets.join('\n'),
    });
    const relayHint = (roleplayCtx.relayGroupNames || []).length
      ? `用户存档中的群聊名称（chatShares 里 targetType 为 group 时 groupName 须与下列之一一致或明显包含关系）:${roleplayCtx.relayGroupNames.join('、')}`
      : '用户当前无存档群聊：chatShares 请只用 targetType=private_user（角色与用户的私聊转发），不要写 group。';
    const prompt = [
      `当前虚拟时间:${virtualIso}，赛季:${season}`,
      `用户:${user?.name || '旅行者'}，角色池:${refChars}`,
      relayHint,
      roleplayCtx.relationLines.length ? `关系摘要:\n${roleplayCtx.relationLines.join('\n')}` : '关系摘要:暂无',
      '请生成更贴近真实微博生态的内容：热搜、争议、辟谣、生活、营销、二次元、体育、娱乐混合。',
      '可适当包含“荣耀联盟官号”（authorId=glory_league_official, authorName=荣耀联盟官号）发布的赛程公告、规则说明、处罚通报、全明星投票、辟谣声明。',
      '热搜只要6条，均用 #xxx# 形式。可含赛程/绯闻/知情人爆料/路人拍到/现实新闻影子，但不要直接泄露聊天原文。',
      '帖子不要全部围绕user；角色行为应符合人设，口吻差异明显。要出现微博站内转发链（带@）。',
      '每条微博带 3 条左右热门评论（带点赞数）。',
      '并生成 3-6 条微博私信，收件人可为任意作者或用户本人，发送者身份可为粉丝/黑子/梦女/同行/营销号/广告商。',
      'chatShares：默认必须输出空数组 []。仅当剧情明确需要「把某条微博转进聊天」时再填 1～2 条（勿为凑数输出）。字段含义：postIndex 对应 posts 下标；private_user 或 group+真实群名；lines 为口语对白；可 wrongSend+wrongGroupName。',
      '必须只输出1个JSON对象，不允许解释。',
      'JSON Schema:',
      '{"trending":["#话题#"],"news":["简讯"],"posts":[{"authorId":"id","authorName":"name","content":"text","tags":["#tag#"],"fans":12345.6,"reposts":1,"comments":2,"likes":3,"repostFromAuthorId":"可空","repostFromAuthorName":"可空","repostFromPostId":"可空","repostComment":"可空","hotComments":[{"author":"路人A","content":"评论","likes":99}]}],"dms":[{"receiverKey":"authorId或用户名","senderName":"昵称","senderType":"粉丝|黑子|梦女|梦男|同行|营销号|广告商","content":"私信内容"}],"chatShares":[]}',
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
      const inserted = await persistGeneratedPayload(parsed);
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
        ownerUserId,
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

  container.querySelector('.weibo-refresh')?.addEventListener('click', () => {
    container.querySelector('.weibo-generate')?.click();
  });
  container.querySelector('.weibo-search-btn')?.addEventListener('click', () => {
    const q = (container.querySelector('.weibo-search-input')?.value || '').trim();
    const { close, root } = openGlobalModal(`
      <div class="modal-header"><h3>指定话题生成</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
      <div class="modal-body">
        <input class="form-input wb-topic-title" placeholder="话题关键词（例：${escapeAttr(q || '和黄少天出去玩被拍') }）" value="${escapeAttr(q)}" />
        <input class="form-input wb-topic-roles" style="margin-top:8px;" placeholder="相关角色（用顿号/逗号分隔）例：黄少天、喻文州、用户" />
        <textarea class="form-input wb-topic-main" rows="5" style="margin-top:8px;" placeholder="主要内容：事件经过、争议点、你希望出现的官号发言/澄清方向"></textarea>
        <div class="text-hint" style="margin-top:8px;">将按你给的主题生成：热搜、原博、站内转发链、争议讨论、官号澄清、私信，以及可选的 chatShares（角色把微博转进私聊/群并带对白）。</div>
        <button type="button" class="btn btn-outline wb-topic-open-page" style="margin-top:12px;width:100%;">打开话题聚合页（不生成）</button>
        <button type="button" class="btn btn-primary wb-topic-generate" style="margin-top:8px;width:100%;">按主题生成</button>
      </div>
    `);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    root.querySelector('.wb-topic-open-page')?.addEventListener('click', () => {
      const topic = (root.querySelector('.wb-topic-title')?.value || '').trim();
      if (!topic) {
        showToast('请先填写话题关键词');
        return;
      }
      close();
      navigate('weibo-topic', { topic });
    });
    root.querySelector('.wb-topic-generate')?.addEventListener('click', async () => {
      const topic = (root.querySelector('.wb-topic-title')?.value || '').trim();
      const roles = (root.querySelector('.wb-topic-roles')?.value || '').trim();
      const main = (root.querySelector('.wb-topic-main')?.value || '').trim();
      if (!topic && !main) {
        showToast('请至少填写话题或主要内容');
        return;
      }
      close();
      const roleplayCtx = await collectRoleplayContextForWeibo(user?.id || '', season);
      const refChars = CHARACTERS.slice(0, 18).map((c) => c.name).join('、');
      const virtualIso = new Date(virtualNow).toISOString().replace('T', ' ').slice(0, 16);
      const systemPrompt = await buildWeiboAiSystemPrompt(user, season, {
        worldBookId: meta.weiboWorldBookId || '',
        referenceNotes: roleplayCtx.snippets.join('\n'),
      });
      const relayHintTopic = (roleplayCtx.relayGroupNames || []).length
        ? `用户存档群名（chatShares 用 group 时 groupName 须匹配）:${roleplayCtx.relayGroupNames.join('、')}`
        : '用户无存档群聊：chatShares 仅用 private_user。';
      const prompt = [
        `当前虚拟时间:${virtualIso}，赛季:${season}`,
        `用户:${user?.name || '旅行者'}，角色池:${refChars}`,
        `指定话题:${topic || '（未填）'}`,
        `相关角色:${roles || '（AI自行判断）'}`,
        `主要内容:${main || '（AI自行扩展）'}`,
        relayHintTopic,
        roleplayCtx.relationLines.length ? `关系摘要:\n${roleplayCtx.relationLines.join('\n')}` : '关系摘要:暂无',
        '围绕该指定话题生成完整微博舆情页：热搜、新闻简讯、原博、多人站内转发与@、争议分歧、官号澄清/发言、营销号和路人解读。',
        '转发是微博站内转发，不是聊天分享；可多层转发并附评论，形成链路。',
        '请生成几条微博私信（粉丝/黑子/梦男梦女/同行/营销号/广告商）。',
        'chatShares：默认 []；仅剧情需要时再 1～2 条（规则同主生成页说明）。',
        '只输出1个JSON对象，不允许解释。',
        'JSON Schema:',
        '{"trending":["#话题#"],"news":["简讯"],"posts":[{"authorId":"id","authorName":"name","content":"text","tags":["#tag#"],"fans":12345.6,"reposts":1,"comments":2,"likes":3,"repostFromAuthorId":"可空","repostFromAuthorName":"可空","repostFromPostId":"可空","repostComment":"可空","hotComments":[{"author":"路人A","content":"评论","likes":99}]}],"dms":[{"receiverKey":"authorId或用户名","senderName":"昵称","senderType":"粉丝|黑子|梦女|梦男|同行|营销号|广告商","content":"私信内容"}],"chatShares":[]}',
      ].join('\n');
      const genCap = await resolveGenerationMaxTokens(4096);
      setWeiboBusy(true);
      showToast('正在生成指定话题微博…');
      try {
        const raw = await apiChat(
          [{ role: 'system', content: `${systemPrompt}\n\n只输出合法JSON，不要解释。` }, { role: 'user', content: prompt }],
          { temperature: 0.92, maxTokens: genCap }
        );
        const parsed = await parseWeiboPayload(raw);
        const inserted = await persistGeneratedPayload(parsed, { topicHint: topic });
        await render(container);
        showToast(`话题页生成完成（新增${inserted}条）`);
        if (topic) navigate('weibo-topic', { topic });
      } catch (err) {
        showToast(`话题生成失败：${err?.message || '未知错误'}`);
      } finally {
        setWeiboBusy(false);
      }
    });
  });

  container.querySelectorAll('.weibo-trend-link').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const topic = btn.getAttribute('data-topic') || '';
      if (topic) navigate('weibo-topic', { topic });
    });
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
    postEl.querySelector('[data-act="comment"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const post = posts.find((p) => p.id === postEl.dataset.postId);
      if (!post) return;
      const list = post.commentList || [];
      const { close, root } = openGlobalModal(`
        <div class="modal-header"><h3>评论</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
        <div class="modal-body">
          <div class="weibo-comment-sheet">${list.map((c, idx) => `<div class="weibo-comment-row"><div class="weibo-comment-avatar">${escapeHtml(String(c.author || '评').slice(0, 1))}</div><div class="weibo-comment-main"><div class="weibo-comment-author">${escapeHtml(c.author || '匿名')}</div><div class="weibo-comment-text">${escapeHtml(c.content || '')}</div></div><div style="display:flex;align-items:center;gap:6px;"><div class="weibo-comment-like">${formatSocialCount(Math.max(Number(c.likes || 0), Math.floor(6 + seededNoise(hashCode(`${post.id}_${c.author}_${c.content}`), 0, 480))))}</div><button type="button" class="weibo-comment-del-btn wb-comment-del" data-comment-idx="${idx}" aria-label="删除评论">${icon('trash', 'weibo-act-svg')}</button></div></div>`).join('') || '<div class="text-hint">暂无评论</div>'}</div>
          <textarea class="form-input wb-comment" rows="3" placeholder="写评论..." style="margin-top:8px;"></textarea>
          <button type="button" class="btn btn-primary wb-comment-send" style="margin-top:8px;width:100%;">发送</button>
        </div>
      `);
      root.querySelector('.modal-close-btn')?.addEventListener('click', close);
      root.querySelectorAll('.wb-comment-del').forEach((delBtn) => {
        delBtn.addEventListener('click', async () => {
          const idx = Number(delBtn.getAttribute('data-comment-idx'));
          if (!Number.isInteger(idx) || idx < 0) return;
          if (!confirm('确认删除这条评论吗？')) return;
          const currentPost = await db.get('weiboPosts', post.id);
          if (!currentPost) return;
          const comments = Array.isArray(currentPost.commentList) ? currentPost.commentList : [];
          if (idx >= comments.length) return;
          comments.splice(idx, 1);
          currentPost.commentList = comments;
          currentPost.comments = comments.length;
          await db.put('weiboPosts', currentPost);
          close();
          await render(container);
        });
      });
      root.querySelector('.wb-comment-send')?.addEventListener('click', async () => {
        const text = (root.querySelector('.wb-comment')?.value || '').trim();
        if (!text) return;
        const nowTs = await getVirtualNow(user?.id || '', 0);
        post.commentList = [...(post.commentList || []), { author: user?.name || '旅行者', content: text, timestamp: nowTs }];
        post.comments = post.commentList.length;
        await db.put('weiboPosts', post);
        close();
        await render(container);
      });
    });
    postEl.querySelector('[data-act="repost"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const post = posts.find((p) => p.id === postEl.dataset.postId);
      if (!post) return;
      const txt = String(window.prompt('转发并评论（可空）', '') || '').trim();
      const nowTs = await getVirtualNow(user?.id || '', 0);
      post.repostList = [...(post.repostList || []), { author: user?.name || '旅行者', content: `${formatMentionName(post.authorName)} ${txt || '转发微博'}`.trim(), timestamp: nowTs }];
      post.reposts = Math.max(Number(post.reposts || 0), post.repostList.length);
      await db.put('weiboPosts', post);
      const repostPost = {
        id: 'weibo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        ownerUserId,
        authorId: user?.id || 'guest',
        authorName: user?.name || '旅行者',
        avatar: user?.avatar || null,
        content: txt || `转发了 ${formatMentionName(post.authorName)}`,
        images: [],
        timestamp: nowTs,
        reposts: 0,
        comments: 0,
        likes: 0,
        metadata: {
          repostFrom: {
            authorId: post.authorId || '',
            authorName: post.authorName || '',
            postId: post.id,
            content: String(post.content || '').slice(0, 160),
          },
        },
      };
      await db.put('weiboPosts', repostPost);
      await render(container);
    });
    postEl.querySelector('[data-act="like"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const post = posts.find((p) => p.id === postEl.dataset.postId);
      if (!post || !user) return;
      post.metadata = post.metadata || {};
      const uid = String(user.id || '').trim();
      const uname = String(user.name || '').trim();
      const likedBy = new Set(Array.isArray(post.metadata.likedByUserIds) ? post.metadata.likedByUserIds : []);
      const hasLiked = likedBy.has(uid) || (!!uname && likedBy.has(uname));
      if (hasLiked) {
        likedBy.delete(uid);
        if (uname) likedBy.delete(uname);
        post.likes = Math.max(0, Number(post.likes || 0) - 1);
      } else {
        if (uid) likedBy.add(uid);
        else if (uname) likedBy.add(uname);
        post.likes = Math.max(0, Number(post.likes || 0)) + 1;
      }
      post.metadata.likedByUserIds = [...likedBy];
      await db.put('weiboPosts', post);
      await render(container);
    });
    postEl.querySelector('[data-act="share"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const post = posts.find((p) => p.id === postEl.dataset.postId);
      if (!post || !user?.id) return;
      const allChats = await db.getAllByIndex('chats', 'userId', user.id);
      const { close, root } = openGlobalModal(`
        <div class="modal-header"><h3>分享至聊天</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
        <div class="modal-body">
          ${(allChats || []).slice(0, 24).map((c) => `<button type="button" class="btn btn-outline btn-block wb-share-chat" data-cid="${escapeAttr(c.id)}">${escapeHtml(c.groupSettings?.name || (c.type === 'group' ? '群聊' : '私聊'))}</button>`).join('') || '<div class="text-hint">暂无聊天窗口</div>'}
        </div>
      `);
      root.querySelector('.modal-close-btn')?.addEventListener('click', close);
      root.querySelectorAll('.wb-share-chat').forEach((el) => {
        el.addEventListener('click', async () => {
          const chatId = el.getAttribute('data-cid') || '';
          const target = allChats.find((c) => c.id === chatId);
          if (!target) return;
          const ts = await getVirtualNow(user.id, 0);
          const msg = createMessage({
            chatId: target.id,
            senderId: 'user',
            type: 'chat-bundle',
            content: `weibo://${post.id}`,
            metadata: {
              bundleTitle: `微博分享 · ${post.authorName || '用户'}`,
              bundleSummary: String(post.content || '').slice(0, 80) || '查看微博',
              source: '微博',
              fromChatLabel: '微博',
              bundleItems: [{ senderName: post.authorName || '用户', type: 'text', content: String(post.content || '').slice(0, 300) }],
            },
            timestamp: ts,
          });
          await db.put('messages', msg);
          target.lastMessage = '[微博分享]';
          target.lastActivity = ts;
          await db.put('chats', target);
          close();
          showToast('已分享至聊天');
        });
      });
    });
    postEl.querySelector('[data-act="delete"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const post = posts.find((p) => p.id === postEl.dataset.postId);
      if (!post) return;
      if (!confirm('确认删除这条微博吗？')) return;
      await db.del('weiboPosts', post.id);
      await render(container);
    });
  });

  void navigate;
}
