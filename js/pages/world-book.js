import { navigate, back } from '../core/router.js';
import * as db from '../core/db.js';
import { importWorldBookFromJsonText } from '../core/world-book-import.js';
import { showToast } from '../components/toast.js';
import { WORLD_BOOKS } from '../data/world-books.js';

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

function truncate(s, n = 120) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
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

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'timeline', label: '时间线' },
  { key: 'team', label: '战队' },
  { key: 'social', label: '社交' },
  { key: 'system', label: '系统' },
  { key: 'au', label: 'AU' },
  { key: 'custom', label: '自定义' },
];

function categoryMatchesTab(tabKey, category) {
  if (tabKey === 'all') return true;
  if (tabKey === 'system') return category === 'system' || category === 'meta';
  return category === tabKey;
}

function tagsHtml(keys) {
  const arr = Array.isArray(keys) ? keys : [];
  if (!arr.length) return '<span class="wb-tag muted">无关键词</span>';
  return arr
    .slice(0, 8)
    .map((k) => `<span class="wb-tag">${escapeHtml(k)}</span>`)
    .join('');
}

export default async function render(container) {
  const n = await db.count('worldBooks');
  if (n === 0) {
    await db.putMany('worldBooks', WORLD_BOOKS);
  }

  let activeTab = 'all';

  async function getHiddenIds() {
    const row = await db.get('settings', 'worldBookHiddenIds');
    const v = row?.value;
    return new Set(Array.isArray(v) ? v : []);
  }

  async function hideSeedEntry(id) {
    const hidden = await getHiddenIds();
    hidden.add(id);
    await db.put('settings', { key: 'worldBookHiddenIds', value: [...hidden] });
  }

  async function getMergedEntries() {
    const hidden = await getHiddenIds();
    const stored = await db.getAll('worldBooks');
    const byId = new Map(stored.map((e) => [e.id, { ...e }]));
    for (const seed of WORLD_BOOKS) {
      if (hidden.has(seed.id)) continue;
      if (!byId.has(seed.id)) {
        byId.set(seed.id, { ...seed });
      }
    }
    return [...byId.values()].filter((e) => !hidden.has(e.id));
  }

  function buildListHtml(entries) {
    const filtered = entries.filter((e) => categoryMatchesTab(activeTab, e.category));
    if (!filtered.length) {
      return `<div class="placeholder-page" style="padding:32px 16px;"><div class="placeholder-text">该分类暂无条目</div></div>`;
    }
    return filtered
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || (a.name || '').localeCompare(b.name || '', 'zh-CN'))
      .map((e) => {
        const keys = e.keys || [];
        return `
        <div class="wb-entry card-block" data-entry-id="${escapeAttr(e.id)}" role="button" tabindex="0">
          <div class="wb-entry-name">${escapeHtml(e.name || e.id)}</div>
          <div class="wb-entry-tags">${tagsHtml(keys)}</div>
          <div class="wb-entry-preview">${escapeHtml(truncate(e.content, 140))}</div>
        </div>`;
      })
      .join('');
  }

  let entries = await getMergedEntries();

  const tabsRow = TABS.map(
    (t) =>
      `<button type="button" class="wb-tab${t.key === activeTab ? ' active' : ''}" data-tab="${escapeAttr(t.key)}">${escapeHtml(t.label)}</button>`
  ).join('');

  container.classList.add('world-book-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn wb-back" aria-label="返回">‹</button>
      <h1 class="navbar-title">世界书</h1>
      <div class="wb-navbar-actions" style="display:flex;align-items:center;gap:2px;">
        <button type="button" class="navbar-btn wb-import" aria-label="导入世界书 JSON" title="导入">↓</button>
        <button type="button" class="navbar-btn wb-add" aria-label="新建">+</button>
      </div>
    </header>
    <input type="file" class="wb-file-json" accept=".json,application/json" style="position:absolute;width:0;height:0;opacity:0;pointer-events:none" tabindex="-1" aria-hidden="true" />
    <div class="wb-tabs">${tabsRow}</div>
    <div class="page-scroll wb-list">${buildListHtml(entries)}</div>
  `;

  const listEl = container.querySelector('.wb-list');

  const refresh = async () => {
    entries = await getMergedEntries();
    if (listEl) listEl.innerHTML = buildListHtml(entries);
    bindEntryClicks();
  };

  function openEditor(entry) {
    const isNew = !entry;
    const e = entry || {
      id: 'wb_user_' + Date.now(),
      name: '',
      category: 'custom',
      season: 'all',
      keys: [],
      content: '',
      constant: false,
      position: 99,
      depth: 4,
    };
    const keysStr = Array.isArray(e.keys) ? e.keys.join('\n') : '';
    const catOpts = ['timeline', 'team', 'social', 'system', 'meta', 'au', 'custom']
      .map(
        (c) =>
          `<option value="${escapeAttr(c)}"${e.category === c ? ' selected' : ''}>${escapeHtml(c)}</option>`
      )
      .join('');

    const { close, root } = openGlobalModal(`
      <div class="modal-header">
        <h3>${isNew ? '新建条目' : '编辑条目'}</h3>
        <button type="button" class="navbar-btn wb-edit-close" aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">名称</label>
          <input type="text" class="form-input wb-f-name" value="${escapeAttr(e.name || '')}" />
        </div>
        <div class="form-group">
          <label class="form-label">分类</label>
          <select class="form-input wb-f-cat">${catOpts}</select>
        </div>
        <div class="form-group">
          <label class="form-label">赛季</label>
          <input type="text" class="form-input wb-f-season" placeholder="如 S8 或 all" value="${escapeAttr(e.season || 'all')}" />
        </div>
        <div class="form-group">
          <label class="form-label">关键词（每行一个）</label>
          <textarea class="form-input wb-f-keys" rows="3">${escapeHtml(keysStr)}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">内容</label>
          <textarea class="form-input wb-f-content" rows="10">${escapeHtml(e.content || '')}</textarea>
        </div>
        <button type="button" class="btn btn-primary wb-f-save" style="width:100%;margin-top:8px;">保存</button>
        ${isNew ? '' : '<button type="button" class="btn btn-outline wb-f-delete" style="width:100%;margin-top:8px;color:var(--danger,#c0392b);">删除</button>'}
      </div>
    `);

    const doClose = () => close();
    root.querySelector('.wb-edit-close')?.addEventListener('click', doClose);
    root.querySelector('.wb-f-save')?.addEventListener('click', async () => {
      const name = (root.querySelector('.wb-f-name')?.value || '').trim();
      const category = root.querySelector('.wb-f-cat')?.value || 'custom';
      const season = (root.querySelector('.wb-f-season')?.value || 'all').trim() || 'all';
      const keyLines = (root.querySelector('.wb-f-keys')?.value || '')
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);
      const content = root.querySelector('.wb-f-content')?.value || '';
      const updated = {
        ...e,
        name: name || e.name || '未命名',
        category,
        season,
        keys: keyLines,
        content,
      };
      await db.put('worldBooks', updated);
      doClose();
      await refresh();
    });
    root.querySelector('.wb-f-delete')?.addEventListener('click', async () => {
      if (!confirm('确定删除该条目？')) return;
      await db.del('worldBooks', e.id);
      if (WORLD_BOOKS.some((w) => w.id === e.id)) {
        await hideSeedEntry(e.id);
      }
      doClose();
      await refresh();
    });
  }

  function bindEntryClicks() {
    container.querySelectorAll('.wb-entry').forEach((el) => {
      const open = async () => {
        const id = el.dataset.entryId;
        const one = await db.get('worldBooks', id);
        const seed = WORLD_BOOKS.find((w) => w.id === id);
        openEditor(one || seed || { id });
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          open();
        }
      });
    });
  }

  bindEntryClicks();

  const fileInput = container.querySelector('.wb-file-json');
  container.querySelector('.wb-import')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      const { entries: imported, warnings } = importWorldBookFromJsonText(text);
      if (!imported.length) {
        showToast(warnings[0] || '没有可导入的条目');
        return;
      }
      await db.putMany('worldBooks', imported);
      const extra = warnings.length ? ` ${warnings.join('；')}` : '';
      showToast(`已导入 ${imported.length} 条${extra}`);
      await refresh();
    } catch (e) {
      showToast(String(e?.message || e));
    }
  });

  container.querySelector('.wb-back')?.addEventListener('click', () => back());
  container.querySelector('.wb-add')?.addEventListener('click', () => openEditor(null));

  container.querySelectorAll('.wb-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab || 'all';
      container.querySelectorAll('.wb-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      if (listEl) listEl.innerHTML = buildListHtml(entries);
      bindEntryClicks();
    });
  });

  void navigate;
}
