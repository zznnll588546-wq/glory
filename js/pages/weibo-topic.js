import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { getState } from '../core/state.js';
import { icon } from '../components/svg-icons.js';

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

function getWeiboOwnerUserId(userId) {
  return userId || 'guest';
}

function getWeiboMetaKey(userId) {
  return `weiboMeta_${getWeiboOwnerUserId(userId)}`;
}

function getWeiboDmKey(ownerUserId, profileKey) {
  return `weiboDmBox_${ownerUserId}_${profileKey}`;
}

function formatMentionName(name) {
  const n = String(name || '').trim();
  if (!n) return '@匿名用户';
  return n.startsWith('@') ? n : `@${n}`;
}

/** 规范化话题：去 #、trim、小写，用于匹配 */
function normalizeTopicKey(topic) {
  return String(topic || '')
    .replace(/^#+|#+$/g, '')
    .trim()
    .toLowerCase();
}

function displayTopicLabel(topicRaw, key) {
  const t = String(topicRaw || '').trim();
  if (t.startsWith('#') && t.endsWith('#')) return t;
  if (key) return `#${key}#`;
  return t || '话题';
}

function isOfficialPost(p) {
  const id = String(p?.authorId || '');
  const name = String(p?.authorName || '');
  return id === 'glory_league_official' || /联盟官号|荣耀联盟|赛事官方|职业联盟/.test(name);
}

function postMatchesTopic(p, topicKey) {
  if (!topicKey) return false;
  const k = topicKey;
  const blob = [
    p?.content,
    ...(Array.isArray(p?.tags) ? p.tags : []),
    p?.metadata?.repostFrom?.content,
    p?.metadata?.repostFrom?.authorName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return blob.includes(k);
}

function collectRelatedNews(metaNews, topicKey) {
  if (!topicKey || !Array.isArray(metaNews)) return [];
  return metaNews.filter((n) => String(n || '').toLowerCase().includes(topicKey)).slice(0, 6);
}

async function loadRelatedDms(ownerUserId, matchedPosts, topicKey, viewerUser) {
  if (!topicKey) return [];
  const keys = new Set();
  for (const p of matchedPosts.slice(0, 20)) {
    if (p?.authorId) keys.add(String(p.authorId));
    if (p?.authorName) keys.add(String(p.authorName));
  }
  if (viewerUser?.id) keys.add(String(viewerUser.id));
  if (viewerUser?.name) keys.add(String(viewerUser.name));
  keys.add('glory_league_official');
  keys.add('荣耀联盟官号');

  const out = [];
  for (const profileKey of keys) {
    if (!profileKey) continue;
    const row = await db.get('settings', getWeiboDmKey(ownerUserId, profileKey));
    const list = Array.isArray(row?.value) ? row.value : [];
    for (const dm of list) {
      const txt = String(dm?.content || '').toLowerCase();
      if (txt.includes(topicKey)) {
        out.push({ ...dm, inboxFor: profileKey });
      }
    }
  }
  out.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return out.slice(0, 36);
}

function compactPostCard(p, sectionClass = '') {
  const rep = p?.metadata?.repostFrom;
  const repLine = rep
    ? `<div class="weibo-topic-repost-line">转发 ${escapeHtml(formatMentionName(rep.authorName || rep.authorId))}${rep.content ? ` · ${escapeHtml(String(rep.content).slice(0, 72))}` : ''}</div>`
    : '';
  return `
    <article class="weibo-topic-post card-block ${sectionClass}" data-post-id="${escapeAttr(p.id)}">
      <div class="weibo-topic-post-head">
        <button type="button" class="weibo-topic-author weibo-profile-link" data-author-id="${escapeAttr(p.authorId || '')}" data-author-name="${escapeAttr(p.authorName || '')}">
          ${escapeHtml(p.authorName || '用户')}<span class="weibo-v-badge">V</span>
        </button>
        <span class="weibo-topic-time">${escapeHtml(formatTime(p.timestamp || 0))}</span>
      </div>
      ${repLine}
      <div class="weibo-topic-body">${escapeHtml(p.content || '')}</div>
      <div class="weibo-topic-actions">
        <button type="button" class="btn btn-sm btn-outline wb-topic-open-detail">查看原博</button>
      </div>
    </article>
  `;
}

export default async function render(container, params) {
  const topicRaw = String(params?.topic || '').trim();
  const topicKey = normalizeTopicKey(topicRaw);
  const label = displayTopicLabel(topicRaw, topicKey);

  const userRow = await db.get('settings', 'currentUserId');
  const userId = userRow?.value || '';
  const user = userId ? await db.get('users', userId) : null;
  const ownerUserId = getWeiboOwnerUserId(userId);
  const weiboMetaKey = getWeiboMetaKey(userId);
  const season = getState('currentUser')?.currentTimeline || 'S8';

  const metaRow = await db.get('settings', weiboMetaKey);
  const meta = metaRow?.value || { trending: [], news: [] };
  const trending = Array.isArray(meta.trending) ? meta.trending : [];
  const newsAll = Array.isArray(meta.news) ? meta.news : [];

  const trendRank = trending.findIndex((t) => normalizeTopicKey(t) === topicKey);
  const relatedNews = collectRelatedNews(newsAll, topicKey);

  const allPosts = (await db.getAll('weiboPosts')).filter((p) => (p?.ownerUserId || '') === ownerUserId);
  const matched = allPosts.filter((p) => postMatchesTopic(p, topicKey)).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const official = matched.filter((p) => isOfficialPost(p));
  const withRepost = matched.filter((p) => p?.metadata?.repostFrom && !isOfficialPost(p));
  const originals = matched.filter((p) => !isOfficialPost(p) && !p?.metadata?.repostFrom);

  const relatedDms = await loadRelatedDms(ownerUserId, matched, topicKey, user);

  container.classList.add('weibo-page', 'weibo-topic-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn wbt-back" aria-label="返回">‹</button>
      <h1 class="navbar-title weibo-topic-title">${escapeHtml(label)}</h1>
      <span class="navbar-btn" style="visibility:hidden;width:28px;"></span>
    </header>
    <div class="page-scroll" style="padding:10px 12px 24px;">
      <div class="card-block weibo-topic-summary">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <strong>话题聚合</strong>
          <span class="text-hint">${escapeHtml(season)}</span>
        </div>
        <div class="text-hint" style="margin-top:6px;font-size:12px;">
          ${trendRank >= 0 ? `当前热搜榜约第 ${trendRank + 1} 位` : '未在最新热搜榜前六位（仍可浏览相关微博）'}
          · 共 ${matched.length} 条相关动态
        </div>
      </div>
      ${relatedNews.length
        ? `<div class="card-block">
            <div class="weibo-topic-section-title">相关简讯</div>
            <ul class="weibo-topic-news">${relatedNews.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
          </div>`
        : ''}
      ${official.length
        ? `<div class="weibo-topic-section">
            <div class="weibo-topic-section-title">${icon('weibo', 'weibo-act-svg')} 官方 / 澄清</div>
            ${official.map((p) => compactPostCard(p, 'is-official')).join('')}
          </div>`
        : ''}
      ${originals.length
        ? `<div class="weibo-topic-section">
            <div class="weibo-topic-section-title">原博与核心讨论</div>
            ${originals.map((p) => compactPostCard(p)).join('')}
          </div>`
        : ''}
      ${withRepost.length
        ? `<div class="weibo-topic-section">
            <div class="weibo-topic-section-title">转发与表态</div>
            ${withRepost.map((p) => compactPostCard(p, 'is-repost')).join('')}
          </div>`
        : ''}
      ${relatedDms.length
        ? `<div class="card-block">
            <div class="weibo-topic-section-title">关联私信（含关键词）</div>
            <div class="weibo-topic-dm-list">
              ${relatedDms.map((dm) => `
                <div class="weibo-dm-row">
                  <div class="weibo-dm-meta">@${escapeHtml(dm.inboxFor || '')} 收件箱 · ${escapeHtml(dm.senderName || '')} · ${escapeHtml(dm.senderType || '')} · ${escapeHtml(formatTime(dm.timestamp))}</div>
                  <div class="weibo-dm-text">${escapeHtml(dm.content || '')}</div>
                </div>
              `).join('')}
            </div>
          </div>`
        : ''}
      ${!matched.length && !relatedNews.length
        ? `<div class="placeholder-page" style="min-height:auto;padding:32px 12px;">
            <div class="placeholder-text">暂无与该话题直接相关的微博</div>
            <div class="placeholder-sub text-hint" style="margin-top:8px;">可在微博页搜索里「按主题生成」，或从热搜进入后再试</div>
          </div>`
        : ''}
    </div>
  `;

  container.querySelector('.wbt-back')?.addEventListener('click', () => back());
  container.querySelectorAll('.weibo-profile-link').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigate('weibo-profile', {
        authorId: btn.dataset.authorId || '',
        authorName: btn.dataset.authorName || '用户',
      });
    });
  });
  container.querySelectorAll('.wb-topic-open-detail').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const article = btn.closest('.weibo-topic-post');
      const id = article?.dataset.postId;
      if (id) navigate('weibo-detail', { postId: id });
    });
  });
  container.querySelectorAll('.weibo-topic-post').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const id = el.dataset.postId;
      if (id) navigate('weibo-detail', { postId: id });
    });
  });
}
