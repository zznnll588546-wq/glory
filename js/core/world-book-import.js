/**
 * 解析 SillyTavern / 常见世界书 JSON，转为本应用 worldBooks 条目。
 * 参考：entries.{ "0": { name, content, key[], constant, ... }, ... }
 */

function mapStEntry(uidKey, raw, batchId, seqIdx) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.disable === true) return null;
  const keys = [...(Array.isArray(raw.key) ? raw.key : []), ...(Array.isArray(raw.keysecondary) ? raw.keysecondary : [])]
    .map((x) => String(x).trim())
    .filter(Boolean);
  const name = String(raw.name || raw.comment || '导入条目').trim() || '未命名';
  const pos = Number(raw.order ?? raw.display_index ?? raw.position);
  return {
    id: `wb_imp_${batchId}_${seqIdx}_${raw.uid ?? uidKey}`,
    name,
    category: 'custom',
    season: 'all',
    keys,
    content: String(raw.content ?? ''),
    constant: !!raw.constant,
    selective: !!raw.selective,
    position: Number.isFinite(pos) ? pos : 100,
    depth: Number(raw.depth) || 4,
  };
}

/**
 * @param {string} text - JSON 文件全文
 * @returns {{ entries: object[], warnings: string[] }}
 */
export function importWorldBookFromJsonText(text) {
  const warnings = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 解析失败：${e.message || e}`);
  }

  const batchId = Date.now();
  const out = [];

  if (Array.isArray(data?.entries)) {
    let seq = 0;
    data.entries.forEach((raw, i) => {
      const m = mapStEntry(String(i), raw, batchId, seq++);
      if (m) out.push(m);
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
    for (const k of keys) {
      const m = mapStEntry(k, entriesObj[k], batchId, seq++);
      if (m) out.push(m);
    }
    if (!out.length) warnings.push('未找到可导入条目（可能全部 disable 或结构不符）');
    return { entries: out, warnings };
  }

  if (Array.isArray(data)) {
    let seq = 0;
    data.forEach((raw, i) => {
      const m = mapStEntry(String(i), raw, batchId, seq++);
      if (m) out.push(m);
    });
    return { entries: out, warnings };
  }

  throw new Error('无法识别世界书格式：需要包含 entries 对象数组，或顶层为条目数组');
}
