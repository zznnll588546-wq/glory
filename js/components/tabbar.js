import { navigate } from '../core/router.js';

const TABS = [
  { icon: '💬', label: '消息', page: 'chat-list' },
  { icon: '👥', label: '通讯录', page: 'contacts' },
  { icon: '🔍', label: '发现', page: 'moments' },
  { icon: '👤', label: '我的', page: 'user-profile' },
];

export function renderTabbar(container, activePage) {
  const bar = document.createElement('div');
  bar.className = 'tabbar';

  for (const tab of TABS) {
    const item = document.createElement('div');
    item.className = 'tabbar-item' + (tab.page === activePage ? ' active' : '');
    item.innerHTML = `<span class="tab-icon">${tab.icon}</span><span>${tab.label}</span>`;
    item.addEventListener('click', () => navigate(tab.page, {}, true));
    bar.appendChild(item);
  }

  container.appendChild(bar);
  return bar;
}
