import fs from 'fs';
import path from 'path';
import { getDatabase } from '../database/index.js';

/**
 * 视频下载服务
 * 负责将生成的视频保存到本地
 */

/**
 * 规范化文件名
 */
function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"/\\|？*]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 100);
}

/**
 * 确保目录存在
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

/**
 * 规范化存储路径：展开 ~ 并统一路径分隔符
 * - Node.js fs 不会自动展开 ~
 * - 数据库中可能存有 Windows 反斜杠路径，在 macOS/Linux 上 fs 不认
 */
function resolvePath(filePath) {
  if (!filePath) return filePath;
  // 1. 统一反斜杠为正斜杠（在非 Windows 平台上反斜杠不是分隔符）
  let resolved = process.platform === 'win32' ? filePath : filePath.replace(/\\/g, '/');
  // 2. 展开 ~
  if (resolved.startsWith('~')) {
    const homedir = process.platform === 'win32'
      ? process.env.USERPROFILE
      : process.env.HOME;
    resolved = path.join(homedir, resolved.slice(1).replace(/^[\/\\]/, ''));
  }
  return path.normalize(resolved);
}

/**
 * 下载视频到本地
 * @param {string} videoUrl - 视频 URL
 * @param {string} savePath - 保存路径（目录）
 * @param {string} filename - 文件名（不含扩展名）
 * @returns {Promise<{success: boolean, path?: string, error?: string}>}
 */
export async function downloadVideo(videoUrl, savePath, filename) {
  try {
    // 确保保存目录存在
    const targetDir = ensureDir(savePath);

    // 生成安全的文件名
    const safeFilename = sanitizeFilename(filename);
    const filepath = path.join(targetDir, `${safeFilename}.mp4`);

    // 下载视频
    const response = await fetch(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!response.ok) {
      throw new Error(`下载失败：HTTP ${response.status}`);
    }

    // 检查 Content-Type
    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.includes('video')) {
      console.warn('[download] 非视频内容类型:', contentType);
    }

    // 创建写入流
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(filepath, buffer);

    // 验证文件
    const stats = fs.statSync(filepath);
    if (stats.size === 0) {
      fs.unlinkSync(filepath);
      throw new Error('下载的文件为空');
    }

    console.log(`[download] 视频已保存：${filepath} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);

    return {
      success: true,
      path: filepath,
      size: stats.size,
    };
  } catch (error) {
    console.error('[download] 下载失败:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

function getTaskWithProject(taskId) {
  const db = getDatabase();
  return db.prepare(`
    SELECT t.*, p.name as project_name
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.id = ?
  `).get(taskId);
}

function buildTaskVideoFilename(task, taskId) {
  const promptPreview = task.prompt ? sanitizeFilename(task.prompt.substring(0, 30)) : '';
  const baseName = `${sanitizeFilename(task.project_name || 'project')}_task${taskId}${promptPreview ? `_${promptPreview}` : ''}`;
  return `${baseName}.mp4`;
}

/**
 * 根据任务 ID 下载视频
 * @param {number} taskId - 任务 ID
 * @param {string} baseDownloadPath - 基础下载路径
 * @returns {Promise<{success: boolean, path?: string, error?: string}>}
 */
export async function downloadVideoByTaskId(taskId, baseDownloadPath) {
  try {
    const db = getDatabase();
    const task = getTaskWithProject(taskId);

    if (!task) {
      return { success: false, error: '任务不存在' };
    }

    if (!task.video_url) {
      return { success: false, error: '任务没有视频 URL' };
    }

    // 构建保存路径：baseDownloadPath/project_name/
    const projectDir = path.join(baseDownloadPath, sanitizeFilename(task.project_name || `project_${task.project_id}`));
    const filename = buildTaskVideoFilename(task, taskId).replace(/\.mp4$/i, '');

    // 下载视频
    const result = await downloadVideo(task.video_url, projectDir, filename);

    if (result.success) {
      // 更新任务的 video_path
      db.prepare(`UPDATE tasks SET video_path = ? WHERE id = ?`).run(result.path, taskId);
    }

    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 获取已下载视频文件信息
 * @param {number} taskId - 任务 ID
 * @returns {{success: boolean, filePath?: string, filename?: string, task?: any, error?: string}}
 */
export function getDownloadedVideoFileByTaskId(taskId) {
  try {
    const task = getTaskWithProject(taskId);

    if (!task) {
      return { success: false, error: '任务不存在' };
    }

    if (!task.video_path) {
      return { success: false, error: '任务尚未下载到服务器' };
    }

    const resolvedPath = resolvePath(task.video_path);

    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: `视频文件不存在，可能已被删除。\n文件记录路径：${resolvedPath}` };
    }

    return {
      success: true,
      task,
      filePath: resolvedPath,
      filename: path.basename(resolvedPath) || buildTaskVideoFilename(task, taskId),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 打开视频所在文件夹
 * @param {string} videoPath - 视频文件路径
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function openVideoFolder(videoPath) {
  try {
    const { exec } = await import('child_process');
    const dirPath = path.dirname(videoPath);

    // 检查目录是否存在
    if (!fs.existsSync(dirPath)) {
      throw new Error('目录不存在');
    }

    // 根据平台打开文件夹
    const platform = process.platform;

    return new Promise((resolve, reject) => {
      let command;

      if (platform === 'win32') {
        command = `explorer "${dirPath}"`;
      } else if (platform === 'darwin') {
        command = `open "${dirPath}"`;
      } else {
        // Linux (包括 WSL)
        command = `xdg-open "${dirPath}"`;
      }

      exec(command, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve({ success: true });
        }
      });
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 获取下载路径设置
 */
export function getDefaultDownloadPath() {
  const db = getDatabase();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'download_path'`).get();

  if (row && row.value) {
    return resolvePath(row.value);
  }

  // 默认下载到用户目录下的 Videos/Seedance 文件夹
  const homedir = process.platform === 'win32'
    ? process.env.USERPROFILE
    : process.env.HOME;

  return path.join(homedir, 'Videos', 'Seedance');
}

