import { navigate, back } from '../core/router.js';
import * as db from '../core/db.js';
import { getVirtualNow } from '../core/virtual-time.js';
import { createChat, createMessage } from '../models/chat.js';
import { icon } from '../components/svg-icons.js';
import { chat as apiChat } from '../core/api.js';
import { showToast } from '../components/toast.js';
import { resolveChatParticipantName } from '../core/chat-helpers.js';

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

function normalizeMomentForDisplay(post, nameMap) {
  const likes = Array.isArray(post?.likes) ? post.likes : [];
  const comments = Array.isArray(post?.comments) ? post.comments : [];
  return {
    ...post,
    likes: likes.map((x) => {
      if (typeof x === 'string' && nameMap?.has(x)) return nameMap.get(x);
      return x;
    }),
    comments: comments.map((c) => {
      const author = nameMap?.has(c?.author) ? nameMap.get(c.author) : (c?.author || '好友');
      const replyTo = nameMap?.has(c?.replyTo) ? nameMap.get(c.replyTo) : (c?.replyTo || '');
      return { ...c, author, replyTo };
    }),
  };
}

function extractJsonText(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return '';
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  return (fenced?.[1] || text).trim();
}

async function allocMonotonicVirtualTs(userId, scope = 'moments', baseHint = 0) {
  const key = `timeCursor_${userId || 'guest'}_${scope}`;
  const row = await db.get('settings', key);
  const prev = Number(row?.value || 0);
  const nowBase = Number(await getVirtualNow(userId || '', baseHint)) || 0;
  const next = Math.max(nowBase, prev + 30_000);
  await db.put('settings', { key, value: next });
  return next;
}

async function buildActorNameMap(ids = []) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  const map = new Map();
  for (const id of uniq) {
    map.set(id, await resolveChatParticipantName(id));
  }
  return map;
}

async function aiGenerateMomentReactions({ user, post, actorIds = [], allChats = [] }) {
  if (!user?.id || !post || !actorIds.length) return null;
  const names = await buildActorNameMap(actorIds);
  const actorLines = actorIds.map((id) => `${id}:${names.get(id) || id}`).join('；');
  const relatedMsgs = [];
  for (const chat of allChats.slice(0, 20)) {
    if (!Array.isArray(chat?.participants)) continue;
    if (!chat.participants.includes('user')) continue;
    const hit = actorIds.some((id) => chat.participants.includes(id));
    if (!hit) continue;
    const msgs = (await db.getAllByIndex('messages', 'chatId', chat.id))
      .filter((m) => !m.deleted && !m.recalled)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      .slice(-2)
      .map((m) => `${m.senderId === 'user' ? (user.name || '我') : (names.get(m.senderId) || m.senderName || m.senderId)}:${String(m.content || '').slice(0, 70)}`);
    relatedMsgs.push(...msgs);
    if (relatedMsgs.length >= 16) break;
  }
  const history = (post.comments || [])
    .slice(-8)
    .map((c) => `${c.author}:${c.replyTo ? `回复${c.replyTo} ` : ''}${c.text}`)
    .join('\n');
  const prompt = [
    '请生成朋友圈互动，必须只输出 JSON，不要解释。',
    `候选角色：${actorLines}`,
    `发圈人：${post.authorName || '好友'}`,
    `发圈内容：${String(post.content || '').slice(0, 320)}`,
    history ? `历史评论：\n${history}` : '历史评论：无',
    relatedMsgs.length ? `相关上下文：\n${relatedMsgs.join('\n')}` : '相关上下文：无',
    '规则：点赞人数 1-4；评论条数 1-4；评论口吻自然、有承接，允许简短回复；author 必须用角色 id。',
    'JSON schema: {"likes":["roleId"],"comments":[{"author":"roleId","text":"评论内容","replyTo":"可空,填写中文名"}]}',
  ].join('\n');
  const raw = await apiChat(
    [
      { role: 'system', content: '你是社交动态生成器。输出必须是严格 JSON，禁止输出代码块外文字。' },
      { role: 'user', content: prompt },
    ],
    { temperature: 0.85, maxTokens: 900 }
  );
  const parsed = JSON.parse(extractJsonText(raw));
  const likeIds = Array.isArray(parsed?.likes) ? parsed.likes.filter((x) => actorIds.includes(String(x))) : [];
  const comments = Array.isArray(parsed?.comments) ? parsed.comments : [];
  const normalizedComments = comments
    .map((c) => {
      const id = String(c?.author || '').trim();
      if (!actorIds.includes(id)) return null;
      const text = String(c?.text || '').trim().slice(0, 120);
      if (!text) return null;
      const replyTo = String(c?.replyTo || '').trim().slice(0, 24);
      return { author: names.get(id) || id, text, replyTo };
    })
    .filter(Boolean)
    .slice(0, 4);
  const normalizedLikes = [...new Set(likeIds)].map((id) => names.get(id) || id).slice(0, 4);
  return { likes: normalizedLikes, comments: normalizedComments };
}

