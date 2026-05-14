/**
 * ModelToo 成员 ↔ 本地 SQLite users 对齐。
 *
 * 说明：users 表字段 historically 命名为 email，实际存的是「登录账号字符串」（账号名或邮箱均可），
 * 与 ModelToo 的 username / email / display_name 对应；统计页、下载页组长范围等均依赖此处同一套规则。
 * （不做 DB 迁移，仅语义上把该列当作 login / account id。）
 */

import { getDatabase } from '../database/index.js';

/** ModelToo 返回的 UUID 可能是带/不带连字符或大小写不一 */
export function modelTooIdsEqual(a, b) {
  if (a == null || b == null) return false;
  const na = String(a).replace(/-/g, '').toLowerCase();
  const nb = String(b).replace(/-/g, '').toLowerCase();
  return na.length >= 32 && nb.length >= 32 && na === nb;
}

/** 分组对象上的组长 ID（兼容 snake_case / camelCase） */
export function pickGroupLeaderId(group) {
  if (!group || typeof group !== 'object') return null;
  const v = group.leader_id ?? group.leaderId;
  return v != null && String(v).trim() !== '' ? v : null;
}

/** 成员对象上的用户 UUID */
export function pickMemberUserId(member) {
  if (!member || typeof member !== 'object') return null;
  const v = member.id ?? member.userId ?? member.user_id;
  return v != null && String(v).trim() !== '' ? v : null;
}

/**
 * 当前 SD 登录账号（来自 users 表的 email 列存的字符串）是否与 ModelToo 某成员为同一人
 */
export function modelTooMemberMatchesSdLogin(member, sdLoginIdentifier) {
  const hint = String(sdLoginIdentifier || '').trim().toLowerCase();
  if (!hint) return false;
  const raw = member && typeof member === 'object' ? member : {};
  const fields = [
    raw.email,
    raw.username,
    raw.user_name,
    raw.userName,
    raw.display_name,
    raw.displayName,
  ].filter((x) => typeof x === 'string' && x.trim());
  for (const f of fields) {
    const t = f.trim().toLowerCase();
    if (t === hint) return true;
    if (t.includes('@')) {
      const local = t.split('@')[0];
      if (local === hint) return true;
    }
  }
  return false;
}

/**
 * 将 ModelToo 返回的成员对象映射到本地 users.id（按账号名字符串匹配 users.email 列）
 */
export function findLocalUserIdForModelTooMember(member) {
  const raw = member && typeof member === 'object' ? member : {};
  const candidates = [
    raw.email,
    raw.username,
    raw.user_name,
    raw.userName,
    raw.display_name,
    raw.displayName,
  ].filter((x) => typeof x === 'string' && x.trim());
  if (candidates.length === 0) return null;
  const expanded = [];
  for (const c of candidates) {
    const t = c.trim();
    expanded.push(t);
    if (t.includes('@')) expanded.push(t.split('@')[0]);
  }
  const uniq = [...new Set(expanded.map((x) => String(x).trim()).filter(Boolean))];
  const db = getDatabase();
  const stmt = db.prepare('SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) LIMIT 1');
  for (const key of uniq) {
    const row = stmt.get(key);
    if (row) return row.id;
  }
  return null;
}
