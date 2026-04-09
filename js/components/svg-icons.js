const ICONS = {
  back: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14.5 5.5L8 12l6.5 6.5" />
    </svg>
  `,
  more: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  `,
  plus: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  `,
  close: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6l-12 12" />
    </svg>
  `,
  send: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 4L9 15" />
      <path d="M20 4l-6 16-2.4-6.6L5 11z" />
    </svg>
  `,
  advance: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 6l8 6-8 6z" fill="currentColor" stroke="none" />
      <path d="M16.5 6v12" />
    </svg>
  `,
  reroll: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 8a7 7 0 1 0 2 4.9" />
      <path d="M18 3v5h-5" />
    </svg>
  `,
  /** 聊天工具条：推进 */
  arrowRight: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 5l8 7-8 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `,
  /** 聊天工具条：中止 */
  squareStop: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none" />
    </svg>
  `,
  /** 聊天工具条：多选（四点） */
  dotsFour: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="9" r="2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9" r="2" fill="currentColor" stroke="none" />
      <circle cx="9" cy="15" r="2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="2" fill="currentColor" stroke="none" />
    </svg>
  `,
  search: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16l4 4" />
    </svg>
  `,
  edit: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20l4.2-.8L19 8.4 15.6 5 4.8 15.8z" />
      <path d="M13.8 6.8l3.4 3.4" />
    </svg>
  `,
  camera: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 8.5h15a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z" />
      <path d="M8 8.5l1.4-2h5.2l1.4 2" />
      <circle cx="12" cy="14" r="3.2" />
    </svg>
  `,
  voice: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="4.5" width="6" height="10" rx="3" />
      <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0" />
      <path d="M12 17v3" />
    </svg>
  `,
  sticker: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 5h12a2 2 0 0 1 2 2v7.5A4.5 4.5 0 0 1 15.5 19H8a2 2 0 0 1-2-2z" />
      <path d="M14 19a4 4 0 0 0 4-4h-2.6a1.4 1.4 0 0 0-1.4 1.4z" />
      <path d="M9 10h.01M15 10h.01" />
      <path d="M9.2 13.8c.9 1.2 1.8 1.6 2.8 1.6 1 0 1.9-.4 2.8-1.6" />
    </svg>
  `,
  location: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20s6-5.2 6-10.1A6 6 0 1 0 6 9.9C6 14.8 12 20 12 20z" />
      <circle cx="12" cy="10" r="2.3" />
    </svg>
  `,
  link: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 14l4-4" />
      <path d="M8.5 15.5l-2 2a3 3 0 0 1-4.2-4.2l3.2-3.2A3 3 0 0 1 9.7 10" />
      <path d="M15.5 8.5l2-2a3 3 0 1 1 4.2 4.2l-3.2 3.2A3 3 0 0 1 14.3 14" />
    </svg>
  `,
  redpacket: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 8.2h14v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" />
      <path d="M4.5 8.2h15a1 1 0 0 0 0-2H4.5a1 1 0 0 0 0 2z" />
      <circle cx="12" cy="13.5" r="2.5" />
      <path d="M12 11.2v4.6M9.7 13.5h4.6" />
    </svg>
  `,
  transfer: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 7h12" />
      <path d="M7 12h10" />
      <path d="M8 17h8" />
      <path d="M5 4.5h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z" />
    </svg>
  `,
  textimg: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 5h15a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11A1.5 1.5 0 0 1 4.5 5z" />
      <path d="M7 10h10M7 13h7M7 16h5" />
    </svg>
  `,
  message: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 6h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H11l-4.5 3V17H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />
      <path d="M8 10h8M8 13h5" />
    </svg>
  `,
  contacts: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="9" r="3.2" />
      <path d="M3.8 18a5.2 5.2 0 0 1 10.4 0" />
      <circle cx="17.5" cy="10" r="2.2" />
      <path d="M14.8 18a4.2 4.2 0 0 1 5.4-3.9" />
    </svg>
  `,
  weibo: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9.2 17.8c-3 0-5.5-1.8-5.5-4.2 0-1.3.7-2.5 2-3.3.4-.3.9-.4 1-.9.1-.4-.2-1 .4-1.4.7-.4 1.7.1 2.1.6.4.5.8.3 1.2.1 1.6-.8 3.4-.8 4.8.1 1.9 1.1 2.2 3.7.6 5.8-1.5 2.1-4.1 3.2-6.6 3.2z" />
      <circle cx="9.2" cy="13.6" r="1.2" fill="currentColor" stroke="none" />
      <path d="M16.5 6.3c1.4.2 2.7 1 3.4 2.2" />
      <path d="M15.9 3.7c2.4.2 4.5 1.5 5.6 3.4" />
    </svg>
  `,
  forum: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 5h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4 3v-3H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
      <path d="M8 9h8M8 12h8M8 15h5" />
    </svg>
  `,
  moments: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 19s-6.5-3.9-6.5-9A3.7 3.7 0 0 1 9 6.3c1.3 0 2.3.6 3 1.6.7-1 1.7-1.6 3-1.6A3.7 3.7 0 0 1 18.5 10c0 5.1-6.5 9-6.5 9z" />
      <path d="M17.8 5.2l.6 1.2 1.3.2-.9.9.2 1.3-1.2-.6-1.2.6.2-1.3-.9-.9 1.3-.2z" fill="currentColor" stroke="none" />
    </svg>
  `,
  schedule: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5.5" width="16" height="14" rx="2.5" />
      <path d="M8 3.8v3.4M16 3.8v3.4M4 9.2h16" />
      <path d="M8 12h3v3H8z" />
    </svg>
  `,
  timeline: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5v14" />
      <circle cx="7" cy="7" r="2" fill="currentColor" stroke="none" />
      <circle cx="7" cy="17" r="2" fill="currentColor" stroke="none" />
      <path d="M11 7h6M11 17h6M11 12h4" />
    </svg>
  `,
  worldbook: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.5 5.5h7a2.5 2.5 0 0 1 2.5 2.5v10h-7A2.5 2.5 0 0 0 5.5 20z" />
      <path d="M18.5 5.5h-7A2.5 2.5 0 0 0 9 8v10h7A2.5 2.5 0 0 1 18.5 20z" />
      <path d="M9 9h4M9 12h4" />
    </svg>
  `,
  au: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3c3 4.2 6 6.5 6 10a6 6 0 0 1-12 0c0-3.5 3-5.8 6-10z" />
      <path d="M9 13.5c.6.8 1.7 1.3 3 1.3s2.4-.5 3-1.3" />
      <path d="M12 8v2" />
    </svg>
  `,
  presets: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 5h9l3 3v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
      <path d="M14.5 5v3h3" />
      <path d="M8 12h8M8 15h6" />
    </svg>
  `,
  novel: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 5.5h10a2 2 0 0 1 2 2v11.5a2.5 2.5 0 0 0-2.5-2.5H6z" />
      <path d="M6 5.5A2.5 2.5 0 0 0 3.5 8v10.5A2.5 2.5 0 0 1 6 16h9.5" />
      <path d="M8 10h6M8 13h5" />
    </svg>
  `,
  memory: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 5.5a2.5 2.5 0 0 0-5 0v4.5A7.5 7.5 0 0 0 11.5 17h1A7.5 7.5 0 0 0 20 10V5.5a2.5 2.5 0 0 0-5 0" />
      <path d="M9.5 12.5c.7.5 1.5.8 2.5.8s1.8-.3 2.5-.8" />
      <path d="M9 9.5h.01M15 9.5h.01" />
    </svg>
  `,
  stickers: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.5" y="5" width="15" height="14" rx="3" />
      <path d="M9 10h.01M15 10h.01" />
      <path d="M8.5 14.2c1 .9 2.2 1.4 3.5 1.4 1.3 0 2.5-.5 3.5-1.4" />
      <path d="M15 5v4h4" />
    </svg>
  `,
  music: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 18.5a2.5 2.5 0 1 1-2.5-2.5A2.5 2.5 0 0 1 9 18.5z" />
      <path d="M18 16.5A2.5 2.5 0 1 1 15.5 14 2.5 2.5 0 0 1 18 16.5z" />
      <path d="M9 18.5V7l8-1.5v11" />
    </svg>
  `,
  radio: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 8.5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z" />
      <path d="M8 6l8-2" />
      <circle cx="8.5" cy="13.5" r="2.8" />
      <path d="M14.5 12h4M14.5 15h3" />
    </svg>
  `,
  game: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 10h10a4 4 0 0 1 3.8 5.2l-.8 2.5a2 2 0 0 1-3.2.9l-2.3-1.9h-5l-2.3 1.9a2 2 0 0 1-3.2-.9l-.8-2.5A4 4 0 0 1 7 10z" />
      <path d="M8.2 13.5h2.6M9.5 12.2v2.6" />
      <circle cx="15.8" cy="13.2" r="1" fill="currentColor" stroke="none" />
      <circle cx="17.9" cy="15.1" r="1" fill="currentColor" stroke="none" />
    </svg>
  `,
  settings: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8.2A3.8 3.8 0 1 1 8.2 12 3.8 3.8 0 0 1 12 8.2z" />
      <path d="M12 3l1.3 2.2 2.5.5-.4 2.6 1.8 1.8 2.6-.4.5 2.5L21 13.5l-2.2 1.3-.5 2.5-2.6-.4-1.8 1.8.4 2.6-2.5.5L12 21l-1.3-2.2-2.5-.5.4-2.6-1.8-1.8-2.6.4-.5-2.5L3 12l2.2-1.3.5-2.5 2.6.4 1.8-1.8-.4-2.6 2.5-.5z" />
    </svg>
  `,
  profile: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8.2" r="3.6" />
      <path d="M5 19a7 7 0 0 1 14 0" />
    </svg>
  `,
  backstage: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="6.5" width="17" height="12" rx="2" />
      <path d="M9 11.2l6 3.3-6 3.3z" fill="currentColor" stroke="none" />
      <path d="M7.5 6.5l1.2-2h6.6l1.2 2" />
    </svg>
  `,
  theme: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5A6.7 6.7 0 0 1 12 3.5z" />
      <path d="M15.5 5.5l.6 1.2 1.3.2-.9.9.2 1.3-1.2-.6-1.2.6.2-1.3-.9-.9 1.3-.2z" fill="currentColor" stroke="none" />
    </svg>
  `,
  folder: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7.5h5l1.7 2H20a1.5 1.5 0 0 1 1.5 1.5v6.5A2 2 0 0 1 19.5 19h-15A2 2 0 0 1 2.5 17V9A1.5 1.5 0 0 1 4 7.5z" />
    </svg>
  `,
  sparkle: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7z" />
      <path d="M18.5 15.5l.8 2 .2.3.3.2 2 .8-2 .8-.3.2-.2.3-.8 2-.8-2-.2-.3-.3-.2-2-.8 2-.8.3-.2.2-.3z" />
    </svg>
  `,
  recommendation: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="8" cy="9" r="3" />
      <path d="M3.5 18a4.8 4.8 0 0 1 9 0" />
      <path d="M15 10h6M18 7v6" />
    </svg>
  `,
  npc: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8" r="3.2" />
      <path d="M6.5 18c.9-2.7 3-4.2 5.5-4.2s4.6 1.5 5.5 4.2" />
      <path d="M5 5.5h.01M19 5.5h.01" />
    </svg>
  `,
  /** 以角色身份代发 / 开场 */
  roleSay: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10" cy="9" r="3.2" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M4.5 19c.8-3.2 3-5 5.5-5s4.7 1.8 5.5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M16 7l4 2.5-4 2.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `,
};

export function icon(name, className = '', title = '') {
  const svg = ICONS[name] || ICONS.sparkle;
  const cls = ['svg-icon', className].filter(Boolean).join(' ');
  const t = title ? ` title="${title}"` : '';
  return `<span class="${cls}"${t}>${svg}</span>`;
}

export function getIconSvg(name) {
  return ICONS[name] || ICONS.sparkle;
}

export const APP_ICON_NAMES = {
  'wechat-home': 'message',
  'chat-list': 'message',
  'contacts': 'contacts',
  'weibo': 'weibo',
  'forum': 'forum',
  'moments': 'moments',
  'schedule': 'schedule',
  'timeline-select': 'timeline',
  'now-moment': 'advance',
  'world-book': 'worldbook',
  'au-panel': 'au',
  'preset-editor': 'presets',
  'novel-mode': 'novel',
  'memory-manager': 'memory',
  'sticker-manager': 'stickers',
  'music': 'music',
  'radio': 'radio',
  'game-hall': 'game',
  'character-book': 'contacts',
  'settings': 'settings',
  'user-profile': 'profile',
};
