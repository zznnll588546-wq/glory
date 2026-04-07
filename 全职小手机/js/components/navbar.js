export function renderNavbar(container, options = {}) {
  const nav = document.createElement('div');
  nav.className = 'navbar';
  
  if (options.onBack) {
    const backBtn = document.createElement('button');
    backBtn.className = 'navbar-btn';
    backBtn.textContent = '‹';
    backBtn.addEventListener('click', options.onBack);
    nav.appendChild(backBtn);
  } else if (!options.noBack) {
    const spacer = document.createElement('div');
    spacer.style.width = '36px';
    nav.appendChild(spacer);
  }

  const title = document.createElement('div');
  title.className = 'navbar-title';
  title.textContent = options.title || '';
  nav.appendChild(title);

  if (options.rightButtons) {
    for (const btn of options.rightButtons) {
      const el = document.createElement('button');
      el.className = 'navbar-btn';
      el.textContent = btn.icon || btn.text || '';
      if (btn.action) el.addEventListener('click', btn.action);
      nav.appendChild(el);
    }
  } else {
    const spacer = document.createElement('div');
    spacer.style.width = '36px';
    nav.appendChild(spacer);
  }

  container.insertBefore(nav, container.firstChild);
  return nav;
}
