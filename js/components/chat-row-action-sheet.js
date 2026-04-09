import { icon } from './svg-icons.js';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 长按会话行：置顶 / 删除 */
export function openChatRowActionSheet({ chatTitle = '会话', pinned = false, onTogglePin, onDelete, onClosed } = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-chat-row-act-overlay>
      <div class="modal-sheet" role="dialog" aria-modal="true" data-chat-row-act-sheet style="max-width:380px;">
        <div class="modal-header">
          <h3>${escapeHtml(chatTitle)}</h3>
          <button type="button" class="navbar-btn modal-close-btn chat-row-act-close" aria-label="关闭">${icon('close')}</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:10px;padding-bottom:16px;">
          <button type="button" class="btn btn-primary chat-row-act-pin" style="width:100%;">${pinned ? '取消置顶' : '置顶聊天'}</button>
          <button type="button" class="btn btn-outline chat-row-act-del" style="width:100%;border-color:var(--danger,#c53030);color:var(--danger,#c53030);">删除会话</button>
        </div>
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
    onClosed?.();
  };
  host.querySelector('[data-chat-row-act-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-chat-row-act-overlay]')?.addEventListener('click', close);
  host.querySelector('.chat-row-act-close')?.addEventListener('click', close);
  host.querySelector('.chat-row-act-pin')?.addEventListener('click', async () => {
    await onTogglePin?.();
    close();
  });
  host.querySelector('.chat-row-act-del')?.addEventListener('click', async () => {
    if (!window.confirm(`删除会话「${chatTitle}」？聊天记录与本地记忆会一并删除。`)) return;
    await onDelete?.();
    close();
  });
}
