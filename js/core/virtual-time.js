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

/**
 * 供 AI 提示词使用：完整日期、星期、钟点、时段标签（基于 getVirtualNow，本地时区展示）
 */
export async function buildVirtualTimeSnippet(userId, fallback = Date.now()) {
  const now = await getVirtualNow(userId, fallback);
  const d = new Date(now);
  const y = d.getFullYear();
  const mo = d.getMonth() + 1;
  const day = d.getDate();
  const h = d.getHours();
  const mi = d.getMinutes();
  const wdNames = ['日', '一', '二', '三', '四', '五', '六'];
  const wd = wdNames[d.getDay()];
  let slot = '深夜/凌晨';
  if (h >= 5 && h < 9) slot = '清晨';
  else if (h >= 9 && h < 12) slot = '上午';
  else if (h >= 12 && h < 14) slot = '中午';
  else if (h >= 14 && h < 18) slot = '下午';
  else if (h >= 18 && h < 23) slot = '晚间';

  const clock = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  const isoLike = `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')} ${clock}`;
  const line = `${y}年${mo}月${day}日 星期${wd} ${clock}（约${slot}）`;

  return { now, line, isoLike, clock, slot };
}

/**
 * 注入 assembleContext 的 [世界内时间] 长说明（与 buildVirtualTimeSnippet 同源锚点）
 */
export async function getVirtualTimePromptForAi(userId, fallback = Date.now()) {
  const { line, isoLike, slot } = await buildVirtualTimeSnippet(userId, fallback);
  return `[世界内时间·剧情锚定]
锚定：${line}
（刻度参考：${isoLike}；角色台词勿机械背诵本行数字）
感知要求：
1) 这是存档中的「故事世界时钟」，与手机真实日期/时区无关；用户可能在「此刻」等界面推进或修改虚拟时间，你必须以本锚点为唯一权威。
2) 「今天、明天、昨晚、上周、周末、刚下课、一会训练、午饭点、收工」等全部按该世界线理解，禁止按现实日历臆断剧情排期或赛事节点。
3) 聊天记录里每条消息的时间戳也在同一条虚拟时间轴上：越早的消息对应越早的虚拟时刻；不要用现实今天是星期几去硬套角色口中的星期几。
4) 描写熬夜、早起、迟到、摸鱼、食堂/训练馆是否还开着等细节前，先对照钟点与星期；当前约「${slot}」，避免把白天写成深夜收工、把深夜写成午饭闲聊。
5) 结合当前赛季（时间线）理解宏观节奏：赛段、休赛期、转会传闻等要与世界线月份/季节感相容，避免百年错位式口误。
6) 「差一点、一点点、发晕一点」等仍是程度口语，不要误判为具体钟点（如凌晨一点）。`;
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

