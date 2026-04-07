import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { chatStream, chat as apiChat } from '../core/api.js';
import { assembleNovelContext } from '../core/context.js';
import { getState } from '../core/state.js';
import { createMemory } from '../models/memory.js';
import { showToast } from '../components/toast.js';

function openSceneModal(initial, onSave) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-modal-overlay>
      <div class="modal-sheet modal-sheet-tall" role="dialog" aria-modal="true" data-modal-sheet>
        <div class="modal-header">
          <h3>线下场景设定</h3>
          <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">✕</button>
        </div>
        <div class="modal-body">
          <textarea class="novel-scene-ta" rows="10" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);font-size:var(--font-sm);line-height:1.5;" placeholder="地点、天气、同行者状态、禁忌或目标…"></textarea>
          <button type="button" class="novel-scene-save" style="width:100%;margin-top:12px;padding:12px;background:var(--primary);color:var(--text-inverse);border:none;border-radius:var(--radius-md);font-weight:600;">保存</button>
        </div>
      </div>
    </div>
  `;
  const ta = host.querySelector('.novel-scene-ta');
  ta.value = initial || '';
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-modal-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-modal-overlay]')?.addEventListener('click', close);
  host.querySelector('.modal-close-btn')?.addEventListener('click', close);
  host.querySelector('.novel-scene-save')?.addEventListener('click', () => {
    onSave(ta.value);
    close();
  });
}

async function getUserId() {
  const r = await db.get('settings', 'currentUserId');
  return r?.value || '';
}

async function loadLifeSchedule(uid) {
  const row = await db.get('settings', `lifeSchedule_${uid}`);
  return row?.value || { virtualNow: Date.now(), todos: [], completed: [] };
}

async function saveLifeSchedule(uid, data) {
  await db.put('settings', { key: `lifeSchedule_${uid}`, value: data });
}

export default async function render(container, params = {}) {
  const stUser = getState('currentUser');
  const userId = stUser?.id || (await getUserId());
  if (!userId) {
    container.innerHTML = `<div class="placeholder-page"><div class="placeholder-text">请先选择用户档案</div></div>`;
    return;
  }

  const chatId = params.chatId || '';
  const characterIds = String(params.characterIds || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const draftKey = `offlineDraft_${userId}`;
  const sceneKey = `offlineScene_${userId}`;
  const prefsKey = `offlineGenPrefs_${userId}`;

  let draftRow = await db.get('settings', draftKey);
  let fullText = draftRow?.value?.text || '';
  let sceneRow = await db.get('settings', sceneKey);
  let sceneText = sceneRow?.value?.text || '';
  let prefsRow = await db.get('settings', prefsKey);
  let wordMin = Number(prefsRow?.value?.wordMin) || 200;
  let wordMax = Number(prefsRow?.value?.wordMax) || 450;

  container.classList.add('novel-page');
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.height = '100%';
  container.style.overflow = 'hidden';
  container.style.padding = '0';

  container.innerHTML = `
    <header class="navbar" style="flex-shrink:0;">
      <button type="button" class="navbar-btn novel-back" aria-label="返回">‹</button>
      <h1 class="navbar-title">线下相遇</h1>
      <span class="navbar-btn" style="visibility:hidden"></span>
    </header>
    <div class="text-hint" style="flex-shrink:0;padding:6px 16px;font-size:var(--font-xs);">
      ${characterIds.length ? `同行角色：${characterIds.length}人` : '未绑定角色（可从聊天详情发起）'} · 数据仅属于当前用户
    </div>
    <div class="novel-content" style="flex:1;min-height:0;overflow-y:auto;padding:16px;padding-bottom:calc(120px + var(--safe-bottom));white-space:pre-wrap;"></div>
    <div class="novel-toolbar" style="flex-shrink:0;flex-wrap:wrap;gap:8px;">
      <label style="flex:1;min-width:120px;font-size:var(--font-xs);display:flex;align-items:center;gap:6px;">
        字数 <input type="number" class="off-wmin" value="${wordMin}" min="80" max="2000" style="width:52px;" />-<input type="number" class="off-wmax" value="${wordMax}" min="100" max="4000" style="width:52px;" />
      </label>
      <button type="button" class="novel-continue" style="flex:1;min-width:100px;padding:10px;background:var(--primary);color:var(--text-inverse);border-radius:var(--radius-md);font-size:var(--font-sm);font-weight:600;">继续生成</button>
      <button type="button" class="novel-end" style="flex:1;min-width:100px;padding:10px;background:#e8a87c;color:#fff;border:none;border-radius:var(--radius-md);font-size:var(--font-sm);font-weight:600;">结束并总结</button>
      <button type="button" class="novel-phone" style="flex:1;min-width:80px;padding:10px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);font-size:var(--font-sm);">手机</button>
      <button type="button" class="novel-scene" style="flex:1;min-width:80px;padding:10px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);font-size:var(--font-sm);">场景</button>
    </div>
  `;

  const contentEl = container.querySelector('.novel-content');
  const setDisplayText = (t) => {
    contentEl.textContent = t;
    contentEl.scrollTop = contentEl.scrollHeight;
  };
  setDisplayText(fullText);

  async function persistDraft() {
    await db.put('settings', { key: draftKey, value: { text: fullText } });
  }

  async function persistPrefs() {
    wordMin = Math.max(50, parseInt(container.querySelector('.off-wmin')?.value || String(wordMin), 10) || wordMin);
    wordMax = Math.max(wordMin, parseInt(container.querySelector('.off-wmax')?.value || String(wordMax), 10) || wordMax);
    await db.put('settings', { key: prefsKey, value: { wordMin, wordMax } });
  }

  container.querySelector('.off-wmin')?.addEventListener('change', persistPrefs);
  container.querySelector('.off-wmax')?.addEventListener('change', persistPrefs);

  let streaming = false;

  async function runContinue() {
    if (streaming) return;
    await persistPrefs();
    streaming = true;
    const btn = container.querySelector('.novel-continue');
    btn.style.opacity = '0.5';

    const messages = await assembleNovelContext(sceneText, fullText.trim() || null, {
      chatId,
      characterIds,
      wordMin,
      wordMax,
    });

    const divider = fullText.trim() ? '\n\n' : '';
    const snapshot = fullText;
    fullText += divider;
    setDisplayText(fullText + '…');

    try {
      let acc = '';
      await chatStream(
        messages,
        (delta, text) => {
          acc = text;
          setDisplayText(snapshot + divider + acc);
        },
        { maxTokens: Math.min(4096, Math.ceil(wordMax * 2.5)) }
      );
      fullText = snapshot + divider + acc;
      setDisplayText(fullText);
      await persistDraft();
    } catch (e) {
      window.alert(e.message || String(e));
      fullText = snapshot;
      setDisplayText(fullText);
    } finally {
      streaming = false;
      btn.style.opacity = '1';
    }
  }

  async function endAndArchive() {
    if (!fullText.trim()) {
      showToast('还没有正文，无法总结');
      return;
    }
    if (!window.confirm('结束本次线下相遇？将生成约100字摘要写入「此时此刻」已完成，并写入相关角色记忆（按当前用户隔离）。')) return;
    try {
      const user = getState('currentUser') || (await db.get('users', userId));
      const season = user?.currentTimeline || 'S8';
      const raw = await apiChat(
        [
          { role: 'system', content: '只输出一段中文剧情摘要，严格100字以内，不要标题、标号、引号包裹全文。' },
          { role: 'user', content: `概括以下「线下相遇」正文的关键情节与情绪结果：\n${fullText.slice(-12000)}` },
        ],
        { temperature: 0.2, maxTokens: 400 }
      );
      const summary = String(raw || '').trim().slice(0, 120);
      if (!summary) {
        showToast('摘要生成失败');
        return;
      }

      const life = await loadLifeSchedule(userId);
      if (typeof life.virtualNow !== 'number') life.virtualNow = Date.now();
      life.completed = [
        ...(life.completed || []),
        {
          id: 'off_done_' + Date.now(),
          title: '线下相遇',
          summary,
          at: life.virtualNow,
          characterIds: [...characterIds],
          chatId,
          season,
          type: 'offline',
        },
      ];
      await saveLifeSchedule(userId, life);

      for (const cid of characterIds) {
        await db.put(
          'memories',
          createMemory({
            userId,
            chatId,
            characterId: cid,
            type: 'event',
            content: `【线下相遇】${summary}`,
            source: 'offline-summary',
          })
        );
      }

      fullText = '';
      await db.put('settings', { key: draftKey, value: { text: '' } });
      setDisplayText('');
      showToast('已归档到日程与记忆');
      navigate('now-moment');
    } catch (e) {
      showToast(`归档失败：${e.message || e}`);
    }
  }

  container.querySelector('.novel-back').addEventListener('click', () => back());
  container.querySelector('.novel-continue').addEventListener('click', () => runContinue());
  container.querySelector('.novel-end').addEventListener('click', () => endAndArchive());
  container.querySelector('.novel-phone').addEventListener('click', () => navigate('chat-list'));
  container.querySelector('.novel-scene').addEventListener('click', () => {
    openSceneModal(sceneText, async (v) => {
      sceneText = v;
      await db.put('settings', { key: sceneKey, value: { text: v } });
    });
  });
}
