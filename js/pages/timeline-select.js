import { navigate, back } from '../core/router.js';
import * as db from '../core/db.js';
import { SEASONS } from '../models/timeline.js';
import { setState } from '../core/state.js';

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function getCurrentUserId() {
  const row = await db.get('settings', 'currentUserId');
  return row?.value ?? null;
}

async function getCurrentUser() {
  const uid = await getCurrentUserId();
  if (!uid) return null;
  return db.get('users', uid);
}

function showToast(msg) {
  const wrap = document.getElementById('toast-container');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

function seasonKeyEvents(s) {
  const parts = [];
  if (s.champion && s.id !== 'S0') parts.push(`冠军：${s.champion}`);
  if (s.description) parts.push(s.description);
  return parts.join(' ');
}

export default async function render(container) {
  let user = await getCurrentUser();
  if (!user) {
    container.innerHTML = `<div class="placeholder-page"><div class="placeholder-text">请先创建用户档案</div></div>`;
    return;
  }

  let selectedSeasonId = user.currentTimeline || 'S8';

  function buildTrackHtml() {
    return SEASONS.map((s, i) => {
      const active = s.id === user.currentTimeline;
      const title = `${escapeHtml(s.id)}-${escapeHtml(s.name)}`;
      const champ = s.champion ? `冠军 ${escapeHtml(s.champion)}` : '';
      const info = [escapeHtml(s.year), champ].filter(Boolean).join(' · ');
      return `
        <div class="timeline-node${active ? ' active' : ''}${selectedSeasonId === s.id ? ' selected' : ''}" 
             data-season-id="${escapeAttr(s.id)}" role="button" tabindex="0" style="--i:${i}">
          <div class="timeline-node-dot"></div>
          <div class="timeline-node-body">
            <div class="timeline-node-title">${title}</div>
            <div class="timeline-node-info">${info}</div>
          </div>
        </div>`;
    }).join('');
  }

  function descriptionPanel(seasonId) {
    const s = SEASONS.find((x) => x.id === seasonId) || SEASONS[0];
    return `
      <h3 class="timeline-desc-title">${escapeHtml(s.id)} ${escapeHtml(s.name)}</h3>
      <p class="timeline-desc-text">${escapeHtml(seasonKeyEvents(s))}</p>
    `;
  }

  container.classList.add('timeline-select-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn ts-back" aria-label="返回">‹</button>
      <h1 class="navbar-title">时间线选择</h1>
      <span class="navbar-btn" style="visibility:hidden" aria-hidden="true"></span>
    </header>
    <div class="page-scroll timeline-select-body">
      <div class="timeline-track">${buildTrackHtml()}</div>
      <div class="timeline-desc-panel">${descriptionPanel(selectedSeasonId)}</div>
      <section class="timeline-skip-section">
        <h3 class="timeline-skip-title">时间推进</h3>
        <p class="timeline-skip-hint">手动推进模拟时间（用于剧情扮演）</p>
        <div class="timeline-skip-btns">
          <button type="button" class="btn btn-outline ts-skip" data-unit="day">推进一天</button>
          <button type="button" class="btn btn-outline ts-skip" data-unit="week">推进一周</button>
          <button type="button" class="btn btn-outline ts-skip" data-unit="month">推进一个月</button>
        </div>
      </section>
    </div>
  `;

  const descEl = container.querySelector('.timeline-desc-panel');
  const trackEl = container.querySelector('.timeline-track');

  function bindNodes() {
    container.querySelectorAll('.timeline-node').forEach((node) => {
      const onSelect = async () => {
        const sid = node.dataset.seasonId;
        if (!sid) return;
        selectedSeasonId = sid;
        container.querySelectorAll('.timeline-node').forEach((n) => n.classList.remove('selected'));
        node.classList.add('selected');
        if (descEl) descEl.innerHTML = descriptionPanel(sid);
      };
      const onActivate = async () => {
        const sid = node.dataset.seasonId;
        if (!sid) return;
        user = (await getCurrentUser()) || user;
        user.currentTimeline = sid;
        await db.put('users', user);
        setState('currentUser', user);
        if (trackEl) trackEl.innerHTML = buildTrackHtml();
        bindNodes();
        if (descEl) descEl.innerHTML = descriptionPanel(sid);
        showToast(`已切换到 ${sid}`);
      };
      node.addEventListener('click', () => {
        onSelect();
        onActivate();
      });
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
          onActivate();
        }
      });
    });
  }

  bindNodes();

  container.querySelector('.ts-back')?.addEventListener('click', () => back());

  container.querySelectorAll('.ts-skip').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const unit = btn.dataset.unit;
      const row = await db.get('settings', 'simTime');
      const v = row?.value && typeof row.value === 'object' ? { ...row.value } : { days: 0 };
      if (unit === 'day') v.days = (v.days || 0) + 1;
      if (unit === 'week') v.days = (v.days || 0) + 7;
      if (unit === 'month') v.days = (v.days || 0) + 30;
      await db.put('settings', { key: 'simTime', value: v });
      const label = unit === 'day' ? '一天' : unit === 'week' ? '一周' : '一个月';
      showToast(`已推进${label}`);
    });
  });

  void navigate;
}
