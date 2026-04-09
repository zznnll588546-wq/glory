/** 修正已错误入库的表情名称（如「失望：https」整段被写进 name） */
export function sanitizeStickerDisplayName(raw) {
  let n = String(raw || '').trim();
  if (!n) return '表情';
  n = n.replace(/[：:]\s*https?:\/\/\S*$/i, '').trim();
  n = n.replace(/[：:]\s*https?$/i, '').trim();
  return n || '表情';
}
