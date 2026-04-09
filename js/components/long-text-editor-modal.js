import { icon } from './svg-icons.js';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

/** 大号弹窗编辑多行文本（与文字图片弹窗同为 modal-sheet-tall） */
export function openLongTextEditorModal({ title = '编辑内容', placeholder = '', value = '', rows = 12 } = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return Promise.resolve(null);
  return new Promise((resolve) => {
    const rowCount = Math.max(6, Number(rows) || 12);
    host.innerHTML = `
      <div class="modal-overlay" data-modal-overlay>
        <div class="modal-sheet modal-sheet-tall" role="dialog" aria-modal="true" data-modal-sheet style="max-width:480px;">
          <div class="modal-header">
            <h3>${escapeHtml(title)}</h3>
            <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">${icon('close')}</button>
          </div>
          <div class="modal-body">
            <textarea class="form-input long-editor-input" rows="${rowCount}" placeholder="${escapeAttr(placeholder)}" style="width:100%;min-height:220px;max-height:62vh;overflow:auto;line-height:1.55;padding:10px 12px;resize:vertical;">${escapeHtml(value)}</textarea>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
              <button type="button" class="btn btn-sm btn-outline long-editor-cancel">取消</button>
              <button type="button" class="btn btn-sm btn-primary long-editor-ok">确认</button>
            </div>
          </div>
        </div>
      </div>
    `;
    host.classList.add('active');
    const done = (val) => {
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(val);
    };
    const input = host.querySelector('.long-editor-input');
    host.querySelector('[data-modal-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('[data-modal-overlay]')?.addEventListener('click', () => done(null));
    host.querySelector('.modal-close-btn')?.addEventListener('click', () => done(null));
    host.querySelector('.long-editor-cancel')?.addEventListener('click', () => done(null));
    host.querySelector('.long-editor-ok')?.addEventListener('click', () => done(String(input?.value || '')));
    setTimeout(() => input?.focus(), 0);
  });
}
