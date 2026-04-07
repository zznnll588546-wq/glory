export function createUser(overrides = {}) {
  return {
    id: overrides.id || 'user_' + Date.now(),
    name: overrides.name || '旅行者',
    avatar: overrides.avatar || null,
    bio: overrides.bio || '',
    currentTimeline: overrides.currentTimeline || 'S8',
    selectedTeam: overrides.selectedTeam || null,
    auPreset: overrides.auPreset || null,
    auCustom: overrides.auCustom || '',
    worldLineOverrides: overrides.worldLineOverrides || {},
    friends: overrides.friends || [],
    friendGroups: overrides.friendGroups || [{ id: 'default', name: '默认分组' }],
    recommendedCards: overrides.recommendedCards || [],
    settings: overrides.settings || {},
    createdAt: overrides.createdAt || Date.now(),
  };
}
