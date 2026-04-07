import { back } from '../core/router.js';
import * as db from '../core/db.js';
import { PROMPTS, PROMPT_CATEGORIES } from '../data/prompts.js';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function presetKey(id) {
  return 'preset_' + id;
}

async function loadPresetRecord(id) {
  const row = await db.get('settings', presetKey(id));
  if (row?.value && typeof row.value === 'object') return row.value;
  const def = PROMPTS[id];
  if (def) return { ...def };
  return null;
}

async function listAllPresetIds() {
  const all = await db.getAll('settings');
  const fromDb = new Set(
    all.filter((r) => r.key && String(r.key).startsWith('preset_')).map((r) => String(r.key).slice('preset_'.length))
  );
  for (const id of Object.keys(PROMPTS)) fromDb.add(id);
  return [...fromDb];
}

async function seedPresetsIfEmpty() {
  const all = await db.getAll('settings');
  const hasAny = all.some((r) => r.key && String(r.key).startsWith('preset_'));
  if (hasAny) return;
  for (const p of Object.values(PROMPTS)) {
    await db.put('settings', { key: presetKey(p.id), value: { id: p.id, name: p.name, category: p.category, content: p.content } });
  }
}

function truncate(s, n = 72) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
}

export default async function render(container) {
  await seedPresetsIfEmpty();

  const tabKeys = [...Object.keys(PROMPT_CATEGORIES), 'custom'];
  let activeTab = tabKeys[0];
  let editingId = null;

  container.classList.add('preset-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn preset-back" aria-label="返回">‹</button>
      <h1 class="navbar-title">预设管理</h1>
      <button type="button" class="navbar-btn preset-add" aria-label="新建">+</button>
    </header>
    <div class="preset-tab-row" role="tablist"></div>
    <div class="page-scroll preset-list"></div>
    <div class="preset-edit" style="display:none;">
      <div class="page-scroll" style="padding-top:12px;">
        <div class="card-block">
          <label class="settings-item-label" style="display:block;margin-bottom:6px;">名称</label>
          <input type="text" class="preset-name-input" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);font-size:var(--font-md);" />
        </div>
        <div class="card-block">
          <label class="settings-item-label" style="display:block;margin-bottom:6px;">分类</label>
          <select class="preset-cat-select" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);font-size:var(--font-md);"></select>
        </div>
        <div class="card-block">
          <label class="settings-item-label" style="display:block;margin-bottom:6px;">内容</label>
          <textarea class="preset-content-input" rows="14" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);font-size:var(--font-sm);font-family:inherit;line-height:1.5;"></textarea>
        </div>
        <button type="button" class="preset-save-btn" style="width:100%;padding:14px;background:var(--primary);color:var(--text-inverse);border:none;border-radius:var(--radius-md);font-size:var(--font-md);font-weight:600;">保存</button>
        <button type="button" class="preset-cancel-btn" style="width:100%;margin-top:10px;padding:12px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);font-size:var(--font-sm);">返回列表</button>
      </div>
    </div>
  `;

  const tabRow = container.querySelector('.preset-tab-row');
  const listEl = container.querySelector('.preset-list');
  const editEl = container.querySelector('.preset-edit');
  const nameInput = container.querySelector('.preset-name-input');
  const catSelect = container.querySelector('.preset-cat-select');
  const contentInput = container.querySelector('.preset-content-input');

  function tabLabel(key) {
    if (key === 'custom') return '自定义';
    return PROMPT_CATEGORIES[key]?.name || key;
  }

  function fillCategorySelect() {
    catSelect.innerHTML = '';
    for (const key of Object.keys(PROMPT_CATEGORIES)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = PROMPT_CATEGORIES[key].name;
      catSelect.appendChild(opt);
    }
    const o2 = document.createElement('option');
    o2.value = 'custom';
    o2.textContent = '自定义';
    catSelect.appendChild(o2);
  }

  fillCategorySelect();

  function renderTabs() {
    tabRow.innerHTML = tabKeys
      .map(
        (key) => `
      <button type="button" role="tab" class="preset-tab${key === activeTab ? ' active' : ''}" data-tab="${escapeHtml(key)}">
        ${escapeHtml(tabLabel(key))}
      </button>`
      )
      .join('');
    tabRow.querySelectorAll('.preset-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        renderTabs();
        renderList();
      });
    });
  }

  async function renderList() {
    const ids = await listAllPresetIds();
    const items = [];
    for (const id of ids) {
      const rec = await loadPresetRecord(id);
      if (!rec) continue;
      if (activeTab === 'custom') {
        if (rec.category !== 'custom') continue;
      } else if (rec.category !== activeTab) continue;
      items.push(rec);
    }
    items.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));

    if (!items.length) {
      listEl.innerHTML = `<div class="placeholder-page" style="min-height:200px;"><div class="placeholder-text">该分类暂无预设</div></div>`;
      return;
    }

    listEl.innerHTML = items
      .map(
        (p) => `
      <div class="card-block preset-card" data-preset-id="${escapeHtml(p.id)}" role="button" tabindex="0">
        <div style="font-weight:600;font-size:var(--font-md);">${escapeHtml(p.name || p.id)}</div>
        <div style="font-size:var(--font-sm);color:var(--text-secondary);margin-top:6px;">${escapeHtml(truncate(p.content))}</div>
      </div>`
      )
      .join('');

    listEl.querySelectorAll('.preset-card').forEach((el) => {
      const open = async () => {
        editingId = el.dataset.presetId;
        const rec = await loadPresetRecord(editingId);
        if (!rec) return;
        nameInput.value = rec.name || '';
        catSelect.value = rec.category === 'custom' ? 'custom' : rec.category in PROMPT_CATEGORIES ? rec.category : 'custom';
        contentInput.value = rec.content || '';
        tabRow.style.display = 'none';
        listEl.style.display = 'none';
        editEl.style.display = 'block';
        container.querySelector('.preset-add').style.visibility = 'hidden';
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });
  }

  function showListView() {
    editingId = null;
    editEl.style.display = 'none';
    listEl.style.display = 'block';
    tabRow.style.display = 'flex';
    container.querySelector('.preset-add').style.visibility = 'visible';
    renderList();
  }

  container.querySelector('.preset-back').addEventListener('click', () => {
    if (editEl.style.display === 'block') showListView();
    else back();
  });

  container.querySelector('.preset-add').addEventListener('click', () => {
    editingId = 'custom_' + Date.now();
    nameInput.value = '新预设';
    catSelect.value = activeTab === 'custom' ? 'custom' : activeTab;
    contentInput.value = '';
    tabRow.style.display = 'none';
    listEl.style.display = 'none';
    editEl.style.display = 'block';
    container.querySelector('.preset-add').style.visibility = 'hidden';
  });

  container.querySelector('.preset-cancel-btn').addEventListener('click', () => showListView());

  container.querySelector('.preset-save-btn').addEventListener('click', async () => {
    const id = editingId;
    if (!id) return;
    const name = nameInput.value.trim() || '未命名';
    let category = catSelect.value;
    if (!(category in PROMPT_CATEGORIES) && category !== 'custom') category = 'custom';
    const content = contentInput.value;
    await db.put('settings', { key: presetKey(id), value: { id, name, category, content } });
    showListView();
  });

  renderTabs();
  await renderList();
}
