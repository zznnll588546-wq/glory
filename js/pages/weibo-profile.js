import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { chat as apiChat } from '../core/api.js';
import { getState } from '../core/state.js';
import { CHARACTERS } from '../data/characters.js';

function e(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function t(ts) {
  return new Date(ts || Date.now()).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function listRecentChatHints(messages, max = 8) {
  const rows = [...messages]
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .filter((m) => m && m.content && m.type === 'text')
    .slice(0, max)
    .map((m) => `- ${String(m.content).replace(/\s+/g, ' ').slice(0, 42)}`);
  return rows.join('\n');
}

async function resolveAvatar(authorId, authorName) {
  if (authorId) {
    const user = await db.get('users', authorId);
    if (user?.avatar) return user.avatar;
    const ch = await db.get('characters', authorId);
    if (ch?.avatar) return ch.avatar;
  }
  if (authorName) {
    const allChars = await db.getAll('characters');
    const found = allChars.find((c) => c.name === authorName || c.realName === authorName || (c.aliases || []).includes(authorName));
    if (found?.avatar) return found.avatar;
  }
  return '';
}

export default async function render(container, params) {
  const authorId = params?.authorId || '';
  const authorName = params?.authorName || '用户';
  const season = getState('currentUser')?.currentTimeline || 'S8';
  const allPosts = await db.getAll('weiboPosts');
  const posts = allPosts
    .filter((p) => (authorId && p.authorId === authorId) || (!authorId && p.authorName === authorName) || (authorName && p.authorName === authorName))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const metaRow = await db.get('settings', 'weiboMeta');
  const meta = metaRow?.value || { profiles: {}, followingIds: [] };
  const profileKey = authorId || authorName;
  const profile = meta.profiles?.[profileKey] || {};
  const avatar = await resolveAvatar(authorId, authorName);
  const avatarHtml = avatar ? `<img src="${e(avatar)}" class="weibo-avatar-img" alt="" />` : '<span class="weibo-avatar-fallback">👤</span>';
  const followed = new Set(meta.followingIds || []).has(profileKey);

  container.classList.add('weibo-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn wbp-back">‹</button>
      <h1 class="navbar-title">微博主页</h1>
      <button type="button" class="navbar-btn wbp-gen">⚡</button>
    </header>
    <div class="page-scroll" style="padding:10px 16px 24px;">
      <div class="card-block">
        <div style="display:flex;gap:10px;align-items:center;">
          <div class="weibo-avatar">${avatarHtml}</div>
          <div style="min-width:0;flex:1;">
            <div class="weibo-post-name">${e(authorName)}</div>
            <div class="weibo-post-meta">粉丝 ${Number(profile.fans || 0).toLocaleString('zh-CN')} · ${followed ? '已关注' : '未关注'}</div>
            <div class="text-hint" style="margin-top:4px;">${e(profile.bio || '这个人还没写微博简介')}</div>
          </div>
          <button type="button" class="btn btn-outline wbp-follow">${followed ? '取消关注' : '+关注'}</button>
        </div>
      </div>
      <div class="card-block">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong>TA 的微博</strong>
          <span class="text-hint">${posts.length} 条</span>
        </div>
      </div>
      <div class="wbp-list">
        ${posts.map((p) => `
          <article class="weibo-post card-block" data-post-id="${e(p.id)}">
            <div class="weibo-post-meta">${e(t(p.timestamp))}</div>
            <div class="weibo-post-content" style="margin-top:6px;">${e(p.content || '')}</div>
            <div class="weibo-post-meta" style="margin-top:8px;">转发 ${Number(p.reposts || 0)} · 评论 ${Number(p.comments || 0)} · 点赞 ${Number(p.likes || 0)}</div>
          </article>
        `).join('') || '<div class="placeholder-page" style="height:auto;padding:20px 0;"><div class="placeholder-text">这个主页还没微博</div></div>'}
      </div>
    </div>
  `;

  container.querySelector('.wbp-back')?.addEventListener('click', () => back());
  container.querySelector('.wbp-follow')?.addEventListener('click', async () => {
    const set = new Set(meta.followingIds || []);
    if (set.has(profileKey)) set.delete(profileKey);
    else set.add(profileKey);
    meta.followingIds = [...set];
    await db.put('settings', { key: 'weiboMeta', value: meta });
    await render(container, params);
  });
  container.querySelector('.wbp-gen')?.addEventListener('click', async () => {
    const currentUserIdRow = await db.get('settings', 'currentUserId');
    const currentUserId = currentUserIdRow?.value || '';
    const chats = currentUserId ? await db.getAllByIndex('chats', 'userId', currentUserId) : [];
    const recentMsgs = [];
    for (const c of chats.slice(0, 8)) {
      const msg = await db.getAllByIndex('messages', 'chatId', c.id);
      recentMsgs.push(...msg.slice(-12));
    }
    const recentHints = listRecentChatHints(recentMsgs, 10);
    const char = CHARACTERS.find((x) => x.id === authorId || x.name === authorName);
    const charHints = [char?.personality, char?.speechStyle, char?.bio].filter(Boolean).join('；');
    const prompt = [
      `你要扮演微博运营文案，生成角色微博。`,
      `时间线: ${season}`,
      `角色: ${authorName} (${authorId || 'unknown'})`,
      `角色设定线索: ${charHints || '按角色人设自然发挥'}`,
      `最近聊天摘要:\n${recentHints || '- 暂无聊天内容'}`,
      '输出JSON: {"posts":[{"content":"...","mode":"post|repost","ref":"可空","hot":true|false}]}',
      '要求: 3-6条，语气贴人设；可有转发；要带时间线感和生活感，不要解释。',
    ].join('\n');
    try {
      const raw = await apiChat(
        [{ role: 'system', content: '只输出合法JSON，不要解释。' }, { role: 'user', content: prompt }],
        { temperature: 0.95, maxTokens: 1400 }
      );
      const text = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const parsed = JSON.parse(text);
      for (const it of parsed.posts || []) {
        const post = {
          id: `weibo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          authorId: authorId || authorName,
          authorName,
          avatar: null,
          content: it.mode === 'repost' ? `转发 ${it.ref || '某条微博'}\n${it.content || ''}` : (it.content || ''),
          images: [],
          timestamp: Date.now() - Math.floor(Math.random() * 3600_000),
          reposts: 0,
          comments: 0,
          likes: Math.floor(Math.random() * 300),
          fans: Number(profile.fans || 0),
          commentList: [],
          repostList: [],
        };
        await db.put('weiboPosts', post);
      }
      await render(container, params);
    } catch (_) {}
  });
  container.querySelectorAll('.wbp-list .weibo-post').forEach((el) => {
    el.addEventListener('click', () => navigate('weibo-detail', { postId: el.dataset.postId }));
  });
}
