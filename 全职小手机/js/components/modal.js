export function showModal(options = {}) {
  const container = document.getElementById('modal-container');
  if (!container) return null;
  container.classList.add('active');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay' + (options.center ? ' modal-sheet-center' : '');

  const sheet = document.createElement('div');
  sheet.className = 'modal-sheet';

  if (options.title) {
    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `<h3>${options.title}</h3><button class="navbar-btn" data-close>✕</button>`;
    sheet.appendChild(header);
  }

  const body = document.createElement('div');
  body.className = 'modal-body';
  if (options.content) {
    if (typeof options.content === 'string') {
      body.innerHTML = options.content;
    } else {
      body.appendChild(options.content);
    }
  }
  sheet.appendChild(body);

  overlay.appendChild(sheet);
  container.appendChild(overlay);

  const close = () => {
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.2s';
    setTimeout(() => {
      overlay.remove();
      if (!container.querySelector('.modal-overlay')) {
        container.classList.remove('active');
      }
    }, 200);
  };

  overlay.addEventListener('click', e => {
    if (e.target === overlay || e.target.dataset.close !== undefined) close();
  });
  sheet.querySelector('[data-close]')?.addEventListener('click', close);

  return { overlay, sheet, body, close };
}
