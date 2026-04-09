import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { CHARACTERS } from '../data/characters.js';
import { TEAMS } from '../data/teams.js';
import { createMessage } from '../models/chat.js';
import { createMemory, MEMORY_TYPES } from '../models/memory.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { getCharacterStateForSeason, getDisplayTeamName } from '../core/chat-helpers.js';
import { getState } from '../core/state.js';
import { estimateChatTokens } from '../core/context.js';
import { maybeSummarizeChatMemory } from '../core/chat-summary.js';
import { getVirtualNow } from '../core/virtual-time.js';

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

async function getCurrentUserId() {
  const row = await db.get('settings', 'currentUserId');
  return row?.value ?? null;
}

function resolveName(id) {
  if (!id || id === 'user') return '我';
  const c = CHARACTERS.find((x) => x.id === id);
  return c?.name || id;
}

async function loadChatPrefs(chatId) {
  const row = await db.get('settings', `chatPrefs_${chatId}`);
  return row?.value || {
    contextDepth: 200,
    innerVoiceInjectLimit: 2,
    autoSummary: false,
    autoSummaryFreq: 200,
    customSummaryPrompt: '',
    customGroupSummaryPrompt: '',
    linkedContextLimit: 100,
    linkedContextScope: 'loose',
  };
}

async function saveChatPrefs(chatId, prefs) {
  await db.put('settings', { key: `chatPrefs_${chatId}`, value: prefs });
}

async function getAiOpsDebugEnabled() {
  const row = await db.get('settings', 'aiOpsDebugEnabled');
  return !!row?.value;
}

async function setAiOpsDebugEnabled(v) {
  await db.put('settings', { key: 'aiOpsDebugEnabled', value: !!v });
}

