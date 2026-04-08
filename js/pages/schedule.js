import { navigate, back } from '../core/router.js';
import { TEAMS, teamsEligibleForSchedule } from '../data/teams.js';
import { SEASONS } from '../models/timeline.js';

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

function seasonStartDate(seasonId) {
  const n = Number(String(seasonId || 'S8').replace(/[^\d]/g, '')) || 8;
  return new Date(2014 + n, 8, 1, 19, 30, 0, 0);
}

function formatDateTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function buildSeasonEvents(seasonId) {
  const base = seasonStartDate(seasonId).getTime();
  return [
    { type: 'event', title: '赛季开幕式', at: base + 2 * 86400000 },
    { type: 'event', title: '全明星周末', at: base + 90 * 86400000 },
    { type: 'event', title: '季后赛开始', at: base + 220 * 86400000 },
    { type: 'event', title: '总决赛', at: base + 260 * 86400000 },
  ];
}

function build37Rounds(seasonId) {
  const teams = teamsEligibleForSchedule(seasonId).map((t) => t.id);
  const roundsA = generateRoundRobin(teams);
  const rounds = [];
  while (rounds.length < 37) {
    const source = rounds.length < roundsA.length ? roundsA[rounds.length] : roundsA[(rounds.length - roundsA.length) % roundsA.length].map((m) => ({ home: m.away, away: m.home }));
    rounds.push(source);
  }
  const base = seasonStartDate(seasonId).getTime();
  return rounds.map((matches, idx) => ({
    type: 'round',
    round: idx + 1,
    at: base + idx * 7 * 86400000,
    matches,
  }));
}

function matchRow(homeId, awayId) {
  const home = TEAMS[homeId];
  const away = TEAMS[awayId];
  if (!home || !away) return '';
  return `
    <div class="schedule-match card-block">
      <div class="schedule-side schedule-home">
        <span class="schedule-team-icon">${home.icon}</span>
        <span class="schedule-team-name">${escapeHtml(home.abbr || home.name)}</span>
      </div>
      <span class="schedule-vs">VS</span>
      <div class="schedule-side schedule-away">
        <span class="schedule-team-icon">${away.icon}</span>
        <span class="schedule-team-name">${escapeHtml(away.abbr || away.name)}</span>
      </div>
    </div>`;
}

export default async function render(container, params = {}) {
  const initialSeason = params.seasonId && SEASONS.some((s) => s.id === params.seasonId) ? params.seasonId : 'S8';

  function buildScheduleHtml(seasonId, targetTs = 0) {
    const rounds = build37Rounds(seasonId);
    const events = buildSeasonEvents(seasonId);
    const merged = [...rounds, ...events].sort((a, b) => a.at - b.at);
    if (!merged.length) {
      return `<div class="placeholder-page" style="padding:32px 16px;"><div class="placeholder-text">该赛季暂无足够战队生成赛程</div></div>`;
    }
    return merged
      .map((item) => {
        const highlight = targetTs && Math.abs(item.at - targetTs) < 3 * 86400000 ? ' schedule-focus' : '';
        if (item.type === 'event') {
          return `
          <section class="schedule-round${highlight}">
            <h2 class="schedule-round-title">📌 ${escapeHtml(item.title)}</h2>
            <div class="card-block" style="margin-top:6px;">${escapeHtml(formatDateTime(item.at))}</div>
          </section>
          `;
        }
        const rows = item.matches.map((m) => matchRow(m.home, m.away)).join('');
        return `
        <section class="schedule-round${highlight}">
          <h2 class="schedule-round-title">第${item.round}轮 · ${escapeHtml(formatDateTime(item.at))}</h2>
          ${rows}
        </section>`;
      })
      .join('');
  }

  const tabsHtml = SEASONS.map(
    (s) =>
      `<button type="button" class="schedule-tab${s.id === initialSeason ? ' active' : ''}" data-season="${escapeAttr(s.id)}">${escapeHtml(s.id)}</button>`
  ).join('');

  container.classList.add('schedule-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn schedule-back" aria-label="返回">‹</button>
      <h1 class="navbar-title">赛程表</h1>
      <span class="navbar-btn" style="visibility:hidden" aria-hidden="true"></span>
    </header>
    <div class="schedule-tabs-wrap">
      <div class="schedule-tabs" role="tablist">${tabsHtml}</div>
      <div class="schedule-jump-tools">
        <input type="month" class="form-input schedule-month" />
        <input type="date" class="form-input schedule-date" />
        <input type="time" class="form-input schedule-time" value="19:30" />
        <button type="button" class="btn btn-outline btn-sm schedule-jump-btn">跳转</button>
      </div>
    </div>
    <div class="page-scroll schedule-body">${buildScheduleHtml(initialSeason)}</div>
  `;

  container.querySelector('.schedule-back')?.addEventListener('click', () => back());

  const bodyEl = container.querySelector('.schedule-body');
  const monthEl = container.querySelector('.schedule-month');
  const dateEl = container.querySelector('.schedule-date');
  const timeEl = container.querySelector('.schedule-time');
  let activeSeason = initialSeason;
  container.querySelectorAll('.schedule-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.schedule-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const sid = btn.dataset.season;
      activeSeason = sid || activeSeason;
      if (bodyEl && sid) bodyEl.innerHTML = buildScheduleHtml(sid);
    });
  });

  const onJump = () => {
    const d = dateEl?.value;
    if (!d) return;
    const t = timeEl?.value || '19:30';
    const ts = new Date(`${d}T${t}`).getTime();
    if (!Number.isFinite(ts)) return;
    if (bodyEl) bodyEl.innerHTML = buildScheduleHtml(activeSeason, ts);
  };
  container.querySelector('.schedule-jump-btn')?.addEventListener('click', onJump);
  monthEl?.addEventListener('change', () => {
    const v = monthEl.value;
    if (!v) return;
    dateEl.value = `${v}-01`;
  });

  void navigate;
}
