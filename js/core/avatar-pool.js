import * as db from './db.js';

function toArray(x) {
  return Array.isArray(x) ? x : [];
}

function normalizePath(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  if (/^(data:|https?:|blob:)/i.test(raw)) return raw;
  return raw.startsWith('assets/') ? raw : `assets/passerby-avatars/${raw}`;
}

function hashSeed(seed = '') {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h << 5) - h + s.charCodeAt(i);
  return Math.abs(h);
}

export function pickPasserbyAvatar(pool = [], seed = '') {
  const list = toArray(pool).map(normalizePath).filter(Boolean);
  if (!list.length) return '';
  const idx = hashSeed(seed || 'npc') % list.length;
  return list[idx] || '';
}

export async function loadPasserbyAvatarPool() {
  const row = await db.get('settings', 'passerbyAvatarPool');
  const saved = toArray(row?.value).map(normalizePath).filter(Boolean);
  if (saved.length) return saved;
  try {
    const res = await fetch('assets/passerby-avatars/manifest.json', { cache: 'no-cache' });
    if (!res.ok) return [];
    const json = await res.json();
    const files = toArray(json?.files).map(normalizePath).filter(Boolean);
    if (files.length) {
      await db.put('settings', { key: 'passerbyAvatarPool', value: files });
    }
    return files;
  } catch (_) {
    return [];
  }
}

