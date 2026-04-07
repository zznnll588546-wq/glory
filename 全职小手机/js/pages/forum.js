import { navigate, back } from '../core/router.js';
import * as db from '../core/db.js';
import { createMessage } from '../models/chat.js';
import { chat as apiChat, resolveGenerationMaxTokens } from '../core/api.js';
import { buildForumAiSystemPrompt } from '../core/context.js';
import { showToast } from '../components/toast.js';
import { getState } from '../core/state.js';
import { WORLD_BOOKS } from '../data/world-books.js';

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

/** 帖子按用户隔离；版块元数据在 settings 中全局固定 */
async function loadThreadsForUser(userId) {
  if (!userId) return [];
  try {
    const list = await db.getAllByIndex('forumThreads', 'userId', userId);
    return list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  } catch (_) {
    const all = await db.getAll('forumThreads');
    return all.filter((t) => t.userId === userId).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }
}

async function getWorldBookOptions() {
  const stored = await db.getAll('worldBooks');
  const byId = new Map(stored.map((e) => [e.id, e]));
  for (const s of WORLD_BOOKS) {
    if (!byId.has(s.id)) byId.set(s.id, { ...s });
  }
  return [...byId.values()].sort(
    (a, b) =>
      (a.position ?? 100) - (b.position ?? 100) || (a.name || '').localeCompare(b.name || '', 'zh-CN')
  );
}

function worldBookSelectMarkup(className) {
  return `
    <label class="form-label">绑定世界书（可选）</label>
    <select class="form-input ${className}"></select>
    <p class="text-hint" style="font-size:11px;margin-top:4px;">可选中已导入或内置世界书；AI 生成时会全文注入系统上下文。</p>`;
}

async function fillWorldBookSelect(root, className, wbList, selectedId = '') {
  const sel = root.querySelector(`select.${className}`);
  if (!sel) return;
  sel.innerHTML = '';
  sel.appendChild(new Option('不绑定（仅用全局时间线/预设）', ''));
  for (const w of wbList) {
    const o = new Option(w.name || w.id, w.id);
    if (w.id === selectedId) o.selected = true;
    sel.appendChild(o);
  }
}

