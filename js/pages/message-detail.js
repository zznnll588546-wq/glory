import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { normalizeMessageForUi, orderShareCardHtml } from '../core/chat-helpers.js';

function e(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export default async function render(container, params) {
  const chatId = params?.chatId;
  const msgId = params?.msgId;
  if (!chatId || !msgId) {
    container.innerHTML = '<div class="placeholder-page"><div class="placeholder-text">缺少消息参数</div></div>';
    return;
  }
  const msgRaw = await db.get('messages', msgId);
  if (!msgRaw) {
    container.innerHTML = '<div class="placeholder-page"><div class="placeholder-text">消息不存在</div></div>';
    return;
  }
  const msg = normalizeMessageForUi(msgRaw);
  const chatMessages = (await db.getAllByIndex('messages', 'chatId', chatId)).map(normalizeMessageForUi);
  let body = `<div class="card-block"><div class="text-hint">暂无详情</div></div>`;

  if (msg.type === 'sticker') {
    const src = String(msg.metadata?.url || msg.content || '').replace(/"/g, '&quot;');
    body = `<div class="card-block"><div class="link-card-title">表情包</div><div class="chat-sticker" style="text-align:center;margin-top:10px;"><img src="${src}" alt="${e(msg.metadata?.stickerName || '表情')}" style="max-width:100%;max-height:320px;object-fit:contain;border-radius:12px;" /></div></div>`;
  } else if (msg.type === 'orderShare') {
    body = `<div class="card-block">${orderShareCardHtml(msg, e)}</div>`;
  } else if (msg.type === 'location') {
    body = `<div class="card-block"><div class="link-card-title">位置共享</div><div class="link-card-desc">${e(msg.content || msg.metadata?.locationName || '')}</div><div style="margin-top:10px;height:220px;border-radius:12px;background:linear-gradient(135deg,#dfe8f3,#b8cbe3);display:flex;align-items:center;justify-content:center;color:#486a8d;">地图预览</div></div>`;
  } else if (msg.type === 'redpacket') {
    const state = msg.metadata?.packetState || 'pending';
    const packetLogs = chatMessages
      .filter((m) => m.type === 'redpacket')
      .slice(-5)
      .map((m) => `<div style="font-size:12px;color:#ffe9e5;">• ${e(m.content || m.metadata?.greeting || '红包')} · ${new Date(m.timestamp || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>`)
      .join('');
    body = `<div class="card-block" style="background:linear-gradient(145deg,#ff6b57,#d84f3b);color:#fff;">
      <div class="link-card-title" style="color:#fff;">微信红包</div>
      <div class="link-card-desc" style="color:#ffe9e5;">${e(msg.content || msg.metadata?.greeting || '恭喜发财')}</div>
      <div style="margin-top:18px;padding:12px;border-radius:12px;background:rgba(255,255,255,0.2);">${state === 'claimed' ? '已领取' : state === 'expired' ? '已过期' : '待领取'}</div>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button type="button" class="btn btn-outline md-pkt-claim" style="flex:1;border-color:#fff;color:#fff;">领取</button>
        <button type="button" class="btn btn-outline md-pkt-expire" style="flex:1;border-color:#fff;color:#fff;">标记过期</button>
      </div>
      <div style="margin-top:10px;padding:8px;border-radius:10px;background:rgba(255,255,255,0.18);">${packetLogs || '<div style="font-size:12px;color:#ffe9e5;">暂无红包记录</div>'}</div>
    </div>`;
  } else if (msg.type === 'transfer') {
    const state = msg.metadata?.transferState || 'pending';
    const transferLogs = chatMessages
      .filter((m) => m.type === 'transfer')
      .slice(-5)
      .map((m) => `<div style="font-size:12px;color:#dcfff0;">• ${e(m.content || m.metadata?.amount || '¥0.00')} · ${new Date(m.timestamp || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>`)
      .join('');
    body = `<div class="card-block" style="background:linear-gradient(145deg,#24c18a,#1da574);color:#fff;">
      <div class="link-card-title" style="color:#fff;">转账详情</div>
      <div style="font-size:28px;font-weight:700;margin:12px 0;">${e(msg.content || msg.metadata?.amount || '¥0.00')}</div>
      <div class="link-card-desc" style="color:#dcfff0;">状态：${state === 'accepted' ? '已收款' : state === 'returned' ? '已退回' : '待确认'}</div>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button type="button" class="btn btn-outline md-tf-accept" style="flex:1;border-color:#fff;color:#fff;">收款</button>
        <button type="button" class="btn btn-outline md-tf-return" style="flex:1;border-color:#fff;color:#fff;">退回</button>
      </div>
      <div style="margin-top:10px;padding:8px;border-radius:10px;background:rgba(255,255,255,0.18);">${transferLogs || '<div style="font-size:12px;color:#dcfff0;">暂无转账记录</div>'}</div>
    </div>`;
  } else if (msg.type === 'link') {
    const url = String(msg.content || '');
    if (url.startsWith('weibo://')) {
      const wid = url.slice('weibo://'.length);
      const post = await db.get('weiboPosts', wid);
      body = `<div class="card-block"><div class="link-card-title">微博网页</div><div class="link-card-desc">${e(post?.authorName || msg.metadata?.title || '微博')}</div><div style="margin-top:10px;padding:12px;border-radius:10px;background:#f6f9ff;border:1px solid #d9e7fb;line-height:1.6;">${e(post?.content || msg.metadata?.desc || '')}</div><button type="button" class="btn btn-primary md-open-weibo" style="margin-top:10px;width:100%;">打开微博详情</button></div>`;
    } else if (url.startsWith('forum://')) {
      const fid = url.slice('forum://'.length);
      const thread = await db.get('forumThreads', fid);
      body = `<div class="card-block"><div class="link-card-title">论坛网页</div><div class="link-card-desc">${e(thread?.title || msg.metadata?.title || '论坛帖子')}</div><div style="margin-top:10px;padding:12px;border-radius:10px;background:#f6f9ff;border:1px solid #d9e7fb;line-height:1.6;">${e(thread?.content || msg.metadata?.desc || '')}</div><button type="button" class="btn btn-primary md-open-forum" style="margin-top:10px;width:100%;">打开论坛详情</button></div>`;
    } else {
      body = `<div class="card-block"><div class="link-card-title">${e(msg.metadata?.title || '链接')}</div><div class="link-card-desc">${e(msg.metadata?.source || '')}</div><div style="margin-top:10px;padding:12px;border-radius:10px;background:#f6f9ff;border:1px solid #d9e7fb;">${e(url)}</div></div>`;
    }
  } else if (msg.type === 'chatBundle') {
    const items = Array.isArray(msg.metadata?.items) ? msg.metadata.items : [];
    const fromLab = String(msg.metadata?.fromChatLabel || '').trim();
    const fromLine = fromLab ? `<div class="text-hint" style="font-size:12px;margin-top:6px;color:var(--text-secondary);">转自「${e(fromLab)}」</div>` : '';
    const list = items
      .slice(0, 50)
      .map((it) => `<div style="padding:8px 10px;border-radius:10px;background:#f7fbff;border:1px solid #d8e8fa;margin-top:6px;"><div style="font-size:12px;color:#6f8cab;">${e(it.senderName || it.senderId || '某人')}</div><div style="margin-top:4px;">${e(it.content || '')}</div></div>`)
      .join('');
    body = `<div class="card-block"><div class="link-card-title">${e(msg.metadata?.bundleTitle || '合并转发')}</div><div class="link-card-desc">${e(msg.metadata?.bundleSummary || `共 ${items.length} 条`)}</div>${fromLine}<div style="margin-top:10px;">${list || '<div class="text-hint">暂无片段</div>'}</div></div>`;
  }

  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn md-back">‹</button>
      <h1 class="navbar-title">消息详情</h1>
      <span class="navbar-btn" style="visibility:hidden"></span>
    </header>
    <div class="page-scroll" style="padding-top:12px;">${body}</div>
  `;
  container.querySelector('.md-back')?.addEventListener('click', () => back());
  container.querySelector('.md-open-weibo')?.addEventListener('click', () => {
    const url = String(msg.content || '');
    const wid = url.startsWith('weibo://') ? url.slice('weibo://'.length) : '';
    if (wid) navigate('weibo-detail', { postId: wid });
  });
  container.querySelector('.md-open-forum')?.addEventListener('click', () => {
    const url = String(msg.content || '');
    const fid = url.startsWith('forum://') ? url.slice('forum://'.length) : '';
    if (fid) navigate('forum-detail', { threadId: fid });
  });
  container.querySelector('.md-pkt-claim')?.addEventListener('click', async () => {
    msgRaw.metadata = { ...(msgRaw.metadata || {}), packetState: 'claimed' };
    await db.put('messages', msgRaw);
    await render(container, params);
  });
  container.querySelector('.md-pkt-expire')?.addEventListener('click', async () => {
    msgRaw.metadata = { ...(msgRaw.metadata || {}), packetState: 'expired' };
    await db.put('messages', msgRaw);
    await render(container, params);
  });
  container.querySelector('.md-tf-accept')?.addEventListener('click', async () => {
    msgRaw.metadata = { ...(msgRaw.metadata || {}), transferState: 'accepted' };
    await db.put('messages', msgRaw);
    await render(container, params);
  });
  container.querySelector('.md-tf-return')?.addEventListener('click', async () => {
    msgRaw.metadata = { ...(msgRaw.metadata || {}), transferState: 'returned' };
    await db.put('messages', msgRaw);
    await render(container, params);
  });
}
