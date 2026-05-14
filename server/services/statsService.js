/**
 * 统计服务 - 基于本地 tasks 表实现用户/分组维度的生成统计
 */

import { getDatabase } from '../database/index.js';

function buildUserIdClause(filterUserIds) {
  if (!filterUserIds || filterUserIds.length === 0) return { clause: '', params: [] };
  const ph = filterUserIds.map(() => '?').join(', ');
  return { clause: ` AND user_id IN (${ph}) `, params: filterUserIds };
}

function buildUsersTableClause(filterUserIds) {
  if (!filterUserIds || filterUserIds.length === 0) return { clause: '', params: [] };
  const ph = filterUserIds.map(() => '?').join(', ');
  return { clause: ` AND u.id IN (${ph}) `, params: filterUserIds };
}

/**
 * 获取用户生成统计（按时间范围，可选按本地用户 ID 列表过滤）
 * @param {number} days - 最近 N 天，0 或负数表示全部
 * @param {number[] | null} filterUserIds - 仅统计这些用户的任务；null 表示全部用户
 */
export function getUserGenerationStats(days = 30, filterUserIds = null) {
  if (filterUserIds && filterUserIds.length === 0) {
    return [];
  }

  const db = getDatabase();

  let timeFilter = '';
  let params = [];

  if (days > 0) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    timeFilter = `AND (t.created_at >= ? OR t.completed_at >= ?)`;
    params = [since, since];
  }

  const { clause: userClause, params: userParams } = buildUsersTableClause(filterUserIds);

  const sql = `
    SELECT 
      u.id as user_id,
      u.email,
      u.display_name,
      COUNT(DISTINCT t.id) as task_count,
      COALESCE(SUM(t.video_count), 0) as video_count,
      COALESCE(SUM(CASE WHEN t.status = 'done' THEN t.video_count ELSE 0 END), 0) as success_video_count,
      MAX(t.completed_at) as last_active_at,
      COUNT(CASE WHEN t.status = 'done' THEN 1 END) as success_task_count,
      COUNT(t.id) as total_task_count
    FROM users u
    LEFT JOIN tasks t ON t.user_id = u.id ${timeFilter}
    WHERE 1=1 ${userClause}
    GROUP BY u.id, u.email, u.display_name
    ORDER BY video_count DESC, success_video_count DESC
    LIMIT 100
  `;

  const rows = db.prepare(sql).all(...params, ...userParams);

  const failureBreakdown = getUserFailureBreakdown(days, filterUserIds);

  return rows.map(row => {
    const fb = failureBreakdown.find(f => f.userId === row.user_id) || { submission: 0, generation: 0, download: 0 };
    return {
      userId: row.user_id,
      email: row.email,
      displayName: String(row.display_name ?? '').trim(),
      taskCount: row.task_count || 0,
      videoCount: row.video_count || 0,
      successVideoCount: row.success_video_count || 0,
      successRate: row.total_task_count > 0
        ? Math.round((row.success_task_count / row.total_task_count) * 100)
        : 0,
      lastActive: row.last_active_at || null,
      submissionFailureCount: fb.submission || 0,
      generationFailureCount: fb.generation || 0,
      downloadFailureCount: fb.download || 0,
    };
  });
}

/**
 * 获取每个用户的失败阶段分布
 */
function getUserFailureBreakdown(days = 30, filterUserIds = null) {
  if (filterUserIds && filterUserIds.length === 0) {
    return [];
  }

  const db = getDatabase();

  let timeFilter = '';
  let params = [];

  if (days > 0) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    timeFilter = `AND (created_at >= ? OR completed_at >= ?)`;
    params = [since, since];
  }

  const { clause: uidClause, params: uidParams } = buildUserIdClause(filterUserIds);

  const errorSqlFixed = `
    SELECT 
      user_id,
      SUM(CASE WHEN LOWER(COALESCE(error_message,'')) LIKE '%413%' 
                 OR LOWER(COALESCE(error_message,'')) LIKE '%payload too large%'
                 OR LOWER(COALESCE(error_message,'')) LIKE '%sensitive%'
                 OR LOWER(COALESCE(error_message,'')) LIKE '%overdue%'
                 THEN 1 ELSE 0 END) as submission,
      SUM(CASE WHEN LOWER(COALESCE(error_message,'')) LIKE '%timeout%' 
                 OR LOWER(COALESCE(error_message,'')) LIKE '%轮询超时%'
                 OR LOWER(COALESCE(error_message,'')) LIKE '%contain real person%'
                 OR LOWER(COALESCE(error_message,'')) LIKE '%copyright%'
                 THEN 1 ELSE 0 END) as generation
    FROM tasks
    WHERE status = 'error' ${timeFilter} ${uidClause}
    GROUP BY user_id
  `;

  const errorRows = db.prepare(errorSqlFixed).all(...params, ...uidParams);

  const downloadSql = `
    SELECT user_id, COUNT(*) as download
    FROM tasks
    WHERE download_status = 'failed' ${timeFilter} ${uidClause}
    GROUP BY user_id
  `;

  const downloadRows = db.prepare(downloadSql).all(...params, ...uidParams);

  const map = new Map();
  errorRows.forEach(r => map.set(r.user_id, { submission: r.submission || 0, generation: r.generation || 0, download: 0 }));
  downloadRows.forEach(r => {
    if (map.has(r.user_id)) {
      map.get(r.user_id).download = r.download || 0;
    } else {
      map.set(r.user_id, { submission: 0, generation: 0, download: r.download || 0 });
    }
  });

  return Array.from(map.entries()).map(([userId, counts]) => ({ userId, ...counts }));
}

