import { back } from '../core/router.js';

export default async function render(container) {
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn radio-back" aria-label="返回">‹</button>
      <h1 class="navbar-title">电台</h1>
      <span class="navbar-btn" style="visibility:hidden"></span>
    </header>
    <div class="placeholder-page" style="height:calc(100% - var(--navbar-h));">
      <div class="placeholder-icon">📻</div>
      <div class="placeholder-text">电台</div>
      <div class="placeholder-sub">功能开发中...</div>
    </div>
  `;
  container.querySelector('.radio-back').addEventListener('click', () => back());
}
