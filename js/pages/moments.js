import { navigate, back } from '../core/router.js';
import * as db from '../core/db.js';

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
    .map((c) => {
      const who = escapeHtml(c.author || '好友');
      const tx = escapeHtml(c.text || '');
      return `<div class="moment-comment-line"><strong>${who}</strong>：${tx}</div>`;
    })
    .join('');
  return `
    <div class="moment-comments">
      ${likeLine}
      ${commentLines}
    </div>
  `;
}

export default async function render(container) {
  const user = await getCurrentUser();
  const posts = (await db.getAll('momentsPosts')).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

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
          <button type="button" class="moment-like-btn">赞</button>
          <button type="button" class="moment-ai-btn">AI互动</button>
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
    <div class="moments-header">
      <div class="moments-header-avatar">${avatarInner(user)}</div>
      <div class="moments-header-name">${escapeHtml(user?.name || '旅行者')}</div>
    </div>
    <div class="page-scroll moments-feed">${listHtml || '<div class="placeholder-page" style="padding:32px 16px;"><div class="placeholder-text">还没有动态</div></div>'}</div>
    <button type="button" class="moments-fab" aria-label="发布动态">+</button>
  `;

  container.querySelector('.moments-back')?.addEventListener('click', () => back());

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
    root.querySelector('.moments-compose-submit')?.addEventListener('click', async () => {
      const text = (root.querySelector('.moments-compose-text')?.value || '').trim();
      const vis = root.querySelector('.moments-compose-vis')?.value || 'all';
      if (!text && pickedImages.length === 0) return;
      const post = {
        id: 'moment_' + Date.now(),
        authorId: user?.id || 'guest',
        authorName: user?.name || '旅行者',
        authorEmoji: '👤',
        avatar: user?.avatar || null,
        content: text,
        images: pickedImages.slice(),
        timestamp: Date.now(),
        visibility: vis,
        likes: [],
        comments: [],
      };
      await db.put('momentsPosts', post);
      close();
      await render(container);
    });
  });

  container.querySelectorAll('.moment-ai-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      alert('coming soon');
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

  void navigate;
}
