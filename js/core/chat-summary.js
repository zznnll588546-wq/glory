import * as db from './db.js';
import { chat as apiChat } from './api.js';
import { createMemory } from '../models/memory.js';

function formatTs(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function parseRoleBlocks(text = '') {
  const raw = String(text || '');
  const globalMatch = raw.match(/【全局】([\s\S]*?)(?=【角色:|$)/);
  const global = (globalMatch?.[1] || '').trim();
  const roleRe = /【角色:([^\]]+)】([\s\S]*?)(?=【角色:|$)/g;
  const roles = [];
  let m;
  while ((m = roleRe.exec(raw))) {
    const roleId = String(m[1] || '').trim();
    const body = String(m[2] || '').trim();
    if (!roleId || !body) continue;
    roles.push({ roleId, body });
  }
  return { global, roles };
}

export async function maybeSummarizeChatMemory({
  chat,
  userId,
  currentUserName = '我',
  resolveName = (id) => id,
  force = false,
}) {
  if (!chat?.id || !userId) return { ok: false, reason: 'missing-chat-or-user' };
  const prefKey = `chatPrefs_${chat.id}`;
  const prefRow = await db.get('settings', prefKey);
  const prefs = prefRow?.value || { autoSummary: false, autoSummaryFreq: 200, customSummaryPrompt: '' };
  if (!force && !prefs.autoSummary) return { ok: false, reason: 'auto-summary-off' };

  const allMessages = await db.getAllByIndex('messages', 'chatId', chat.id);
  const sorted = [...allMessages]
    .filter((m) => !m.deleted && !m.recalled)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  if (!sorted.length) return { ok: false, reason: 'no-messages' };

  const allMems = await db.getAllByIndex('memories', 'chatId', chat.id);
  const lastSummary = [...allMems]
    .filter((m) => m.type === 'summary' && (!m.userId || m.userId === userId))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
  const sinceTs = lastSummary?.timestamp || 0;
  const delta = sorted.filter((m) => (m.timestamp || 0) > sinceTs);
  const freq = Math.max(20, Number(prefs.autoSummaryFreq) || 200);
  if (!force && delta.length < freq) return { ok: false, reason: 'not-enough-delta', deltaCount: delta.length, freq };
  if (!delta.length) return { ok: false, reason: 'no-delta' };

  const isGroup = chat.type === 'group';
  const roleIds = (chat.participants || []).filter((id) => id && id !== 'user');
  const roleLine = roleIds.map((id) => `${id}:${resolveName(id)}`).join('，');
  const textBlock = delta
    .map((m) => {
      const sender = m.senderId === 'user' ? currentUserName : (m.senderName || resolveName(m.senderId));
      return `[${sender}]: ${String(m.content || '')}`;
    })
    .join('\n');
  const customPrompt = prefs.customSummaryPrompt ? `\n额外要求：${prefs.customSummaryPrompt}` : '';
  const rangeText = `${formatTs(delta[0]?.timestamp)} ~ ${formatTs(delta[delta.length - 1]?.timestamp)}`;

  const systemPrompt = isGroup
    ? `你是对话纪要助手。请总结群聊增量记录，必须覆盖：具体约定、重要对话、冲突/吐槽、立下的flag、后续待办。输出格式严格如下：
【全局】
- ...
【角色:角色ID】
- ...
要求：
1) 仅使用以下角色ID：${roleLine || '（无）'}
2) 全局部分写群体事件；角色部分写该角色相关的关键信息
3) 每条尽量具体（时间、对象、动作、结果）
4) 不要编造，不要输出解释文字。${customPrompt}`
    : `你是对话纪要助手。请总结私聊增量记录，必须覆盖：具体约定、重要对话、冲突/吐槽、立下的flag、后续待办。输出格式严格如下：
【全局】
- ...
【角色:${roleIds[0] || 'partner'}】
- ...
要求：每条具体，不要编造，不要输出解释文字。${customPrompt}`;

  const result = await apiChat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `会话类型：${isGroup ? '群聊' : '私聊'}\n增量区间：${rangeText}\n\n以下是增量聊天记录：\n${textBlock}` },
    ],
    { temperature: 0.3, maxTokens: 1200 }
  );
  if (!result?.trim()) return { ok: false, reason: 'empty-api' };

  const parsed = parseRoleBlocks(result);
  const globalContent = parsed.global || result.trim();
  await db.put('memories', createMemory({
    chatId: chat.id,
    userId,
    characterId: '',
    type: 'summary',
    content: `【区间】${rangeText}\n${globalContent}`,
    source: force ? 'api-summary-manual' : 'api-summary-auto',
  }));

  for (const r of parsed.roles) {
    if (!roleIds.includes(r.roleId)) continue;
    await db.put('memories', createMemory({
      chatId: chat.id,
      userId,
      characterId: r.roleId,
      type: 'summary',
      content: `【区间】${rangeText}\n${r.body}`,
      source: force ? 'api-summary-manual-role' : 'api-summary-auto-role',
    }));
  }
  return { ok: true, deltaCount: delta.length, rangeText };
}

