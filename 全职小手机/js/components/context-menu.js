export function showContextMenu(x, y, items = []) {
  closeContextMenu();
  const container = document.getElementById('context-menu-container');
  if (!container) return;
  container.classList.add('active');

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:699;';
  container.appendChild(overlay);

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  let left = Math.min(x, viewW - 160);
  let top = Math.min(y, viewH - items.length * 40 - 20);
  if (left < 8) left = 8;
  if (top < 8) top = 8;

  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'context-menu-item';
    el.innerHTML = `<span>${item.icon || ''}</span><span>${item.label}</span>`;
    el.addEventListener('click', () => {
      closeContextMenu();
      if (item.action) item.action();
    });
    menu.appendChild(el);
  }

  container.appendChild(menu);
  overlay.addEventListener('click', closeContextMenu);
}

export function closeContextMenu() {
  const container = document.getElementById('context-menu-container');
  if (!container) return;
  container.innerHTML = '';
  container.classList.remove('active');
}
