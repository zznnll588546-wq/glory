import { navigate, back } from '../core/router.js';
import * as db from '../core/db.js';
import { setState } from '../core/state.js';
import { createUser } from '../models/user.js';
import { SEASONS } from '../models/timeline.js';
import { ensureLifeSchedule, resetLifeScheduleToSeasonStart } from '../core/virtual-time.js';
import { TEAMS } from '../data/teams.js';
import { CHARACTERS } from '../data/characters.js';
import { createCharacterProfile } from '../models/character.js';

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function getCurrentUserId() {
  const row = await db.get('settings', 'currentUserId');
  return row?.value ?? null;
}

async function setCurrentUserId(id) {
  await db.put('settings', { key: 'currentUserId', value: id });
}

async function loadArenaProfile() {
  const row = await db.get('settings', 'arenaProfile');
  return row?.value || { cardName: '', silverWeapon: '', profession: '', playStyle: '' };
}

async function saveArenaProfile(profile) {
  await db.put('settings', { key: 'arenaProfile', value: profile });
}

async function ensureCurrentUser() {
  let uid = await getCurrentUserId();
  if (uid) {
    const u = await db.get('users', uid);
    if (u) return u;
  }
  const user = createUser();
  await db.put('users', user);
  await ensureLifeSchedule(user.id, user.currentTimeline || 'S8');
  await setCurrentUserId(user.id);
  return user;
}

async function ensureCharacterInDb(staticChar) {
  const existing = await db.get('characters', staticChar.id);
  if (existing) return existing;
  const profile = createCharacterProfile({
    id: staticChar.id,
    name: staticChar.name,
    realName: staticChar.realName,
    accountCard: staticChar.accountCard,
    aliases: staticChar.aliases || [],
    className: staticChar.className,
    team: staticChar.team,
    avatar: staticChar.avatar,
    defaultEmoji: staticChar.defaultEmoji,
    debutSeason: staticChar.debutSeason,
    personality: staticChar.personality,
    speechStyle: staticChar.speechStyle,
    timelineStates: staticChar.timelineStates || {},
    relationships: staticChar.relationships || {},
  });
  await db.put('characters', profile);
  return profile;
}

import { getCharacterStateForSeason } from '../core/chat-helpers.js';

