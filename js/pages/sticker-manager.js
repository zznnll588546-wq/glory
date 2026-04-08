import { back } from '../core/router.js';
import * as db from '../core/db.js';
import { parseStickerImportLine } from '../core/chat-helpers.js';
import { sanitizeStickerDisplayName } from '../core/sticker-sanitize.js';

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

function openModal(innerHtml) {
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
  return { close, host };
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default async function render(container) {
  let packs = await db.getAll('stickerPacks');
  packs = [...packs].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
  let selectedId = packs[0]?.id || null;
  let manageMode = false;
  const selectedSet = new Set();

  container.classList.add('sticker-manager-page');
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.height = '100%';
  container.style.overflow = 'hidden';

  container.innerHTML = `
    <header class="navbar" style="flex-shrink:0;">
      <button type="button" class="navbar-btn stk-back" aria-label="返回">‹</button>
      <h1 class="navbar-title">表情包管理</h1>
      <span class="navbar-btn" style="visibility:hidden"></span>
    </header>
    <div class="stk-pack-tabs preset-tab-row" style="flex-shrink:0;"></div>
    <div class="stk-main" style="flex:1;min-height:0;overflow-y:auto;"></div>
    <div class="stk-actions" style="flex-shrink:0;padding:12px 16px;padding-bottom:calc(12px + var(--safe-bottom));background:var(--glass-bg);border-top:1px solid var(--border);display:flex;flex-wrap:wrap;gap:8px;"></div>
    <input type="file" class="stk-file-input" accept=".jpg,.jpeg,.png,.gif,.webp" multiple style="display:none;" />
  `;

  const tabsEl = container.querySelector('.stk-pack-tabs');
  const mainEl = container.querySelector('.stk-main');
  const actionsEl = container.querySelector('.stk-actions');
  const fileInput = container.querySelector('.stk-file-input');

  function currentPack() {
    const p = packs.find((x) => x.id === selectedId) || null;
    if (p && !Array.isArray(p.stickers)) p.stickers = [];
    return p;
  }

  async function savePack(pack) {
    await db.put('stickerPacks', pack);
    packs = await db.getAll('stickerPacks');
    packs = [...packs].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
  }

  function renderTabs() {
    if (!packs.length) {
      tabsEl.innerHTML = '';
      return;
    }
    tabsEl.innerHTML = packs
      .map(
        (p) => `
      <button type="button" class="preset-tab${p.id === selectedId ? ' active' : ''}" data-pack-id="${escapeAttr(p.id)}">
        ${escapeHtml(p.name || '未命名')}
      </button>`
      )
      .join('');
    tabsEl.querySelectorAll('[data-pack-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedId = btn.dataset.packId;
        manageMode = false;
        selectedSet.clear();
        renderAll();
      });
    });
  }

  function renderMain() {
    if (!packs.length) {
      mainEl.innerHTML = `
        <div class="placeholder-page" style="min-height:200px;padding:32px 16px;">
          <div class="placeholder-text">还没有表情包</div>
          <button type="button" class="stk-first-create" style="margin-top:16px;padding:12px 24px;background:var(--primary);color:var(--text-inverse);border-radius:var(--radius-md);font-weight:600;">新建分组</button>
        </div>`;
      mainEl.querySelector('.stk-first-create')?.addEventListener('click', () => openNewPackModal());
      return;
    }

    const pack = currentPack();
    if (!pack) {
      selectedId = packs[0].id;
      return renderAll();
    }

    const stickers = Array.isArray(pack.stickers) ? pack.stickers : [];
    if (!stickers.length) {
      mainEl.innerHTML = `<div class="placeholder-page" style="min-height:160px;"><div class="placeholder-sub">当前分组暂无表情，请导入或上传</div></div>`;
      return;
    }

    mainEl.innerHTML = `
      <div class="sticker-grid">
        ${stickers
          .map((s) => {
            const sel = manageMode && selectedSet.has(s.id);
            return `
          <div class="stk-cell" data-sid="${escapeAttr(s.id)}" style="cursor:pointer;">
            <div class="stk-thumb" style="position:relative;width:100%;">
              <img src="${escapeAttr(s.url)}" alt="${escapeAttr(sanitizeStickerDisplayName(s.name))}" />
              ${
                manageMode
                  ? `<div class="stk-check" style="position:absolute;inset:0;display:flex;align-items:flex-start;justify-content:flex-end;padding:4px;background:${sel ? 'rgba(0,0,0,0.35)' : 'transparent'};">
                       <span style="width:22px;height:22px;border-radius:4px;border:2px solid #fff;background:${sel ? 'var(--primary)' : 'rgba(255,255,255,0.8)'};color:#fff;font-size:14px;line-height:18px;text-align:center;">${sel ? '✓' : ''}</span>
                     </div>`
                  : ''
              }
            </div>
            <div class="stk-caption">${escapeHtml(sanitizeStickerDisplayName(s.name))}</div>
          </div>`;
          })
          .join('')}
      </div>`;

    mainEl.querySelectorAll('.stk-cell').forEach((cell) => {
      cell.addEventListener('click', async () => {
        const sid = cell.dataset.sid;
        const p = currentPack();
        const st = p.stickers.find((x) => x.id === sid);
        if (!st) return;
        if (manageMode) {
          if (selectedSet.has(sid)) selectedSet.delete(sid);
          else selectedSet.add(sid);
          renderAll();
          return;
        }
        try {
          await navigator.clipboard.writeText(st.url);
        } catch (_) {}
      });
    });
  }

  function renderActions() {
    if (!packs.length) {
      actionsEl.innerHTML = '';
      return;
    }
    const bulkDelete =
      manageMode && selectedSet.size
        ? `<button type="button" class="stk-bulk-del" style="padding:8px 12px;background:var(--danger, #c44);color:#fff;border-radius:var(--radius-md);font-size:var(--font-xs);">删除选中(${selectedSet.size})</button>`
        : '';
    actionsEl.innerHTML = `
      <button type="button" class="stk-new-pack" style="flex:1;min-width:100px;padding:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);font-size:var(--font-xs);">新建分组</button>
      <button type="button" class="stk-url-import" style="flex:1;min-width:100px;padding:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);font-size:var(--font-xs);">批量URL导入</button>
      <button type="button" class="stk-upload" style="flex:1;min-width:100px;padding:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);font-size:var(--font-xs);">上传本地图片</button>
      <button type="button" class="stk-manage" style="flex:1;min-width:100px;padding:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);font-size:var(--font-xs);">${manageMode ? '完成' : '管理'}</button>
      <button type="button" class="stk-sanitize-names" style="flex:1;min-width:100px;padding:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);font-size:var(--font-xs);">修正名称</button>
      ${bulkDelete}
    `;

    actionsEl.querySelector('.stk-new-pack')?.addEventListener('click', () => openNewPackModal());
    actionsEl.querySelector('.stk-url-import')?.addEventListener('click', () => openUrlImportModal());
    actionsEl.querySelector('.stk-upload')?.addEventListener('click', () => fileInput.click());
    actionsEl.querySelector('.stk-manage')?.addEventListener('click', () => {
      manageMode = !manageMode;
      if (!manageMode) selectedSet.clear();
      renderAll();
    });
    actionsEl.querySelector('.stk-sanitize-names')?.addEventListener('click', async () => {
      const p = currentPack();
      if (!p?.stickers?.length) return;
      let n = 0;
      for (const s of p.stickers) {
        const rawTrim = String(s.name || '').trim();
        const next = sanitizeStickerDisplayName(s.name);
        if (!rawTrim && next === '表情') continue;
        if (next !== rawTrim) {
          s.name = next;
          n += 1;
        }
      }
      if (n) await savePack(p);
      alert(n ? `已把 ${n} 个表情的名称写回为净化后的短名（去掉误带的链接片段）。` : '当前分组名称无需修正。');
      renderAll();
    });
    actionsEl.querySelector('.stk-bulk-del')?.addEventListener('click', async () => {
      const p = currentPack();
      if (!p || !selectedSet.size) return;
      if (!window.confirm(`删除 ${selectedSet.size} 个表情？`)) return;
      p.stickers = p.stickers.filter((s) => !selectedSet.has(s.id));
      await savePack(p);
      selectedSet.clear();
      manageMode = false;
      renderAll();
    });
  }

  function openNewPackModal() {
    const { close, host } = openModal(`
      <div class="modal-header">
        <h3>新建分组</h3>
        <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">
        <input type="text" class="stk-new-name" placeholder="分组名称" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);" />
        <button type="button" class="stk-new-confirm" style="width:100%;margin-top:12px;padding:12px;background:var(--primary);color:var(--text-inverse);border:none;border-radius:var(--radius-md);font-weight:600;">创建</button>
      </div>
    `);
    const xclose = () => close();
    host.querySelector('.modal-close-btn')?.addEventListener('click', xclose);
    host.querySelector('.stk-new-confirm')?.addEventListener('click', async () => {
      const name = host.querySelector('.stk-new-name')?.value?.trim() || '新分组';
      const pack = { id: 'stk_' + Date.now(), name, stickers: [] };
      await savePack(pack);
      selectedId = pack.id;
      xclose();
      renderAll();
    });
  }

  function openUrlImportModal() {
    const p = currentPack();
    if (!p) return;
    const { close, host } = openModal(`
      <div class="modal-header">
        <h3>批量 URL 导入</h3>
        <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">
        <p style="font-size:var(--font-xs);color:var(--text-hint);margin-bottom:8px;">每行：表情名 +（全角/半角冒号或空格）+ URL；也支持仅一行 URL（名称显示为「表情」）。例：我真没招了：https://i.postimg.cc/xxx.png</p>
        <textarea class="stk-url-ta" rows="10" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);font-size:var(--font-sm);"></textarea>
        <button type="button" class="stk-url-ok" style="width:100%;margin-top:12px;padding:12px;background:var(--primary);color:var(--text-inverse);border:none;border-radius:var(--radius-md);font-weight:600;">导入</button>
      </div>
    `);
    host.querySelector('.modal-close-btn')?.addEventListener('click', close);
    host.querySelector('.stk-url-ok')?.addEventListener('click', async () => {
      const raw = host.querySelector('.stk-url-ta')?.value || '';
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let lineNo = 0;
      for (const line of lines) {
        const parsed = parseStickerImportLine(line);
        if (!parsed) continue;
        p.stickers.push({
          id: 'st_' + Date.now() + '_' + lineNo++ + '_' + Math.random().toString(36).slice(2, 6),
          name: parsed.name,
          url: parsed.url,
        });
      }
      await savePack(p);
      close();
      renderAll();
    });
  }

  fileInput.addEventListener('change', async () => {
    const p = currentPack();
    if (!p || !fileInput.files?.length) return;
    for (const file of fileInput.files) {
      try {
        const url = await fileToDataUrl(file);
        p.stickers.push({
          id: 'st_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
          name: file.name.replace(/\.[^.]+$/, ''),
          url,
        });
      } catch (_) {}
    }
    fileInput.value = '';
    await savePack(p);
    renderAll();
  });

  function renderAll() {
    renderTabs();
    renderMain();
    renderActions();
  }

  container.querySelector('.stk-back').addEventListener('click', () => back());

  renderAll();
}
