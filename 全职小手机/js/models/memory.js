export function createMemory(overrides = {}) {
  return {
    id: overrides.id || 'mem_' + Date.now(),
    chatId: overrides.chatId || '',
    characterId: overrides.characterId || '',
    userId: overrides.userId || '',
    type: overrides.type || 'event',
    category: overrides.category || 'general',
    content: overrides.content || '',
    importance: overrides.importance || 'normal',
    timestamp: overrides.timestamp || Date.now(),
    source: overrides.source || 'manual',
  };
}

export const MEMORY_TYPES = {
  event: '事件',
  relationship: '关系变化',
  preference: '喜好/习惯',
  secret: '秘密',
  promise: '约定',
  summary: 'API总结',
};
