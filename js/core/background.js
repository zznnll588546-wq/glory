import * as db from './db.js';
import { chat } from './api.js';

let _timers = {};
let _workerUrl = null;
let _worker = null;
let _enabled = false;

export async function init() {
  const cfg = await db.get('settings', 'backgroundKeepAlive');
  _enabled = cfg?.value?.enabled ?? false;
  
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && _enabled) {
      startWorker();
    } else {
      stopWorker();
    }
  });

  if (_enabled) loadSchedules();
}

async function loadSchedules() {
  const chats = await db.getAll('chats');
  for (const c of chats) {
    if (c.autoActive && c.autoInterval) {
      scheduleChat(c.id, c.autoInterval);
    }
  }
}

export function scheduleChat(chatId, intervalMs) {
  if (_timers[chatId]) clearInterval(_timers[chatId]);
  _timers[chatId] = setInterval(() => triggerAutoReply(chatId), intervalMs);
}

export function unscheduleChat(chatId) {
  if (_timers[chatId]) {
    clearInterval(_timers[chatId]);
    delete _timers[chatId];
  }
}

async function triggerAutoReply(chatId) {
  try {
    const chatData = await db.get('chats', chatId);
    if (!chatData || !chatData.autoActive) {
      unscheduleChat(chatId);
      return;
    }
    const event = new CustomEvent('background-trigger', { detail: { chatId } });
    window.dispatchEvent(event);
  } catch (e) {
    console.error('Background auto-reply error:', e);
  }
}

function startWorker() {
  if (_worker) return;
  const code = `
    let timers = {};
    self.onmessage = e => {
      const { type, chatId, interval } = e.data;
      if (type === 'schedule') {
        if (timers[chatId]) clearInterval(timers[chatId]);
        timers[chatId] = setInterval(() => self.postMessage({ chatId }), interval);
      } else if (type === 'unschedule') {
        if (timers[chatId]) { clearInterval(timers[chatId]); delete timers[chatId]; }
      } else if (type === 'stop') {
        Object.values(timers).forEach(clearInterval);
        timers = {};
      }
    };
  `;
  const blob = new Blob([code], { type: 'application/javascript' });
  _workerUrl = URL.createObjectURL(blob);
  _worker = new Worker(_workerUrl);
  _worker.onmessage = e => {
    if (e.data.chatId) triggerAutoReply(e.data.chatId);
  };
}

function stopWorker() {
  if (_worker) {
    _worker.postMessage({ type: 'stop' });
    _worker.terminate();
    _worker = null;
  }
  if (_workerUrl) {
    URL.revokeObjectURL(_workerUrl);
    _workerUrl = null;
  }
}

export function setEnabled(on) {
  _enabled = on;
  void (async () => {
    const prev = (await db.get('settings', 'backgroundKeepAlive'))?.value || {};
    await db.put('settings', { key: 'backgroundKeepAlive', value: { ...prev, enabled: on } });
  })();
  if (!on) {
    Object.keys(_timers).forEach(unscheduleChat);
    stopWorker();
  } else {
    loadSchedules();
  }
}
