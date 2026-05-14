/**
 * 下载页可见范围：管理员全员、普通成员仅自己、组长（ModelToo 分组 leader_id）可见组内已匹配本地的账号。
 */

import { getDatabase } from '../database/index.js';
import {
  fetchModelTooGroups,
  fetchModelTooGroupUsers,
  findModelTooUserIdByLoginHint,
} from './modelTooAdminClient.js';
import {
  modelTooMemberMatchesSdLogin,
  findLocalUserIdForModelTooMember,
  modelTooIdsEqual,
  pickGroupLeaderId,
  pickMemberUserId,
} from './modelTooLocalUserMatch.js';

const MODELTOO_API_URL = (process.env.MODELTOO_API_URL || '').replace(/\/+$/, '');

/** 下拉展示：有 display_name 则「展示名 (账号)」，否则仅账号 */
function scopeLabelFromRow(row) {
  if (!row) return '';
  const dn = String(row.display_name ?? '').trim();
  const ac = String(row.email ?? '').trim();
  if (dn && ac) return `${dn} (${ac})`;
  return ac || dn || String(row.id);
}

function scopeLabelFromSdUser(u) {
  if (!u) return '';
  const dn = String(u.displayName ?? u.display_name ?? '').trim();
  const ac = String(u.email ?? '').trim();
  if (dn && ac) return `${dn} (${ac})`;
  return ac || dn || String(u.id);
}

const leaderIdsCache = new Map(); // sdUserId -> { userIds, diagnostics, exp }
const CACHE_MS = 60_000;

function baseDiagnostics(sdUser) {
  const loginIdentifier = String(sdUser.email || '');
  return {
    loginIdentifier,
    modelTooApiConfigured: !!MODELTOO_API_URL,
    groupsFetchedCount: null,
    isLeaderInModelToo: false,
    ledGroupsCount: 0,
    modelTooMemberCount: 0,
    mappedLocalUserCount: 1,
    usedFallbackUuidScan: false,
    tips: [],
    /** 给前端展示：服务端日志在跑 node 的终端（npm run dev 里 server 那一段），不是浏览器 F12 */
    serverLogHint:
      '若需服务端日志：请看运行「node server/index.js」或 npm concurrently 里名为 server 的终端窗口（不是浏览器控制台）。',
  };
}

export function parseOptionalUserId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析 ModelToo 组长身份 + 映射到本地 users.id（含自己）。
 * @returns {{ userIds: number[], diagnostics: object }}
 */
export async function getLeaderManageableLocalUserIds(sdUser) {
  const selfId = Number(sdUser.id);
  const diagnostics = baseDiagnostics(sdUser);

  if (!MODELTOO_API_URL) {
    diagnostics.tips.push('未配置 MODELTOO_API_URL，无法从 ModelToo 判断组长');
    return { userIds: [selfId], diagnostics };
  }

  try {
    const groups = await fetchModelTooGroups(MODELTOO_API_URL);
    const list = Array.isArray(groups) ? groups : [];
    diagnostics.groupsFetchedCount = list.length;

    /** 先按分组 leader_id 找到组长成员，再比对是否与当前 SD 登录为同一人 */
    const memberListsOfLedGroups = [];
    for (const g of list) {
      if (!g || !g.id) continue;
      const leaderRaw = pickGroupLeaderId(g);
      if (!leaderRaw) continue;

      const members = await fetchModelTooGroupUsers(MODELTOO_API_URL, g.id);
      const arr = Array.isArray(members) ? members : [];
      const leaderMember = arr.find((m) => modelTooIdsEqual(pickMemberUserId(m), leaderRaw));
      if (!leaderMember) continue;
      if (!modelTooMemberMatchesSdLogin(leaderMember, sdUser.email)) continue;

      memberListsOfLedGroups.push(arr);
    }

    if (memberListsOfLedGroups.length === 0) {
      diagnostics.tips.push(
        '未匹配到「您是某组 leader_id 对应的组长」：请确认 ModelToo 分组已设组长；组长在该组成员列表中；SD 登录名与 ModelToo 组长 username 或邮箱(@前)一致'
      );
      const mtUid = await findModelTooUserIdByLoginHint(MODELTOO_API_URL, sdUser.email);
      if (!mtUid) {
        if (list.length > 0) {
          console.warn(
            `[download-scope] 「${sdUser.email}」未识别为组长（分组 ${list.length} 个）。详情见 /api/download/scope 返回的 scopeDiagnostics`
          );
        }
        return { userIds: [selfId], diagnostics };
      }
      diagnostics.usedFallbackUuidScan = true;
      const led = list.filter((g) => pickGroupLeaderId(g) && modelTooIdsEqual(pickGroupLeaderId(g), mtUid));
      for (const g of led) {
        if (!g.id) continue;
        const members = await fetchModelTooGroupUsers(MODELTOO_API_URL, g.id);
        memberListsOfLedGroups.push(Array.isArray(members) ? members : []);
      }
    }

    if (memberListsOfLedGroups.length === 0) {
      diagnostics.tips.push('已通过全站用户找到 UUID，但没有分组的 leader_id 指向您');
      console.warn(`[download-scope] 「${sdUser.email}」UUID 已解析但 leader_id 无匹配，见 scopeDiagnostics`);
      return { userIds: [selfId], diagnostics };
    }

    diagnostics.isLeaderInModelToo = true;
    diagnostics.ledGroupsCount = memberListsOfLedGroups.length;

    const mtSeen = new Set();
    for (const arr of memberListsOfLedGroups) {
      for (const m of arr) {
        const mid = pickMemberUserId(m);
        if (mid) mtSeen.add(String(mid).replace(/-/g, '').toLowerCase());
      }
    }
    diagnostics.modelTooMemberCount = mtSeen.size;

    const seen = new Set([selfId]);
    for (const arr of memberListsOfLedGroups) {
      for (const m of arr) {
        const lid = findLocalUserIdForModelTooMember(m);
        if (lid != null) seen.add(Number(lid));
      }
    }
    diagnostics.mappedLocalUserCount = seen.size;

    if (seen.size <= 1 && mtSeen.size > 1) {
      diagnostics.tips.push(
        `ModelToo 组内共 ${mtSeen.size} 名成员，但本地 SQLite 仅匹配到您一人；请组员各自用与 ModelToo 一致的账号名在 SD 登录一次，才会出现在下拉列表`
      );
    }

    return { userIds: [...seen], diagnostics };
  } catch (e) {
    diagnostics.tips.push(`请求 ModelToo 失败: ${e.message}`);
    console.warn('[download-scope] 解析组长可见成员失败:', e.message);
    return { userIds: [selfId], diagnostics };
  }
}

