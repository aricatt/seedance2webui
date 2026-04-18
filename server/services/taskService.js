import { randomUUID } from 'crypto';
import { getDatabase, transaction } from '../database/index.js';

/**
 * 任务服务层
 * 负责任务的 CRUD 操作
 */

const TASK_COLUMNS = [
  'project_id',
  'user_id',
  'prompt',
  'task_kind',
  'source_task_id',
  'row_group_id',
  'row_index',
  'video_count',
  'output_index',
  'status',
  'submit_id',
  'history_id',
  'item_id',
  'video_url',
  'video_path',
  'download_status',
  'download_path',
  'downloaded_at',
  'submitted_at',
  'account_info',
  'progress',
  'started_at',
  'completed_at',
  'error_message',
  'retry_count',
  'duration',
];

const TASK_UPDATE_FIELDS = new Set(TASK_COLUMNS);

function pickFirstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function normalizeTaskData(data = {}) {
  const projectId = pickFirstDefined(data.projectId, data.project_id);
  const userId = pickFirstDefined(data.userId, data.user_id);

  if (projectId === undefined || projectId === null) {
    throw new Error('projectId is required');
  }

  return {
    project_id: Number(projectId),
    user_id: userId ? Number(userId) : null,
    prompt: pickFirstDefined(data.prompt, ''),
    task_kind: pickFirstDefined(data.taskKind, data.task_kind, 'output'),
    source_task_id: pickFirstDefined(data.sourceTaskId, data.source_task_id, null),
    row_group_id: pickFirstDefined(data.rowGroupId, data.row_group_id, null),
    row_index: pickFirstDefined(data.rowIndex, data.row_index, null),
    video_count: Number(pickFirstDefined(data.videoCount, data.video_count, 1) || 1),
    output_index: pickFirstDefined(data.outputIndex, data.output_index, null),
    status: pickFirstDefined(data.status, 'pending'),
    submit_id: pickFirstDefined(data.submitId, data.submit_id, null),
    history_id: pickFirstDefined(data.historyId, data.history_id, null),
    item_id: pickFirstDefined(data.itemId, data.item_id, null),
    video_url: pickFirstDefined(data.videoUrl, data.video_url, null),
    video_path: pickFirstDefined(data.videoPath, data.video_path, null),
    download_status: pickFirstDefined(data.downloadStatus, data.download_status, 'pending'),
    download_path: pickFirstDefined(data.downloadPath, data.download_path, null),
    downloaded_at: pickFirstDefined(data.downloadedAt, data.downloaded_at, null),
    submitted_at: pickFirstDefined(data.submittedAt, data.submitted_at, null),
    account_info: pickFirstDefined(data.accountInfo, data.account_info, null),
    progress: pickFirstDefined(data.progress, null),
    started_at: pickFirstDefined(data.startedAt, data.started_at, null),
    completed_at: pickFirstDefined(data.completedAt, data.completed_at, null),
    error_message: pickFirstDefined(data.errorMessage, data.error_message, null),
    retry_count: Number(pickFirstDefined(data.retryCount, data.retry_count, 0) || 0),
    duration: pickFirstDefined(data.duration, null) != null ? Number(pickFirstDefined(data.duration, null)) : null,
  };
}

function normalizeUpdateFields(updates = {}) {
  const normalized = {};

  for (const [key, value] of Object.entries(updates)) {
    switch (key) {
      case 'taskKind':
        normalized.task_kind = value;
        break;
      case 'sourceTaskId':
        normalized.source_task_id = value;
        break;
      case 'rowGroupId':
        normalized.row_group_id = value;
        break;
      case 'rowIndex':
        normalized.row_index = value;
        break;
      case 'videoCount':
        normalized.video_count = value;
        break;
      case 'outputIndex':
        normalized.output_index = value;
        break;
      case 'submitId':
        normalized.submit_id = value;
        break;
      case 'historyId':
        normalized.history_id = value;
        break;
      case 'itemId':
        normalized.item_id = value;
        break;
      case 'videoUrl':
        normalized.video_url = value;
        break;
      case 'videoPath':
        normalized.video_path = value;
        break;
      case 'downloadStatus':
        normalized.download_status = value;
        break;
      case 'downloadPath':
        normalized.download_path = value;
        break;
      case 'downloadedAt':
        normalized.downloaded_at = value;
        break;
      case 'submittedAt':
        normalized.submitted_at = value;
        break;
      case 'accountInfo':
        normalized.account_info = value;
        break;
      case 'errorMessage':
        normalized.error_message = value;
        break;
      case 'retryCount':
        normalized.retry_count = value;
        break;
      case 'startedAt':
        normalized.started_at = value;
        break;
      case 'completedAt':
        normalized.completed_at = value;
        break;
      default:
        normalized[key] = value;
        break;
    }
  }

  return normalized;
}

