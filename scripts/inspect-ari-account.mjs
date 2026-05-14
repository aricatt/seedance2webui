/**
 * 按登录/用户名子串核对：ModelToo 全站用户 + SD 本地 users.email（不写密钥到控制台）
 * 用法: node scripts/inspect-ari-account.mjs [hint]
 * 省略 hint 时默认 ari（历史文件名保留，便于你本地书签/习惯）
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverNm = path.join(root, 'server', 'node_modules');
const require = createRequire(import.meta.url);
require(path.join(serverNm, 'dotenv')).config({ path: path.join(root, '.env') });

const hintRaw = (process.argv[2] || 'ari').trim();
const hint = hintRaw.toLowerCase();

const base = (process.env.MODELTOO_API_URL || '').replace(/\/+$/, '');

function fieldHits(u) {
  const pairs = [
    ['username', u.username],
    ['email', u.email],
    ['display_name', u.display_name ?? u.displayName],
  ];
  const hits = [];
  for (const [name, val] of pairs) {
    if (typeof val !== 'string' || !val.trim()) continue;
    const t = val.trim();
    const tl = t.toLowerCase();
    if (tl === hint) hits.push(`${name} 全字匹配`);
    else if (tl.includes(hint)) hits.push(`${name} 含子串`);
    if (t.includes('@')) {
      const local = t.split('@')[0].toLowerCase();
      if (local === hint) hits.push(`${name}(@前) 全字匹配`);
    }
  }
  return hits;
}

async function modelTooScan() {
  if (!base) {
    console.log('ModelToo: 未配置 MODELTOO_API_URL，跳过');
    return;
  }
  const mod = await import('../server/services/modelTooAdminClient.js');
  let token;
  try {
    token = await mod.getModelTooAdminBearer();
  } catch (e) {
    console.log('ModelToo: 无法取得管理员 Token —', e.message);
    return;
  }

  const limit = 100;
  let skip = 0;
  const matches = [];
  for (;;) {
    const resp = await fetch(`${base}/api/v1/admin/users?skip=${skip}&limit=${limit}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      console.log('ModelToo: 拉取用户列表失败 HTTP', resp.status);
      return;
    }
    const body = await resp.json().catch(() => ({}));
    const items = Array.isArray(body.items) ? body.items : [];
    for (const u of items) {
      const hits = fieldHits(u);
      if (hits.length) {
        matches.push({
          id: String(u.id),
          username: u.username,
          email: u.email,
          display_name: u.display_name ?? u.displayName ?? '',
          hitSummary: hits,
        });
      }
    }
    if (items.length < limit) break;
    skip += limit;
    if (skip > 20000) break;
  }

  console.log('\n=== ModelToo 用户表（admin/users）中与 hint 相关的行 ===');
  console.log('hint:', hintRaw);
  if (matches.length === 0) {
    console.log('未找到：username / email / display_name 中无任何一项等于或包含', JSON.stringify(hintRaw));
    return;
  }
  for (const m of matches) {
    console.log('\nid:', m.id);
    console.log('  username:', m.username);
    console.log('  email   :', m.email);
    console.log('  display_name:', m.display_name || '(空)');
    console.log('  匹配说明:', m.hitSummary.join('；'));
  }
}

function sqliteSd() {
  const dbPath = path.join(root, 'server', 'data', 'seedance.db');
  console.log('\n=== ModelTooSD SQLite users.email（登录账号列）===');
  let Database;
  try {
    Database = require(path.join(serverNm, 'better-sqlite3'));
  } catch (e) {
    console.log('无法加载 better-sqlite3:', e.message);
    return;
  }
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(
        `SELECT id, email, role, status FROM users WHERE LOWER(TRIM(email)) = LOWER(?) OR LOWER(TRIM(email)) LIKE ?`
      )
      .all(hintRaw, `%${hintRaw.toLowerCase()}%`);
    if (!rows.length) {
      console.log('未找到 email 列等于或包含', JSON.stringify(hintRaw), '的用户');
    } else {
      for (const r of rows) {
        console.log('id:', r.id, '| email(账号列):', r.email, '| role:', r.role, '| status:', r.status);
      }
    }
    db.close();
  } catch (e) {
    console.log('SQLite:', e.message);
  }
}

await modelTooScan();
sqliteSd();
