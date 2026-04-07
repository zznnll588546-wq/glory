export function createCharacterProfile(overrides = {}) {
  return {
    id: overrides.id || 'char_' + Date.now(),
    name: overrides.name || '',
    realName: overrides.realName || '',
    accountCard: overrides.accountCard || '',
    aliases: overrides.aliases || [],
    className: overrides.className || '',
    team: overrides.team || '',
    avatar: overrides.avatar || null,
    defaultEmoji: overrides.defaultEmoji || '👤',
    debutSeason: overrides.debutSeason || 'S1',
    personality: overrides.personality || '',
    speechStyle: overrides.speechStyle || '',
    timelineStates: overrides.timelineStates || {},
    relationships: overrides.relationships || {},
    customNickname: overrides.customNickname || '',
    isCustom: overrides.isCustom || false,
  };
}
