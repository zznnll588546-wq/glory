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

  function buildScheduleHtml(seasonId) {
    const teams = teamsEligibleForSchedule(seasonId);
    const ids = teams.map((t) => t.id);
    const rounds = generateRoundRobin(ids);
    if (!rounds.length) {
      return `<div class="placeholder-page" style="padding:32px 16px;"><div class="placeholder-text">该赛季暂无足够战队生成赛程</div></div>`;
    }
    return rounds
      .map((matches, ri) => {
        const rows = matches.map((m) => matchRow(m.home, m.away)).join('');
        return `
        <section class="schedule-round">
          <h2 class="schedule-round-title">第${ri + 1}轮</h2>
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
    </div>
    <div class="page-scroll schedule-body">${buildScheduleHtml(initialSeason)}</div>
  `;

  container.querySelector('.schedule-back')?.addEventListener('click', () => back());

  const bodyEl = container.querySelector('.schedule-body');
  container.querySelectorAll('.schedule-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.schedule-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const sid = btn.dataset.season;
      if (bodyEl && sid) bodyEl.innerHTML = buildScheduleHtml(sid);
    });
  });

  void navigate;
}
