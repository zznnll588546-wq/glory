import { navigate, back } from '../core/router.js';
import * as db from '../core/db.js';
import { createMessage } from '../models/chat.js';
import { chat as apiChat, resolveGenerationMaxTokens } from '../core/api.js';
import { buildForumAiSystemPrompt } from '../core/context.js';
import { showToast } from '../components/toast.js';
import { getState } from '../core/state.js';
import { WORLD_BOOKS } from '../data/world-books.js';
import { CHARACTERS } from '../data/characters.js';
import { getCharacterStateForSeason, formatChatPickerLabel, resolveChatParticipantName } from '../core/chat-helpers.js';
import { getVirtualNow } from '../core/virtual-time.js';
import { applyGeneratedChatShares, getUserChatsForRelay } from '../core/social-chat-relay.js';

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

function buildRandomGenerationKey(prefix = 'gen') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeForumRules(rules, theme = '') {
  const fallback = {
    sectionRule: `围绕主题「${theme || '当前主线'}」生成论坛版块定位与社区规则，强调角色关系与赛季时间一致。`,
    postFormat: '帖子结构建议：标题简短有梗；正文 2-6 段；可带转述、吐槽、引用；语气保持论坛口语化。',
    contentGuide: '论坛内容应包含理性分析、情绪争执、复盘、错窗补救、粉黑大战等真实讨论氛围。',
    replyRule: '回复与回复内容必须在同一段，不要拆成“回复标签一段 + 正文一段”。允许短句连发但保持楼层可读。',
  };
  const src = rules && typeof rules === 'object' ? rules : {};
  return {
    sectionRule: String(src.sectionRule || fallback.sectionRule).trim(),
    postFormat: String(src.postFormat || fallback.postFormat).trim(),
    contentGuide: String(src.contentGuide || fallback.contentGuide).trim(),
    replyRule: String(src.replyRule || fallback.replyRule).trim(),
  };
}

function rulesToText(rules) {
  const r = normalizeForumRules(rules);
  return [
    `版块规则：${r.sectionRule}`,
    `发帖格式：${r.postFormat}`,
    `论坛内容：${r.contentGuide}`,
    `回复规范：${r.replyRule}`,
  ].join('\n');
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

async function collectForumRoleplayHints(userId, season) {
  const chats = await getUserChatsForRelay(userId);
  const snippets = [];
  for (const c of chats.slice(0, 8)) {
    const list = await db.getAllByIndex('messages', 'chatId', c.id);
    const recent = [...list]
      .filter((m) => !m.deleted && !m.recalled && m.senderId !== 'user' && m.type === 'text')
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 2);
    for (const m of recent) {
      snippets.push(`[${m.senderName || m.senderId}] ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 68)}`);
      if (snippets.length >= 12) break;
    }
    if (snippets.length >= 12) break;
  }
  const relayGroupNames = chats
    .filter((c) => c.type === 'group' && (c.participants || []).includes('user'))
    .map((c) => String(c.groupSettings?.name || '').trim())
    .filter(Boolean)
    .slice(0, 16);
  const relation = [];
  const chars = await db.getAll('characters');
  const pool = chars.length ? chars : CHARACTERS;
  for (const c of pool) {
    if (!c?.relationships) continue;
    const st = getCharacterStateForSeason(c, season);
    const pairs = Object.entries(c.relationships).slice(0, 2);
    if (!pairs.length) continue;
    relation.push(`${st.publicName || c.name || c.id}:${pairs.map(([k, v]) => `${k}-${String(v).slice(0, 12)}`).join('；')}`);
    if (relation.length >= 10) break;
  }
  return { snippets, relation, relayGroupNames };
}

