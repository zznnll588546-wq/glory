const _routes = {};
let _currentPage = null;
let _history = [];
const _container = () => document.getElementById('page-container');

export function register(path, renderFn) {
  _routes[path] = renderFn;
}

export function navigate(path, params = {}, replace = false) {
  const hash = '#' + path;
  if (replace) {
    window.history.replaceState({ path, params }, '', hash);
  } else {
    window.history.pushState({ path, params }, '', hash);
    _history.push({ path, params });
  }
  _render(path, params);
}

export function back() {
  if (_history.length > 1) {
    _history.pop();
    window.history.back();
  } else {
    navigate('home', {}, true);
  }
}

export function currentRoute() {
  return _currentPage;
}

async function _render(path, params = {}) {
  const container = _container();
  if (!container) return;

  const renderFn = _routes[path];
  if (!renderFn) {
    container.innerHTML = `<div class="placeholder-page"><div class="placeholder-icon">🚧</div><div class="placeholder-text">页面不存在</div></div>`;
    return;
  }

  const oldPage = container.firstElementChild;
  if (oldPage) {
    oldPage.classList.add('page-exit');
    await new Promise(r => setTimeout(r, 200));
  }

  _currentPage = path;
  container.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'page page-enter';
  page.dataset.page = path;
  container.appendChild(page);

  try {
    await renderFn(page, params);
  } catch (e) {
    console.error('Page render error:', e);
    page.innerHTML = `<div class="placeholder-page"><div class="placeholder-icon">❌</div><div class="placeholder-text">页面加载失败</div><div class="placeholder-sub">${e.message}</div></div>`;
  }
}

export function init() {
  window.addEventListener('popstate', e => {
    const state = e.state;
    if (state && state.path) {
      _render(state.path, state.params || {});
    } else {
      const hash = location.hash.slice(1) || 'home';
      _render(hash);
    }
  });

  const hash = location.hash.slice(1) || 'home';
  navigate(hash, {}, true);
}