/**
 * 批量下载视频
 */
export async function batchDownloadVideos(taskIds, baseDownloadPath) {
  const results = [];

  for (const taskId of taskIds) {
    const result = await downloadVideoByTaskId(taskId, baseDownloadPath);
    results.push({ taskId, ...result });
  }

  return results;
}

/**
 * 获取下载任务列表
 * @param {Object} options - 查询选项
 * @param {string} options.status - 下载状态筛选
 * @param {string} options.type - 类型筛选
 * @param {number} options.page - 页码（从 1 开始）
 * @param {number} options.pageSize - 每页数量
 * @param {number|null} options.userId - 用户 ID，用于过滤（非管理员只能查看自己的任务）
 * @param {boolean} options.isAdmin - 是否管理员，true 时忽略 userId 过滤
 * @returns {Object} { tasks, total, page, pageSize }
 */
export function getDownloadTasks(options = {}) {
  const db = getDatabase();
  const {
    status = 'all',
    type = 'all',
    page = 1,
    pageSize = 20,
    userId = null,
    isAdmin = false,
  } = options;

  const whereClauses = ["t.task_kind = 'output'"];
  const params = [];

  // 非管理员用户只能查看自己的任务
  if (!isAdmin && userId !== null) {
    whereClauses.push('t.user_id = ?');
    params.push(userId);
  }

  if (status !== 'all') {
    if (status === 'generating') {
      whereClauses.push("(t.status = 'generating' OR (t.history_id IS NOT NULL AND t.video_url IS NULL AND t.status != 'cancelled'))");
    } else if (status === 'pending') {
      whereClauses.push("(t.video_url IS NOT NULL AND (t.download_status IS NULL OR t.download_status = 'pending'))");
    } else {
      whereClauses.push('t.download_status = ?');
      params.push(status);
    }
  }

  if (type !== 'all' && type !== 'video') {
    return { tasks: [], total: 0, page, pageSize };
  }

  const whereClause = `WHERE ${whereClauses.join(' AND ')}`;
  const countStmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM tasks t
    ${whereClause}
  `);
  const { count: total } = countStmt.get(...params);

  const offset = (page - 1) * pageSize;
  const query = `
    SELECT
      t.id,
      t.prompt,
      t.status,
      t.download_status,
      t.video_url,
      t.video_path,
      t.download_path,
      t.downloaded_at,
      t.account_info,
      t.history_id,
      t.item_id,
      t.submit_id,
      t.source_task_id,
      t.output_index,
      t.created_at,
      t.completed_at,
      t.duration,
      t.archive_path,
      p.name as project_name,
      u.email as user_email,
      CASE
        WHEN t.status = 'generating' OR (t.history_id IS NOT NULL AND t.video_url IS NULL AND t.status != 'cancelled') THEN 'generating'
        WHEN t.status = 'done' AND t.video_url IS NOT NULL AND (t.download_status IS NULL OR t.download_status = 'pending') THEN 'pending'
        WHEN t.download_status = 'downloading' THEN 'downloading'
        WHEN t.download_status = 'done' THEN 'done'
        WHEN t.download_status = 'failed' THEN 'failed'
        ELSE 'failed'
      END as effective_download_status
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    LEFT JOIN users u ON t.user_id = u.id
    ${whereClause}
    ORDER BY t.created_at DESC
    LIMIT ? OFFSET ?
  `;

  const stmt = db.prepare(query);
  const tasks = stmt.all(...params, pageSize, offset);

  return {
    tasks: tasks.map((task) => ({
      ...task,
      hasHistory: !!task.history_id,
      model_type: 'video',
    })),
    total,
    page,
    pageSize,
  };
}

/**
 * 更新下载状态
 */
export function updateDownloadStatus(taskId, status, extraData = {}) {
  try {
    const db = getDatabase();
    const updates = ['download_status = ?'];
    const values = [status];

    if (status === 'done' && extraData.downloadPath) {
      updates.push('download_path = ?');
      values.push(extraData.downloadPath);
    }
    if (status === 'done') {
      updates.push('downloaded_at = CURRENT_TIMESTAMP');
    }
    if (extraData.error) {
      updates.push('error_message = ?');
      values.push(extraData.error);
    }

    values.push(taskId);

    db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export default {
  downloadVideo,
  downloadVideoByTaskId,
  getDownloadedVideoFileByTaskId,
  openVideoFolder,
  getDefaultDownloadPath,
  batchDownloadVideos,
  getDownloadTasks,
  updateDownloadStatus,
};
