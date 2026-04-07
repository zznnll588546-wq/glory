export function createWorldBookEntry(overrides = {}) {
  return {
    id: overrides.id || 'wb_' + Date.now(),
    name: overrides.name || '',
    category: overrides.category || 'custom',
    season: overrides.season || 'all',
    content: overrides.content || '',
    keys: overrides.keys || [],
    constant: overrides.constant || false,
    selective: overrides.selective || false,
    position: overrides.position || 0,
    depth: overrides.depth || 4,
    isAU: overrides.isAU || false,
    isUserOverride: overrides.isUserOverride || false,
    userId: overrides.userId || null,
    enabled: overrides.enabled !== undefined ? overrides.enabled : true,
  };
}