async function resolveName(id) {
  if (!id || id === 'user') return '我';
  const c = await db.get('characters', id);
  return c?.name || id;
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

function threadDetailHtml(thread) {
  const replies = Array.isArray(thread.replies) ? thread.replies : [];
  const replyBlocks = replies
    .map(
      (r) => `
    <div class="forum-reply">
      <div class="forum-reply-meta">${escapeHtml(r.author || '匿名')} · ${escapeHtml(formatTime(r.timestamp || 0))}</div>
      <div class="forum-reply-body">${escapeHtml(r.content || '')}</div>
    </div>`
    )
    .join('');
  return `
    <div class="modal-header">
      <h3>${escapeHtml(thread.title || '帖子')}</h3>
      <button type="button" class="navbar-btn forum-detail-close" aria-label="关闭">✕</button>
    </div>
    <div class="modal-body forum-detail-body">
      <div class="forum-detail-meta">${escapeHtml(thread.authorName || '用户')} · ${escapeHtml(formatTime(thread.timestamp || 0))}</div>
      <div class="forum-detail-content">${escapeHtml(thread.content || '')}</div>
      <h4 class="forum-replies-title">回复 (${replies.length})</h4>
      <div class="forum-replies">${replyBlocks || '<p class="text-hint">暂无回复</p>'}</div>
      <button type="button" class="btn btn-outline forum-share-chat" style="width:100%;margin-top:8px;">转发到聊天</button>
      <div class="form-group" style="margin-top:12px;">
        <textarea class="form-input forum-reply-input" rows="3" placeholder="写下回复…"></textarea>
        <button type="button" class="btn btn-primary forum-reply-send" style="margin-top:8px;width:100%;">发送回复</button>
      </div>
    </div>
  `;
}

async function getUserChats(userId) {
  if (!userId) return [];
  return (await db.getAllByIndex('chats', 'userId', userId))
    .filter((c) => (c.groupSettings?.allowSocialLinkage ?? true))
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
}

function pickRandom(list) {
  if (!list?.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

async function maybeLinkThreadToChat({ userId, thread }) {
  const all = await getUserChats(userId);
  if (!all.length) return;
  if (Math.random() > 0.55) return;
  const groups = all.filter((c) => c.type === 'group');
  const target = pickRandom(groups) || pickRandom(all);
  if (!target) return;
  const wrongCandidates = all.filter((c) => c.id !== target.id);
  const wrongTarget = pickRandom(wrongCandidates) || target;
  const wrongMode = Math.random();
  const allowWrong = (target.groupSettings?.allowWrongSend ?? true) || (wrongTarget.groupSettings?.allowWrongSend ?? true);
  const isWrongSend = allowWrong && Math.random() < 0.45;
  const finalTarget = isWrongSend ? wrongTarget : target;
  const senderId = thread.authorId || 'npc';
  const senderName = thread.authorName || '匿名';
  const linkMsg = createMessage({
    chatId: finalTarget.id,
    senderId,
    senderName,
    type: 'link',
    content: `forum://${thread.id}`,
    metadata: {
      title: `论坛：${thread.title || '帖子'}`,
      desc: (thread.content || '').slice(0, 80),
      source: '论坛',
      autoLinked: true,
      wrongChat: isWrongSend,
    },
  });
  await db.put('messages', linkMsg);
  finalTarget.lastMessage = '[论坛分享]';
  finalTarget.lastActivity = Date.now();
  await db.put('chats', finalTarget);
  if (!isWrongSend) return;
  if (wrongMode < 0.5) {
    linkMsg.recalled = true;
    linkMsg.metadata = { ...(linkMsg.metadata || {}), recalledContent: linkMsg.content };
    await db.put('messages', linkMsg);
    await db.put('messages', createMessage({
      chatId: finalTarget.id,
      senderId: 'system',
      type: 'system',
      content: `${senderName} 撤回了一条发错窗口的论坛链接（有人已看到）`,
      metadata: { recalledContent: `forum://${thread.id}` },
    }));
  } else {
    await db.put('messages', createMessage({
      chatId: finalTarget.id,
      senderId,
      senderName,
      type: 'text',
      content: '发错地方了…完了，超过撤回时间。',
      metadata: { autoLinked: true, wrongChat: true, recallExpired: true },
    }));
  }
  if (finalTarget.type === 'group') {
    const memberIds = (finalTarget.participants || []).filter((id) => id && id !== 'user').slice(0, 6);
    const roastLines = ['你这错窗有点抽象。', '撤回了也没用，我看到了。', '下次先看群名啊。', '哈哈哈哈哈大型翻车现场。'];
    const pickCount = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < pickCount; i++) {
      const sid = memberIds[i % memberIds.length] || senderId;
      await db.put('messages', createMessage({
        chatId: finalTarget.id,
        senderId: sid,
        senderName: await resolveName(sid),
        type: 'text',
        content: roastLines[Math.floor(Math.random() * roastLines.length)],
        metadata: { wrongSendFollowup: true },
      }));
    }
  }
}

export default async function render(container) {
  const user = await getCurrentUser();
  const userId = user?.id || (await getCurrentUserId());
  const season = getState('currentUser')?.currentTimeline || user?.currentTimeline || 'S8';
  const wbOptions = await getWorldBookOptions();
  let threads = await loadThreadsForUser(userId);
  const cfgRow = await db.get('settings', 'forumMeta');
  const meta = cfgRow?.value || {
    sections: [{ id: 'general', name: '综合讨论', desc: '默认版块' }],
    activeSectionId: 'general',
  };

  function buildListHtml() {
    const active = meta.activeSectionId || 'general';
    const tabHtml = (meta.sections || [])
      .map(
        (s) =>
          `<button type="button" class="preset-tab forum-sec-tab${active === s.id ? ' active' : ''}" data-sec-id="${escapeAttr(s.id)}">${escapeHtml(s.name)}${s.worldBookId ? ' 📖' : ''}</button>`
      )
      .join('');
    const list = threads.filter((t) => (t.sectionId || 'general') === active);
    const listBlock =
      list.length > 0
        ? list
            .map((t) => {
              const rc = Array.isArray(t.replies) ? t.replies.length : 0;
              return `
        <div class="forum-thread card-block" data-thread-id="${escapeAttr(t.id)}" role="button" tabindex="0">
          <div class="forum-thread-title">${escapeHtml(t.title || '无标题')}</div>
          <div class="forum-thread-meta">
            <span>${escapeHtml(t.authorName || '用户')}</span>
            <span>${rc} 回复</span>
            <span>${escapeHtml(formatTime(t.timestamp || 0))}</span>
          </div>
        </div>`;
            })
            .join('')
        : `<div class="placeholder-page" style="padding:32px 16px;min-height:auto;"><div class="placeholder-text">${
            threads.length ? '当前分区暂无帖子' : '当前档案下还没有帖子（切换用户后仅显示该用户帖子）'
          }</div></div>`;
    return `<div class="preset-tab-row" style="padding-top:8px;">${tabHtml}</div>${listBlock}`;
  }

  container.classList.add('forum-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn forum-back" aria-label="返回">‹</button>
      <h1 class="navbar-title">论坛</h1>
      <div style="display:flex;gap:6px;">
        <button type="button" class="navbar-btn forum-ai-board" aria-label="AI建板块">⚡</button>
        <button type="button" class="navbar-btn forum-new-sec" aria-label="新板块">◫</button>
        <button type="button" class="navbar-btn forum-new" aria-label="发帖">+</button>
      </div>
    </header>
    <div class="page-scroll forum-list">${buildListHtml()}</div>
  `;

  const refreshListDom = () => {
    const el = container.querySelector('.forum-list');
    if (el) el.innerHTML = buildListHtml();
    bindThreadClicks();
  };

  if (container._forumSecClick) {
    container.removeEventListener('click', container._forumSecClick);
  }
  container._forumSecClick = async (e) => {
    const tab = e.target.closest('.forum-sec-tab');
    if (!tab || !container.contains(tab)) return;
    meta.activeSectionId = tab.dataset.secId;
    await db.put('settings', { key: 'forumMeta', value: meta });
    refreshListDom();
  };
  container.addEventListener('click', container._forumSecClick);

  function openThreadModal(thread) {
    const { close, root } = openGlobalModal(threadDetailHtml(thread));
    const doClose = () => close();
    root.querySelector('.forum-detail-close')?.addEventListener('click', doClose);
    root.querySelector('.forum-reply-send')?.addEventListener('click', async () => {
      const input = root.querySelector('.forum-reply-input');
      const text = (input?.value || '').trim();
      if (!text) return;
      const t = threads.find((x) => x.id === thread.id);
      if (!t) return;
      if (!Array.isArray(t.replies)) t.replies = [];
      t.replies.push({
        author: user?.name || '旅行者',
        content: text,
        timestamp: Date.now(),
      });
      await db.put('forumThreads', t);
      input.value = '';
      threads = await loadThreadsForUser(userId);
      const updated = threads.find((x) => x.id === thread.id);
      close();
      if (updated) openThreadModal(updated);
      refreshListDom();
    });
    root.querySelector('.forum-share-chat')?.addEventListener('click', async () => {
      const uid = await getCurrentUserId();
      const chats = (await db.getAllByIndex('chats', 'userId', uid || '')).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
      if (!chats.length) return;
      const text = chats.slice(0, 20).map((c, i) => `${i + 1}. ${c.type === 'group' ? (c.groupSettings?.name || '群聊') : '私聊'}`).join('\n');
      const idx = Number(window.prompt(`选择聊天编号：\n${text}`, '1') || '1') - 1;
      const target = chats[Math.max(0, Math.min(chats.length - 1, idx))];
      const linkMsg = createMessage({
        chatId: target.id,
        senderId: 'user',
        type: 'link',
        content: `forum://${thread.id}`,
        metadata: {
          title: `论坛：${thread.title || '帖子'}`,
          desc: (thread.content || '').slice(0, 80),
          source: '论坛',
        },
      });
      await db.put('messages', linkMsg);
      target.lastMessage = '[论坛分享]';
      target.lastActivity = Date.now();
      await db.put('chats', target);
    });
  }

  function bindThreadClicks() {
    container.querySelectorAll('.forum-thread').forEach((el) => {
      const open = () => {
        const id = el.dataset.threadId;
        navigate('forum-detail', { threadId: id });
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });
  }

  bindThreadClicks();

  container.querySelector('.forum-back')?.addEventListener('click', () => back());

  container.querySelector('.forum-new')?.addEventListener('click', () => {
    if (!userId) {
      showToast('请先选择用户档案后再发帖');
      return;
    }
    const { close, root } = openGlobalModal(`
      <div class="modal-header">
        <h3>发帖</h3>
        <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">标题</label>
          <input type="text" class="form-input forum-new-title" placeholder="标题" />
        </div>
        <div class="form-group">
          <label class="form-label">正文</label>
          <textarea class="form-input forum-new-content" rows="8" placeholder="正文内容…"></textarea>
        </div>
        <button type="button" class="btn btn-primary forum-new-submit" style="width:100%;margin-top:8px;">发布</button>
      </div>
    `);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    root.querySelector('.forum-new-submit')?.addEventListener('click', async () => {
      const title = (root.querySelector('.forum-new-title')?.value || '').trim();
      const content = (root.querySelector('.forum-new-content')?.value || '').trim();
      if (!title || !content) return;
      const thread = {
        id: 'forum_' + Date.now(),
        title,
        content,
        authorName: user?.name || '旅行者',
        userId,
        sectionId: meta.activeSectionId || 'general',
        timestamp: Date.now(),
        replies: [],
      };
      await db.put('forumThreads', thread);
      close();
      await render(container);
    });
  });

  container.querySelector('.forum-new-sec')?.addEventListener('click', () => {
    const { close, root } = openGlobalModal(`
      <div class="modal-header"><h3>新建板块</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
      <div class="modal-body">
        <input class="form-input fs-name" placeholder="板块名" />
        <textarea class="form-input fs-desc" rows="3" placeholder="简介" style="margin-top:8px;"></textarea>
        ${worldBookSelectMarkup('fs-wb')}
        <button type="button" class="btn btn-primary fs-save" style="margin-top:8px;width:100%;">保存</button>
      </div>
    `);
    void fillWorldBookSelect(root, 'fs-wb', wbOptions, '');
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    root.querySelector('.fs-save')?.addEventListener('click', async () => {
      const name = (root.querySelector('.fs-name')?.value || '').trim();
      if (!name) return;
      const wbPick = (root.querySelector('select.fs-wb')?.value || '').trim();
      const sec = {
        id: 'sec_' + Date.now(),
        name,
        desc: (root.querySelector('.fs-desc')?.value || '').trim(),
        ...(wbPick ? { worldBookId: wbPick } : {}),
      };
      meta.sections = [...(meta.sections || []), sec];
      meta.activeSectionId = sec.id;
      await db.put('settings', { key: 'forumMeta', value: meta });
      close();
      await render(container);
    });
  });

  container.querySelector('.forum-ai-board')?.addEventListener('click', () => {
    if (!userId) {
      showToast('请先选择用户档案；生成帖子将记入当前档案');
      return;
    }
    const { close, root } = openGlobalModal(`
      <div class="modal-header"><h3>AI创建版块</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
      <div class="modal-body">
        ${worldBookSelectMarkup('fab-wb')}
        <label class="form-label" style="margin-top:10px;">主题</label>
        <input class="form-input fab-theme" placeholder="如：S8 赛后舆论、绑定世界书内的某事件讨论" />
        <textarea class="form-input fab-ref" rows="4" placeholder="补充说明（可选，会并入系统上下文）" style="margin-top:8px;"></textarea>
        <button type="button" class="btn btn-primary fab-go" style="margin-top:8px;width:100%;">生成</button>
      </div>
    `);
    void fillWorldBookSelect(root, 'fab-wb', wbOptions, '');
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    root.querySelector('.fab-go')?.addEventListener('click', async () => {
      const theme = (root.querySelector('.fab-theme')?.value || '').trim();
      if (!theme) return;
      const ref = (root.querySelector('.fab-ref')?.value || '').trim();
      const wbId = (root.querySelector('select.fab-wb')?.value || '').trim() || null;
      const systemPrompt = await buildForumAiSystemPrompt(user, season, {
        worldBookId: wbId,
        referenceNotes: ref,
      });
      const userTask = [
        `当前任务：根据主题「${theme}」设计一个论坛新版块，并生成若干首开帖（含少量回复楼层）。`,
        '硬性要求：只输出一个合法 JSON 对象，不要用 markdown 代码块包裹。',
        'JSON 结构：',
        '{"section":{"name":"版块名","desc":"版块简介"},"threads":[{"title":"帖子标题","content":"帖子正文","authorName":"昵称","authorId":"","replies":[{"author":"回复者","content":"回复内容"}]}]}',
        'threads 数量建议 3～8 条；允许匿名、小号、忘切号、队粉互撕等真实论坛气质。',
      ].join('\n');
      const btn = root.querySelector('.fab-go');
      const genCap = await resolveGenerationMaxTokens(4096);
      try {
        btn.disabled = true;
        btn.textContent = `生成中…(max≈${genCap})`;
        showToast('论坛版块生成中，请稍候…');
        const raw = await apiChat(
          [
            { role: 'system', content: `${systemPrompt}\n\n---\n\n你是论坛内容生成助手。严格遵守上文世界观与绑定世界书（若有）。` },
            { role: 'user', content: userTask },
          ],
          { temperature: 0.9, maxTokens: genCap }
        );
        const text = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
        const parsed = JSON.parse(text);
        const sec = {
          id: 'sec_' + Date.now(),
          name: parsed.section?.name || theme,
          desc: parsed.section?.desc || '',
          ...(wbId ? { worldBookId: wbId } : {}),
        };
        meta.sections = [...(meta.sections || []), sec];
        meta.activeSectionId = sec.id;
        for (const t of parsed.threads || []) {
          const thread = {
            id: 'forum_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
            title: t.title || '无标题',
            content: t.content || '',
            authorName: t.authorName || '匿名',
            authorId: t.authorId || '',
            userId,
            sectionId: sec.id,
            timestamp: Date.now() - Math.floor(Math.random() * 7200_000),
            replies: (t.replies || []).map((r) => ({ author: r.author || '匿名', content: r.content || '', timestamp: Date.now() })),
          };
          await db.put('forumThreads', thread);
          await maybeLinkThreadToChat({ userId: userId || '', thread });
        }
        await db.put('settings', { key: 'forumMeta', value: meta });
        close();
        await render(container);
        showToast('论坛版块已生成');
      } catch (e) {
        showToast(`生成失败：${e?.message || '未知错误'}`);
        btn.disabled = false;
        btn.textContent = '生成';
      }
    });
  });

  void navigate;
}
