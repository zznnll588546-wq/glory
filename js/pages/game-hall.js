import { back } from '../core/router.js';

const GAMES = [
  { icon: '🎲', title: '真心话大冒险', desc: '聚会互动玩法' },
  { icon: '🖌️', title: '你画我猜', desc: '默契与脑洞' },
  { icon: '🕵️', title: '谁是卧底', desc: '语言与推理' },
];

export default async function render(container) {
  container.classList.add('game-hall-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn gh-back" aria-label="返回">‹</button>
      <h1 class="navbar-title">游戏大厅</h1>
      <span class="navbar-btn" style="visibility:hidden"></span>
    </header>
    <div class="page-scroll" style="padding-top:16px;">
      <div class="placeholder-page" style="min-height:auto;padding:24px 16px 32px;align-items:center;">
        <div class="placeholder-icon">🎮</div>
        <div class="placeholder-text">游戏大厅</div>
        <div class="placeholder-sub" style="text-align:center;">真心话大冒险等功能开发中...</div>
      </div>
      <div class="game-hall-skeleton">
        ${GAMES.map(
          (g) => `
        <div class="card-block" style="display:flex;align-items:center;gap:14px;margin-bottom:12px;">
          <div style="font-size:36px;width:52px;text-align:center;">${g.icon}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:var(--font-md);">${g.title}</div>
            <div style="font-size:var(--font-xs);color:var(--text-secondary);margin-top:4px;">${g.desc}</div>
          </div>
          <span style="font-size:var(--font-xs);padding:4px 10px;border-radius:var(--radius-full);background:var(--primary-bg);color:var(--primary);white-space:nowrap;">即将开放</span>
        </div>`
        ).join('')}
      </div>
    </div>
  `;
  container.querySelector('.gh-back').addEventListener('click', () => back());
}
