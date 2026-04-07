const _state = {};
const _listeners = {};

export function getState(key) {
  return _state[key];
}

export function setState(key, value) {
  const old = _state[key];
  _state[key] = value;
  if (_listeners[key]) {
    for (const fn of _listeners[key]) {
      try { fn(value, old); } catch (e) { console.error('State listener error:', e); }
    }
  }
}

export function subscribe(key, fn) {
  if (!_listeners[key]) _listeners[key] = new Set();
  _listeners[key].add(fn);
  return () => _listeners[key].delete(fn);
}

export function batchUpdate(updates) {
  for (const [key, value] of Object.entries(updates)) {
    setState(key, value);
  }
}

export function getSnapshot() {
  return { ..._state };
}
