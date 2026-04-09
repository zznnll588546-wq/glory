export function createUser(overrides = {}) {
  return {
    id: overrides.id || 'user_' + Date.now(),
    name: overrides.name || '旅行者',
    avatar: overrides.avatar || null,
    bio: overrides.bio || '',
    /** 微博「我的主页」粉丝数；null 表示未指定，微博页可回退 weiboMeta.profiles[userId].fans */
    weiboFans: (() => {
      const v = overrides.weiboFans;
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, n) : null;
    })(),
    /** 微博主页简介；留空则微博页使用 bio */
    weiboBio: overrides.weiboBio != null ? String(overrides.weiboBio) : '',
    /** 主屏幕装饰用，不单独写入 AI 系统卡（AI 仍用 bio 作简介） */
    signature: overrides.signature || '',
    currentTimeline: overrides.currentTimeline || 'S8',
    selectedTeam: overrides.selectedTeam || null,
    auPreset: overrides.auPreset || null,
    auCustom: overrides.auCustom || '',
    /** 与当前 AU 一并注入上下文的条目 id（世界书页） */
    auBoundWorldBookIds: Array.isArray(overrides.auBoundWorldBookIds) ? overrides.auBoundWorldBookIds : [],
    /** 用户命名的 AU 存档：{ id, name, auPreset, auCustom, worldBookIds } */
    auSavedPresets: Array.isArray(overrides.auSavedPresets) ? overrides.auSavedPresets : [],
    worldLineOverrides: overrides.worldLineOverrides || {},
    friends: overrides.friends || [],
    friendGroups: overrides.friendGroups || [{ id: 'default', name: '默认分组' }],
    recommendedCards: overrides.recommendedCards || [],
    settings: overrides.settings || {},
    createdAt: overrides.createdAt || Date.now(),
  };
}