async function aiGenerateMomentsBatch({ user, count, actorIds, allChats }) {
  const n = Math.max(3, Math.min(5, Number(count || 3)));
  const names = await buildActorNameMap(actorIds);
  const rolePool = actorIds.slice(0, 14).map((id) => `${id}:${names.get(id) || id}`).join('；');
  const samples = [];
  for (const c of allChats.slice(0, 12)) {
    const msgs = (await db.getAllByIndex('messages', 'chatId', c.id))
      .filter((m) => !m.deleted && !m.recalled)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      .slice(-2)
      .map((m) => String(m.content || '').slice(0, 70));
    samples.push(...msgs);
    if (samples.length >= 20) break;
  }
  const prompt = [
    `请生成 ${n} 条朋友圈动态，必须只输出 JSON。`,
    `角色池：${rolePool || '无可用角色'}`,
    `用户名：${user?.name || '旅行者'}`,
    samples.length ? `近期上下文：\n${samples.join('\n')}` : '近期上下文：无',
    '要求：每条包含 author(角色id)、content(10-70字)、mood(可空)、withImage(false即可)。避免模板句。',
    `JSON schema: {"posts":[{"author":"roleId","content":"文本","mood":"可空","withImage":false}]}`,
  ].join('\n');
  const raw = await apiChat(
    [
      { role: 'system', content: '你是朋友圈文案生成器。必须输出严格 JSON，不要任何额外说明。' },
      { role: 'user', content: prompt },
    ],
    { temperature: 0.9, maxTokens: 1600 }
  );
  const parsed = JSON.parse(extractJsonText(raw));
  const posts = Array.isArray(parsed?.posts) ? parsed.posts : [];
  return posts
    .map((p) => {
      const id = String(p?.author || '').trim();
      if (!actorIds.includes(id)) return null;
      const content = String(p?.content || '').trim().slice(0, 180);
      if (!content) return null;
      return { authorId: id, authorName: names.get(id) || id, content };
    })
    .filter(Boolean)
    .slice(0, n);
}

