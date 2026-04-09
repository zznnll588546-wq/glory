import { navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { getState } from '../core/state.js';
import { TEAMS, teamsEligibleForSchedule } from '../data/teams.js';
import { showToast } from '../components/toast.js';
import { seasonStartVirtualTs } from '../core/virtual-time.js';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function generateRoundRobin(teamIds) {
  let arr = [...teamIds];
  if (arr.length < 2) return [];
  if (arr.length % 2) arr.push('__BYE__');
  const n = arr.length;
  const numRounds = n - 1;
  const half = n / 2;
  const rounds = [];
  for (let r = 0; r < numRounds; r++) {
    const matches = [];
    for (let i = 0; i < half; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a !== '__BYE__' && b !== '__BYE__') {
        matches.push({ home: a, away: b });
      }
    }
    rounds.push(matches);
    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop());
    arr = [fixed, ...rest];
  }
  return rounds;
}

function fmtVirtual(ms) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

async function getUserId() {
  const r = await db.get('settings', 'currentUserId');
  return r?.value || '';
}

function seasonBaseMs(seasonId = 'S8') {
  return seasonStartVirtualTs(seasonId);
}

export default async function render(container) {
  const stUser = getState('currentUser');
  let userId = stUser?.id || (await getUserId());
  if (!userId) {
    container.innerHTML = `<div class="placeholder-page"><div class="placeholder-text">请先选择用户档案</div></div>`;
    return;
  }

  const key = `lifeSchedule_${userId}`;

  async function load() {
    const row = await db.get('settings', key);
    const v = row?.value || {};
    const fallbackNow = seasonBaseMs(season);
    return {
      virtualNow: typeof v.virtualNow === 'number' ? v.virtualNow : fallbackNow,
      todos: Array.isArray(v.todos) ? v.todos : [],
      completed: Array.isArray(v.completed) ? v.completed : [],
    };
  }

  async function save(data) {
    await db.put('settings', { key, value: data });
  }

  const user = stUser?.id === userId ? stUser : (await db.get('users', userId)) || stUser;
  const season = user?.currentTimeline || 'S8';
  let data = await load();

  container.classList.add('now-moment-page', 'page');
  container.innerHTML = `
    <header class="navbar">
      <span class="navbar-btn" style="visibility:hidden"></span>
      <h1 class="navbar-title">此时此刻</h1>
      <button type="button" class="navbar-btn nm-home" aria-label="回桌面">⌂</button>
    </header>
    <div class="nm-body" style="flex:1;overflow-y:auto;padding:12px 16px;padding-bottom:calc(24px + var(--safe-bottom));"></div>
  `;
  const bodyEl = container.querySelector('.nm-body');

  function scheduleSnippetHtml() {
    const teams = teamsEligibleForSchedule(season);
    const ids = teams.map((t) => t.id);
    const rounds = generateRoundRobin(ids);
    if (!rounds.length) {
      return `<p class="nm-muted" style="font-size:var(--font-xs);margin:0;">当前赛季战队不足，暂无单循环参考。</p>`;
    }
    const take = rounds.slice(0, 2);
    return take
      .map((matches, ri) => {
        const rows = matches
          .map((m) => {
            const h = TEAMS[m.home];
            const a = TEAMS[m.away];
            if (!h || !a) return '';
            return `<div class="nm-match">${escapeHtml(h.abbr || h.name)} <span class="nm-vs">vs</span> ${escapeHtml(a.abbr || a.name)}</div>`;
          })
          .join('');
        return `<div class="nm-round"><strong>第${ri + 1}轮</strong>${rows}</div>`;
      })
      .join('');
  }

  function renderInner() {
    const vn = data.virtualNow;
    const completed = [...(data.completed || [])].sort((a, b) => (b.at || 0) - (a.at || 0));
    const todos = data.todos || [];

    bodyEl.innerHTML = `
      <p class="nm-intro" style="font-size:var(--font-xs);color:var(--text-muted);line-height:1.5;margin:0 0 12px;">
        「此时此刻」是个人日程与世界内时钟（按用户隔离）。「时间线」用于切换赛季叙事基准；这里管理虚拟日期推进、待办与已完成记录（含线下相遇归档）。
      </p>

      <section class="card-block nm-section">
        <h2 class="nm-h2">世界内时间</h2>
        <div class="nm-clock">${escapeHtml(fmtVirtual(vn))}</div>
        <div class="nm-advance-row" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;">
          <button type="button" class="nm-adv30" style="flex:1;min-width:100px;padding:10px;background:var(--primary);color:var(--text-inverse);border:none;border-radius:var(--radius-md);font-weight:600;">+30 分钟</button>
          <button type="button" class="nm-advcustom" style="flex:1;min-width:100px;padding:10px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);">自定义…</button>
          <button type="button" class="nm-sync-season" style="flex:1;min-width:100px;padding:10px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);">同步赛季起点</button>
          <button type="button" class="nm-jump-date" style="flex:1;min-width:100px;padding:10px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);">跳转日期…</button>
        </div>
        <p class="nm-muted" style="font-size:var(--font-xs);margin:8px 0 0;">仅推进你的「生活日程」时间戳，不影响全局赛季设定。</p>
      </section>

      <section class="card-block nm-section">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <h2 class="nm-h2" style="margin:0;">赛程参考（${escapeHtml(season)}）</h2>
          <button type="button" class="nm-gosched" style="font-size:var(--font-xs);padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);">完整赛程</button>
        </div>
        <div class="nm-schedule-snippet" style="margin-top:10px;">${scheduleSnippetHtml()}</div>
      </section>

      <section class="card-block nm-section">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <h2 class="nm-h2" style="margin:0;">待办</h2>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button type="button" class="nm-add-train" style="font-size:var(--font-xs);padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);">训练</button>
            <button type="button" class="nm-add-rest" style="font-size:var(--font-xs);padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);">休息</button>
            <button type="button" class="nm-addtodo" style="font-size:var(--font-xs);padding:6px 10px;background:var(--primary);color:var(--text-inverse);border:none;border-radius:var(--radius-sm);">添加</button>
          </div>
        </div>
        <ul class="nm-todos" style="list-style:none;padding:0;margin:10px 0 0;">
          ${
            todos.length
              ? todos
                  .map(
                    (t) => `
            <li class="nm-todo" data-id="${escapeHtml(t.id)}" style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);">
              <span style="flex:1;font-size:var(--font-sm);">${escapeHtml(t.text || '')}</span>
              <button type="button" class="nm-todo-del" data-id="${escapeHtml(t.id)}" style="color:var(--danger, #c44);font-size:var(--font-xs);">删除</button>
            </li>`
                  )
                  .join('')
              : `<li class="nm-muted" style="font-size:var(--font-sm);padding:8px 0;">暂无待办</li>`
          }
        </ul>
      </section>

      <section class="card-block nm-section">
        <h2 class="nm-h2">已完成 / 归档</h2>
        <ul class="nm-done" style="list-style:none;padding:0;margin:10px 0 0;">
          ${
            completed.length
              ? completed
                  .map((c) => {
                    const title = escapeHtml(c.title || '记录');
                    const sum = escapeHtml(c.summary || '');
                    const when = c.at != null ? escapeHtml(fmtVirtual(c.at)) : '';
                    const tag = c.type === 'offline' ? '线下' : escapeHtml(c.type || '');
                    return `
            <li style="padding:10px 0;border-bottom:1px solid var(--border);">
              <div style="font-size:var(--font-xs);color:var(--text-muted);">${when}${tag ? ` · ${tag}` : ''}</div>
              <div style="font-weight:600;font-size:var(--font-sm);margin-top:4px;">${title}</div>
              <div style="font-size:var(--font-sm);margin-top:4px;line-height:1.45;">${sum}</div>
            </li>`;
                  })
                  .join('')
              : `<li class="nm-muted" style="font-size:var(--font-sm);padding:8px 0;">暂无归档（线下相遇「结束并总结」后会出现在此）</li>`
          }
        </ul>
      </section>

      <section class="card-block nm-section" style="text-align:center;">
        <button type="button" class="nm-timeline" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg-card);font-size:var(--font-sm);">前往时间线（切换赛季）</button>
      </section>
    `;

    bodyEl.querySelector('.nm-adv30')?.addEventListener('click', async () => {
      data.virtualNow = (data.virtualNow || seasonBaseMs(season)) + 30 * 60 * 1000;
      await save(data);
      showToast('已推进 30 分钟');
      renderInner();
    });

    bodyEl.querySelector('.nm-advcustom')?.addEventListener('click', async () => {
      const raw = window.prompt('推进多少分钟？（可填小数）', '60');
      if (raw == null || raw === '') return;
      const n = parseFloat(raw);
      if (!Number.isFinite(n) || n <= 0) {
        showToast('请输入有效分钟数');
        return;
      }
      data.virtualNow = (data.virtualNow || seasonBaseMs(season)) + n * 60 * 1000;
      await save(data);
      showToast(`已推进 ${n} 分钟`);
      renderInner();
    });

    bodyEl.querySelector('.nm-gosched')?.addEventListener('click', () => navigate('schedule', { seasonId: season }));

    bodyEl.querySelector('.nm-sync-season')?.addEventListener('click', async () => {
      data.virtualNow = seasonBaseMs(season);
      await save(data);
      showToast(`已同步到 ${season} 赛季时间起点`);
      renderInner();
    });
    bodyEl.querySelector('.nm-jump-date')?.addEventListener('click', async () => {
      const d0 = new Date(data.virtualNow || seasonBaseMs(season));
      const preset = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')} ${String(d0.getHours()).padStart(2, '0')}:${String(d0.getMinutes()).padStart(2, '0')}`;
      const raw = window.prompt('输入世界内时间（YYYY-MM-DD HH:mm）', preset);
      if (!raw) return;
      const parsed = new Date(raw.replace(' ', 'T'));
      if (!Number.isFinite(parsed.getTime())) {
        showToast('时间格式无效');
        return;
      }
      data.virtualNow = parsed.getTime();
      await save(data);
      showToast('已跳转到指定时间');
      renderInner();
    });

    bodyEl.querySelector('.nm-addtodo')?.addEventListener('click', async () => {
      const text = window.prompt('待办内容');
      if (text == null || !String(text).trim()) return;
      data.todos = [...(data.todos || []), { id: 'td_' + Date.now(), text: String(text).trim() }];
      await save(data);
      renderInner();
    });
    bodyEl.querySelector('.nm-add-train')?.addEventListener('click', async () => {
      const hh = new Date(data.virtualNow || seasonBaseMs(season)).getHours();
      const text = hh < 12 ? '上午基础训练（手速/操作）' : hh < 18 ? '下午战术会 + 团训赛' : '晚间自由训练/加练';
      data.todos = [...(data.todos || []), { id: 'td_' + Date.now(), text }];
      await save(data);
      renderInner();
    });
    bodyEl.querySelector('.nm-add-rest')?.addEventListener('click', async () => {
      data.todos = [...(data.todos || []), { id: 'td_' + Date.now(), text: '休息与恢复（放松/复盘后早睡）' }];
      await save(data);
      renderInner();
    });

    bodyEl.querySelectorAll('.nm-todo-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        data.todos = (data.todos || []).filter((t) => t.id !== id);
        await save(data);
        renderInner();
      });
    });

    bodyEl.querySelector('.nm-timeline')?.addEventListener('click', () => navigate('timeline-select'));
  }

  container.querySelector('.nm-home')?.addEventListener('click', () => navigate('home'));
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.height = '100%';
  container.style.overflow = 'hidden';

  renderInner();
}
