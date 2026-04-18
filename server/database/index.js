import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data/seedance.db');

// 确保数据目录存在
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db = null;

/**
 * 初始化数据库
 */
export function initDatabase() {
  if (db) return db;

  db = new Database(DB_PATH);

  // 启用外键约束
  db.pragma('foreign_keys = ON');

  const existingTableCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).get().count;

  if (existingTableCount === 0) {
    // 读取并执行 Schema
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');

    // 执行 Schema（支持多条 SQL 语句）
    db.exec(schema);
  }

  // 应用迁移
  applyMigrations(db);

  console.log(`[database] 数据库初始化成功：${DB_PATH}`);
  return db;
}

/**
 * 应用数据库迁移
 *
 * schema.sql 已经是最新的 canonical schema, 通常无需额外迁移。
 * 当未来引入 schema 变更时, 在 migrations/ 目录下按时间戳命名新 SQL 即可。
 */
function applyMigrations(db) {
  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const insertAppliedMigration = db.prepare('INSERT INTO schema_migrations (version) VALUES (?)');
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );

  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    console.log(`[database] 应用迁移：${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.exec(sql);
    insertAppliedMigration.run(file);
  }
}

/**
 * 获取数据库实例
 */
export function getDatabase() {
  if (!db) {
    return initDatabase();
  }
  return db;
}

/**
 * 关闭数据库连接
 */
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
    console.log('[database] 数据库连接已关闭');
  }
}

/**
 * 以事务方式执行多个操作
 */
export function transaction(fn) {
  const database = getDatabase();
  const transaction = database.transaction(fn);
  return transaction();
}

export default {
  initDatabase,
  getDatabase,
  closeDatabase,
  transaction,
};
