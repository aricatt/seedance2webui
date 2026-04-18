import { getDatabase } from '../database/index.js';

/**
 * 全局设置服务层
 */

const EDITABLE_SETTING_KEYS = new Set([
  'model',
  'ratio',
  'duration',
  'download_path',
  'max_concurrent',
  'min_interval',
  'max_interval',
]);

function sanitizeSettingsRowMap(rows) {
  const settings = {};
  for (const row of rows) {
    if (row.key === 'session_id') {
      continue;
    }
    settings[row.key] = row.value;
  }
  return settings;
}

/**
 * 获取所有可编辑全局设置
 */
export function getAllSettings() {
  const db = getDatabase();
  const stmt = db.prepare(`SELECT * FROM settings`);
  const rows = stmt.all();
  return sanitizeSettingsRowMap(rows);
}

/**
 * 获取单个设置
 */
export function getSetting(key) {
  if (!EDITABLE_SETTING_KEYS.has(key)) {
    return null;
  }

  const db = getDatabase();
  const stmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
  const row = stmt.get(key);
  return row ? row.value : null;
}

/**
 * 更新设置
 */
export function updateSetting(key, value) {
  if (!EDITABLE_SETTING_KEYS.has(key)) {
    throw new Error('不支持更新该设置项');
  }

  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(key, value);
  return { key, value };
}

/**
 * 批量更新设置
 */
export function updateSettings(settings) {
  const db = getDatabase();
  const entries = Object.entries(settings).filter(([key]) => EDITABLE_SETTING_KEYS.has(key));

  const stmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `);

  const transaction = db.transaction((items) => {
    for (const [key, value] of items) {
      stmt.run(key, value);
    }
  });

  transaction(entries);
  return getAllSettings();
}

export default {
  getAllSettings,
  getSetting,
  updateSetting,
  updateSettings,
};
