import * as db from './db.js';

function scheduleKey(userId) {
  return `lifeSchedule_${userId}`;
}

export function seasonStartVirtualTs(seasonId = 'S8') {
  const sid = String(seasonId || 'S8').toUpperCase();
  const m = sid.match(/^S(\d{1,2})$/);
  let year = 2022; // S8 fallback
  if (m) {
    const n = Number(m[1]);
    year = n === 0 ? 2012 : 2014 + n; // S1->2015 ... S10->2024
  }
  // 统一锚点：赛季开始前的 8/1 09:00（本地时区）
  return new Date(year, 7, 1, 9, 0, 0, 0).getTime();
}

function normalizeScheduleRecord(raw, fallbackNow) {
  const v = raw && typeof raw === 'object' ? { ...raw } : {};
  // 兼容旧结构：只有 virtualNow
  const legacyNow = typeof v.virtualNow === 'number' ? v.virtualNow : null;
  if (typeof v.anchorVirtual !== 'number') v.anchorVirtual = legacyNow ?? fallbackNow;
  if (typeof v.anchorReal !== 'number') v.anchorReal = Date.now();
  if (typeof v.speed !== 'number' || !Number.isFinite(v.speed) || v.speed <= 0) v.speed = 1;
  if (typeof v.paused !== 'boolean') v.paused = false;
  if (!Array.isArray(v.todos)) v.todos = [];
  if (!Array.isArray(v.completed)) v.completed = [];
  // 保留旧字段，便于其它页面渐进迁移
  v.virtualNow = v.anchorVirtual;
  return v;
}

export async function ensureLifeSchedule(userId, seasonId = 'S8') {
  if (!userId) return null;
  const key = scheduleKey(userId);
  const row = await db.get('settings', key);
  const fallback = seasonStartVirtualTs(seasonId);
  const normalized = normalizeScheduleRecord(row?.value, fallback);
  if (!row?.value || JSON.stringify(row.value) !== JSON.stringify(normalized)) {
    await db.put('settings', { key, value: normalized });
  }
  return normalized;
}

export async function resetLifeScheduleToSeasonStart(userId, seasonId = 'S8') {
  if (!userId) return;
  const key = scheduleKey(userId);
  const start = seasonStartVirtualTs(seasonId);
  const nowReal = Date.now();
  const row = await db.get('settings', key);
  const prev = row?.value && typeof row.value === 'object' ? row.value : {};
  await db.put('settings', {
    key,
    value: {
      ...prev,
      anchorVirtual: start,
      anchorReal: nowReal,
      virtualNow: start,
      speed: 1,
      paused: false,
      todos: Array.isArray(prev.todos) ? prev.todos : [],
      completed: Array.isArray(prev.completed) ? prev.completed : [],
    },
  });
}

export async function advanceVirtualTime(userId, deltaMs = 0, fallbackSeasonId = 'S8') {
  if (!userId) return;
  const now = await getVirtualNow(userId, seasonStartVirtualTs(fallbackSeasonId));
  const next = Math.max(0, Number(now || 0) + Number(deltaMs || 0));
  const row = await db.get('settings', scheduleKey(userId));
  const normalized = normalizeScheduleRecord(row?.value, next);
  await db.put('settings', {
    key: scheduleKey(userId),
    value: {
      ...normalized,
      anchorVirtual: next,
      anchorReal: Date.now(),
      virtualNow: next,
    },
  });
}

export async function getVirtualNow(userId, fallback = Date.now()) {
  if (!userId) return fallback;
  const row = await db.get('settings', scheduleKey(userId));
  const fallbackNow = Number.isFinite(Number(fallback)) ? Number(fallback) : Date.now();
  const normalized = normalizeScheduleRecord(row?.value, fallbackNow);
  if (!row?.value || JSON.stringify(row.value) !== JSON.stringify(normalized)) {
    await db.put('settings', { key: scheduleKey(userId), value: normalized });
  }
  if (normalized.paused) return normalized.anchorVirtual;
  const elapsedReal = Math.max(0, Date.now() - normalized.anchorReal);
  const now = normalized.anchorVirtual + elapsedReal * normalized.speed;
  return now;
}

export async function allocateVirtualTimestamps(userId, count = 1, stepMs = 15000) {
  const c = Math.max(1, Number(count) || 1);
  const step = Math.max(1000, Number(stepMs) || 15000);
  const base = await getVirtualNow(userId, Date.now());
  const out = [];
  for (let i = 0; i < c; i++) out.push(base + i * step);
  if (userId) {
    const row = await db.get('settings', scheduleKey(userId));
    const normalized = normalizeScheduleRecord(row?.value, base);
    const nextAnchor = base + c * step;
    await db.put('settings', {
      key: scheduleKey(userId),
      value: {
        ...normalized,
        anchorVirtual: nextAnchor,
        anchorReal: Date.now(),
        virtualNow: nextAnchor,
      },
    });
  }
  return out;
}

/**
 * 会话内单调递增时间戳（基于虚拟时间，并保证 >= 当前会话最大 timestamp + 1）
 */
export async function allocateChatTimestamps(userId, chatId, count = 1, stepMs = 15000) {
  const raw = await allocateVirtualTimestamps(userId, count, stepMs);
  if (!chatId) return raw;
  const all = await db.getAllByIndex('messages', 'chatId', chatId);
  let cursor = all.reduce((mx, m) => Math.max(mx, Number(m?.timestamp || 0)), 0);
  return raw.map((ts) => {
    const n = Number(ts || 0);
    cursor = Math.max(cursor + 1, n);
    return cursor;
  });
}

