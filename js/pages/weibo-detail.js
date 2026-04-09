import { back } from '../core/router.js';
import * as db from '../core/db.js';
import { getVirtualNow } from '../core/virtual-time.js';

function e(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function t(ts) {
  return new Date(ts || Date.now()).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default async function render(container, params) {
  const postId = params?.postId;
  const currentUserId = (await db.get('settings', 'currentUserId'))?.value || '';
  const ownerUserId = currentUserId || 'guest';
  const post = postId ? await db.get('weiboPosts', postId) : null;
  if (!post || (post.ownerUserId || '') !== ownerUserId) {
    container.innerHTML = '<div class="placeholder-page"><div class="placeholder-text">微博不存在</div></div>';
    return;
  }
  const comments = post.commentList || [];
  const reposts = post.repostList || [];
  const repostMeta = post?.metadata?.repostFrom || null;
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn wb-back">‹</button>
      <h1 class="navbar-title">微博详情</h1>
      <span class="navbar-btn" style="visibility:hidden"></span>
    </header>
    <div class="page-scroll" style="padding:10px 16px 24px;">
      <div class="card-block">
        <div class="weibo-post-name">${e(post.authorName || '用户')}</div>
        <div class="weibo-post-meta">${e(t(post.timestamp))}</div>
        ${repostMeta ? `<div class="weibo-repost-origin">转发 @${e(repostMeta.authorName || repostMeta.authorId || '某人')}${repostMeta.content ? `：${e(String(repostMeta.content).slice(0, 120))}` : ''}</div>` : ''}
        <div class="weibo-post-content" style="margin-top:8px;">${e(post.content || '')}</div>
      </div>
      <div class="card-block">
        <div style="font-weight:600;">转发区 (${reposts.length})</div>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">
          ${reposts.map((r) => `<div style="padding:8px;border-radius:10px;background:#f7fbff;border:1px solid #d8e8fa;"><div style="font-size:12px;color:#6f8cab;">${e(r.author || '匿名转发')} · ${e(t(r.timestamp))}</div><div>${e(r.content || '转发微博')}</div></div>`).join('') || '<div class="text-hint">暂无转发</div>'}
        </div>
      </div>
      <div class="card-block">
        <div style="font-weight:600;">评论区 (${comments.length})</div>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">
          ${comments.map((c) => `<div style="padding:8px;border-radius:10px;background:#f7fbff;border:1px solid #d8e8fa;"><div style="font-size:12px;color:#6f8cab;">${e(c.author || '匿名')}</div><div>${e(c.content || '')}</div></div>`).join('') || '<div class="text-hint">暂无评论</div>'}
        </div>
        <textarea class="form-input wb-detail-comment" rows="3" placeholder="写评论..." style="margin-top:10px;"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button type="button" class="btn btn-outline wb-detail-repost" style="flex:1;">转发</button>
          <button type="button" class="btn btn-primary wb-detail-send" style="flex:1;">发送评论</button>
        </div>
      </div>
    </div>
  `;
  container.querySelector('.wb-back')?.addEventListener('click', () => back());
  container.querySelector('.wb-detail-send')?.addEventListener('click', async () => {
    const text = (container.querySelector('.wb-detail-comment')?.value || '').trim();
    if (!text) return;
    const nowTs = await getVirtualNow((await db.get('settings', 'currentUserId'))?.value || '', Date.now());
    post.commentList = [...(post.commentList || []), { author: '旅行者', content: text, timestamp: nowTs }];
    post.comments = post.commentList.length;
    await db.put('weiboPosts', post);
    await render(container, params);
  });
  container.querySelector('.wb-detail-repost')?.addEventListener('click', async () => {
    const text = (container.querySelector('.wb-detail-comment')?.value || '').trim();
    const nowTs = await getVirtualNow((await db.get('settings', 'currentUserId'))?.value || '', Date.now());
    post.repostList = [...(post.repostList || []), { author: '旅行者', content: text || '转发微博', timestamp: nowTs }];
    post.reposts = post.repostList.length;
    await db.put('weiboPosts', post);
    await render(container, params);
  });
}
