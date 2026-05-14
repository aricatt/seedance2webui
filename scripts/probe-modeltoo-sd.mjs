/**
 * 一次性核对 ModelToo 分组/组长 与 SD 本地 users（不落盘密钥）
 * 用法: node scripts/probe-modeltoo-sd.mjs
 *
 * 依赖在 server/node_modules（与 express 服务一致），不从仓库根解析。
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverNm = path.join(root, 'server', 'node_modules');
const require = createRequire(import.meta.url);
require(path.join(serverNm, 'dotenv')).config({ path: path.join(root, '.env') });
const Database = require(path.join(serverNm, 'better-sqlite3'));

const dbPath = path.join(root, 'server', 'data', 'seedance.db');
/** 只用于本脚本，避免走 getDatabase()；与 modelTooLocalUserMatch 规则一致 */
function findLocalUserIdWithDb(db, member) {
  const raw = member && typeof member === 'object' ? member : {};
  const candidates = [raw.email, raw.username, raw.user_name, raw.userName].filter(
    (x) => typeof x === 'string' && x.trim()
  );
  if (candidates.length === 0) return null;
  const expanded = [];
  for (const c of candidates) {
    const t = c.trim();
    expanded.push(t);
    if (t.includes('@')) expanded.push(t.split('@')[0]);
  }
  const uniq = [...new Set(expanded.map((x) => String(x).trim()).filter(Boolean))];
  const stmt = db.prepare('SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) LIMIT 1');
  for (const key of uniq) {
    const row = stmt.get(key);
    if (row) return row.id;
  }
  return null;
}

let sqliteDb = null;
console.log('\n=== SQLite users:', dbPath, '===');
try {
  sqliteDb = new Database(dbPath, { readonly: true });
  const rows = sqliteDb.prepare('SELECT id, email, role, status FROM users ORDER BY id').all();
  console.log('count:', rows.length);
  rows.forEach((r) => console.log(' ', r.id, String(r.email), r.role, r.status));
} catch (e) {
  console.log('SQLite:', e.message);
  console.log('(将跳过「本地 users 映射」列；可在 server 目录执行 npm rebuild better-sqlite3 与当前 Node 对齐)');
}

const base = (process.env.MODELTOO_API_URL || '').replace(/\/+$/, '');
console.log('MODELTOO_API_URL:', base || '(empty)');

function uuidEq(a, b) {
  if (a == null || b == null) return false;
  const na = String(a).replace(/-/g, '').toLowerCase();
  const nb = String(b).replace(/-/g, '').toLowerCase();
  return na.length >= 32 && nb.length >= 32 && na === nb;
}

async function main() {
  const mod = await import('../server/services/modelTooAdminClient.js');
  const matchMod = await import('../server/services/modelTooLocalUserMatch.js');

  const groups = await mod.fetchModelTooGroups(base);
  console.log('\n=== ModelToo groups:', groups.length, '===');
  for (const g of groups) {
    const lid = matchMod.pickGroupLeaderId(g);
    console.log('-', g.name, '| id:', g.id, '| leader_id:', lid ?? '(null)', '| member_count:', g.member_count);
  }

  const hint = 'wangyue';
  const mtUid = await mod.findModelTooUserIdByLoginHint(base, hint);
  console.log('\nfindModelTooUserIdByLoginHint("' + hint + '"):', mtUid ?? '(null)');

  for (const g of groups) {
    const gid = g.id;
    if (!gid) continue;
    const users = await mod.fetchModelTooGroupUsers(base, gid);
    const arr = Array.isArray(users) ? users : [];
    const leaderRaw = matchMod.pickGroupLeaderId(g);
    const leaderMember = arr.find((m) => matchMod.modelTooIdsEqual(matchMod.pickMemberUserId(m), leaderRaw));
    const leaderMatchesHint =
      leaderMember && matchMod.modelTooMemberMatchesSdLogin(leaderMember, hint);

    console.log('\n--- Group:', g.name, '---');
    console.log('members returned:', arr.length, '| leader_id:', leaderRaw ?? '(null)');
    if (leaderRaw && !leaderMember) {
      console.log('ISSUE: leader_id 指向的用户不在该组成员列表中（SD 无法在校验组长身份时关联到 leader 行）');
    }
    if (leaderMember) {
      console.log(
        'leader member:',
        leaderMember.username,
        '/',
        leaderMember.email,
        '| id:',
        leaderMember.id,
        '| matches_sd_login_wangyue:',
        leaderMatchesHint
      );
    }
    arr.forEach((m) => {
      const localId = sqliteDb ? findLocalUserIdWithDb(sqliteDb, m) : null;
      const mapLabel = sqliteDb
        ? localId ?? '(no row in SD users.email)'
        : '(sqlite unavailable)';
      console.log(' ', m.username, '/', m.email, '-> local_user_id:', mapLabel);
    });
  }
  if (sqliteDb) sqliteDb.close();
}

try {
  await main();
} catch (e) {
  console.error('\nModelToo 请求失败:', e.message);
  if (sqliteDb) try { sqliteDb.close(); } catch (_) {}
  process.exitCode = 1;
}
