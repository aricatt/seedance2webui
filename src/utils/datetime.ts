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
export function formatDbTime(utc?: string | null, locale = 'zh-CN'): string {
  if (!utc) return '-';
  const trimmed = String(utc).trim();
  // 已经带时区标记（Z 或 ±HH:MM）则直接解析
  const hasTz = /([Zz]|[+\-]\d{2}:?\d{2})$/.test(trimmed);
  // 无 T 的用 T 替换空格，再补 Z
  const normalized = hasTz
    ? trimmed
    : (trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')) + 'Z';
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return trimmed;
  return d.toLocaleString(locale);
}

/**
 * 只显示日期部分（YYYY/MM/DD 等本地化格式）
 */
export function formatDbDate(utc?: string | null, locale = 'zh-CN'): string {
  if (!utc) return '-';
  const trimmed = String(utc).trim();
  const hasTz = /([Zz]|[+\-]\d{2}:?\d{2})$/.test(trimmed);
  const normalized = hasTz
    ? trimmed
    : (trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')) + 'Z';
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return trimmed;
  return d.toLocaleDateString(locale);
}