export default async function render(container) {
  const user = await getCurrentUser();
  const virtualNow = await getVirtualNow(user?.id || '', 0);
  const userId = user?.id || (await getCurrentUserId());
  const season = getState('currentUser')?.currentTimeline || user?.currentTimeline || 'S8';
  const wbOptions = await getWorldBookOptions();
  let threads = await loadThreadsForUser(userId);
  const cfgRow = await db.get('settings', 'forumMeta');
  const meta = cfgRow?.value || {
    sections: [{ id: 'general', name: '综合讨论', desc: '默认版块' }],
    activeSectionId: 'general',
  };
  for (const sec of meta.sections || []) {
    if (!sec.forumRules) sec.forumRules = normalizeForumRules(null, sec.name || '');
  }

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
        <button type="button" class="navbar-btn forum-ai-post" aria-label="AI生成帖子">✦</button>
        <button type="button" class="navbar-btn forum-sec-edit" aria-label="版块规则">⚙</button>
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
        timestamp: virtualNow,
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
      const slice = chats.slice(0, 20);
      const lines = await Promise.all(
        slice.map(async (c, i) => `${i + 1}. ${await formatChatPickerLabel(c, resolveChatParticipantName)}`),
      );
      const text = lines.join('\n');
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
      target.lastActivity = virtualNow;
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
        timestamp: virtualNow,
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
        <label class="form-label" style="margin-top:10px;">版块生成键（可空，空则随机）</label>
        <input class="form-input fab-sec-key" placeholder="用于记录该版块长期生成上下文的 key" />
        <label class="form-label" style="margin-top:10px;">帖子生成键（可空，空则随机）</label>
        <input class="form-input fab-post-key" placeholder="该版块内后续发帖可复用/覆盖的 key" />
        <label class="form-label" style="margin-top:10px;">版块规则草案（可编辑）</label>
        <textarea class="form-input fab-rules" rows="5" placeholder="可提前写版块规则、发帖格式、论坛内容、回复规范"></textarea>
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
      const secKey = (root.querySelector('.fab-sec-key')?.value || '').trim() || buildRandomGenerationKey('forum_section');
      const postKey = (root.querySelector('.fab-post-key')?.value || '').trim() || buildRandomGenerationKey('forum_post');
      const rulesDraft = (root.querySelector('.fab-rules')?.value || '').trim();
      const wbId = (root.querySelector('select.fab-wb')?.value || '').trim() || null;
      const systemPrompt = await buildForumAiSystemPrompt(user, season, {
        worldBookId: wbId,
        referenceNotes: ref,
      });
      const rpHints = await collectForumRoleplayHints(userId, season);
      const relayHint = (rpHints.relayGroupNames || []).length
        ? `用户存档中的群聊名称（chatShares 若 targetType 为 group，groupName 须与下列之一一致或明显匹配）:${rpHints.relayGroupNames.join('、')}`
        : '用户当前无存档群聊：chatShares 请只用 private_user（角色与用户的私聊转发），不要写 group。';
      const userTask = [
        `当前任务：根据主题「${theme}」设计一个论坛新版块，并生成若干首开帖（含少量回复楼层）。`,
        `版块生成键：${secKey}`,
        `帖子生成键：${postKey}`,
        `当前赛季：${season}。只允许使用当前赛季可见身份与关系，禁止未来剧情穿越。`,
        relayHint,
        '帖子风格要有差异：理性分析、情绪吐槽、带链接转发、错窗/错群后的补救口吻可混合出现，但不要统一模板语气。',
        rulesDraft ? `用户提供的规则草案（优先融合）：\n${rulesDraft}` : '',
        rpHints.relation.length ? `角色关系速记：\n${rpHints.relation.join('\n')}` : '角色关系速记：暂无',
        rpHints.snippets.length ? `历史聊天口吻片段（当前存档）：\n${rpHints.snippets.join('\n')}` : '历史聊天口吻片段：暂无',
        'chatShares：默认必须输出空数组 []。仅当剧情明确需要「把某帖转进聊天」时再填 1～2 条；postIndex 为 threads 下标，其余字段同微博 chatShares 规则。',
        '回复和回复内容不要分段，必须同一条回复文本内完整表达，不要先单独写“回复某人”再断行写正文。',
        '硬性要求：只输出一个合法 JSON 对象，不要用 markdown 代码块包裹。',
        'JSON 结构：',
        '{"section":{"name":"版块名","desc":"版块简介"},"rules":{"sectionRule":"版块规则","postFormat":"发帖格式","contentGuide":"论坛内容","replyRule":"回复规范"},"threads":[{"title":"帖子标题","content":"帖子正文","authorName":"昵称","authorId":"","replies":[{"author":"回复者","content":"回复内容"}]}],"chatShares":[]}',
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
        const normalizedRules = normalizeForumRules(parsed.rules, theme);
        const sec = {
          id: 'sec_' + Date.now(),
          name: parsed.section?.name || theme,
          desc: parsed.section?.desc || '',
          generationKey: secKey,
          postGenerationKey: postKey,
          generationPrompt: `主题:${theme}\n补充说明:${ref || '无'}\n生成时间:${formatTime(virtualNow)}`,
          forumRules: normalizedRules,
          ...(wbId ? { worldBookId: wbId } : {}),
        };
        meta.sections = [...(meta.sections || []), sec];
        meta.activeSectionId = sec.id;
        const insertedThreads = [];
        for (const t of parsed.threads || []) {
          const thread = {
            id: 'forum_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
            title: t.title || '无标题',
            content: t.content || '',
            authorName: t.authorName || '匿名',
            authorId: t.authorId || '',
            userId,
            sectionId: sec.id,
            timestamp: virtualNow - Math.floor(Math.random() * 7200_000),
            replies: (t.replies || []).map((r) => ({ author: r.author || '匿名', content: r.content || '', timestamp: virtualNow })),
          };
          await db.put('forumThreads', thread);
          insertedThreads.push(thread);
        }
        await applyGeneratedChatShares({
          userId: userId || '',
          chatShares: parsed.chatShares,
          relayItems: insertedThreads,
          virtualNow,
          relaySpec: {
            urlScheme: 'forum',
            sourceLabel: '论坛',
            lastMessagePreview: '[论坛分享]',
            linkTitle: (th, fname) => `论坛：${th.title || fname}`,
            linkDesc: (th) => th.content || '',
            extraLinkMetadata: () => ({ fromForumRelay: true }),
          },
        });
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

  container.querySelector('.forum-sec-edit')?.addEventListener('click', () => {
    const activeId = meta.activeSectionId || 'general';
    const idx = (meta.sections || []).findIndex((s) => s.id === activeId);
    if (idx < 0) return;
    const sec = meta.sections[idx];
    const rules = normalizeForumRules(sec.forumRules, sec.name || '');
    const { close, root } = openGlobalModal(`
      <div class="modal-header"><h3>编辑版块规则</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
      <div class="modal-body">
        <label class="form-label">版块生成键</label>
        <input class="form-input fs-gen-key" value="${escapeAttr(sec.generationKey || '')}" placeholder="留空将自动生成" />
        <label class="form-label" style="margin-top:8px;">帖子生成键</label>
        <input class="form-input fs-post-key" value="${escapeAttr(sec.postGenerationKey || '')}" placeholder="留空将自动生成" />
        <label class="form-label" style="margin-top:8px;">版块规则</label>
        <textarea class="form-input fs-rule-section" rows="3">${escapeHtml(rules.sectionRule)}</textarea>
        <label class="form-label" style="margin-top:8px;">发帖格式</label>
        <textarea class="form-input fs-rule-post" rows="3">${escapeHtml(rules.postFormat)}</textarea>
        <label class="form-label" style="margin-top:8px;">论坛内容</label>
        <textarea class="form-input fs-rule-content" rows="3">${escapeHtml(rules.contentGuide)}</textarea>
        <label class="form-label" style="margin-top:8px;">回复规范</label>
        <textarea class="form-input fs-rule-reply" rows="3">${escapeHtml(rules.replyRule)}</textarea>
        <button type="button" class="btn btn-primary fs-rule-save" style="margin-top:10px;width:100%;">保存</button>
      </div>
    `);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    root.querySelector('.fs-rule-save')?.addEventListener('click', async () => {
      sec.generationKey = (root.querySelector('.fs-gen-key')?.value || '').trim() || buildRandomGenerationKey('forum_section');
      sec.postGenerationKey = (root.querySelector('.fs-post-key')?.value || '').trim() || buildRandomGenerationKey('forum_post');
      sec.forumRules = normalizeForumRules({
        sectionRule: (root.querySelector('.fs-rule-section')?.value || '').trim(),
        postFormat: (root.querySelector('.fs-rule-post')?.value || '').trim(),
        contentGuide: (root.querySelector('.fs-rule-content')?.value || '').trim(),
        replyRule: (root.querySelector('.fs-rule-reply')?.value || '').trim(),
      }, sec.name || '');
      await db.put('settings', { key: 'forumMeta', value: meta });
      close();
      showToast('版块规则已保存');
      await render(container);
    });
  });

  container.querySelector('.forum-ai-post')?.addEventListener('click', () => {
    if (!userId) {
      showToast('请先选择用户档案');
      return;
    }
    const sec = (meta.sections || []).find((s) => s.id === (meta.activeSectionId || 'general'));
    if (!sec) return;
    const { close, root } = openGlobalModal(`
      <div class="modal-header"><h3>AI生成本版块新帖</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
      <div class="modal-body">
        <label class="form-label">生成要求（可空）</label>
        <textarea class="form-input fap-demand" rows="4" placeholder="如：延续上次争论，新增2条互怼回复"></textarea>
        <label class="form-label" style="margin-top:8px;">本次帖子生成键（可空）</label>
        <input class="form-input fap-key" placeholder="留空则复用版块键并追加随机后缀" />
        <button type="button" class="btn btn-primary fap-go" style="margin-top:10px;width:100%;">生成新帖</button>
      </div>
    `);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    root.querySelector('.fap-go')?.addEventListener('click', async () => {
      const demand = (root.querySelector('.fap-demand')?.value || '').trim();
      const onceKeyRaw = (root.querySelector('.fap-key')?.value || '').trim();
      const onceKey = onceKeyRaw || `${sec.postGenerationKey || buildRandomGenerationKey('forum_post')}_${Math.random().toString(36).slice(2, 5)}`;
      const systemPrompt = await buildForumAiSystemPrompt(user, season, {
        worldBookId: sec.worldBookId || null,
        referenceNotes: `同版块续写。版块名:${sec.name || ''}`,
      });
      const sectionThreads = threads
        .filter((t) => (t.sectionId || 'general') === sec.id)
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, 8);
      const history = sectionThreads.map((t, i) => {
        const rs = Array.isArray(t.replies) ? t.replies.slice(0, 3).map((r) => `${r.author}:${r.content}`).join(' | ') : '';
        return `${i + 1}. ${t.title}\n正文:${String(t.content || '').slice(0, 180)}\n回复样例:${rs || '无'}`;
      }).join('\n\n');
      const task = [
        `任务：在论坛版块「${sec.name || '当前版块'}」下生成 1 条新帖子，并附带 0-4 条回复。`,
        `版块生成键：${sec.generationKey || buildRandomGenerationKey('forum_section')}`,
        `版块帖子主生成键：${sec.postGenerationKey || buildRandomGenerationKey('forum_post')}`,
        `本次帖子生成键：${onceKey}`,
        `版块规则如下：\n${rulesToText(sec.forumRules)}`,
        demand ? `本次额外定制要求：${demand}` : '本次额外定制要求：无（可随机，但必须符合版块风格）',
        history ? `同版块历史帖子摘要：\n${history}` : '同版块历史帖子摘要：暂无',
        '强制：回复和回复内容不要分段，回复文本中一次写完整，不要拆成上下两段。',
        '只输出 JSON 对象，不要 markdown：{"thread":{"title":"标题","content":"正文","authorName":"昵称","authorId":"","replies":[{"author":"回复者","content":"回复内容"}]}}',
      ].join('\n');
      const btn = root.querySelector('.fap-go');
      const genCap = await resolveGenerationMaxTokens(3072);
      try {
        btn.disabled = true;
        btn.textContent = `生成中…(max≈${genCap})`;
        const raw = await apiChat(
          [
            { role: 'system', content: `${systemPrompt}\n\n---\n\n你是论坛帖子生成助手，当前任务只允许输出同版块新增帖子。` },
            { role: 'user', content: task },
          ],
          { temperature: 0.95, maxTokens: genCap }
        );
        const text = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
        const parsed = JSON.parse(text);
        const th = parsed.thread || {};
        const nowTs = await getVirtualNow(userId || '', 0);
        const thread = {
          id: 'forum_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
          title: th.title || `${sec.name || '版块'}新帖`,
          content: th.content || '',
          authorName: th.authorName || '匿名',
          authorId: th.authorId || '',
          userId,
          sectionId: sec.id,
          timestamp: nowTs,
          generationKey: onceKey,
          replies: (th.replies || []).map((r) => ({ author: r.author || '匿名', content: r.content || '', timestamp: nowTs })),
        };
        await db.put('forumThreads', thread);
        close();
        await render(container);
        showToast('已在当前版块生成新帖');
      } catch (e) {
        showToast(`生成失败：${e?.message || '未知错误'}`);
        btn.disabled = false;
        btn.textContent = '生成新帖';
      }
    });
  });

  void navigate;
}