export async function getLeaderManageableLocalUserIdsCached(sdUser) {
  const now = Date.now();
  const key = Number(sdUser.id);
  const hit = leaderIdsCache.get(key);
  if (hit && hit.exp > now) return { userIds: hit.userIds, diagnostics: hit.diagnostics };
  const { userIds, diagnostics } = await getLeaderManageableLocalUserIds(sdUser);
  leaderIdsCache.set(key, { userIds, diagnostics, exp: now + CACHE_MS });
  return { userIds, diagnostics };
}

/**
 * @returns {{ type: 'all' } | { type: 'single', userId: number } | { type: 'in', userIds: number[] }}
 */
export async function resolveDownloadTaskScope(user, requestedFilterUserId) {
  const db = getDatabase();
  const selfId = Number(user.id);

  if (user.role === 'admin') {
    if (requestedFilterUserId == null) {
      return { type: 'all' };
    }
    const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(requestedFilterUserId);
    if (!exists) {
      const err = new Error('所选用户不存在');
      err.statusCode = 400;
      throw err;
    }
    return { type: 'single', userId: requestedFilterUserId };
  }

  const { userIds: manageable } = await getLeaderManageableLocalUserIdsCached(user);
  const mids = manageable.map(Number);

  if (mids.length <= 1) {
    return { type: 'single', userId: selfId };
  }

  if (requestedFilterUserId == null) {
    return { type: 'in', userIds: mids };
  }

  const rid = Number(requestedFilterUserId);
  if (!mids.includes(rid)) {
    const err = new Error('无权查看该用户的下载任务');
    err.statusCode = 403;
    throw err;
  }
  return { type: 'single', userId: rid };
}

export function scopeToTaskWhereClause(scope, alias = 't') {
  if (!scope || scope.type === 'all') return { clause: '', params: [] };
  if (scope.type === 'single') {
    return { clause: ` AND ${alias}.user_id = ? `, params: [scope.userId] };
  }
  if (scope.type === 'in' && Array.isArray(scope.userIds) && scope.userIds.length > 0) {
    const ph = scope.userIds.map(() => '?').join(', ');
    return { clause: ` AND ${alias}.user_id IN (${ph}) `, params: scope.userIds };
  }
  return { clause: '', params: [] };
}

export async function assertDownloadTaskAccessible(req, taskUserId) {
  if (req.user.role === 'admin') return;
  const uid = Number(taskUserId);
  const { userIds: ids } = await getLeaderManageableLocalUserIdsCached(req.user);
  if (!ids.some((x) => Number(x) === uid)) {
    const err = new Error('无权操作该任务');
    err.statusCode = 403;
    throw err;
  }
}

export async function buildDownloadScopePayload(sdUser) {
  const db = getDatabase();

  if (sdUser.role === 'admin') {
    const rows = db
      .prepare(
        `SELECT id, email, display_name FROM users WHERE status = 'active' ORDER BY email COLLATE NOCASE LIMIT 500`
      )
      .all();
    return {
      viewerRole: 'admin',
      defaultFilterUserId: null,
      filterOptions: [
        { id: null, label: '全员' },
        ...rows.map((r) => ({ id: r.id, label: scopeLabelFromRow(r) })),
      ],
      scopeDiagnostics: null,
    };
  }

  const { userIds: manageable, diagnostics } = await getLeaderManageableLocalUserIdsCached(sdUser);
  const showLeaderUi = diagnostics.isLeaderInModelToo || manageable.length > 1;

  if (!showLeaderUi) {
    return {
      viewerRole: 'member',
      defaultFilterUserId: sdUser.id,
      filterOptions: [{ id: sdUser.id, label: scopeLabelFromSdUser(sdUser) }],
      scopeDiagnostics: diagnostics,
    };
  }

  const options = manageable
    .map((id) => {
      const row = db.prepare('SELECT id, email, display_name FROM users WHERE id = ?').get(id);
      return row ? { id: row.id, label: scopeLabelFromRow(row) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh-CN'));

  return {
    viewerRole: 'leader',
    defaultFilterUserId: null,
    filterOptions: [{ id: null, label: '全员（组内已匹配账号）' }, ...options],
    scopeDiagnostics: diagnostics,
  };
}
