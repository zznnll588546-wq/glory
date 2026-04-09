const DEFAULT_GROUP_SETTINGS = {
  name: '',
  avatar: null,
  owner: null,
  admins: [],
  announcement: '',
  muted: [],
  allMuted: false,
  isObserverMode: false,
  plotDirective: '',
  groupJumpIntent: '',
  dialogueStarters: [],
  allowPrivateTrigger: false,
  allowSocialLinkage: true,
  linkageMode: 'notify',
  allowWrongSend: true,
  allowPrivateMentionLinkage: true,
  allowAiOfflineInvite: false,
  allowAiGroupOps: true,
  useCustomLinkageTargets: false,
  linkageTargetGroupIds: [],
  linkagePrivateMemberIds: [],
  groupThemeTags: [],
};

export function createChat(overrides = {}) {
  return {
    id: overrides.id || 'chat_' + Date.now(),
    type: overrides.type || 'private',
    userId: overrides.userId || null,
    participants: overrides.participants || [],
    groupSettings: { ...DEFAULT_GROUP_SETTINGS, ...(overrides.groupSettings || {}) },
    lastMessage: overrides.lastMessage || '',
    lastActivity: overrides.lastActivity || Date.now(),
    unread: overrides.unread || 0,
    autoActive: overrides.autoActive || false,
    autoInterval: overrides.autoInterval || 300000,
    pinned: overrides.pinned || false,
  };
}

export function createMessage(overrides = {}) {
  return {
    id: overrides.id || 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    chatId: overrides.chatId || '',
    senderId: overrides.senderId || 'user',
    senderName: overrides.senderName || '',
    type: overrides.type || 'text',
    content: overrides.content || '',
    timestamp: Number.isFinite(Number(overrides.timestamp)) ? Number(overrides.timestamp) : 0,
    reactions: overrides.reactions || {},
    replyTo: overrides.replyTo || null,
    replyPreview: overrides.replyPreview || null,
    deleted: overrides.deleted || false,
    recalled: overrides.recalled || false,
    forwarded: overrides.forwarded || false,
    metadata: overrides.metadata || {},
  };
}