export default async function render(container) {
  const user = await getCurrentUser();
  const userId = user?.id || '';
  const prefsKey = `momentsPrefs_${userId || 'guest'}`;
  const momentsPrefs = (await db.get('settings', prefsKey))?.value || { coverImage: '', groups: ['战队', '同期', '亲友'] };
  const posts = (await db.getAll('momentsPosts')).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const allChats = userId ? await db.getAllByIndex('chats', 'userId', userId) : [];
  const contacts = allChats
    .filter((c) => c.type === 'private' && Array.isArray(c.participants))
    .map((c) => c.participants.find((p) => p !== 'user'))
    .filter(Boolean);
  const contactNameMap = await buildActorNameMap(contacts);

  const listHtml = posts
    .map((p) => {
      const viewPost = normalizeMomentForDisplay(p, contactNameMap);
      const av = p.avatar
        ? `<img src="${escapeAttr(p.avatar)}" alt="" class="moment-post-avatar-img" />`
        : `<span class="moment-post-avatar-emoji">${escapeHtml(p.authorEmoji || '👤')}</span>`;
      return `
      <article class="moment-post card-block" data-moment-id="${escapeAttr(p.id)}">
        <header class="moment-post-header">
          <div class="moment-post-avatar">${av}</div>
          <div>
            <div class="moment-post-name">${escapeHtml(viewPost.authorName || '好友')}</div>
            <div class="moment-post-time">${escapeHtml(formatTime(viewPost.timestamp || 0))}</div>
          </div>
        </header>
        <div class="moment-post-content">${escapeHtml(viewPost.content || '')}</div>
        ${renderMomentImages(viewPost.images)}
        ${commentsSection(viewPost)}
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
      <button type="button" class="navbar-btn moments-batch-ai" aria-label="批量生成">✦</button>
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
  container.querySelector('.moments-batch-ai')?.addEventListener('click', async () => {
    if (!userId) return;
    const actorIds = [...new Set(contacts)].slice(0, 16);
    if (!actorIds.length) {
      showToast('暂无可用角色，先建立私聊或群聊再试');
      return;
    }
    showToast('正在调用 API 生成朋友圈…');
    try {
      const amount = 3 + Math.floor(Math.random() * 3);
      const generated = await aiGenerateMomentsBatch({ user, count: amount, actorIds, allChats });
      if (!generated.length) {
        showToast('未生成有效内容');
        return;
      }
      for (const item of generated) {
        const ts = await allocMonotonicVirtualTs(userId, 'moments-post');
        await db.put('momentsPosts', {
          id: 'moment_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
          authorId: item.authorId,
          authorName: item.authorName,
          authorEmoji: '👤',
          avatar: null,
          content: item.content,
          images: [],
          timestamp: ts,
          visibility: 'all',
          visibleGroups: [],
          mentionIds: [],
          contextSnippet: '',
          likes: [],
          comments: [],
        });
      }
      showToast(`已生成 ${generated.length} 条朋友圈`);
      await render(container);
    } catch (e) {
      showToast(`生成失败：${e?.message || '未知错误'}`);
    }
  });
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
      const postTs = await allocMonotonicVirtualTs(userId, 'moments-post');
      const post = {
        id: 'moment_' + Date.now(),
        authorId: user?.id || 'guest',
        authorName: user?.name || '旅行者',
        authorEmoji: '👤',
        avatar: user?.avatar || null,
        content: text,
        images: pickedImages.slice(),
        timestamp: postTs,
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
      try {
        const p = await db.get('momentsPosts', id);
        if (!p) return;
        const actors = [...new Set(contacts)].slice(0, 8);
        if (!actors.length) return;
        if (!Array.isArray(p.likes)) p.likes = [];
        if (!Array.isArray(p.comments)) p.comments = [];
        showToast('正在生成评论与点赞…');
        const generated = await aiGenerateMomentReactions({ user, post: p, actorIds: actors, allChats });
        if (!generated) return;
        const likeSet = new Set((p.likes || []).map((x) => (typeof x === 'string' ? x : x.name || '')));
        for (const name of generated.likes || []) {
          if (!likeSet.has(name)) {
            p.likes.push(name);
            likeSet.add(name);
          }
        }
        for (const c of generated.comments || []) {
          p.comments.push(c);
        }
        await db.put('momentsPosts', p);
        if (Math.random() < 0.45) {
          const actor = actors[Math.floor(Math.random() * actors.length)];
          await triggerPrivateFromMoment(userId, actor, p);
        }
        await render(container);
      } catch (err) {
        showToast(`生成失败：${err?.message || '未知错误'}`);
      }
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
        const ts = await allocMonotonicVirtualTs(userId || '', 'moments-share');
        const msg = createMessage({
          chatId: target.id,
          senderId: 'user',
          type: 'chat-bundle',
          content: `moment://${id}`,
          metadata: {
            bundleTitle: `朋友圈分享 · ${post.authorName || '好友'}`,
            bundleSummary: String(post.content || '').slice(0, 80) || '查看朋友圈',
            source: '朋友圈',
            fromChatLabel: '朋友圈',
            bundleItems: [
              {
                senderName: post.authorName || '好友',
                type: 'text',
                content: String(post.content || '').slice(0, 300),
              },
            ],
          },
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
              lastActivity: await getVirtualNow(userId || '', 0),
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
      lastActivity: await getVirtualNow(userId, 0),
    });
    await db.put('chats', dm);
  }
  const ts = await getVirtualNow(userId, 0);
  const actorName = await resolveChatParticipantName(actorId);
  const msg = createMessage({
    chatId: dm.id,
    senderId: actorId,
    senderName: actorName,
    type: 'text',
    content: `看到你朋友圈那条了：${String(post.content || '').slice(0, 40)}${String(post.content || '').length > 40 ? '…' : ''}`,
    timestamp: ts,
  });
  await db.put('messages', msg);
  dm.lastMessage = msg.content.slice(0, 80);
  dm.lastActivity = ts;
  await db.put('chats', dm);
}
