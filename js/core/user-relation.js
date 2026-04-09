import * as db from './db.js';

const USER_RELATION_KEY = 'userRelationConfig';

function toNum(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

export async function getRelationSnapshot(userId, characterId) {
  if (!userId || !characterId) return null;
  const row = await db.get('settings', USER_RELATION_KEY);
  const byUserId = row?.value?.byUserId || {};
  const pack = byUserId[userId] || { profile: {}, relations: {} };
  const rel = pack.relations?.[characterId] || { affection: 35, desire: 20, bond: 30, known: false };
  return {
    affection: toNum(rel.affection, 35),
    desire: toNum(rel.desire, 20),
    bond: toNum(rel.bond, 30),
    known: rel.known === true,
  };
}

export async function getLatestRelationDelta(userId, characterId) {
  if (!userId || !characterId) return null;
  const row = await db.get('settings', `userRelationDeltaLog_${userId}_${characterId}`);
  const list = Array.isArray(row?.value) ? row.value : [];
  return list[0] || null;
}

function parseExplicitDelta(text = '') {
  const t = String(text || '');
  const patterns = [
    { key: 'affection', re: /好感(?:度)?\s*[:：]?\s*([+\-]?\d+(?:\.\d+)?)/ig },
    { key: 'desire', re: /欲望(?:值)?\s*[:：]?\s*([+\-]?\d+(?:\.\d+)?)/ig },
    { key: 'bond', re: /关系(?:值)?\s*[:：]?\s*([+\-]?\d+(?:\.\d+)?)/ig },
  ];
  const out = { affection: 0, desire: 0, bond: 0 };
  let hit = false;
  for (const p of patterns) {
    let m;
    while ((m = p.re.exec(t))) {
      out[p.key] += toNum(m[1], 0);
      hit = true;
    }
  }
  return hit ? out : null;
}

function evalDelta(text = '') {
  const explicit = parseExplicitDelta(text);
  if (explicit) return explicit;
  const t = String(text || '');
  const mult = Math.min(1.5, 1 + (t.match(/[！!]{2,}|[?？]{2,}|！！|？？/g)?.length || 0) * 0.2);
  const directedAtUser = /(?:^|[，。！？\s])(?:你|你们|给你|对你|和你|邀你|拉你|@你|@用户)(?:$|[，。！？\s])/i.test(t);
  let affection = 0;
  let desire = 0;
  let bond = 0;

  // 情绪亲近
  if (/谢谢|辛苦|抱抱|晚安|喜欢|在意|关心|陪你|放心|我在|别怕|想你|信你|懂你/.test(t)) affection += 0.9;
  if (/亲|吻|暧昧|心动|脸红|想抱|想亲|撩|贴贴|色色|欲|占有|吃醋/.test(t)) desire += 1.0;
  if (/一起|约|拉你|邀请|进群|并肩|配合|复盘|训练|合作|战术|联动|组队/.test(t)) bond += 1.0;

  // 冲突疏离
  // 负向变化仅在明显对用户定向时生效，避免群聊“泛吐槽”误扣到用户关系
  if (directedAtUser && /烦|滚|闭嘴|讨厌|不想理|别来|看不顺眼|阴阳怪气|拉黑|懒得/.test(t)) affection -= 0.95;
  if (directedAtUser && /不许|管太多|控制|占有欲|嫉妒到|吃醋到/.test(t)) desire += 0.35;
  if (directedAtUser && /散了|算了|各走各的|别合作|不配合|拆伙|冷处理/.test(t)) bond -= 0.95;

  // 语气方向（粗略）
  if (/哈哈|笑死|可爱|好耶|稳了|行|可以|没问题/.test(t)) {
    affection += 0.3;
    bond += 0.25;
  }
  if (directedAtUser && /失望|无语|算你狠|呵呵|就这|不行|离谱/.test(t)) {
    affection -= 0.35;
    bond -= 0.3;
  }

  affection = Number((affection * mult).toFixed(2));
  desire = Number((desire * mult).toFixed(2));
  bond = Number((bond * mult).toFixed(2));
  if (!affection && !desire && !bond) return null;
  return { affection, desire, bond };
}

export async function applyRelationDeltaFromMessage({ userId, characterId, messageId, text = '', timestamp = Date.now() }) {
  if (!userId || !characterId || !messageId) return null;
  const appliedKey = `userRelationDeltaApplied_${messageId}`;
  if ((await db.get('settings', appliedKey))?.value) return { checked: true, delta: null };
  const delta = evalDelta(text);
  await db.put('settings', { key: appliedKey, value: true });
  if (!delta) return { checked: true, delta: null };

  const row = await db.get('settings', USER_RELATION_KEY);
  const value = row?.value || { byUserId: {} };
  const byUserId = value.byUserId || {};
  const pack = byUserId[userId] || { profile: {}, relations: {} };
  const prev = pack.relations?.[characterId] || { affection: 35, desire: 20, bond: 30, known: false };
  const next = {
    ...prev,
    affection: toNum(prev.affection, 35) + toNum(delta.affection, 0),
    desire: toNum(prev.desire, 20) + toNum(delta.desire, 0),
    bond: toNum(prev.bond, 30) + toNum(delta.bond, 0),
  };
  pack.relations = { ...(pack.relations || {}), [characterId]: next };
  byUserId[userId] = pack;
  await db.put('settings', { key: USER_RELATION_KEY, value: { ...value, byUserId } });

  const logKey = `userRelationDeltaLog_${userId}_${characterId}`;
  const prevLog = (await db.get('settings', logKey))?.value;
  const list = Array.isArray(prevLog) ? prevLog : [];
  const entry = {
    ts: Number(timestamp || Date.now()),
    messageId,
    delta,
    preview: String(text || '').slice(0, 72),
  };
  await db.put('settings', { key: logKey, value: [entry, ...list].slice(0, 30) });
  return { checked: true, before: prev, after: next, delta };
}
