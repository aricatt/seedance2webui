/**
 * 批量把 ModelToo 用户的展示名同步到 SD users.display_name
 *
 * 匹配规则与 modelTooLocalUserMatch.findLocalUserIdForModelTooMember 一致（MT 的 username/email/display_name 等与本地 users.email 对齐）。
 * 写入规则与登录同步一致：优先 MT display_name，否则用 MT username。
 *
 * 用法:
 *   node scripts/sync-display-names-from-modeltoo.mjs           # 执行更新
 *   node scripts/sync-display-names-from-modeltoo.mjs --dry-run # 仅打印将变更的行
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverNm = path.join(root, 'server', 'node_modules');
const require = createRequire(import.meta.url);
require(path.join(serverNm, 'dotenv')).config({ path: path.join(root, '.env') });

const dryRun = process.argv.includes('--dry-run');
const base = (process.env.MODELTOO_API_URL || '').replace(/\/+$/, '');

async function main() {
  if (!base) {
    console.error('未配置 MODELTOO_API_URL，跳过');
    process.exitCode = 1;
    return;
  }

  const { initDatabase, getDatabase } = await import('../server/database/index.js');
  initDatabase();
  const { clampDisplayName } = await import('../server/services/authService.js');
  const { findLocalUserIdForModelTooMember } = await import(
    '../server/services/modelTooLocalUserMatch.js'
  );
  const { getModelTooAdminBearer } = await import('../server/services/modelTooAdminClient.js');

  const db = getDatabase();
  const token = await getModelTooAdminBearer();

  function mtDisplayToSave(u) {
    const fromProfile = String(u.display_name ?? u.displayName ?? '').trim();
    if (fromProfile) return clampDisplayName(fromProfile);
    return clampDisplayName(String(u.username ?? '').trim());
  }

  const selectRow = db.prepare(
    'SELECT id, email, display_name FROM users WHERE id = ?'
  );
  const updateStmt = db.prepare(
    `UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?`
  );

  let mtTotal = 0;
  let matched = 0;
  let updated = 0;
  let skippedNoLocal = 0;
  let skippedNoMtName = 0;
  let unchanged = 0;

  const limit = 100;
  let skip = 0;
  for (;;) {
    const resp = await fetch(`${base}/api/v1/admin/users?skip=${skip}&limit=${limit}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      const t = await resp.text();
      console.error('ModelToo admin/users 失败 HTTP', resp.status, t.slice(0, 200));
      process.exitCode = 1;
      return;
    }
    const body = await resp.json().catch(() => ({}));
    const items = Array.isArray(body.items) ? body.items : [];
    mtTotal += items.length;

    for (const u of items) {
      const newDn = mtDisplayToSave(u);
      if (!newDn) {
        skippedNoMtName++;
        continue;
      }

      const localId = findLocalUserIdForModelTooMember(u);
      if (localId == null) {
        skippedNoLocal++;
        continue;
      }
      matched++;

      const row = selectRow.get(localId);
      const cur = String(row?.display_name ?? '').trim();
      if (cur === newDn) {
        unchanged++;
        continue;
      }

      if (dryRun) {
        console.log(
          `[dry-run] id=${localId} email=${row?.email} | display_name: "${cur}" -> "${newDn}" (MT: ${u.username})`
        );
        updated++;
        continue;
      }

      updateStmt.run(newDn, localId);
      updated++;
      console.log(`已更新 id=${localId} (${row?.email}) -> "${newDn}"`);
    }

    if (items.length < limit) break;
    skip += limit;
    if (skip > 50000) break;
  }

  console.log('\n--- 汇总 ---');
  console.log('ModelToo 用户行数:', mtTotal);
  console.log('匹配到本地用户:', matched);
  console.log('跳过（MT 无可用展示名）:', skippedNoMtName);
  console.log('跳过（本地无匹配 users.email）:', skippedNoLocal);
  console.log('本地已是目标值:', unchanged);
  console.log(dryRun ? '将写入（dry-run 未写库）:' : '已写入:', updated);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
