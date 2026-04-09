import { currentRoute, currentRouteParams } from './router.js';

const STORAGE_KEY = 'qzx_group_ai_reply_banner_v1';

function readState() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o.chatId !== 'string') return null;
    return { chatId: o.chatId, label: String(o.label || '群聊') };
  } catch (_) {
    return null;
  }
}

function writeState(data) {
  if (!data) sessionStorage.removeItem(STORAGE_KEY);
  else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/** AI 一轮续写落盘成功后调用；同页正在看该群则不写入，避免多余提示 */
export function notifyGroupAiReplyCommitted({ chatId, label }) {
  if (!chatId) return;
  if (currentRoute() === 'group-chat' && String(currentRouteParams().chatId || '') === String(chatId)) return;
  writeState({ chatId: String(chatId), label: String(label || '群聊').trim() || '群聊' });
}

export function peekPendingGroupAiBanner() {
  return readState();
}

export function clearPendingGroupAiBanner() {
  writeState(null);
}

export function clearGroupAiReplyBannerForChat(chatId) {
  const cur = readState();
  if (cur && String(cur.chatId) === String(chatId)) writeState(null);
}
