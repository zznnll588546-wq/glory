import { back } from '../core/router.js';
import * as db from '../core/db.js';
import { chat as apiChat } from '../core/api.js';
import { MEMORY_TYPES, createMemory } from '../models/memory.js';
import { CHARACTERS } from '../data/characters.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function formatTime(ts) {
  return new Date(ts || Date.now()).toLocaleString('zh-CN');
}

async function loadPrefs() {
  const row = await db.get('settings', 'memoryManagerPrefs');
  return row?.value || { option: 1, messageCount: 200, selectedChatId: '' };
}

async function savePrefs(prefs) {
  await db.put('settings', { key: 'memoryManagerPrefs', value: prefs });
}

async function getCurrentUserId() {
  const row = await db.get('settings', 'currentUserId');
  return row?.value ?? null;
}

function resolveCharacterName(id) {
  const c = CHARACTERS.find((x) => x.id === id);
  return c?.name || id;
}

export default async function render(container) {
  let prefs = await loadPrefs();
  const userId = await getCurrentUserId();
  const chats = userId
    ? await db.getAllByIndex('chats', 'userId', userId)
    : await db.getAll('chats');

  if (!prefs.selectedChatId && chats.length) prefs.selectedChatId = chats[0].id;

  container.classList.add('memory-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn mem-back" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">记忆管理</h1>
      <span class="navbar-btn" style="visibility:hidden"></span>
    </header>
    <div class="page-scroll" style="padding-top:12px;">
      <p style="font-size:var(--font-xs);color:var(--text-hint);padding:0 4px 12px;line-height:1.5;">
        记忆按聊天窗口隔离，每条记忆可绑定特定角色，防止信息跨角色泄漏。
      </p>
      <div class="card-block">
        <div class="settings-item-label" style="margin-bottom:8px;">选择会话</div>
        <select class="form-input mem-chat-select"></select>
      </div>
      <div class="card-block mem-scheme-section">
        <div class="settings-item-label" style="margin-bottom:10px;">记忆方案</div>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:var(--font-sm);">
          <input type="radio" name="mem-opt" value="1" class="mem-opt-radio" />
          选项 1：记忆表格（手动管理）
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:var(--font-sm);">
          <input type="radio" name="mem-opt" value="2" class="mem-opt-radio" />
          选项 2：API总结（自动摘要当前窗口）
        </label>
      </div>
      <div class="mem-panel-opt1"></div>
      <div class="mem-panel-opt2" style="display:none;"></div>
    </div>
  `;

  const chatSelect = container.querySelector('.mem-chat-select');
  const radios = container.querySelectorAll('.mem-opt-radio');
  const panel1 = container.querySelector('.mem-panel-opt1');
  const panel2 = container.querySelector('.mem-panel-opt2');

  chatSelect.innerHTML = chats.length === 0
    ? `<option value="">暂无会话</option>`
    : chats.map((c) => {
        const label = c.groupSettings?.name || c.lastMessage?.slice(0, 20) || c.id;
        return `<option value="${escapeAttr(c.id)}">${escapeHtml(label)}</option>`;
      }).join('');

  if (prefs.selectedChatId) chatSelect.value = prefs.selectedChatId;

  function syncRadio() {
    radios.forEach((r) => { r.checked = String(r.value) === String(prefs.option); });
  }
  syncRadio();

  async function persist() {
    prefs.selectedChatId = chatSelect.value;
    prefs.option = [...radios].find((r) => r.checked)?.value === '2' ? 2 : 1;
    await savePrefs(prefs);
  }

  function getParticipants() {
    const chat = chats.find((c) => c.id === chatSelect.value);
    return (chat?.participants || []).filter((p) => p && p !== 'user');
  }

  async function renderOpt1() {
    const chatId = chatSelect.value;
    let list = chatId ? await db.getAllByIndex('memories', 'chatId', chatId) : [];
    list = [...list].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const byType = {};
    for (const t of Object.keys(MEMORY_TYPES)) byType[t] = [];
    for (const m of list) {
      const t = m.type in MEMORY_TYPES ? m.type : 'event';
      byType[t].push(m);
    }

    let html = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin:12px 0 8px;">
        <span class="settings-item-label">记忆条目（共${list.length}条）</span>
        <button type="button" class="btn btn-primary btn-sm mem-add-btn">+ 新增记忆</button>
      </div>`;

    for (const type of Object.keys(MEMORY_TYPES)) {
      const rows = byType[type];
      if (!rows.length) continue;
      html += `<div style="font-size:var(--font-xs);color:var(--primary);font-weight:600;padding:8px 0 4px;">${escapeHtml(MEMORY_TYPES[type])}</div>`;
      for (const m of rows) {
        const charLabel = m.characterId ? resolveCharacterName(m.characterId) : '全局/共享';
        html += `
        <div class="memory-entry card-block" style="margin-bottom:8px;" data-mem-id="${escapeAttr(m.id)}">
          <div class="memory-entry-type">${escapeHtml(MEMORY_TYPES[m.type] || m.type)}</div>
          <div class="memory-entry-content" style="margin:4px 0;">${escapeHtml(m.content || '')}</div>
          <div style="font-size:var(--font-xs);color:var(--text-hint);">关联角色：${escapeHtml(charLabel)} · ${escapeHtml(formatTime(m.timestamp))}</div>
          <div style="margin-top:8px;display:flex;gap:8px;">
            <button type="button" class="btn btn-outline btn-sm mem-edit-btn" data-id="${escapeAttr(m.id)}">编辑</button>
            <button type="button" class="btn btn-outline btn-sm mem-del-btn" data-id="${escapeAttr(m.id)}" style="color:var(--red);">删除</button>
          </div>
        </div>`;
      }
    }

    if (!list.length) {
      html += `<div class="text-hint" style="padding:24px 0;text-align:center;">当前会话暂无记忆条目</div>`;
    }

    panel1.innerHTML = html;

    panel1.querySelector('.mem-add-btn')?.addEventListener('click', async () => {
      if (!chatSelect.value) return;
      const participants = getParticipants();
      const charOptions = participants.map((id) => `<option value="${escapeAttr(id)}">${escapeHtml(resolveCharacterName(id))}</option>`).join('');

      const host = document.getElementById('modal-container');
      if (!host) return;
      host.classList.add('active');
      host.innerHTML = `
        <div class="modal-overlay" data-modal-overlay>
          <div class="modal-sheet" role="dialog" aria-modal="true" data-modal-sheet>
            <div class="modal-header">
              <h3>新增记忆</h3>
              <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">${icon('close')}</button>
            </div>
            <div class="modal-body">
              <div class="form-group">
                <label class="form-label">类型</label>
                <select class="form-input mem-new-type">
                  ${Object.entries(MEMORY_TYPES).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">关联角色（留空=全局共享）</label>
                <select class="form-input mem-new-char">
                  <option value="">全局/共享</option>
                  ${charOptions}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">内容</label>
                <textarea class="form-textarea mem-new-content" placeholder="描述这条记忆"></textarea>
              </div>
              <button type="button" class="btn btn-primary btn-block mem-new-save">保存</button>
            </div>
          </div>
        </div>
      `;
      const close = () => { host.classList.remove('active'); host.innerHTML = ''; };
      host.querySelector('[data-modal-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
      host.querySelector('[data-modal-overlay]')?.addEventListener('click', close);
      host.querySelector('.modal-close-btn')?.addEventListener('click', close);
      host.querySelector('.mem-new-save')?.addEventListener('click', async () => {
        const type = host.querySelector('.mem-new-type')?.value || 'event';
        const characterId = host.querySelector('.mem-new-char')?.value || '';
        const content = host.querySelector('.mem-new-content')?.value?.trim();
        if (!content) { showToast('请填写记忆内容'); return; }
        const mem = createMemory({ chatId: chatSelect.value, characterId, type, content, source: 'manual' });
        await db.put('memories', mem);
        close();
        await renderOpt1();
        showToast('记忆已保存');
      });
    });

    panel1.querySelectorAll('.mem-edit-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const m = await db.get('memories', btn.dataset.id);
        if (!m) return;
        const next = window.prompt('编辑内容', m.content || '');
        if (next == null) return;
        m.content = next;
        await db.put('memories', m);
        await renderOpt1();
      });
    });

    panel1.querySelectorAll('.mem-del-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm('删除这条记忆？')) return;
        await db.del('memories', btn.dataset.id);
        await renderOpt1();
      });
    });
  }

  async function renderOpt2() {
    const chatId = chatSelect.value;
    const n = prefs.messageCount || 200;

    panel2.innerHTML = `
      <div class="card-block" style="margin-top:12px;">
        <label class="form-label" style="display:block;margin-bottom:6px;">最近消息条数（用于生成摘要）</label>
        <input type="number" class="form-input mem-msg-count" min="1" max="2000" value="${n}" />
        <div class="text-hint" style="margin-top:8px;">将调用 API 对当前聊天窗口的最近 N 条消息进行摘要，结果存为记忆条目。</div>
        <button type="button" class="btn btn-primary btn-block mem-gen-btn" style="margin-top:12px;">生成总结</button>
        <div class="mem-gen-status" style="margin-top:8px;font-size:var(--font-sm);color:var(--text-secondary);"></div>
      </div>
    `;

    const countInput = panel2.querySelector('.mem-msg-count');
    const genBtn = panel2.querySelector('.mem-gen-btn');
    const statusEl = panel2.querySelector('.mem-gen-status');

    genBtn.addEventListener('click', async () => {
      const num = parseInt(countInput.value, 10) || 200;
      if (!chatId) { showToast('请先选择会话'); return; }
      genBtn.disabled = true;
      statusEl.textContent = '正在拉取消息并调用 API…';

      try {
        const allMessages = await db.getAllByIndex('messages', 'chatId', chatId);
        const sorted = [...allMessages]
          .filter((m) => !m.deleted && !m.recalled)
          .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
          .slice(-num);

        if (sorted.length === 0) {
          statusEl.textContent = '当前会话没有可总结的消息。';
          genBtn.disabled = false;
          return;
        }

        const textBlock = sorted.map((m) => {
          const sender = m.senderId === 'user' ? '用户' : (m.senderName || m.senderId);
          return `[${sender}]: ${m.content || ''}`;
        }).join('\n');

        const summaryPrompt = [
          { role: 'system', content: '你是一个专业的对话摘要助手。请将以下聊天记录总结为简洁的事件要点列表，每个要点一行，使用"- "开头。只总结关键事件、关系变化、约定和重要细节，不要添加评论。输出中文。' },
          { role: 'user', content: `以下是最近${sorted.length}条聊天记录，请总结：\n\n${textBlock}` },
        ];

        statusEl.textContent = `正在总结 ${sorted.length} 条消息…`;
        const result = await apiChat(summaryPrompt, { temperature: 0.3, maxTokens: 1024 });

        if (!result || !result.trim()) {
          statusEl.textContent = 'API 返回为空，请检查配置。';
          genBtn.disabled = false;
          return;
        }

        const mem = createMemory({
          chatId,
          characterId: '',
          type: 'summary',
          content: result.trim(),
          source: 'api-summary',
        });
        await db.put('memories', mem);
        statusEl.textContent = '总结完成并已存为记忆条目。';
        showToast('总结已生成');
      } catch (e) {
        statusEl.textContent = `总结失败：${e.message || e}`;
      } finally {
        genBtn.disabled = false;
      }
    });

    countInput.addEventListener('change', async () => {
      prefs.messageCount = parseInt(countInput.value, 10) || 200;
      await savePrefs(prefs);
    });
  }

  async function refreshPanels() {
    await persist();
    if (prefs.option === 2) {
      panel1.style.display = 'none';
      panel2.style.display = 'block';
      await renderOpt2();
    } else {
      panel1.style.display = 'block';
      panel2.style.display = 'none';
      await renderOpt1();
    }
  }

  chatSelect.addEventListener('change', () => refreshPanels());
  radios.forEach((r) =>
    r.addEventListener('change', async () => {
      prefs.option = r.value === '2' ? 2 : 1;
      await savePrefs(prefs);
      await refreshPanels();
    })
  );

  container.querySelector('.mem-back').addEventListener('click', () => back());
  await refreshPanels();
}
