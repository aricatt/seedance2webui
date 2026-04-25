/**
 * 时间显示工具
 *
 * 背景：SQLite 的 `CURRENT_TIMESTAMP` 返回的是 UTC 时间，但字符串格式
 *       `YYYY-MM-DD HH:MM:SS` 没有时区标记。
 *       JS 的 `new Date('YYYY-MM-DD HH:MM:SS')` 在大部分浏览器里会把它当作
 *       本地时间解析，导致呈现时间比实际早 8 小时（北京时区）。
 *
 * 解决：在解析前给字符串加上 `Z` 后缀，明确告诉 JS 这是 UTC。
 */

/**
 * 把 DB 返回的 UTC 无时区时间字符串格式化为用户本地时间字符串。
 * 支持 SQLite 两种常见格式：
 *   - `2026-04-21 02:55:00`（DEFAULT CURRENT_TIMESTAMP）
 *   - `2026-04-21T02:55:00`（ISO 无 Z）
 *   - `2026-04-21T02:55:00Z` / 带 +HH:MM 时区（已带时区则原样解析）
 * 其它解析失败时，返回原字符串。
 */
/**
 * 将 DB 返回的 UTC 无时区时间字符串解析为毫秒时间戳。
 * 解析失败返回 NaN。无时区标记的字符串一律当作 UTC，避免 `new Date()` 把
 * `"YYYY-MM-DD HH:MM:SS"` 当作本地时间，导致北京时区下偏差 8 小时 / 480 分钟。
 */
export function parseDbTimeMs(utc?: string | null): number {
  if (!utc) return Number.NaN;
  const trimmed = String(utc).trim();
  const hasTz = /([Zz]|[+\-]\d{2}:?\d{2})$/.test(trimmed);
  const normalized = hasTz
    ? trimmed
    : (trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')) + 'Z';
  return new Date(normalized).getTime();
}

export function formatDbTime(utc?: string | null, locale = 'zh-CN'): string {
  if (!utc) return '-';
  const ms = parseDbTimeMs(utc);
  if (Number.isNaN(ms)) return String(utc).trim();
  return new Date(ms).toLocaleString(locale);
}

/**
 * 只显示日期部分（YYYY/MM/DD 等本地化格式）
 */
export function formatDbDate(utc?: string | null, locale = 'zh-CN'): string {
  if (!utc) return '-';
  const ms = parseDbTimeMs(utc);
  if (Number.isNaN(ms)) return String(utc).trim();
  return new Date(ms).toLocaleDateString(locale);
}