export default async function render(container, params) {
  const chatId = params?.chatId;
  if (!chatId) { container.innerHTML = '<div class="placeholder-page"><div class="placeholder-text">缺少会话</div></div>'; return; }

  let chat = await db.get('chats', chatId);
  if (!chat) { container.innerHTML = '<div class="placeholder-page"><div class="placeholder-text">会话不存在</div></div>'; return; }

  const userId = await getCurrentUserId();
  const currentUser = getState('currentUser');
  const season = currentUser?.currentTimeline || 'S8';
  const isGroup = chat.type === 'group';
  const gs = chat.groupSettings || {};
  const participants = (chat.participants || []).filter(Boolean);
  const isUserInGroup = participants.includes('user');
  const aiMembers = participants.filter((p) => p !== 'user');
  let prefs = await loadChatPrefs(chatId);
  const aiOpsDebugEnabled = await getAiOpsDebugEnabled();

  const partnerName = isGroup
    ? (gs.name || aiMembers.slice(0, 3).map(resolveName).join('、'))
    : resolveName(aiMembers[0]);

  container.classList.add('chat-details-page');

  async function fullRender() {
    chat = await db.get('chats', chatId) || chat;
    const blocked = !!chat.blocked;
    const memories = await db.getAllByIndex('memories', 'chatId', chatId);
    const memFiltered = memories.filter((m) => !m.userId || m.userId === userId);
    const tokenStat = await estimateChatTokens(chatId, aiMembers, prefs.contextDepth || 200);
    const allChats = userId ? await db.getAllByIndex('chats', 'userId', userId) : [];
    const peerRoleIds = new Set(aiMembers);
    const linkageGroups = allChats
      .filter(
        (c) =>
          c.type === 'group'
          && c.id !== chatId
          && (c.participants || []).some((p) => peerRoleIds.has(p)),
      )
      .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    const validLinkageIds = new Set(linkageGroups.map((g) => g.id));
    const rawLinkage = gs.linkageTargetGroupIds || [];
    const prunedLinkage = rawLinkage.filter((id) => validLinkageIds.has(id));
    if (prunedLinkage.length !== rawLinkage.length) {
      gs.linkageTargetGroupIds = prunedLinkage;
      chat.groupSettings = gs;
      await db.put('chats', chat);
    }
    const selectedGroupIds = new Set(gs.linkageTargetGroupIds || []);
    const linkageGroupHint = linkageGroups
      .filter((g) => selectedGroupIds.has(g.id))
      .slice(0, 4)
      .map((g) => g.groupSettings?.name || '群聊')
      .join('、');
    const selectedMemberIds = new Set(gs.linkagePrivateMemberIds || []);
    const linkageMemberHint = participants
      .filter((id) => id !== 'user' && selectedMemberIds.has(id))
      .slice(0, 6)
      .map((id) => resolveName(id))
      .join('、');
    const linkageModeLabel =
      gs.linkageMode === 'rant' ? '吐槽' : gs.linkageMode === 'auto' ? '自动' : '通知';
    const linkedScopeLabel = String(prefs.linkedContextScope || 'loose') === 'strict' ? '严格（仅强关联）' : '宽松（默认）';

    let groupSection = '';
    if (isGroup) {
      const memberHtml = await Promise.all(participants.map(async (id) => {
        const name = resolveName(id);
        const isOwner = gs.owner === id;
        const isAdmin = (gs.admins || []).includes(id);
        const badge = isOwner ? '群主' : isAdmin ? '管理' : '';
        return `<div class="gi-member"><div class="avatar avatar-sm"><span>${escapeHtml(name.slice(0, 1))}</span></div><div class="gi-member-name">${escapeHtml(name)}${badge ? ` <span class="gi-badge">${badge}</span>` : ''}</div></div>`;
      }));

      groupSection = `
        <div class="cd-section">
          <div class="cd-section-title">群成员 (${participants.length}人)</div>
          <div class="gi-member-grid">${memberHtml.join('')}</div>
          <div class="cd-setting-row" style="margin-top:8px;cursor:pointer;" data-act="add-member">
            <span class="cd-setting-label">+ 邀请成员</span>
          </div>
        </div>
        <div class="cd-section">
          <div class="cd-section-title">群设置</div>
          <div class="cd-setting-row" data-act="rename"><span class="cd-setting-label">群名称</span><span class="cd-setting-value">${escapeHtml(gs.name || '未命名')} ›</span></div>
          <div class="cd-setting-row" data-act="announcement"><span class="cd-setting-label">群公告</span><span class="cd-setting-value">${escapeHtml((gs.announcement || '未设置').slice(0, 20))} ›</span></div>
          <div class="cd-setting-row" data-act="plot"><span class="cd-setting-label">剧情推进提示</span><span class="cd-setting-value">${escapeHtml((gs.plotDirective || '未设置').slice(0, 20))} ›</span></div>
          <div class="cd-setting-row" data-act="observer"><span class="cd-setting-label">旁观者模式</span><div class="toggle${gs.isObserverMode ? ' on' : ''}"></div></div>
          <div class="cd-setting-row" data-act="pm-trigger"><span class="cd-setting-label">群聊触发私聊</span><div class="toggle${gs.allowPrivateTrigger ? ' on' : ''}"></div></div>
          <div class="cd-setting-row" data-act="set-owner"><span class="cd-setting-label">转让群主</span><span class="cd-setting-value">${escapeHtml(resolveName(gs.owner))} ›</span></div>
          <div class="cd-setting-row" data-act="set-admin"><span class="cd-setting-label">设置管理员</span><span class="cd-setting-value">›</span></div>
          <div class="cd-setting-row" data-act="kick"><span class="cd-setting-label">踢出成员</span><span class="cd-setting-value">›</span></div>
        </div>
      `;
    }

    const linkageGroupOptions = linkageGroups.map((g) => `
      <label style="display:flex;align-items:center;gap:8px;padding:4px 0;">
        <input type="checkbox" class="cd-linkage-group-cb" value="${escapeAttr(g.id)}" ${selectedGroupIds.has(g.id) ? 'checked' : ''} />
        <span>${escapeHtml(g.groupSettings?.name || '群聊')}</span>
        <span class="text-hint" style="margin-left:auto;">${escapeHtml(g.id)}</span>
      </label>
    `).join('') || '<div class="text-hint">暂无可选目标群</div>';
    const linkageMemberOptions = participants
      .filter((id) => id !== 'user')
      .map((id) => `
      <label style="display:flex;align-items:center;gap:8px;padding:4px 0;">
        <input type="checkbox" class="cd-linkage-member-cb" value="${escapeAttr(id)}" ${selectedMemberIds.has(id) ? 'checked' : ''} />
        <span>${escapeHtml(resolveName(id))}</span>
        <span class="text-hint" style="margin-left:auto;">${escapeHtml(id)}</span>
      </label>
    `).join('');

    const linkageSection = `
      <div class="cd-section">
        <div class="cd-section-title">联动目标细化</div>
        <div class="cd-setting-row cd-act" data-act="toggle-custom-linkage">
          <span class="cd-setting-label">使用自定义目标群</span>
          <div class="toggle${gs.useCustomLinkageTargets ? ' on' : ''}"></div>
        </div>
        <div class="cd-setting-row cd-act" data-act="linkage-mode">
          <span class="cd-setting-label">联动类型</span>
          <span class="cd-setting-value">${escapeHtml(linkageModeLabel)} ›</span>
        </div>
        <div class="cd-setting-row"><span class="cd-setting-label">${isGroup ? '群聊联动目标群' : '私聊触发目标群'}</span><span class="cd-setting-value">${escapeHtml(linkageGroupHint || '未指定（随机）')}</span></div>
        <details style="margin-top:8px;">
          <summary style="cursor:pointer;color:var(--text-secondary);">下拉选择目标群（可多选）</summary>
          <div style="margin-top:8px;max-height:180px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px 10px;">${linkageGroupOptions}</div>
          <button type="button" class="btn btn-sm btn-outline cd-save-linkage-groups" style="margin-top:8px;">保存目标群</button>
        </details>
        <div class="text-hint" style="padding:0 2px 8px;">可多选；可选你在群里的公共群（用于新话题/通知）与无你在场的小群（关系网吐槽）。联动类型选「自动」时，由角色在回复末尾输出 [联动风格:通知] 或 [联动风格:吐槽]（单独一行）决定走向；该行不展示给用户。未写时按通知向处理。</div>
        ${isGroup ? `
        <div class="cd-setting-row"><span class="cd-setting-label">群触发私聊角色</span><span class="cd-setting-value">${escapeHtml(linkageMemberHint || '未指定（群内角色均可）')}</span></div>
        <details style="margin-top:8px;">
          <summary style="cursor:pointer;color:var(--text-secondary);">下拉选择成员（可多选）</summary>
          <div style="margin-top:8px;max-height:180px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px 10px;">${linkageMemberOptions || '<div class="text-hint">暂无可选成员</div>'}</div>
          <button type="button" class="btn btn-sm btn-outline cd-save-linkage-members" style="margin-top:8px;">保存成员设置</button>
        </details>
        <div class="text-hint" style="padding:0 2px 8px;">仅被勾选的成员会触发“群聊 -> 私聊联动”。</div>
        ` : ''}
      </div>
    `;

    const summaryMems = memFiltered
      .filter((m) => m.type === 'summary')
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 12);
    const summaryHtml = summaryMems.map((m) => {
      const charLabel = m.characterId ? resolveName(m.characterId) : '全局';
      return `<div class="cd-setting-row" style="flex-direction:column;align-items:stretch;gap:4px;" data-mem-id="${escapeAttr(m.id)}">
        <div style="display:flex;justify-content:space-between;"><span style="font-weight:500;">[总结] ${escapeHtml(charLabel)}</span><span class="text-hint">${new Date(m.timestamp || Date.now()).toLocaleString('zh-CN')}</span></div>
        <div style="font-size:var(--font-xs);color:var(--text-secondary);white-space:pre-wrap;">${escapeHtml((m.content || '').slice(0, 220))}</div>
      </div>`;
    }).join('') || '<div class="text-hint" style="padding:12px 0;">暂无总结记忆</div>';

    const memoryHtml = memFiltered.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 20).map((m) => {
      const charLabel = m.characterId ? resolveName(m.characterId) : '全局';
      return `<div class="cd-setting-row" style="flex-direction:column;align-items:stretch;gap:4px;" data-mem-id="${escapeAttr(m.id)}">
        <div style="display:flex;justify-content:space-between;"><span style="font-weight:500;">[${escapeHtml(MEMORY_TYPES[m.type] || m.type)}] ${escapeHtml(charLabel)}</span><button class="cd-mem-del" data-id="${escapeAttr(m.id)}" style="color:var(--red);font-size:var(--font-xs);background:none;border:none;">删除</button></div>
        <div style="font-size:var(--font-xs);color:var(--text-secondary);">${escapeHtml((m.content || '').slice(0, 100))}</div>
      </div>`;
    }).join('') || '<div class="text-hint" style="padding:12px 0;">暂无记忆条目</div>';

    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn cd-back" aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">${isGroup ? '聊天信息' : '聊天设定'}</h1>
        <span class="navbar-btn" style="visibility:hidden"></span>
      </header>
      <div class="page-scroll" style="padding-bottom:24px;">
        ${groupSection}
        ${linkageSection}
        <div class="cd-section">
          <div class="cd-section-title">记忆卡片</div>
          <div class="cd-setting-row"><span class="cd-setting-label">估算输入 tokens</span><span class="cd-setting-value">约 ${tokenStat.estimatedInputTokens} tok</span></div>
          <div class="text-hint" style="padding:0 2px 8px;">按当前上下文深度和系统提示词估算，仅作参考。</div>
          <div class="cd-setting-row"><span class="cd-setting-label">上下文深度</span><input type="number" class="cd-context-depth" value="${prefs.contextDepth}" min="10" max="2000" style="width:60px;text-align:center;border:1px solid var(--border);border-radius:6px;padding:4px;" /> <span style="font-size:var(--font-xs);color:var(--text-hint);">条</span></div>
          <div class="cd-setting-row"><span class="cd-setting-label">注入心声条数</span><input type="number" class="cd-inner-voice-limit" value="${Math.max(0, Math.min(8, Number(prefs.innerVoiceInjectLimit ?? 2) || 0))}" min="0" max="8" style="width:60px;text-align:center;border:1px solid var(--border);border-radius:6px;padding:4px;" /> <span style="font-size:var(--font-xs);color:var(--text-hint);">条（默认2，0=关闭）</span></div>
          <div class="cd-setting-row"><span class="cd-setting-label">群聊关联上下文</span><input type="number" class="cd-linked-context-limit" value="${Number(prefs.linkedContextLimit ?? 100)}" min="0" max="300" style="width:60px;text-align:center;border:1px solid var(--border);border-radius:6px;padding:4px;" /> <span style="font-size:var(--font-xs);color:var(--text-hint);">条（0=关闭）</span></div>
          <div class="cd-setting-row cd-act" data-act="linked-context-scope"><span class="cd-setting-label">关联范围</span><span class="cd-setting-value">${escapeHtml(linkedScopeLabel)} ›</span></div>
          <div class="cd-setting-row"><span class="cd-setting-label">自动总结</span><div class="toggle cd-auto-summary${prefs.autoSummary ? ' on' : ''}"></div></div>
          <div class="cd-setting-row"><span class="cd-setting-label">自动总结频率</span><input type="number" class="cd-auto-freq" value="${prefs.autoSummaryFreq}" min="50" max="2000" style="width:60px;text-align:center;border:1px solid var(--border);border-radius:6px;padding:4px;" /> <span style="font-size:var(--font-xs);color:var(--text-hint);">条</span></div>
          <div class="cd-setting-row" style="flex-direction:column;align-items:stretch;gap:6px;">
            <span class="cd-setting-label">${isGroup ? '群聊总结附加要求' : '私聊总结附加要求'}</span>
            ${isGroup
    ? `<textarea class="form-textarea cd-group-summary-prompt" rows="4" placeholder="例如：必须写出每个角色原话要点、谁@了谁、群内昵称与真名对应…">${escapeHtml(prefs.customGroupSummaryPrompt || '')}</textarea>
            <div class="text-hint">仅作用于本群自动/手动总结，与私聊分离。不影响【全局】/【角色:ID】块结构。</div>`
    : `<textarea class="form-textarea cd-summary-prompt" rows="3" placeholder="例如：使用第一人称叙述、重点记录情感变化、以小说风格撰写…">${escapeHtml(prefs.customSummaryPrompt || '')}</textarea>
            <div class="text-hint">仅作用于私聊总结。群聊请在对应群 → 右上角「记忆」进入本页填写「群聊总结附加要求」。</div>`}
          </div>
          <div class="cd-primary-btn cd-generate-summary">立即总结</div>
          <div class="text-hint" style="text-align:center;">${isGroup ? '总结写入本群记忆，续写本群时会按会话注入。' : '总结写入本会话记忆，私聊与线下等场景按规则复用。'}</div>
        </div>
        <div class="cd-section">
          <div class="cd-section-title">记忆条目 (${memFiltered.length}条)</div>
          ${memoryHtml}
          <div class="cd-primary-btn cd-add-memory" style="margin-top:8px;">+ 新增记忆</div>
        </div>
        <div class="cd-section">
          <div class="cd-section-title">已总结记忆 (${summaryMems.length}条)</div>
          ${summaryHtml}
        </div>
        <div class="cd-section">
          <div class="cd-section-title">线下相遇</div>
          <div class="text-hint" style="padding:0 2px 8px;">日程与钟表在主页「此时此刻」。此处仅绑定本聊天；每个用户档案数据独立。</div>
          <div class="cd-setting-row cd-act" data-act="offline-ai">
            <span class="cd-setting-label">允许 AI 主动提议线下</span>
            <div class="toggle${gs.allowAiOfflineInvite ? ' on' : ''}"></div>
          </div>
          <div class="cd-setting-row cd-act" data-act="ai-group-ops">
            <span class="cd-setting-label">允许 AI 拉群/邀请/禁言</span>
            <div class="toggle${gs.allowAiGroupOps ? ' on' : ''}"></div>
          </div>
          <div class="cd-primary-btn cd-offline-start">发起线下邀约（进入场景）</div>
        </div>
        <div class="cd-section">
          <div class="cd-section-title">操作</div>
          <div class="cd-setting-row cd-act" data-act="social-linkage">
            <span class="cd-setting-label">社交平台自动联动</span>
            <div class="toggle${gs.allowSocialLinkage !== false ? ' on' : ''}"></div>
          </div>
          <div class="cd-setting-row cd-act" data-act="wrong-send">
            <span class="cd-setting-label">错群/错窗事件</span>
            <div class="toggle${gs.allowWrongSend !== false ? ' on' : ''}"></div>
          </div>
          <div class="cd-setting-row cd-act" data-act="debug-ai-ops">
            <span class="cd-setting-label">调试：显示群操作触发来源</span>
            <div class="toggle${aiOpsDebugEnabled ? ' on' : ''}"></div>
          </div>
          <div class="cd-primary-btn cd-act" data-act="debug-print-last">测试：打印最近上下文/原文到控制台</div>
          <div class="cd-primary-btn cd-act" data-act="clear-history">清除聊天记录</div>
          <div class="cd-primary-btn cd-act" data-act="clear-memory">清除所有记忆</div>
          ${isGroup && isUserInGroup ? '<div class="cd-danger-btn cd-act" data-act="leave-group">退出群聊</div>' : ''}
          ${isGroup && !isUserInGroup ? '<div class="cd-primary-btn cd-act" data-act="rejoin-group">重新加入群聊</div>' : ''}
          <div class="cd-danger-btn cd-act" data-act="${blocked ? 'unblock' : 'block'}">${blocked ? '取消拉黑 ' + escapeHtml(partnerName) : '拉黑 ' + escapeHtml(partnerName)}</div>
        </div>
      </div>
    `;

    container.querySelector('.cd-back')?.addEventListener('click', () => back());

    container.querySelector('.cd-context-depth')?.addEventListener('change', async (e) => {
      prefs.contextDepth = parseInt(e.target.value) || 200;
      await saveChatPrefs(chatId, prefs);
    });
    container.querySelector('.cd-inner-voice-limit')?.addEventListener('change', async (e) => {
      const n = parseInt(e.target.value, 10);
      prefs.innerVoiceInjectLimit = Number.isFinite(n) ? Math.max(0, Math.min(8, n)) : 2;
      e.target.value = String(prefs.innerVoiceInjectLimit);
      await saveChatPrefs(chatId, prefs);
      showToast(`心声注入条数：${prefs.innerVoiceInjectLimit}`);
    });
    container.querySelector('.cd-linked-context-limit')?.addEventListener('change', async (e) => {
      const n = parseInt(e.target.value, 10);
      prefs.linkedContextLimit = Number.isFinite(n) ? Math.max(0, Math.min(300, n)) : 100;
      e.target.value = String(prefs.linkedContextLimit);
      await saveChatPrefs(chatId, prefs);
    });
    container.querySelector('.cd-auto-summary')?.addEventListener('click', async function () {
      this.classList.toggle('on');
      prefs.autoSummary = this.classList.contains('on');
      await saveChatPrefs(chatId, prefs);
    });
    container.querySelector('.cd-auto-freq')?.addEventListener('change', async (e) => {
      prefs.autoSummaryFreq = parseInt(e.target.value) || 200;
      await saveChatPrefs(chatId, prefs);
    });
    container.querySelector('.cd-summary-prompt')?.addEventListener('change', async (e) => {
      prefs.customSummaryPrompt = e.target.value || '';
      await saveChatPrefs(chatId, prefs);
    });
    container.querySelector('.cd-group-summary-prompt')?.addEventListener('change', async (e) => {
      prefs.customGroupSummaryPrompt = e.target.value || '';
      await saveChatPrefs(chatId, prefs);
    });

    container.querySelector('.cd-generate-summary')?.addEventListener('click', async () => {
      const btn = container.querySelector('.cd-generate-summary');
      btn.textContent = '正在总结…';
      btn.style.opacity = '0.5';
      try {
        const result = await maybeSummarizeChatMemory({
          chat,
          userId,
          currentUserName: currentUser?.name || '我',
          resolveName,
          force: true,
        });
        if (!result.ok) {
          showToast(result.reason === 'no-delta' ? '自上次总结后暂无新增消息' : '暂无可总结消息');
          return;
        }
        showToast(`总结完成（增量 ${result.deltaCount} 条）`);
        await fullRender();
      } catch (e) {
        showToast(`总结失败：${e.message}`);
      } finally {
        btn.textContent = '立即总结';
        btn.style.opacity = '1';
      }
    });

    container.querySelector('.cd-add-memory')?.addEventListener('click', async () => {
      const type = window.prompt('类型 (event/relationship/preference/secret/promise/summary)', 'event');
      if (!type) return;
      const charName = window.prompt('关联角色名（留空=全局）', '');
      const characterId = charName ? (CHARACTERS.find((c) => c.name === charName || c.id === charName)?.id || '') : '';
      const content = window.prompt('记忆内容');
      if (!content) return;
      const mem = createMemory({ chatId, userId, characterId, type, content, source: 'manual' });
      await db.put('memories', mem);
      showToast('记忆已保存');
      await fullRender();
    });

    container.querySelectorAll('.cd-mem-del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!window.confirm('删除这条记忆？')) return;
        await db.del('memories', btn.dataset.id);
        await fullRender();
      });
    });

    container.querySelector('.cd-save-linkage-groups')?.addEventListener('click', async () => {
      const ids = [...container.querySelectorAll('.cd-linkage-group-cb:checked')].map((el) => el.value);
      gs.linkageTargetGroupIds = ids;
      chat.groupSettings = gs;
      await db.put('chats', chat);
      showToast(ids.length ? `已设置 ${ids.length} 个联动目标群` : '已清空目标群（恢复随机）');
      await fullRender();
    });
    container.querySelector('.cd-save-linkage-members')?.addEventListener('click', async () => {
      const ids = [...container.querySelectorAll('.cd-linkage-member-cb:checked')].map((el) => el.value);
      gs.linkagePrivateMemberIds = ids;
      chat.groupSettings = gs;
      await db.put('chats', chat);
      showToast(ids.length ? `已设置 ${ids.length} 位成员` : '已清空成员限制（群内均可）');
      await fullRender();
    });

    container.querySelectorAll('.cd-act').forEach((el) => {
      el.addEventListener('click', async () => {
        const act = el.dataset.act;
        if (act === 'clear-history') {
          if (!window.confirm('确认清空所有聊天记录？此操作不可撤销。')) return;
          const msgs = await db.getAllByIndex('messages', 'chatId', chatId);
          await Promise.all(msgs.map((m) => db.del('messages', m.id)));
          chat.lastMessage = '';
          chat.lastActivity = await getVirtualNow(userId || '', Date.now());
          await db.put('chats', chat);
          showToast('聊天记录已清空');
        } else if (act === 'clear-memory') {
          if (!window.confirm('确认清除所有记忆？此操作不可撤销。')) return;
          const mems = await db.getAllByIndex('memories', 'chatId', chatId);
          await Promise.all(mems.map((m) => db.del('memories', m.id)));
          showToast('记忆已清空');
        } else if (act === 'block') {
          chat.blocked = true;
          await db.put('chats', chat);
          showToast(`已拉黑 ${partnerName}`);
        } else if (act === 'unblock') {
          chat.blocked = false;
          await db.put('chats', chat);
          showToast(`已取消拉黑 ${partnerName}`);
        } else if (act === 'leave-group') {
          if (!window.confirm('确认退出群聊？群聊仍会继续存在。')) return;
          chat.participants = chat.participants.filter((p) => p !== 'user');
          const gs2 = chat.groupSettings || {};
          gs2.isObserverMode = true;
          chat.groupSettings = gs2;
          await db.put('chats', chat);
          const sysMsg = createMessage({ chatId, senderId: 'system', type: 'system', content: `${currentUser?.name || '我'} 已退出群聊` });
          await db.put('messages', sysMsg);
          showToast('已退出群聊');
        } else if (act === 'social-linkage') {
          gs.allowSocialLinkage = !(gs.allowSocialLinkage !== false);
          chat.groupSettings = gs;
          await db.put('chats', chat);
          showToast(gs.allowSocialLinkage ? '已开启自动联动' : '已关闭自动联动');
        } else if (act === 'wrong-send') {
          gs.allowWrongSend = !(gs.allowWrongSend !== false);
          chat.groupSettings = gs;
          await db.put('chats', chat);
          showToast(gs.allowWrongSend ? '已开启错群事件' : '已关闭错群事件');
        } else if (act === 'debug-ai-ops') {
          const now = await getAiOpsDebugEnabled();
          await setAiOpsDebugEnabled(!now);
          showToast(!now ? '已开启调试显示' : '已关闭调试显示');
        } else if (act === 'debug-print-last') {
          const key = `aiDebugSnapshot_${chatId}`;
          const snap = (await db.get('settings', key))?.value || null;
          if (!snap) {
            showToast('暂无调试快照，请先触发一次 AI 回复');
          } else {
            console.group('[AI调试快照]');
            console.log('chatId:', chatId);
            console.log('snapshot:', snap);
            if (snap.payload) console.log('payload(context):', snap.payload);
            if (snap.raw != null) console.log('raw:', snap.raw);
            if (snap.cleaned != null) console.log('cleaned:', snap.cleaned);
            console.groupEnd();
            showToast('已打印到控制台（F12）');
          }
        } else if (act === 'offline-ai') {
          gs.allowAiOfflineInvite = !gs.allowAiOfflineInvite;
          chat.groupSettings = gs;
          await db.put('chats', chat);
          showToast(gs.allowAiOfflineInvite ? 'AI 可提议线下' : '已关闭 AI 线下提议');
        } else if (act === 'ai-group-ops') {
          gs.allowAiGroupOps = !gs.allowAiGroupOps;
          chat.groupSettings = gs;
          await db.put('chats', chat);
          showToast(gs.allowAiGroupOps ? 'AI 群管理权限已开启' : 'AI 群管理权限已关闭');
        } else if (act === 'toggle-custom-linkage') {
          gs.useCustomLinkageTargets = !gs.useCustomLinkageTargets;
          chat.groupSettings = gs;
          await db.put('chats', chat);
          showToast(gs.useCustomLinkageTargets ? '已启用自定义目标群' : '已切回随机目标群');
        } else if (act === 'linkage-mode') {
          const order = ['notify', 'rant', 'auto'];
          const cur = order.includes(gs.linkageMode) ? gs.linkageMode : 'notify';
          const next = order[(order.indexOf(cur) + 1) % order.length];
          gs.linkageMode = next;
          chat.groupSettings = gs;
          await db.put('chats', chat);
          showToast(
            next === 'notify' ? '联动类型：通知' : next === 'rant' ? '联动类型：吐槽' : '联动类型：自动（AI 用 [联动风格:…] 决定）',
          );
        } else if (act === 'linked-context-scope') {
          const raw = window.prompt('关联范围：输入 loose（宽松）或 strict（严格）', String(prefs.linkedContextScope || 'loose'));
          if (raw == null) return;
          const s = String(raw).trim().toLowerCase();
          prefs.linkedContextScope = s === 'strict' ? 'strict' : 'loose';
          await saveChatPrefs(chatId, prefs);
          showToast(`已切换关联范围：${prefs.linkedContextScope === 'strict' ? '严格' : '宽松'}`);
        } else if (act === 'rejoin-group') {
          if (!chat.participants.includes('user')) chat.participants.push('user');
          const gs2 = chat.groupSettings || {};
          gs2.isObserverMode = false;
          chat.groupSettings = gs2;
          await db.put('chats', chat);
          const sysMsg = createMessage({ chatId, senderId: 'system', type: 'system', content: `${currentUser?.name || '我'} 已重新加入群聊` });
          await db.put('messages', sysMsg);
          showToast('已重新加入');
        }
        await fullRender();
      });
    });

    container.querySelector('.cd-offline-start')?.addEventListener('click', () => {
      let ids = [];
      if (isGroup) {
        const raw = window.prompt(
          '输入参与线下的角色名，多个用逗号分隔（留空=群内全部 AI 角色）',
          aiMembers.map(resolveName).join('、')
        );
        if (raw === null) return;
        const parts = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        if (parts.length) {
          for (const n of parts) {
            const f = CHARACTERS.find((c) => c.name === n || c.id === n || (c.aliases || []).includes(n));
            if (f && aiMembers.includes(f.id)) ids.push(f.id);
          }
        } else {
          ids = [...aiMembers];
        }
      } else if (aiMembers[0]) {
        ids = [aiMembers[0]];
      }
      if (!ids.length) {
        showToast('没有可带入线下的角色');
        return;
      }
      navigate('novel-mode', { chatId, characterIds: ids.join(',') });
    });

    if (isGroup) {
      container.querySelector('[data-act="add-member"]')?.addEventListener('click', async () => {
        const name = window.prompt('输入要添加的角色名');
        if (!name) return;
        const found = CHARACTERS.find((c) => c.name === name || c.id === name || (c.aliases || []).includes(name));
        if (!found) { showToast('未找到该角色'); return; }
        if (!chat.participants.includes(found.id)) {
          chat.participants.push(found.id);
          if (!await db.get('characters', found.id)) await db.put('characters', { ...found });
          await db.put('chats', chat);
          showToast(`已添加 ${found.name}`);
          await fullRender();
        }
      });
      container.querySelector('[data-act="rename"]')?.addEventListener('click', async () => {
        const n = window.prompt('群名称', gs.name || '');
        if (n == null) return;
        gs.name = n;
        chat.groupSettings = gs;
        await db.put('chats', chat);
        await fullRender();
      });
      container.querySelector('[data-act="announcement"]')?.addEventListener('click', async () => {
        const t = window.prompt('群公告', gs.announcement || '');
        if (t == null) return;
        gs.announcement = t;
        chat.groupSettings = gs;
        await db.put('chats', chat);
        await fullRender();
      });
      container.querySelector('[data-act="plot"]')?.addEventListener('click', async () => {
        const t = window.prompt('剧情推进提示', gs.plotDirective || '');
        if (t == null) return;
        gs.plotDirective = t;
        chat.groupSettings = gs;
        await db.put('chats', chat);
        await fullRender();
      });
      container.querySelector('[data-act="observer"]')?.addEventListener('click', async () => {
        gs.isObserverMode = !gs.isObserverMode;
        chat.groupSettings = gs;
        await db.put('chats', chat);
        navigate('chat-details', { chatId }, true);
      });
      container.querySelector('[data-act="pm-trigger"]')?.addEventListener('click', async () => {
        gs.allowPrivateTrigger = !gs.allowPrivateTrigger;
        chat.groupSettings = gs;
        await db.put('chats', chat);
        navigate('chat-details', { chatId }, true);
      });
      container.querySelector('[data-act="set-owner"]')?.addEventListener('click', async () => {
        const name = window.prompt('转让群主给');
        if (!name) return;
        const found = participants.find((id) => resolveName(id) === name || id === name);
        if (!found) { showToast('未找到'); return; }
        gs.owner = found;
        chat.groupSettings = gs;
        await db.put('chats', chat);
        await fullRender();
      });
      container.querySelector('[data-act="set-admin"]')?.addEventListener('click', async () => {
        const name = window.prompt('设为管理员');
        if (!name) return;
        const found = participants.find((id) => resolveName(id) === name || id === name);
        if (!found) { showToast('未找到'); return; }
        gs.admins = [...new Set([...(gs.admins || []), found])];
        chat.groupSettings = gs;
        await db.put('chats', chat);
        await fullRender();
      });
      container.querySelector('[data-act="kick"]')?.addEventListener('click', async () => {
        const name = window.prompt('踢出成员');
        if (!name) return;
        const found = participants.find((id) => resolveName(id) === name || id === name);
        if (!found) { showToast('未找到'); return; }
        chat.participants = chat.participants.filter((p) => p !== found);
        gs.admins = (gs.admins || []).filter((a) => a !== found);
        chat.groupSettings = gs;
        await db.put('chats', chat);
        await fullRender();
      });
    }
  }

  await fullRender();
}
