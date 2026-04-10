import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { chat as apiChat } from '../core/api.js';
import { getState, setState } from '../core/state.js';
import { CHARACTERS } from '../data/characters.js';
import { getVirtualNow } from '../core/virtual-time.js';
import { icon } from '../components/svg-icons.js';

function e(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function t(ts) {
  return new Date(ts || Date.now()).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatSocialCount(v) {
  const n = Math.max(0, Number(v) || 0);
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toFixed(1);
}

function getWeiboDmKey(ownerUserId, profileKey) {
  return `weiboDmBox_${ownerUserId}_${profileKey}`;
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
  const currentUserId = (await db.get('settings', 'currentUserId'))?.value || '';
  const ownerUserId = currentUserId || 'guest';
  const weiboMetaKey = `weiboMeta_${ownerUserId}`;
  const authorId = params?.authorId || '';
  const authorName = params?.authorName || '用户';
  const season = getState('currentUser')?.currentTimeline || 'S8';
  const allPosts = await db.getAll('weiboPosts');
  const posts = allPosts
    .filter((p) => (p?.ownerUserId || '') === ownerUserId)
    .filter((p) => (authorId && p.authorId === authorId) || (!authorId && p.authorName === authorName) || (authorName && p.authorName === authorName))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const metaRow = await db.get('settings', weiboMetaKey);
  const legacyMetaRow = metaRow ? null : await db.get('settings', 'weiboMeta');
  const meta = metaRow?.value || { profiles: {}, followingIds: [] };
  if (!metaRow && legacyMetaRow?.value) {
    Object.assign(meta, legacyMetaRow.value);
    await db.put('settings', { key: weiboMetaKey, value: meta });
  }
  const profileKey = authorId || authorName;
  const profile = meta.profiles?.[profileKey] || {};
  const viewerUser = currentUserId ? await db.get('users', currentUserId) : null;
  const isSelf = !!(authorId && currentUserId && authorId === currentUserId);
  const fansRaw = isSelf && viewerUser?.weiboFans != null && Number.isFinite(Number(viewerUser.weiboFans))
    ? Number(viewerUser.weiboFans)
    : (profile.fans != null && profile.fans !== '' ? Number(profile.fans) : 0);
  const fansDisplay = Number.isFinite(fansRaw) ? fansRaw : 0;
  const bioWeibo = isSelf
    ? (String(viewerUser?.weiboBio || '').trim() || String(viewerUser?.bio || '').trim() || profile.bio || '')
    : (profile.bio || '');
  const bioDisplay = bioWeibo || '这个人还没写微博简介';
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
    <div class="page-scroll" style="padding:10px 16px 24px;${meta.homeBg ? `background-image:url('${e(meta.homeBg)}');background-size:cover;background-attachment:fixed;` : ''}">
      <div class="card-block">
        <div style="display:flex;gap:10px;align-items:center;">
          <div class="weibo-avatar">${avatarHtml}</div>
          <div style="min-width:0;flex:1;">
            <div class="weibo-post-name">${e(authorName)}<span class="weibo-v-badge">V</span></div>
            <div class="weibo-post-meta" style="display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;">
              <button type="button" class="wbp-fans-btn" title="编辑粉丝数（不会自动生成）">粉丝 ${e(formatSocialCount(fansDisplay))}</button>
              ${isSelf ? '' : `<span>·</span><span>${followed ? '已关注' : '未关注'}</span>`}
            </div>
            <div class="text-hint" style="margin-top:4px;">${e(bioDisplay)}</div>
            ${isSelf ? `<div class="text-hint" style="margin-top:6px;font-size:11px;">粉丝与简介与「我的资料」里「微博主页」一致。也可点粉丝数快速修改。<button type="button" class="btn btn-linkish wbp-goto-profile">打开我的资料</button></div>` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
            <button type="button" class="btn btn-outline btn-sm wbp-edit-card" title="编辑微博主页展示">编辑</button>
            ${isSelf ? '' : `<button type="button" class="btn btn-outline wbp-follow">${followed ? '取消关注' : '+关注'}</button>`}
            <button type="button" class="btn btn-outline wbp-dm" title="粉丝私信">${icon('message', 'weibo-act-svg')}</button>
          </div>
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
          ${(() => {
            const repostMeta = p?.metadata?.repostFrom;
            const repostBlock = repostMeta
              ? `<div class="weibo-repost-origin" style="margin-top:8px;padding:8px 10px;border-radius:10px;background:#f7fbff;border:1px solid #d8e8fa;">
                  <div style="font-size:12px;color:#6f8cab;">转发 @${e(repostMeta.authorName || repostMeta.authorId || '某人')}</div>
                  <div style="margin-top:4px;line-height:1.5;">${e(String(repostMeta.content || '（原文不可见）').slice(0, 120))}</div>
                </div>`
              : '';
            return `
          <article class="weibo-post card-block" data-post-id="${e(p.id)}">
            <div class="weibo-post-meta">${e(t(p.timestamp))}</div>
            <div class="weibo-post-content" style="margin-top:6px;">${e(p.content || '')}</div>
            ${repostBlock}
            <div class="weibo-post-meta" style="margin-top:8px;">转发 ${Number(p.reposts || 0)} · 评论 ${Number(p.comments || 0)} · 点赞 ${Number(p.likes || 0)}</div>
          </article>
        `;
          })()}
        `).join('') || '<div class="placeholder-page" style="height:auto;padding:20px 0;"><div class="placeholder-text">这个主页还没微博</div></div>'}
      </div>
    </div>
  `;

  const openWeiboCardEditor = () => {
    const fansPrefill = isSelf
      ? (viewerUser?.weiboFans != null ? String(viewerUser.weiboFans) : String(Math.round(fansDisplay)))
      : String(Math.round(fansDisplay));
    const bioPrefill = isSelf
      ? (String(viewerUser?.weiboBio || '').trim() || String(viewerUser?.bio || '').trim() || String(profile.bio || ''))
      : String(profile.bio || '');
    const { close, root } = openGlobalModal(`
      <div class="modal-header"><h3>编辑微博主页</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
      <div class="modal-body">
        <label class="form-label">粉丝数</label>
        <input type="number" class="form-input wbp-edit-fans" min="0" step="1" value="${e(fansPrefill)}" />
        <p class="text-hint" style="font-size:11px;margin-top:4px;">不会自动生成；${isSelf ? '留空则取消个人档案里的固定粉丝数，仍可用下方已保存的微博数据。' : '角色主页仅保存在本档微博资料里。'}</p>
        <label class="form-label" style="margin-top:10px;">微博简介</label>
        <textarea class="form-input wbp-edit-bio" rows="3" placeholder="简介">${e(bioPrefill)}</textarea>
        ${isSelf ? '<p class="text-hint" style="font-size:11px;margin-top:4px;">与「我的资料 → 微博主页」一致；简介留空保存后，将按个人简介展示。</p>' : ''}
        <button type="button" class="btn btn-primary wbp-edit-save" style="margin-top:12px;width:100%;">保存</button>
      </div>
    `);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    root.querySelector('.wbp-edit-save')?.addEventListener('click', async () => {
      const fansStr = String(root.querySelector('.wbp-edit-fans')?.value || '').trim();
      const bioStr = String(root.querySelector('.wbp-edit-bio')?.value || '').trim();
      meta.profiles = meta.profiles || {};
      const nextProf = { ...(meta.profiles[profileKey] || {}) };

      if (isSelf && currentUserId) {
        const u = await db.get('users', currentUserId);
        if (u) {
          if (fansStr === '') {
            u.weiboFans = null;
            if (nextProf.fans == null || nextProf.fans === '') {
              nextProf.fans = profile.fans != null ? profile.fans : fansDisplay;
            }
          } else {
            const n = Math.max(0, Number(fansStr) || 0);
            u.weiboFans = n;
            nextProf.fans = n;
          }
          u.weiboBio = bioStr;
          await db.put('users', u);
          setState('currentUser', u);
          nextProf.bio = bioStr || String(u.bio || '').trim() || nextProf.bio;
        }
      } else {
        const n = Math.max(0, Number(fansStr) || Number(profile.fans) || 0);
        nextProf.fans = n;
        nextProf.bio = bioStr;
      }

      meta.profiles[profileKey] = nextProf;
      await db.put('settings', { key: weiboMetaKey, value: meta });
      close();
      await render(container, params);
    });
  };

  container.querySelector('.wbp-back')?.addEventListener('click', () => back());
  container.querySelector('.wbp-fans-btn')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    openWeiboCardEditor();
  });
  container.querySelector('.wbp-edit-card')?.addEventListener('click', () => openWeiboCardEditor());
  container.querySelector('.wbp-goto-profile')?.addEventListener('click', () => navigate('user-profile'));
  container.querySelector('.wbp-follow')?.addEventListener('click', async () => {
    const set = new Set(meta.followingIds || []);
    if (set.has(profileKey)) set.delete(profileKey);
    else set.add(profileKey);
    meta.followingIds = [...set];
    await db.put('settings', { key: weiboMetaKey, value: meta });
    await render(container, params);
  });
  container.querySelector('.wbp-dm')?.addEventListener('click', () => {
    navigate('weibo-dm', {
      profileKey,
      profileName: authorName,
      ownerUserId,
    });
  });
  container.querySelector('.wbp-gen')?.addEventListener('click', async () => {
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
      '输出JSON: {"posts":[{"content":"...","mode":"post|repost","refAuthor":"可空","refText":"可空","hot":true|false}],"dms":[{"senderName":"昵称","senderType":"粉丝|黑子|梦女|梦男|同行|营销号|广告商","content":"私信内容"}]}',
      '要求: 3-6条，语气贴人设；可有转发并使用@；要带时间线感和生活感，不要解释。',
    ].join('\n');
    try {
      const raw = await apiChat(
        [{ role: 'system', content: '只输出合法JSON，不要解释。' }, { role: 'user', content: prompt }],
        { temperature: 0.95, maxTokens: 1400 }
      );
      const text = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const parsed = JSON.parse(text);
      const nowTs = await getVirtualNow(currentUserId || '', 0);
      for (const it of parsed.posts || []) {
        const mode = String(it.mode || 'post');
        const refAuthor = String(it.refAuthor || '').trim();
        const post = {
          id: `weibo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          ownerUserId,
          authorId: authorId || authorName,
          authorName,
          avatar: null,
          content: mode === 'repost' ? (it.content || `转发了 @${refAuthor || '某人'}`) : (it.content || ''),
          images: [],
          timestamp: nowTs - Math.floor(Math.random() * 3600_000),
          reposts: 0,
          comments: 0,
          likes: Math.floor(Math.random() * 300),
          fans: Number(profile.fans || 0),
          commentList: [],
          repostList: [],
          metadata: mode === 'repost'
            ? {
                repostFrom: {
                  authorName: refAuthor || '某人',
                  content: String(it.refText || '').slice(0, 120),
                },
              }
            : {},
        };
        await db.put('weiboPosts', post);
      }
      const dmKey = getWeiboDmKey(ownerUserId, profileKey);
      const dmRow = await db.get('settings', dmKey);
      const prev = Array.isArray(dmRow?.value) ? dmRow.value : [];
      const next = [...prev];
      for (const dm of (parsed.dms || []).slice(0, 8)) {
        next.push({
          id: `wb_dm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          senderName: String(dm?.senderName || '路人粉'),
          senderType: String(dm?.senderType || '粉丝'),
          content: String(dm?.content || '').trim(),
          timestamp: nowTs - Math.floor(Math.random() * 1_200_000),
        });
      }
      await db.put('settings', { key: dmKey, value: next.slice(-120) });
      await render(container, params);
    } catch (_) {}
  });
  container.querySelectorAll('.wbp-list .weibo-post').forEach((el) => {
    el.addEventListener('click', () => navigate('weibo-detail', { postId: el.dataset.postId }));
  });
}
