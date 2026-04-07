import { back } from '../core/router.js';

export default async function render(container) {
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn music-back" aria-label="返回">‹</button>
      <h1 class="navbar-title">音乐</h1>
      <span class="navbar-btn" style="visibility:hidden"></span>
    </header>
    <div class="placeholder-page" style="height:calc(100% - var(--navbar-h));">
      <div class="placeholder-icon">🎵</div>
      <div class="placeholder-text">一起听音乐</div>
      <div class="placeholder-sub">功能开发中...</div>
    </div>
  `;
  container.querySelector('.music-back').addEventListener('click', () => back());
}
