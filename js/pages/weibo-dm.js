import { back } from '../core/router.js';
import * as db from '../core/db.js';
import { chat as apiChat } from '../core/api.js';
import { getState } from '../core/state.js';
import { getVirtualNow } from '../core/virtual-time.js';
import { showToast } from '../components/toast.js';

function e(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function t(ts) {
  return new Date(ts || Date.now()).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getWeiboDmKey(ownerUserId, profileKey) {
  return `weiboDmBox_${ownerUserId}_${profileKey}`;
}

export default async function render(container, params) {
  const currentUserId = (await db.get('settings', 'currentUserId'))?.value || '';
  const ownerUserId = params?.ownerUserId || currentUserId || 'guest';
  const profileKey = String(params?.profileKey || currentUserId || 'user');
  const profileName = String(params?.profileName || '主页');
  const boxKey = getWeiboDmKey(ownerUserId, profileKey);
  const boxRow = await db.get('settings', boxKey);
  const messages = (Array.isArray(boxRow?.value) ? boxRow.value : []).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const season = getState('currentUser')?.currentTimeline || 'S8';

  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn wbdm-back">‹</button>
      <h1 class="navbar-title">${e(profileName)} · 粉丝私信</h1>
      <button type="button" class="navbar-btn wbdm-gen">⚡</button>
    </header>
    <div class="page-scroll" style="padding:10px 12px 24px;">
      <div class="card-block" style="display:flex;justify-content:space-between;align-items:center;">
        <strong>收件箱</strong>
        <button type="button" class="btn btn-sm btn-outline wbdm-clear">清空</button>
      </div>
      <div class="card-block">
        ${messages.map((m) => `
          <div class="weibo-dm-row">
            <div class="weibo-dm-meta">${e(m.senderName || '匿名')} · ${e(m.senderType || '粉丝')} · ${e(t(m.timestamp))}</div>
            <div class="weibo-dm-text">${e(m.content || '')}</div>
          </div>
        `).join('') || '<div class="text-hint">暂无私信，点右上角 ⚡ 可生成</div>'}
      </div>
    </div>
  `;

  container.querySelector('.wbdm-back')?.addEventListener('click', () => back());
  container.querySelector('.wbdm-clear')?.addEventListener('click', async () => {
    await db.put('settings', { key: boxKey, value: [] });
    await render(container, params);
  });
  container.querySelector('.wbdm-gen')?.addEventListener('click', async () => {
    const nowTs = await getVirtualNow(currentUserId || '', 0);
    const prompt = [
      `当前赛季: ${season}`,
      `当前虚拟时间: ${new Date(nowTs).toISOString().replace('T', ' ').slice(0, 16)}`,
      `收件人主页: ${profileName} (${profileKey})`,
      '请生成 4-8 条微博私信，发送者可包含粉丝/黑子/梦女/梦男/同行/营销号/广告商。',
      '只输出 JSON: {"dms":[{"senderName":"昵称","senderType":"类型","content":"私信内容"}]}',
    ].join('\n');
    try {
      const raw = await apiChat(
        [{ role: 'system', content: '你是微博私信生成器，只输出合法JSON。' }, { role: 'user', content: prompt }],
        { temperature: 0.9, maxTokens: 900 }
      );
      const text = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const parsed = JSON.parse(text);
      const prev = Array.isArray((await db.get('settings', boxKey))?.value) ? (await db.get('settings', boxKey)).value : [];
      const next = [...prev];
      for (const dm of (parsed?.dms || []).slice(0, 10)) {
        next.push({
          id: `wb_dm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          senderName: String(dm?.senderName || '路人粉'),
          senderType: String(dm?.senderType || '粉丝'),
          content: String(dm?.content || '').trim(),
          timestamp: nowTs - Math.floor(Math.random() * 1800_000),
        });
      }
      await db.put('settings', { key: boxKey, value: next.slice(-120) });
      showToast('已生成粉丝私信');
      await render(container, params);
    } catch (err) {
      showToast(`生成失败：${err?.message || '未知错误'}`);
    }
  });
}

