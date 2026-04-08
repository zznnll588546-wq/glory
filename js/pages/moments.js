import { navigate, back } from '../core/router.js';
import * as db from '../core/db.js';
import { getVirtualNow } from '../core/virtual-time.js';
import { createChat, createMessage } from '../models/chat.js';
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

async function getCurrentUserId() {
  const row = await db.get('settings', 'currentUserId');
  return row?.value ?? null;
}

async function getCurrentUser() {
  const uid = await getCurrentUserId();
  if (!uid) return null;
  return db.get('users', uid);
}

function openGlobalModal(innerHtml) {
  const host = document.getElementById('modal-container');
  if (!host) return { close: () => {} };
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-modal-overlay>
      <div class="modal-sheet modal-sheet-tall" role="dialog" aria-modal="true" data-modal-sheet>
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

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function avatarInner(user) {
  const a = user?.avatar;
  if (a && String(a).startsWith('data:')) {
    return `<img src="${escapeAttr(a)}" alt="" class="moment-avatar-img" />`;
  }
  if (a && String(a).trim()) return escapeAttr(a);
  return '👤';
}

function renderMomentImages(images) {
  if (!Array.isArray(images) || !images.length) return '';
  const cells = images
    .slice(0, 9)
    .map((src) => `<div class="moment-img-cell"><img src="${escapeAttr(src)}" alt="" loading="lazy" /></div>`)
    .join('');
  return `<div class="moment-images">${cells}</div>`;
}

function commentsSection(post) {
  const likes = Array.isArray(post.likes) ? post.likes : [];
  const comments = Array.isArray(post.comments) ? post.comments : [];
  const likeNames = likes.map((x) => (typeof x === 'string' ? x : x.name || '好友')).join('、');
  const likeLine =
    likes.length > 0
      ? `<div class="moment-likes-line">❤ ${escapeHtml(likeNames || '点赞')}</div>`
      : '';
  const commentLines = comments
    .map((c, idx) => {
      const who = escapeHtml(c.author || '好友');
      const tx = escapeHtml(c.text || '');
      const replyTo = c.replyTo ? `<span class="moment-comment-replyto"> 回复 ${escapeHtml(c.replyTo)}</span>` : '';
      return `<button type="button" class="moment-comment-line" data-comment-idx="${idx}"><strong>${who}</strong>${replyTo}：${tx}</button>`;
    })
    .join('');
  return `
    <div class="moment-comments is-collapsed">
      ${likeLine}
      ${commentLines}
      <div class="moment-comment-input-row">
        <input type="text" class="form-input moment-comment-input" placeholder="写评论..." />
        <button type="button" class="btn btn-primary btn-sm moment-comment-send">发送</button>
      </div>
    </div>
  `;
}

export default async function render(container) {
  const user = await getCurrentUser();
  const userId = user?.id || '';
  const virtualNow = await getVirtualNow(userId, Date.now());
  const prefsKey = `momentsPrefs_${userId || 'guest'}`;
  const momentsPrefs = (await db.get('settings', prefsKey))?.value || { coverImage: '', groups: ['战队', '同期', '亲友'] };
  const posts = (await db.getAll('momentsPosts')).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const allChats = userId ? await db.getAllByIndex('chats', 'userId', userId) : [];
  const contacts = allChats
    .filter((c) => c.type === 'private' && Array.isArray(c.participants))
    .map((c) => c.participants.find((p) => p !== 'user'))
    .filter(Boolean);

  const listHtml = posts
    .map((p) => {
      const av = p.avatar
        ? `<img src="${escapeAttr(p.avatar)}" alt="" class="moment-post-avatar-img" />`
        : `<span class="moment-post-avatar-emoji">${escapeHtml(p.authorEmoji || '👤')}</span>`;
      return `
      <article class="moment-post card-block" data-moment-id="${escapeAttr(p.id)}">
        <header class="moment-post-header">
          <div class="moment-post-avatar">${av}</div>
          <div>
            <div class="moment-post-name">${escapeHtml(p.authorName || '好友')}</div>
            <div class="moment-post-time">${escapeHtml(formatTime(p.timestamp || 0))}</div>
          </div>
        </header>
        <div class="moment-post-content">${escapeHtml(p.content || '')}</div>
        ${renderMomentImages(p.images)}
        ${commentsSection(p)}
        <div class="moment-actions">
          <button type="button" class="moment-like-btn">${icon('moments', 'moment-action-svg')}<span>赞</span></button>
          <button type="button" class="moment-comment-toggle-btn">${icon('message', 'moment-action-svg')}<span>评论</span></button>
          <div class="moment-actions-right">
            <button type="button" class="moment-ai-btn" title="生成评论与点赞">${icon('sparkle', 'moment-action-svg')}</button>
            <button type="button" class="moment-forward-btn" title="分享">${icon('send', 'moment-action-svg')}</button>
          </div>
        </div>
      </article>`;
    })
    .join('');

  container.classList.add('moments-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn moments-back" aria-label="返回">‹</button>
      <h1 class="navbar-title">朋友圈</h1>
      <span class="navbar-btn" style="visibility:hidden" aria-hidden="true"></span>
    </header>
    <div class="moments-header"${momentsPrefs.coverImage ? ` style="background-image:url('${escapeAttr(momentsPrefs.coverImage)}')"` : ''}>
      <div class="moments-header-avatar">${avatarInner(user)}</div>
      <div class="moments-header-name">${escapeHtml(user?.name || '旅行者')}</div>
      <button type="button" class="moments-cover-btn">封面</button>
    </div>
    <div class="page-scroll moments-feed">${listHtml || '<div class="placeholder-page" style="padding:32px 16px;"><div class="placeholder-text">还没有动态</div></div>'}</div>
    <button type="button" class="moments-fab" aria-label="发布动态">+</button>
  `;

  container.querySelector('.moments-back')?.addEventListener('click', () => back());
  container.querySelector('.moments-cover-btn')?.addEventListener('click', () => {
    const { close, root } = openGlobalModal(`
      <div class="modal-header"><h3>朋友圈封面</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
      <div class="modal-body">
        <input type="file" class="form-input moments-cover-file" accept="image/*" />
        <button type="button" class="btn btn-primary btn-block moments-cover-save" style="margin-top:12px;">保存</button>
      </div>
    `);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    let picked = '';
    root.querySelector('.moments-cover-file')?.addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      picked = await fileToDataUrl(f);
    });
    root.querySelector('.moments-cover-save')?.addEventListener('click', async () => {
      if (!picked) return;
      await db.put('settings', { key: prefsKey, value: { ...momentsPrefs, coverImage: picked } });
      close();
      await render(container);
    });
  });

  container.querySelector('.moments-fab')?.addEventListener('click', () => {
    const { close, root } = openGlobalModal(`
      <div class="modal-header">
        <h3>发布动态</h3>
        <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">
        <textarea class="form-input moments-compose-text" rows="5" placeholder="分享生活…"></textarea>
        <div class="form-group" style="margin-top:12px;">
          <label class="form-label">图片</label>
          <input type="file" class="moments-compose-files" accept="image/*" multiple />
        </div>
        <div class="form-group">
          <label class="form-label">可见范围</label>
          <select class="form-input moments-compose-vis">
            <option value="all">全部可见</option>
            <option value="partial">部分可见</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">@通讯录角色（可多选）</label>
          <div class="moments-mention-list">
            ${contacts.slice(0, 24).map((cid) => `<label><input type="checkbox" value="${escapeAttr(cid)}" class="moments-mention-item" /> @${escapeHtml(cid)}</label>`).join('') || '<span class="text-hint">当前通讯录暂无角色</span>'}
          </div>
        </div>
        <div class="form-group moments-group-pick" style="display:none;">
          <label class="form-label">可见组别</label>
          <div class="moments-mention-list">
            ${momentsPrefs.groups.map((g) => `<label><input type="checkbox" value="${escapeAttr(g)}" class="moments-vis-group" /> ${escapeHtml(g)}</label>`).join('')}
          </div>
        </div>
        <button type="button" class="btn btn-primary moments-compose-submit" style="width:100%;margin-top:12px;">发布</button>
      </div>
    `);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    const pickedImages = [];
    root.querySelector('.moments-compose-files')?.addEventListener('change', async (e) => {
      const input = e.target;
      const files = [...(input.files || [])].slice(0, 9);
      pickedImages.length = 0;
      for (const f of files) {
        try {
          pickedImages.push(await fileToDataUrl(f));
        } catch {
          /* skip */
        }
      }
    });
    root.querySelector('.moments-compose-vis')?.addEventListener('change', (e) => {
      const v = e.target.value;
      const block = root.querySelector('.moments-group-pick');
      if (block) block.style.display = v === 'partial' ? '' : 'none';
    });
    root.querySelector('.moments-compose-submit')?.addEventListener('click', async () => {
      const text = (root.querySelector('.moments-compose-text')?.value || '').trim();
      const vis = root.querySelector('.moments-compose-vis')?.value || 'all';
      const mentionIds = [...root.querySelectorAll('.moments-mention-item:checked')].map((el) => el.value);
      const visibleGroups = [...root.querySelectorAll('.moments-vis-group:checked')].map((el) => el.value);
      if (!text && pickedImages.length === 0) return;
      const contextSnippet = (await db.getAllByIndex('messages', 'chatId', (allChats[0] || {}).id || '__none__')).slice(-3).map((m) => m.content).join(' / ');
      const post = {
        id: 'moment_' + Date.now(),
        authorId: user?.id || 'guest',
        authorName: user?.name || '旅行者',
        authorEmoji: '👤',
        avatar: user?.avatar || null,
        content: text,
        images: pickedImages.slice(),
        timestamp: virtualNow,
        visibility: vis,
        visibleGroups,
        mentionIds,
        contextSnippet: contextSnippet.slice(0, 220),
        likes: [],
        comments: [],
      };
      await db.put('momentsPosts', post);
      close();
      await render(container);
    });
  });

  container.querySelectorAll('.moment-ai-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const article = btn.closest('.moment-post');
      const id = article?.dataset.momentId;
      if (!id || !userId) return;
      const p = await db.get('momentsPosts', id);
      if (!p) return;
      const actors = contacts.slice(0, 6);
      if (!actors.length) return;
      if (!Array.isArray(p.likes)) p.likes = [];
      if (!Array.isArray(p.comments)) p.comments = [];
      const likeCount = Math.min(actors.length, 1 + Math.floor(Math.random() * 3));
      const commentCount = 1 + Math.floor(Math.random() * 3);
      actors.slice(0, likeCount).forEach((cid) => {
        if (!p.likes.includes(cid)) p.likes.push(cid);
      });
      const historyCtx = (p.comments || []).slice(-6).map((c) => `${c.author}:${c.text}`).join(' | ');
      const pool = ['这条有意思', '笑死我了', '你是真会发', '看到了，晚点细聊', '这不是刚聊过的吗', `接上面评论：${historyCtx ? historyCtx.slice(0, 20) : '展开说说'}`];
      for (let i = 0; i < commentCount; i++) {
        const cid = actors[(i + 1) % actors.length];
        p.comments.push({ author: cid, text: pool[Math.floor(Math.random() * pool.length)] });
      }
      await db.put('momentsPosts', p);
      if (Math.random() < 0.45) {
        const actor = actors[Math.floor(Math.random() * actors.length)];
        await triggerPrivateFromMoment(userId, actor, p);
      }
      await render(container);
    });
  });

  container.querySelectorAll('.moment-like-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const article = btn.closest('.moment-post');
      const id = article?.dataset.momentId;
      if (!id || !user) return;
      const all = await db.getAll('momentsPosts');
      const p = all.find((x) => x.id === id);
      if (!p) return;
      if (!Array.isArray(p.likes)) p.likes = [];
      const name = user.name || '我';
      const idx = p.likes.findIndex((x) => (typeof x === 'string' ? x === name : x.name === name));
      if (idx >= 0) p.likes.splice(idx, 1);
      else p.likes.push(name);
      await db.put('momentsPosts', p);
      await render(container);
    });
  });

  container.querySelectorAll('.moment-comment-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const article = btn.closest('.moment-post');
      const box = article?.querySelector('.moment-comments');
      if (!box) return;
      box.classList.toggle('is-collapsed');
    });
  });

  container.querySelectorAll('.moment-comment-line').forEach((row) => {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      const article = row.closest('.moment-post');
      const input = article?.querySelector('.moment-comment-input');
      if (!input) return;
      const name = row.querySelector('strong')?.textContent || '';
      input.dataset.replyTo = name;
      input.placeholder = name ? `回复 ${name}：` : '写评论...';
      input.focus();
    });
  });

  container.querySelectorAll('.moment-comment-send').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const article = btn.closest('.moment-post');
      const id = article?.dataset.momentId;
      const input = article?.querySelector('.moment-comment-input');
      const text = (input?.value || '').trim();
      if (!id || !text || !user) return;
      const p = await db.get('momentsPosts', id);
      if (!p) return;
      if (!Array.isArray(p.comments)) p.comments = [];
      p.comments.push({ author: user.name || '我', text, replyTo: input?.dataset.replyTo || '' });
      await db.put('momentsPosts', p);
      await render(container);
    });
  });

  container.querySelectorAll('.moment-forward-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const article = btn.closest('.moment-post');
      const id = article?.dataset.momentId;
      if (!id || !allChats.length) return;
      const post = await db.get('momentsPosts', id);
      if (!post) return;
      const groupChats = allChats.filter((c) => c.type === 'group');
      const privateChats = allChats.filter((c) => c.type !== 'group');
      const { close, root } = openGlobalModal(`
        <div class="modal-header"><h3>转发到聊天</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">指定角色私聊</label>
            <div class="moments-mention-list">
              ${contacts.slice(0, 24).map((cid) => `<button type="button" class="btn btn-outline btn-sm moments-pick-dm" data-char-id="${escapeAttr(cid)}">${escapeHtml(cid)}</button>`).join('') || '<span class="text-hint">暂无可选角色</span>'}
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">群聊</label>
            <div class="home-editor-list">
              ${groupChats.slice(0, 30).map((c) => `<button type="button" class="btn btn-outline btn-block moments-pick-chat" data-cid="${escapeAttr(c.id)}">${escapeHtml(c.groupSettings?.name || '群聊')}</button>`).join('') || '<span class="text-hint">暂无群聊</span>'}
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">现有私聊</label>
            <div class="home-editor-list">
              ${privateChats.slice(0, 30).map((c) => `<button type="button" class="btn btn-outline btn-block moments-pick-chat" data-cid="${escapeAttr(c.id)}">${escapeHtml(c.groupSettings?.name || '私聊')}</button>`).join('') || '<span class="text-hint">暂无私聊</span>'}
            </div>
          </div>
        </div>
      `);
      root.querySelector('.modal-close-btn')?.addEventListener('click', close);
      const forwardTo = async (target) => {
        if (!target) return;
        const ts = await getVirtualNow(userId || '', Date.now());
        const msg = createMessage({
          chatId: target.id,
          senderId: 'user',
          type: 'link',
          content: `moment://${id}`,
          metadata: { title: `朋友圈：${post.authorName || '好友'}`, desc: String(post.content || '').slice(0, 80), source: '朋友圈' },
          timestamp: ts,
        });
        await db.put('messages', msg);
        target.lastMessage = '[朋友圈分享]';
        target.lastActivity = ts;
        await db.put('chats', target);
        close();
      };
      root.querySelectorAll('.moments-pick-chat').forEach((el) => {
        el.addEventListener('click', async () => {
          const cid = el.dataset.cid;
          const target = allChats.find((c) => c.id === cid);
          await forwardTo(target);
        });
      });
      root.querySelectorAll('.moments-pick-dm').forEach((el) => {
        el.addEventListener('click', async () => {
          const cid = el.dataset.charId;
          if (!cid) return;
          let dm = allChats.find((c) => c.type === 'private' && (c.participants || []).includes('user') && (c.participants || []).includes(cid));
          if (!dm) {
            dm = createChat({
              type: 'private',
              userId,
              participants: ['user', cid],
              lastMessage: '',
              lastActivity: await getVirtualNow(userId || '', Date.now()),
            });
            await db.put('chats', dm);
          }
          await forwardTo(dm);
        });
      });
    });
  });

  void navigate;
}

async function triggerPrivateFromMoment(userId, actorId, post) {
  if (!userId || !actorId) return;
  const chats = await db.getAllByIndex('chats', 'userId', userId);
  let dm = chats.find((c) => c.type === 'private' && (c.participants || []).includes('user') && (c.participants || []).includes(actorId));
  if (!dm) {
    dm = createChat({
      type: 'private',
      userId,
      participants: ['user', actorId],
      lastMessage: '',
      lastActivity: await getVirtualNow(userId, Date.now()),
    });
    await db.put('chats', dm);
  }
  const ts = await getVirtualNow(userId, Date.now());
  const msg = createMessage({
    chatId: dm.id,
    senderId: actorId,
    senderName: actorId,
    type: 'text',
    content: `刚在朋友圈看到你发的：「${String(post.content || '').slice(0, 40)}」`,
    timestamp: ts,
  });
  await db.put('messages', msg);
  dm.lastMessage = msg.content.slice(0, 80);
  dm.lastActivity = ts;
  await db.put('chats', dm);
}