/**
 * 获取全局汇总 KPI
 */
export function getGlobalGenerationSummary(days = 30, filterUserIds = null) {
  if (filterUserIds && filterUserIds.length === 0) {
    return {
      totalVideos: 0,
      successVideos: 0,
      totalTasks: 0,
      successRate: 0,
      activeUsers: 0,
    };
  }

  const db = getDatabase();

  let whereParts = [];
  let params = [];

  if (days > 0) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    whereParts.push('(created_at >= ? OR completed_at >= ?)');
    params.push(since, since);
  }

  const { clause: uidClause, params: uidParams } = buildUserIdClause(filterUserIds);
  if (uidClause.trim()) {
    // 去掉前置 AND（避免 trim 后 /^ AND / 不匹配导致生成 WHERE AND ...）
    whereParts.push(uidClause.trim().replace(/^\s*AND\s+/i, '').trim());
    params.push(...uidParams);
  }

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const sql = `
    SELECT 
      COALESCE(SUM(video_count), 0) as total_videos,
      COALESCE(SUM(CASE WHEN status = 'done' THEN video_count ELSE 0 END), 0) as success_videos,
      COUNT(*) as total_tasks,
      COUNT(CASE WHEN status = 'done' THEN 1 END) as success_tasks,
      COUNT(DISTINCT user_id) as active_users
    FROM tasks
    ${whereSql}
  `;

  const row = db.prepare(sql).get(...params);

  const successRate = row.total_tasks > 0
    ? Math.round((row.success_tasks / row.total_tasks) * 100)
    : 0;

  return {
    totalVideos: row.total_videos || 0,
    successVideos: row.success_videos || 0,
    totalTasks: row.total_tasks || 0,
    successRate,
    activeUsers: row.active_users || 0,
  };
}

function classifyFailureStage(errorMessage) {
  const msg = (errorMessage || '').toLowerCase();

  if (
    msg.includes('timeout') ||
    msg.includes('轮询超时') ||
    msg.includes('contain real person') ||
    msg.includes('related to copyright restrictions')
  ) {
    return 'generation';
  }

  if (
    msg.includes('413') ||
    msg.includes('payload too large') ||
    msg.includes('sensitive information') ||
    msg.includes('overdue balance') ||
    msg.includes('account has an overdue')
  ) {
    return 'submission';
  }

  return 'generation';
}

/**
 * 获取失败原因分布（按阶段分类展示）
 */
export function getErrorDistribution(days = 30, filterUserIds = null) {
  if (filterUserIds && filterUserIds.length === 0) {
    return {
      submissionFailures: [],
      generationFailures: [],
      downloadFailedCount: 0,
      totalErrorTasks: 0,
    };
  }

  const db = getDatabase();

  let timeFilter = '';
  let params = [];

  if (days > 0) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    timeFilter = `AND (created_at >= ? OR completed_at >= ?)`;
    params = [since, since];
  }

  const { clause: uidClause, params: uidParams } = buildUserIdClause(filterUserIds);

  const errorSql = `
    SELECT 
      COALESCE(error_message, '(无错误信息)') as error_message,
      COUNT(*) as count
    FROM tasks
    WHERE status = 'error' ${timeFilter} ${uidClause}
    GROUP BY error_message
    ORDER BY count DESC
  `;

  const errorRows = db.prepare(errorSql).all(...params, ...uidParams);

  const submissionFailures = [];
  const generationFailures = [];
  let totalErrorTasks = 0;

  errorRows.forEach(row => {
    const stage = classifyFailureStage(row.error_message);
    const item = {
      error_message: row.error_message,
      count: row.count,
    };
    totalErrorTasks += row.count;

    if (stage === 'submission') {
      submissionFailures.push(item);
    } else {
      generationFailures.push(item);
    }
  });

  const downloadFailedSql = `
    SELECT COUNT(*) as count
    FROM tasks
    WHERE download_status = 'failed' ${timeFilter} ${uidClause}
  `;
  const downloadRow = db.prepare(downloadFailedSql).get(...params, ...uidParams);
  const downloadFailedCount = downloadRow?.count || 0;

  return {
    submissionFailures,
    generationFailures,
    downloadFailedCount,
    totalErrorTasks: totalErrorTasks + downloadFailedCount,
  };
}