function insertTaskRecord(db, taskData) {
  const record = normalizeTaskData(taskData);
  const stmt = db.prepare(`
    INSERT INTO tasks (${TASK_COLUMNS.join(', ')})
    VALUES (${TASK_COLUMNS.map(() => '?').join(', ')})
  `);
  const result = stmt.run(...TASK_COLUMNS.map((column) => record[column]));
  return getTaskById(result.lastInsertRowid);
}

function cloneTaskAssetsWithDb(db, sourceTaskId, targetTaskId) {
  const assets = db.prepare(`
    SELECT asset_type, file_path, image_uri, sort_order
    FROM task_assets
    WHERE task_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(sourceTaskId);

  if (assets.length === 0) {
    return [];
  }

  const insertStmt = db.prepare(`
    INSERT INTO task_assets (task_id, asset_type, file_path, image_uri, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  const selectStmt = db.prepare(`SELECT * FROM task_assets WHERE task_id = ? ORDER BY sort_order ASC, id ASC`);

  for (const asset of assets) {
    insertStmt.run(targetTaskId, asset.asset_type, asset.file_path, asset.image_uri || null, asset.sort_order || 0);
  }

  return selectStmt.all(targetTaskId);
}

function expandDraftTaskWithDb(db, draftTaskId, options = {}) {
  const draftTask = getTaskById(draftTaskId);

  if (!draftTask) {
    throw new Error(`任务不存在: ${draftTaskId}`);
  }

  if (draftTask.task_kind !== 'draft') {
    throw new Error(`任务不是草稿任务: ${draftTaskId}`);
  }

  const totalOutputs = Math.max(1, Number(draftTask.video_count || 1));
  const rowGroupId = options.rowGroupId || draftTask.row_group_id || randomUUID();
  const outputTasks = [];

  for (let index = 0; index < totalOutputs; index += 1) {
    const outputTask = insertTaskRecord(db, {
      project_id: draftTask.project_id,
      user_id: draftTask.user_id,
      prompt: draftTask.prompt || '',
      task_kind: 'output',
      source_task_id: draftTask.id,
      row_group_id: rowGroupId,
      row_index: draftTask.row_index,
      video_count: totalOutputs,
      output_index: index + 1,
      status: 'pending',
      download_status: 'pending',
      account_info: draftTask.account_info,
    });

    cloneTaskAssetsWithDb(db, draftTask.id, outputTask.id);
    outputTasks.push(outputTask);
  }

  return outputTasks;
}

/**
 * 获取任务详情（支持权限检查）
 * @param {number} id - 任务 ID
 * @param {number|null} userId - 用户 ID，用于权限检查
 * @param {boolean} isAdmin - 是否管理员
 */
export function getTaskById(id, userId = null, isAdmin = false) {
  const db = getDatabase();

  let query = `
    SELECT t.*, p.name as project_name
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.id = ?
  `;

  const params = [id];

  // 非管理员用户只能查看自己的任务
  if (!isAdmin && userId !== null) {
    query += ` AND t.user_id = ?`;
    params.push(userId);
  }

  const stmt = db.prepare(query);
  return stmt.get(...params);
}

/**
 * 创建任务
 */
export function createTask(taskData) {
  const db = getDatabase();
  return insertTaskRecord(db, taskData);
}

/**
 * 批量创建任务
 */
export function createTasksBulk(tasksData) {
  return transaction(() => {
    const db = getDatabase();
    return tasksData.map((task) => insertTaskRecord(db, task));
  });
}

/**
 * 更新任务
 */
export function updateTask(id, updates) {
  const db = getDatabase();
  const normalizedUpdates = normalizeUpdateFields(updates);
  const updatesList = [];
  const values = [];

  for (const [key, value] of Object.entries(normalizedUpdates)) {
    if (TASK_UPDATE_FIELDS.has(key)) {
      updatesList.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (updatesList.length === 0) {
    return getTaskById(id);
  }

  updatesList.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);

  const stmt = db.prepare(`
    UPDATE tasks
    SET ${updatesList.join(', ')}
    WHERE id = ?
  `);
  stmt.run(...values);

  return getTaskById(id);
}

/**
 * 更新任务状态
 */
export function updateTaskStatus(id, status, extraUpdates = {}) {
  const updates = { status, ...extraUpdates };

  if (status === 'generating' && !extraUpdates.started_at && !extraUpdates.startedAt) {
    updates.started_at = new Date().toISOString();
  }

  if ((status === 'done' || status === 'error' || status === 'cancelled') && !extraUpdates.completed_at && !extraUpdates.completedAt) {
    updates.completed_at = new Date().toISOString();
  }

  return updateTask(id, updates);
}

/**
 * 删除任务
 */
export function deleteTask(id) {
  const db = getDatabase();
  const stmt = db.prepare(`DELETE FROM tasks WHERE id = ?`);
  return stmt.run(id);
}

/**
 * 添加任务素材
 */
export function addTaskAsset(taskId, { assetType, filePath, imageUri, sortOrder = 0 }) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO task_assets (task_id, asset_type, file_path, image_uri, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(taskId, assetType, filePath, imageUri || null, sortOrder);

  const assetStmt = db.prepare(`SELECT * FROM task_assets WHERE id = ?`);
  return assetStmt.get(result.lastInsertRowid);
}

/**
 * 获取任务素材列表
 */
export function getTaskAssets(taskId) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM task_assets
    WHERE task_id = ?
    ORDER BY sort_order ASC, id ASC
  `);
  return stmt.all(taskId);
}

/**
 * 克隆任务素材关联
 */
export function cloneTaskAssets(sourceTaskId, targetTaskId) {
  return transaction(() => {
    const db = getDatabase();
    return cloneTaskAssetsWithDb(db, sourceTaskId, targetTaskId);
  });
}

/**
 * 删除任务素材
 */
export function deleteTaskAsset(assetId) {
  const db = getDatabase();
  const stmt = db.prepare(`DELETE FROM task_assets WHERE id = ?`);
  return stmt.run(assetId);
}

/**
 * 更新素材的 image_uri
 */
export function updateAssetImageUri(assetId, imageUri) {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE task_assets
    SET image_uri = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  return stmt.run(imageUri, assetId);
}

/**
 * 获取项目下的所有任务（带素材）
 */
export function getTasksWithAssets(projectId, options = {}) {
  const db = getDatabase();
  const tasks = getTasksByProjectId(projectId, options);
  const assetsStmt = db.prepare(`SELECT * FROM task_assets WHERE task_id = ? ORDER BY sort_order ASC, id ASC`);

  return tasks.map(task => ({
    ...task,
    assets: assetsStmt.all(task.id),
  }));
}

/**
 * 根据项目 ID 获取任务列表
 */
export function getTasksByProjectId(projectId, options = {}) {
  const db = getDatabase();
  const whereClauses = ['project_id = ?'];
  const values = [projectId];

  if (options.status) {
    whereClauses.push('status = ?');
    values.push(options.status);
  }

  if (options.taskKind) {
    whereClauses.push('task_kind = ?');
    values.push(options.taskKind);
  }

  if (options.sourceTaskId !== undefined) {
    whereClauses.push('source_task_id = ?');
    values.push(options.sourceTaskId);
  }

  if (options.rowGroupId) {
    whereClauses.push('row_group_id = ?');
    values.push(options.rowGroupId);
  }

  const stmt = db.prepare(`
    SELECT * FROM tasks
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY COALESCE(row_index, 999999) ASC, created_at DESC
  `);
  return stmt.all(...values);
}

/**
 * 获取某个草稿任务展开出的输出任务
 */
export function getOutputTasksBySourceTaskId(sourceTaskId) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT t.*, p.name as project_name
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.source_task_id = ? AND t.task_kind = 'output'
    ORDER BY t.output_index ASC, t.id ASC
  `);
  return stmt.all(sourceTaskId);
}

/**
 * 将草稿任务展开为输出任务
 */
export function expandDraftTaskToOutputTasks(draftTaskId, options = {}) {
  return transaction(() => {
    const db = getDatabase();
    return expandDraftTaskWithDb(db, draftTaskId, options);
  });
}

/**
 * 批量将草稿任务展开为输出任务
 */
export function expandDraftTasksToOutputTasks(draftTaskIds, options = {}) {
  return transaction(() => {
    const db = getDatabase();
    const outputTasks = [];

    for (const draftTaskId of draftTaskIds) {
      const expanded = expandDraftTaskWithDb(db, draftTaskId, options);
      outputTasks.push(...expanded);
    }

    return outputTasks;
  });
}

/**
 * 获取所有待处理的任务
 */
export function getPendingTasks() {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT t.*, p.name as project_name
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.status = 'pending' AND t.task_kind = 'output'
    ORDER BY t.created_at ASC
  `);
  return stmt.all();
}

/**
 * 根据状态筛选任务
 */
export function getTasksByStatus(projectId, status) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM tasks
    WHERE project_id = ? AND status = ?
    ORDER BY created_at DESC
  `);
  return stmt.all(projectId, status);
}

export default {
  getTaskById,
  createTask,
  createTasksBulk,
  updateTask,
  updateTaskStatus,
  deleteTask,
  addTaskAsset,
  getTaskAssets,
  cloneTaskAssets,
  deleteTaskAsset,
  updateAssetImageUri,
  getTasksWithAssets,
  getTasksByProjectId,
  getOutputTasksBySourceTaskId,
  expandDraftTaskToOutputTasks,
  expandDraftTasksToOutputTasks,
  getPendingTasks,
  getTasksByStatus,
};
