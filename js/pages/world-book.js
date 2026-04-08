import { navigate, back } from '../core/router.js';
import * as db from '../core/db.js';
import { importWorldBookFromJsonText } from '../core/world-book-import.js';
import { showToast } from '../components/toast.js';
import { WORLD_BOOKS } from '../data/world-books.js';

function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function truncate(s, n = 100) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
function normalizeKind(e) { return e?.kind === 'group' ? 'group' : 'item'; }

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

export default async function render(container) {
  if ((await db.count('worldBooks')) === 0) {
    await db.putMany('worldBooks', WORLD_BOOKS);
  }
  let activeTab = 'all';
  const expandedBooks = new Set();
  const selectedIds = new Set();
  let entries = [];

  async function getHiddenIds() {
    const row = await db.get('settings', 'worldBookHiddenIds');
    return new Set(Array.isArray(row?.value) ? row.value : []);
  }
  async function hideSeedEntry(id) {
    const set = await getHiddenIds();
    set.add(id);
    await db.put('settings', { key: 'worldBookHiddenIds', value: [...set] });
  }
  async function loadEntries() {
    const hidden = await getHiddenIds();
    const stored = await db.getAll('worldBooks');
    const byId = new Map(stored.map((e) => [e.id, { ...e, kind: normalizeKind(e) }]));
    for (const seed of WORLD_BOOKS) {
      if (hidden.has(seed.id)) continue;
      if (!byId.has(seed.id)) byId.set(seed.id, { ...seed, kind: normalizeKind(seed) });
    }
    entries = [...byId.values()].filter((e) => !hidden.has(e.id));
  }

  function getBooks() {
    const books = entries.filter((e) => e.kind === 'group' && e.isBookRoot);
    if (!books.length) {
      books.push({
        id: '__legacy_book__',
        kind: 'group',
        isBookRoot: true,
        name: '默认世界书',
        enabled: true,
        position: -999,
      });
    }
    return books.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }
  function getSubGroups(bookId) {
    return entries
      .filter((e) => e.kind === 'group' && !e.isBookRoot && (e.parentGroupId || '') === bookId)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }
  function getItemsByGroup(groupId, bookId) {
    return entries
      .filter((e) => e.kind !== 'group')
      .filter((e) => categoryMatchesTab(activeTab, e.category))
      .filter((e) => (groupId ? e.groupId === groupId : !e.groupId) && ((e.bookId || '') === bookId || (bookId === '__legacy_book__' && !e.bookId)))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }

  function renderItemRow(item) {
    const checked = selectedIds.has(item.id) ? 'checked' : '';
    const enabled = item.enabled === false ? '' : 'checked';
    return `
      <div class="wb-sortable card-block" draggable="true" data-sort-id="${escapeAttr(item.id)}" data-kind="item" style="margin:6px 12px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <input type="checkbox" class="wb-select" data-id="${escapeAttr(item.id)}" ${checked} />
          <span style="cursor:grab;">↕</span>
          <strong style="flex:1;">${escapeHtml(item.name || item.id)}</strong>
          <label style="font-size:12px;"><input type="checkbox" class="wb-enabled" data-id="${escapeAttr(item.id)}" ${enabled} /> 启用</label>
          <button type="button" class="btn btn-outline btn-sm wb-rename" data-id="${escapeAttr(item.id)}">重命名</button>
          <button type="button" class="btn btn-outline btn-sm wb-del-one" data-id="${escapeAttr(item.id)}">删</button>
        </div>
        <div class="wb-entry-preview" style="margin-top:4px;">${escapeHtml(truncate(item.content || '', 120))}</div>
      </div>`;
  }

  function buildListHtml() {
    const books = getBooks();
    const batchBar = `
      <div class="card-block" style="margin:10px 12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <span class="text-hint">已选 <strong>${selectedIds.size}</strong> 项</span>
        <button type="button" class="btn btn-outline btn-sm wb-batch-enable">批量启用</button>
        <button type="button" class="btn btn-outline btn-sm wb-batch-disable">批量停用</button>
        <button type="button" class="btn btn-danger btn-sm wb-batch-delete">批量删除</button>
      </div>`;
    const blocks = books.map((book) => {
      const isOpen = expandedBooks.has(book.id);
      const subGroups = getSubGroups(book.id);
      const ungrouped = getItemsByGroup('', book.id);
      const totalItems = ungrouped.length + subGroups.reduce((s, g) => s + getItemsByGroup(g.id, book.id).length, 0);
      const subGroupBlocks = subGroups
        .map((g) => {
          const gItems = getItemsByGroup(g.id, book.id);
          const gEnabled = g.enabled === false ? '' : 'checked';
          return `
            <div class="card-block wb-sortable" draggable="true" data-sort-id="${escapeAttr(g.id)}" data-kind="group" style="margin:8px 12px;">
              <div style="display:flex;align-items:center;gap:8px;">
                <input type="checkbox" class="wb-select" data-id="${escapeAttr(g.id)}" ${selectedIds.has(g.id) ? 'checked' : ''} />
                <span style="cursor:grab;">↕</span>
                <strong style="flex:1;">${escapeHtml(g.name || '分组')}</strong>
                <label style="font-size:12px;"><input type="checkbox" class="wb-enabled" data-id="${escapeAttr(g.id)}" ${gEnabled} /> 启用</label>
                <button type="button" class="btn btn-outline btn-sm wb-rename" data-id="${escapeAttr(g.id)}">重命名</button>
                <button type="button" class="btn btn-outline btn-sm wb-add-item" data-book-id="${escapeAttr(book.id)}" data-group-id="${escapeAttr(g.id)}">+条目</button>
                <button type="button" class="btn btn-outline btn-sm wb-del-one" data-id="${escapeAttr(g.id)}">删</button>
              </div>
              <div class="wb-sort-zone" data-zone-kind="item" data-parent-id="${escapeAttr(g.id)}">${gItems.map(renderItemRow).join('') || '<div class="text-hint" style="padding:8px;">暂无条目</div>'}</div>
            </div>`;
        })
        .join('');
      const bookEnabled = book.enabled === false ? '' : 'checked';
      return `
        <div class="card-block" style="margin:10px 12px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <button type="button" class="btn btn-outline btn-sm wb-book-expand" data-book-id="${escapeAttr(book.id)}">${isOpen ? '收起' : '展开'}</button>
            <strong style="flex:1;">${escapeHtml(book.name || '世界书')}</strong>
            <span class="text-hint">${totalItems} 条</span>
            <label style="font-size:12px;"><input type="checkbox" class="wb-enabled" data-id="${escapeAttr(book.id)}" ${bookEnabled} /> 整本启用</label>
            <button type="button" class="btn btn-outline btn-sm wb-rename" data-id="${escapeAttr(book.id)}">重命名</button>
            <button type="button" class="btn btn-outline btn-sm wb-add-group" data-book-id="${escapeAttr(book.id)}">+分组</button>
            <button type="button" class="btn btn-outline btn-sm wb-add-item" data-book-id="${escapeAttr(book.id)}" data-group-id="">+条目</button>
            <button type="button" class="btn btn-outline btn-sm wb-del-one" data-id="${escapeAttr(book.id)}">删整本</button>
          </div>
        </div>
        ${isOpen ? `
          <div class="wb-sort-zone" data-zone-kind="group" data-parent-id="${escapeAttr(book.id)}">${subGroupBlocks}</div>
          <div class="wb-sort-zone" data-zone-kind="item" data-parent-id="book:${escapeAttr(book.id)}">${ungrouped.map(renderItemRow).join('')}</div>
        ` : ''}`;
    }).join('');
    return `${batchBar}${blocks || '<div class="placeholder-page"><div class="placeholder-text">暂无数据</div></div>'}`;
  }

  container.classList.add('world-book-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn wb-back" aria-label="返回">‹</button>
      <h1 class="navbar-title">世界书</h1>
      <div style="display:flex;gap:4px;">
        <button type="button" class="navbar-btn wb-import" title="导入">↓</button>
      </div>
    </header>
    <input type="file" class="wb-file-json" accept=".json,application/json" style="position:absolute;width:0;height:0;opacity:0;pointer-events:none" tabindex="-1" />
    <div class="wb-tabs">${TABS.map((t) => `<button type="button" class="wb-tab${t.key === activeTab ? ' active' : ''}" data-tab="${escapeAttr(t.key)}">${escapeHtml(t.label)}</button>`).join('')}</div>
    <div class="page-scroll wb-list"></div>
  `;
  const listEl = container.querySelector('.wb-list');

  async function saveEntry(e) { await db.put('worldBooks', e); }
  async function toggleEnabled(id, enabled) {
    const target = entries.find((e) => e.id === id);
    if (!target) return;
    await saveEntry({ ...target, enabled });
  }
  async function deleteByIdCascade(id) {
    const target = entries.find((e) => e.id === id);
    if (!target) return;
    if (target.kind === 'group' && target.isBookRoot) {
      const related = entries.filter((e) => (e.bookId || '') === target.id || e.id === target.id);
      await Promise.all(related.map((e) => db.del('worldBooks', e.id)));
      return;
    }
    if (target.kind === 'group') {
      const children = entries.filter((e) => e.groupId === target.id || e.id === target.id);
      await Promise.all(children.map((e) => db.del('worldBooks', e.id)));
      return;
    }
    await db.del('worldBooks', id);
    if (WORLD_BOOKS.some((w) => w.id === id)) await hideSeedEntry(id);
  }
  async function openItemEditor(seed) {
    const e = seed?.id ? seed : {
      id: `wb_user_${Date.now()}`,
      kind: 'item',
      bookId: seed?.bookId || '',
      groupId: seed?.groupId || '',
      name: '',
      category: 'custom',
      season: 'all',
      keys: [],
      content: '',
      constant: false,
      selective: false,
      enabled: true,
      position: Date.now(),
      depth: 4,
    };
    const { close, root } = (function openModal(innerHtml) {
      const host = document.getElementById('modal-container');
      if (!host) return { close: () => {}, root: null };
      host.classList.add('active');
      host.innerHTML = `<div class="modal-overlay" data-modal-overlay><div class="modal-sheet modal-sheet-tall" data-modal-sheet>${innerHtml}</div></div>`;
      const close = () => { host.classList.remove('active'); host.innerHTML = ''; };
      host.querySelector('[data-modal-sheet]')?.addEventListener('click', (ev) => ev.stopPropagation());
      host.querySelector('[data-modal-overlay]')?.addEventListener('click', close);
      return { close, root: host };
    })(`
      <div class="modal-header"><h3>编辑条目</h3><button type="button" class="navbar-btn wb-m-close">✕</button></div>
      <div class="modal-body">
        <input class="form-input wb-f-name" placeholder="名称" value="${escapeAttr(e.name || '')}" />
        <input class="form-input wb-f-cat" placeholder="分类 custom/timeline/..." value="${escapeAttr(e.category || 'custom')}" style="margin-top:8px;" />
        <input class="form-input wb-f-season" placeholder="赛季 all/S8" value="${escapeAttr(e.season || 'all')}" style="margin-top:8px;" />
        <textarea class="form-input wb-f-keys" rows="3" style="margin-top:8px;" placeholder="关键词每行一个">${escapeHtml((e.keys || []).join('\n'))}</textarea>
        <textarea class="form-input wb-f-content" rows="10" style="margin-top:8px;" placeholder="内容">${escapeHtml(e.content || '')}</textarea>
        <button type="button" class="btn btn-primary wb-f-save" style="width:100%;margin-top:8px;">保存</button>
      </div>`);
    if (!root) return;
    root.querySelector('.wb-m-close')?.addEventListener('click', close);
    root.querySelector('.wb-f-save')?.addEventListener('click', async () => {
      const name = (root.querySelector('.wb-f-name')?.value || '').trim();
      const category = (root.querySelector('.wb-f-cat')?.value || 'custom').trim();
      const season = (root.querySelector('.wb-f-season')?.value || 'all').trim() || 'all';
      const keys = (root.querySelector('.wb-f-keys')?.value || '').split('\n').map((x) => x.trim()).filter(Boolean);
      const content = root.querySelector('.wb-f-content')?.value || '';
      await saveEntry({ ...e, name: name || '未命名', category, season, keys, content, kind: 'item' });
      close();
      await refresh();
    });
  }

  async function refresh() {
    await loadEntries();
    listEl.innerHTML = buildListHtml();
    bindActions();
  }

  async function persistZoneOrder(zoneEl) {
    const ids = [...zoneEl.children].filter((el) => el.classList.contains('wb-sortable')).map((el) => el.dataset.sortId);
    let n = 0;
    for (const id of ids) {
      const target = entries.find((e) => e.id === id);
      if (!target) continue;
      await saveEntry({ ...target, position: n++ });
    }
    await refresh();
  }

  function bindDnD() {
    let dragging = null;
    container.querySelectorAll('.wb-sortable').forEach((el) => {
      el.addEventListener('dragstart', () => { dragging = el; });
      el.addEventListener('dragend', () => { dragging = null; });
    });
    container.querySelectorAll('.wb-sort-zone').forEach((zone) => {
      zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        const after = [...zone.querySelectorAll('.wb-sortable')].find((it) => {
          const r = it.getBoundingClientRect();
          return e.clientY < r.top + r.height / 2;
        });
        if (!dragging) return;
        if (!after) zone.appendChild(dragging);
        else zone.insertBefore(dragging, after);
      });
      zone.addEventListener('drop', async (e) => {
        e.preventDefault();
        await persistZoneOrder(zone);
      });
    });
  }

  function bindActions() {
    bindDnD();
    container.querySelectorAll('.wb-book-expand').forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.dataset.bookId;
      if (expandedBooks.has(id)) expandedBooks.delete(id);
      else expandedBooks.add(id);
      await refresh();
    }));
    container.querySelectorAll('.wb-enabled').forEach((el) => el.addEventListener('change', async () => {
      await toggleEnabled(el.dataset.id, !!el.checked);
      await refresh();
    }));
    container.querySelectorAll('.wb-rename').forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const target = entries.find((e) => e.id === id);
      if (!target) return;
      const n = window.prompt('新名称', target.name || '');
      if (n == null) return;
      await saveEntry({ ...target, name: String(n).trim() || target.name || '未命名' });
      await refresh();
    }));
    container.querySelectorAll('.wb-del-one').forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!window.confirm('确认删除？')) return;
      await deleteByIdCascade(id);
      selectedIds.delete(id);
      await refresh();
    }));
    container.querySelectorAll('.wb-select').forEach((el) => el.addEventListener('change', () => {
      const id = el.dataset.id;
      if (el.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      listEl.innerHTML = buildListHtml();
      bindActions();
    }));
    container.querySelector('.wb-batch-enable')?.addEventListener('click', async () => {
      for (const id of selectedIds) await toggleEnabled(id, true);
      await refresh();
    });
    container.querySelector('.wb-batch-disable')?.addEventListener('click', async () => {
      for (const id of selectedIds) await toggleEnabled(id, false);
      await refresh();
    });
    container.querySelector('.wb-batch-delete')?.addEventListener('click', async () => {
      if (!selectedIds.size) return;
      if (!window.confirm(`确认删除已选 ${selectedIds.size} 项？`)) return;
      for (const id of [...selectedIds]) await deleteByIdCascade(id);
      selectedIds.clear();
      await refresh();
    });
    container.querySelectorAll('.wb-add-group').forEach((btn) => btn.addEventListener('click', async () => {
      const bookId = btn.dataset.bookId;
      const name = window.prompt('分组名称', '新分组');
      if (!name) return;
      await saveEntry({
        id: `wb_grp_user_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        kind: 'group',
        isBookRoot: false,
        name: String(name).trim() || '新分组',
        category: 'custom',
        season: 'all',
        enabled: true,
        parentGroupId: bookId,
        bookId,
        position: Date.now(),
      });
      expandedBooks.add(bookId);
      await refresh();
    }));
    container.querySelectorAll('.wb-add-item').forEach((btn) => btn.addEventListener('click', async () => {
      const bookId = btn.dataset.bookId || '';
      const groupId = btn.dataset.groupId || '';
      await openItemEditor({ bookId, groupId });
    }));
    container.querySelectorAll('[data-kind="item"]').forEach((card) => {
      card.addEventListener('dblclick', async () => {
        const id = card.dataset.sortId;
        const target = entries.find((e) => e.id === id);
        if (target) await openItemEditor(target);
      });
    });
  }

  const fileInput = container.querySelector('.wb-file-json');
  container.querySelector('.wb-import')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      const { entries: imported, warnings } = importWorldBookFromJsonText(text, { sourceName: f.name });
      if (!imported.length) {
        showToast(warnings[0] || '没有可导入条目');
        return;
      }
      await db.putMany('worldBooks', imported);
      const root = imported.find((x) => x.isBookRoot);
      if (root?.id) expandedBooks.add(root.id);
      showToast(`已导入 ${imported.filter((x) => x.kind !== 'group').length} 条到「${root?.name || f.name}」`);
      await refresh();
    } catch (e) {
      showToast(String(e?.message || e));
    }
  });

  container.querySelector('.wb-back')?.addEventListener('click', () => back());
  container.querySelectorAll('.wb-tab').forEach((btn) => {
    btn.addEventListener('click', async () => {
      activeTab = btn.dataset.tab || 'all';
      container.querySelectorAll('.wb-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      await refresh();
    });
  });

  await refresh();
  void navigate;
}
