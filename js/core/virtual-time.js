import * as db from './db.js';

function scheduleKey(userId) {
  return `lifeSchedule_${userId}`;
}

export async function getVirtualNow(userId, fallback = Date.now()) {
  if (!userId) return fallback;
  const row = await db.get('settings', scheduleKey(userId));
  const v = row?.value || {};
  return typeof v.virtualNow === 'number' ? v.virtualNow : fallback;
}

export async function allocateVirtualTimestamps(userId, count = 1, stepMs = 15000) {
  const c = Math.max(1, Number(count) || 1);
  const step = Math.max(1000, Number(stepMs) || 15000);
  const base = await getVirtualNow(userId, Date.now());
  const out = [];
  for (let i = 0; i < c; i++) out.push(base + i * step);
  if (userId) {
    const row = await db.get('settings', scheduleKey(userId));
    const v = row?.value || {};
    await db.put('settings', { key: scheduleKey(userId), value: { ...v, virtualNow: base + c * step } });
  }
  return out;
}

