/**
 * 解析 SillyTavern / 常见世界书 JSON，转为本应用 worldBooks 条目。
 * 参考：entries.{ "0": { name, content, key[], constant, ... }, ... }
 */

function mapStEntry(uidKey, raw, batchId, seqIdx, rootGroupId = '') {
  if (!raw || typeof raw !== 'object') return null;
  const keys = [...(Array.isArray(raw.key) ? raw.key : []), ...(Array.isArray(raw.keysecondary) ? raw.keysecondary : [])]
    .map((x) => String(x).trim())
    .filter(Boolean);
  const name = String(raw.name || raw.comment || '导入条目').trim() || '未命名';
  const pos = Number(raw.order ?? raw.display_index ?? raw.position);
  return {
    id: `wb_imp_${batchId}_${seqIdx}_${raw.uid ?? uidKey}`,
    kind: 'item',
    name,
    category: 'custom',
    season: 'all',
    keys,
    content: String(raw.content ?? ''),
    constant: !!raw.constant,
    selective: !!raw.selective,
    enabled: raw.disable !== true,
    position: Number.isFinite(pos) ? pos : 100,
    depth: Number(raw.depth) || 4,
    groupId: '',
    bookId: rootGroupId || '',
  };
}

function isGroupDividerEntry(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const name = String(raw.name || raw.comment || '').trim();
  const content = String(raw.content || '').trim();
  if (!name) return false;
  if (content) return false;
  return /^[-—]{1,}.+[-—]{1,}$/.test(name);
}

function mapGroupEntry(raw, batchId, seqIdx, rootGroupId = '') {
  const name = String(raw?.name || raw?.comment || `分组${seqIdx + 1}`).trim();
  return {
    id: `wb_grp_${batchId}_${seqIdx}`,
    kind: 'group',
    name: name.replace(/^[-—\s]+|[-—\s]+$/g, '').trim() || name,
    category: 'custom',
    season: 'all',
    keys: [],
    content: '',
    constant: false,
    selective: false,
    position: seqIdx,
    depth: 1,
    enabled: true,
    parentGroupId: rootGroupId || '',
    bookId: rootGroupId || '',
  };
}

/**
 * @param {string} text - JSON 文件全文
 * @returns {{ entries: object[], warnings: string[] }}
 */
export function importWorldBookFromJsonText(text, options = {}) {
  const warnings = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 解析失败：${e.message || e}`);
  }

  const batchId = Date.now();
  const out = [];
  const sourceNameRaw = String(options?.sourceName || `导入世界书_${batchId}`).trim();
  const sourceName = sourceNameRaw.replace(/\.json$/i, '') || `导入世界书_${batchId}`;
  const rootGroupId = `wb_book_${batchId}`;
  out.push({
    id: rootGroupId,
    kind: 'group',
    isBookRoot: true,
    name: sourceName,
    category: 'custom',
    season: 'all',
    keys: [],
    content: '',
    constant: false,
    selective: false,
    enabled: true,
    position: 0,
    depth: 1,
  });

  if (Array.isArray(data?.entries)) {
    let seq = 0;
    let currentGroupId = '';
    data.entries.forEach((raw, i) => {
      if (isGroupDividerEntry(raw)) {
        const grp = mapGroupEntry(raw, batchId, seq++, rootGroupId);
        currentGroupId = grp.id;
        out.push(grp);
        return;
      }
      const m = mapStEntry(String(i), raw, batchId, seq++, rootGroupId);
      if (m) {
        m.groupId = m.groupId || currentGroupId || '';
        out.push(m);
      }
    });
    if (!out.length) warnings.push('未找到可导入条目（可能全部 disable 或结构不符）');
    return { entries: out, warnings };
  }

  let entriesObj = data?.entries;
  if (!entriesObj && data?.data?.entries && !Array.isArray(data.data.entries)) {
    entriesObj = data.data.entries;
  }

  if (entriesObj && typeof entriesObj === 'object' && !Array.isArray(entriesObj)) {
    const keys = Object.keys(entriesObj).sort((a, b) => Number(a) - Number(b));
    let seq = 0;
    let currentGroupId = '';
    for (const k of keys) {
      const raw = entriesObj[k];
      if (isGroupDividerEntry(raw)) {
        const grp = mapGroupEntry(raw, batchId, seq++, rootGroupId);
        currentGroupId = grp.id;
        out.push(grp);
        continue;
      }
      const m = mapStEntry(k, raw, batchId, seq++, rootGroupId);
      if (m) {
        m.groupId = m.groupId || String(raw?.group || '').trim() || currentGroupId || '';
        out.push(m);
      }
    }
    if (!out.length) warnings.push('未找到可导入条目（可能全部 disable 或结构不符）');
    return { entries: out, warnings };
  }

  if (Array.isArray(data)) {
    let seq = 0;
    let currentGroupId = '';
    data.forEach((raw, i) => {
      if (isGroupDividerEntry(raw)) {
        const grp = mapGroupEntry(raw, batchId, seq++, rootGroupId);
        currentGroupId = grp.id;
        out.push(grp);
        return;
      }
      const m = mapStEntry(String(i), raw, batchId, seq++, rootGroupId);
      if (m) {
        m.groupId = m.groupId || String(raw?.group || '').trim() || currentGroupId || '';
        out.push(m);
      }
    });
    return { entries: out, warnings };
  }

  throw new Error('无法识别世界书格式：需要包含 entries 对象数组，或顶层为条目数组');
}