function getTimelineAwareTeamContacts(teamId, season) {
  const members = CHARACTERS.filter((c) => {
    const state = getCharacterStateForSeason(c, season);
    return state.team === teamId;
  });
  const captains = members.filter((c) => {
    const state = getCharacterStateForSeason(c, season);
    const role = (state.role || '').toLowerCase();
    return role.includes('队长') || role.includes('副队长') || role.includes('核心');
  });
  if (captains.length > 0) return captains.map((c) => c.id);
  return members.slice(0, 3).map((c) => c.id);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function avatarInner(user) {
  const a = user.avatar;
  if (a && String(a).startsWith('data:')) {
    return `<img src="${escapeAttr(a)}" alt="" />`;
  }
  if (a && String(a).trim()) return escapeAttr(a);
  return '👤';
}

export default async function render(container) {
  let user = await ensureCurrentUser();
  const arenaProfile = await loadArenaProfile();
  setState('currentUser', user);

  const seasonsOpts = SEASONS.map(
    (s) =>
      `<option value="${escapeAttr(s.id)}"${user.currentTimeline === s.id ? ' selected' : ''}>${escapeAttr(s.name)} (${escapeAttr(s.year)})</option>`
  ).join('');

  const teamOpts = [
    `<option value=""${!user.selectedTeam ? ' selected' : ''}>无</option>`,
    ...Object.values(TEAMS).map((t) => {
      const sel = user.selectedTeam === t.id ? ' selected' : '';
      return `<option value="${escapeAttr(t.id)}"${sel}>${escapeAttr(t.name)}</option>`;
    }),
  ].join('');

  const allUsers = await db.getAll('users');
  const archiveRows = allUsers
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((u) => {
      const active = u.id === user.id;
      return `
      <div class="list-item archive-user-row" data-user-id="${escapeAttr(u.id)}" role="button" tabindex="0">
        <div class="avatar avatar-sm">${avatarInner(u)}</div>
        <div class="list-item-content">
          <div class="list-item-title">${escapeAttr(u.name || '未命名')}${active ? ' <span style="color:var(--primary);font-size:var(--font-xs);">当前</span>' : ''}</div>
          <div class="list-item-subtitle">${escapeAttr(u.signature?.trim() || u.bio || '无签名/简介')}</div>
        </div>
        <div class="list-item-right">${active ? '✓' : '切换'}</div>
      </div>`;
    })
    .join('');

  container.classList.add('profile-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn profile-back" aria-label="返回">‹</button>
      <h1 class="navbar-title">我的资料</h1>
      <span class="navbar-btn" style="visibility:hidden" aria-hidden="true"></span>
    </header>

    <div class="profile-header">
      <button type="button" class="avatar avatar-xl profile-avatar-btn" aria-label="更换头像">${avatarInner(user)}</button>
      <input type="file" class="profile-avatar-file" accept="image/*" hidden />
      <div class="profile-name profile-name-display">${escapeAttr(user.name || '')}</div>
      <div class="profile-signature profile-signature-display">${escapeAttr(user.signature?.trim() || '未设置个性签名')}</div>
    </div>

    <div class="section-header">基本资料</div>
    <section class="settings-section" style="margin-bottom:16px;">
      <div class="settings-item" style="flex-direction:column;align-items:stretch;gap:8px;">
        <span class="settings-item-label">角色名称</span>
        <input type="text" class="form-input profile-name-input" value="${escapeAttr(user.name || '')}" />
      </div>
      <div class="settings-item" style="flex-direction:column;align-items:stretch;gap:8px;">
        <span class="settings-item-label">个性签名</span>
        <span class="text-hint" style="font-size:11px;line-height:1.4;">主屏幕头像卡片展示用，纯装饰。</span>
        <input type="text" class="form-input profile-signature-input" maxlength="160" value="${escapeAttr(user.signature || '')}" placeholder="一句话展示在主页" />
      </div>
      <div class="settings-item" style="flex-direction:column;align-items:stretch;gap:8px;">
        <span class="settings-item-label">个人简介</span>
        <span class="text-hint" style="font-size:11px;line-height:1.4;">与 AI 对话时会写入「用户角色卡」。</span>
        <textarea class="form-textarea profile-bio-input">${escapeHtml(user.bio || '')}</textarea>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">当前时间线</span>
        <div class="settings-item-value" style="flex:1;max-width:58%;">
          <select class="form-input profile-timeline" style="padding:6px 8px;font-size:var(--font-sm);width:100%;">${seasonsOpts}</select>
        </div>
      </div>
      <div class="settings-item">
        <span class="settings-item-label">所属俱乐部</span>
        <div class="settings-item-value" style="flex:1;max-width:58%;">
          <select class="form-input profile-team" style="padding:6px 8px;font-size:var(--font-sm);width:100%;">${teamOpts}</select>
        </div>
      </div>
      <div class="settings-item" style="flex-direction:column;align-items:stretch;gap:8px;">
        <span class="settings-item-label">头像文件</span>
        <input type="file" class="form-input profile-avatar-file-alt" accept="image/*" />
      </div>
    </section>

    <div style="padding:0 16px 16px;">
      <button type="button" class="btn btn-primary btn-block profile-save">保存</button>
    </div>

    <div class="section-header">竞技场档案</div>
    <section class="settings-section" style="margin-bottom:16px;">
      <div class="settings-item" style="flex-direction:column;align-items:stretch;gap:8px;">
        <span class="settings-item-label">账号卡名</span>
        <input type="text" class="form-input profile-arena-card" value="${escapeAttr(arenaProfile.cardName || '')}" placeholder="例如：一叶之秋" />
      </div>
      <div class="settings-item" style="flex-direction:column;align-items:stretch;gap:8px;">
        <span class="settings-item-label">银武名</span>
        <input type="text" class="form-input profile-arena-weapon" value="${escapeAttr(arenaProfile.silverWeapon || '')}" placeholder="例如：却邪" />
      </div>
      <div class="settings-item" style="flex-direction:column;align-items:stretch;gap:8px;">
        <span class="settings-item-label">职业</span>
        <input type="text" class="form-input profile-arena-profession" value="${escapeAttr(arenaProfile.profession || '')}" placeholder="例如：战斗法师" />
      </div>
      <div class="settings-item" style="flex-direction:column;align-items:stretch;gap:8px;">
        <span class="settings-item-label">作战风格</span>
        <input type="text" class="form-input profile-arena-style" value="${escapeAttr(arenaProfile.playStyle || '')}" placeholder="例如：高压突进 / 控场反打" />
      </div>
      <div class="settings-item">
        <span class="text-hint" style="font-size:11px;line-height:1.45;">用于竞技场建房、组队分配与战果总结展示。</span>
      </div>
    </section>

    <div class="section-header">存档管理</div>
    <section class="settings-section">
      <div style="padding:8px 16px;font-size:var(--font-xs);color:var(--text-hint);line-height:1.5;">每个存档是独立的世界观，拥有自己的联系人、聊天记录和记忆。切换存档后，其他存档的数据不会丢失，只是互相隔离。</div>
      <div style="padding:12px 16px;">
        <button type="button" class="btn btn-outline btn-block profile-new-user">＋ 新建存档</button>
      </div>
      ${archiveRows || '<div class="placeholder-sub" style="padding:16px;">暂无其他存档</div>'}
    </section>
  `;

  const nameInput = container.querySelector('.profile-name-input');
  const signatureInput = container.querySelector('.profile-signature-input');
  const bioInput = container.querySelector('.profile-bio-input');
  const timelineSel = container.querySelector('.profile-timeline');
  const teamSel = container.querySelector('.profile-team');
  const nameDisplay = container.querySelector('.profile-name-display');
  const signatureDisplay = container.querySelector('.profile-signature-display');
  const avatarBtn = container.querySelector('.profile-avatar-btn');
  const avatarFile = container.querySelector('.profile-avatar-file');
  const avatarFileAlt = container.querySelector('.profile-avatar-file-alt');
  const arenaCardInput = container.querySelector('.profile-arena-card');
  const arenaWeaponInput = container.querySelector('.profile-arena-weapon');
  const arenaProfessionInput = container.querySelector('.profile-arena-profession');
  const arenaStyleInput = container.querySelector('.profile-arena-style');

  let pendingAvatar = user.avatar;

  function syncHeaderPreview() {
    const previewUser = {
      ...user,
      name: nameInput.value,
      signature: signatureInput?.value || '',
      bio: bioInput.value,
      avatar: pendingAvatar,
    };
    nameDisplay.textContent = previewUser.name || '';
    signatureDisplay.textContent = previewUser.signature?.trim() || '未设置个性签名';
    avatarBtn.innerHTML = avatarInner(previewUser);
  }

  nameInput.addEventListener('input', syncHeaderPreview);
  signatureInput?.addEventListener('input', syncHeaderPreview);
  bioInput.addEventListener('input', syncHeaderPreview);

  async function applyAvatarFile(file) {
    if (!file) return;
    try {
      pendingAvatar = await fileToDataUrl(file);
      syncHeaderPreview();
    } catch {
      /* ignore */
    }
  }

  avatarBtn.addEventListener('click', () => avatarFile.click());
  avatarFile.addEventListener('change', (e) => {
    applyAvatarFile(e.target.files?.[0]);
    e.target.value = '';
  });
  avatarFileAlt.addEventListener('change', (e) => {
    applyAvatarFile(e.target.files?.[0]);
    e.target.value = '';
  });

  container.querySelector('.profile-save')?.addEventListener('click', async () => {
    const previousTeam = user.selectedTeam;
    const previousTimeline = user.currentTimeline;
    user.name = nameInput.value.trim() || user.name;
    user.signature = (signatureInput?.value || '').trim().slice(0, 160);
    user.bio = bioInput.value || '';
    user.currentTimeline = timelineSel.value || user.currentTimeline;
    user.selectedTeam = teamSel.value || null;
    user.avatar = pendingAvatar;

    if (user.selectedTeam && user.selectedTeam !== previousTeam) {
      const defaults = getTimelineAwareTeamContacts(user.selectedTeam, user.currentTimeline || 'S8');
      const currentFriends = Array.isArray(user.friends) ? [...user.friends] : [];
      const friendIds = new Set(currentFriends.map((item) => (typeof item === 'string' ? item : item?.id)).filter(Boolean));
      for (const charId of defaults) {
        const staticChar = CHARACTERS.find((c) => c.id === charId);
        if (!staticChar) continue;
        await ensureCharacterInDb(staticChar);
        if (!friendIds.has(charId)) {
          currentFriends.push({ id: charId, groupId: 'default', source: 'club-default' });
          friendIds.add(charId);
        }
      }
      user.friends = currentFriends;
    }

    await db.put('users', user);
    if (user.currentTimeline !== previousTimeline) {
      await resetLifeScheduleToSeasonStart(user.id, user.currentTimeline || 'S8');
    } else {
      await ensureLifeSchedule(user.id, user.currentTimeline || 'S8');
    }
    await saveArenaProfile({
      cardName: String(arenaCardInput?.value || '').trim(),
      silverWeapon: String(arenaWeaponInput?.value || '').trim(),
      profession: String(arenaProfessionInput?.value || '').trim(),
      playStyle: String(arenaStyleInput?.value || '').trim(),
    });
    setState('currentUser', user);
    syncHeaderPreview();
    const t = document.getElementById('toast-container');
    if (t) {
      const el = document.createElement('div');
      el.className = 'toast';
      el.textContent = '已保存';
      t.appendChild(el);
      setTimeout(() => el.remove(), 2000);
    }
  });

  container.querySelector('.profile-new-user')?.addEventListener('click', async () => {
    const nu = createUser();
    await db.put('users', nu);
    await ensureLifeSchedule(nu.id, nu.currentTimeline || 'S8');
    await setCurrentUserId(nu.id);
    navigate('user-profile', {}, true);
  });

  container.querySelectorAll('.archive-user-row').forEach((row) => {
    const switchUser = async () => {
      const id = row.dataset.userId;
      if (!id || id === user.id) return;
      await setCurrentUserId(id);
      const switched = await db.get('users', id);
      if (switched) await ensureLifeSchedule(switched.id, switched.currentTimeline || 'S8');
      navigate('user-profile', {}, true);
    };
    row.addEventListener('click', switchUser);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        switchUser();
      }
    });
  });

  container.querySelector('.profile-back')?.addEventListener('click', () => back());
}
