import { back } from '../core/router.js';
import * as db from '../core/db.js';
import { showToast } from '../components/toast.js';

function e(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function t(ts) {
  return new Date(ts || Date.now()).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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

export default async function render(container, params) {
  const threadId = params?.threadId;
  const uid = await getCurrentUserId();
  const user = await getCurrentUser();
  const thread = threadId ? await db.get('forumThreads', threadId) : null;
  if (!thread) {
    container.innerHTML = '<div class="placeholder-page"><div class="placeholder-text">帖子不存在</div></div>';
    return;
  }
  if (thread.userId != null && thread.userId !== uid) {
    container.innerHTML =
      '<div class="placeholder-page"><div class="placeholder-text">该帖子属于其他用户档案，请切换档案后查看</div></div>';
    return;
  }
  const replies = thread.replies || [];
  const replyName = user?.name || '旅行者';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn fd-back">‹</button>
      <h1 class="navbar-title">论坛详情</h1>
      <span class="navbar-btn" style="visibility:hidden"></span>
    </header>
    <div class="page-scroll" style="padding:10px 16px 24px;">
      <div class="card-block">
        <div class="forum-thread-title">${e(thread.title || '无标题')}</div>
        <div class="forum-thread-meta">${e(thread.authorName || '匿名')} · ${e(t(thread.timestamp))}</div>
        <div class="forum-detail-content" style="margin-top:8px;">${e(thread.content || '')}</div>
      </div>
      <div class="card-block">
        <div style="font-weight:600;">楼层回复 (${replies.length})</div>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">
          ${replies.map((r, i) => {
            const isAnon = /匿名|小号/i.test(String(r.author || ''));
            const sub = (r.childReplies || []).map((cr) => `<div style="margin-top:6px;padding:6px 8px;border-radius:8px;background:#fff;border:1px dashed #d7e5f8;"><div style="font-size:11px;color:#8aa0b8;">${e(cr.author || '匿名')} 回复</div><div>${e(cr.content || '')}</div></div>`).join('');
            return `<div style="padding:8px;border-radius:10px;background:#f7fbff;border:1px solid #d8e8fa;">
              <div style="font-size:12px;color:#6f8cab;">#${i + 1} ${e(r.author || '匿名')} ${isAnon ? '<span style="color:#ff9f43;">[匿名/小号]</span>' : ''} · ${e(t(r.timestamp))}</div>
              <div>${e(r.content || '')}</div>
              ${sub}
            </div>`;
          }).join('') || '<div class="text-hint">暂无回复</div>'}
        </div>
        <textarea class="form-input fd-reply-input" rows="3" placeholder="写回复..." style="margin-top:10px;"></textarea>
        <button type="button" class="btn btn-primary fd-reply-send" style="margin-top:8px;width:100%;">发送回复</button>
      </div>
    </div>
  `;
  container.querySelector('.fd-back')?.addEventListener('click', () => back());
  container.querySelector('.fd-reply-send')?.addEventListener('click', async () => {
    if (!uid) {
      showToast('请先选择用户档案后再回复');
      return;
    }
    const text = (container.querySelector('.fd-reply-input')?.value || '').trim();
    if (!text) return;
    thread.replies = [
      ...(thread.replies || []),
      { author: replyName, content: text, timestamp: Date.now(), childReplies: [] },
    ];
    await db.put('forumThreads', thread);
    await render(container, params);
  });
}
