import 'dotenv/config';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase, getDatabase, closeDatabase } from './database/index.js';
import * as projectService from './services/projectService.js';
import * as taskService from './services/taskService.js';
import * as settingsService from './services/settingsService.js';
import * as batchService from './services/batchScheduler.js';
import * as videoDownloader from './services/videoDownloader.js';
import * as authService from './services/authService.js';
import { generateArkVideo, pollArkTaskUntilDone, bufferToDataUri } from './services/arkVideoGenerator.js';
import { assertArkApiKeyOrExit, getArkApiKey } from './services/arkConfig.js';
import {
  getOrUploadToTos,
  getOrUploadToTosByPath,
  cleanupExpiredTosCache,
  isTosConfigured,
} from './services/tosUploader.js';
import { guessMimeType } from './services/arkFileUploader.js';

// 启动时验证 ARK_API_KEY 已配置, 缺失则 fail-fast
assertArkApiKeyOrExit();

// 初始化数据库
initDatabase();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const MODELTOO_API_URL = (process.env.MODELTOO_API_URL || '').replace(/\/+$/, '');

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── ModelToo 远程账号验证 ──────────────────────────────────

/**
 * 尝试通过 ModelToo 远程 API 验证账号密码。
 * 成功返回 { success: true }，任何失败（网络/401/超时）都返回 { success: false }。
 */
async function tryModelTooLogin(username, password) {
  if (!MODELTOO_API_URL) return { success: false };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${MODELTOO_API_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.ok) {
      console.log(`[auth] ModelToo 远程验证成功: ${username}`);
      return { success: true };
    }
    console.log(`[auth] ModelToo 远程验证失败 (HTTP ${resp.status}): ${username}`);
    return { success: false };
  } catch (err) {
    console.log(`[auth] ModelToo 远程不可用: ${err.message}`);
    return { success: false };
  }
}

/**
 * 将 ModelToo 验证通过的账号同步到本地 SQLite。
 * - 本地不存在 → 新建用户 (role=user, credits=10)
 * - 本地已存在 → 仅更新密码哈希
 */
function syncModelTooUser(username, password) {
  const db = getDatabase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(username);
  const passwordHash = authService.hashPassword(password);
  if (!existing) {
    db.prepare(
      `INSERT INTO users (email, password_hash, role, status, credits) VALUES (?, ?, 'user', 'active', 10)`
    ).run(username, passwordHash);
    console.log(`[auth] 已为 ModelToo 用户 "${username}" 创建本地账号`);
  } else {
    db.prepare(
      `UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(passwordHash, existing.id);
    console.log(`[auth] 已同步 ModelToo 用户 "${username}" 的密码`);
  }
}

// 视频/音频需要比图片大得多的上限. 方舟上游 /files 对单文件有自身限制,
// 若超出会由 Ark 服务端拒绝并返回明确错误, 这里放宽到 500MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ============================================================
// 常量定义
// ============================================================
const downloadTokens = new Map();
const DOWNLOAD_TOKEN_TTL_MS = 60 * 1000;
// 流式播放 token 存活更久, 浏览器一次预览可能持续数分钟
const STREAM_TOKEN_TTL_MS = 30 * 60 * 1000;

function cleanupExpiredDownloadTokens() {
  const now = Date.now();
  for (const [token, record] of downloadTokens.entries()) {
    if (record.expiresAt <= now) {
      downloadTokens.delete(token);
    }
  }
}

/**
 * 创建下载 token
 * @param {string|number} taskId
 * @param {number} userId
 * @param {'once'|'stream'} mode - once: 一次性下载; stream: 允许多次使用 (HTTP Range)
 */
function createDownloadToken(taskId, userId, mode = 'once') {
  cleanupExpiredDownloadTokens();
  const token = crypto.randomBytes(24).toString('hex');
  const ttl = mode === 'stream' ? STREAM_TOKEN_TTL_MS : DOWNLOAD_TOKEN_TTL_MS;
  downloadTokens.set(token, {
    taskId: String(taskId),
    userId: Number(userId),
    mode,
    expiresAt: Date.now() + ttl,
  });
  return token;
}

function consumeDownloadToken(token, userId = null) {
  cleanupExpiredDownloadTokens();
  const record = downloadTokens.get(token);
  if (!record) {
    return null;
  }
  if (record.expiresAt <= Date.now()) {
    downloadTokens.delete(token);
    return null;
  }
  if (userId !== null && record.userId !== Number(userId)) {
    downloadTokens.delete(token);
    return null;
  }
  downloadTokens.delete(token);
  return record;
}

/** 查看 token 但不消费, 用于流式播放的多次 Range 请求 */
function peekDownloadToken(token, userId = null) {
  cleanupExpiredDownloadTokens();
  const record = downloadTokens.get(token);
  if (!record) return null;
  if (record.expiresAt <= Date.now()) {
    downloadTokens.delete(token);
    return null;
  }
  if (userId !== null && record.userId !== Number(userId)) {
    return null;
  }
  return record;
}

setInterval(cleanupExpiredDownloadTokens, DOWNLOAD_TOKEN_TTL_MS).unref();

// 认证中间件
const authenticate = async (req, res, next) => {
  const sessionId = req.headers['x-session-id'];

  if (!sessionId) {
    return res.status(401).json({ error: '未登录' });
  }

  try {
    const user = await authService.getCurrentUser(sessionId);
    if (!user) {
      return res.status(401).json({ error: 'Session 已过期或无效' });
    }
    req.user = user;
    req.sessionId = sessionId; // 保存原始 sessionId 供后续使用
    next();
  } catch (error) {
    res.status(401).json({ error: '认证失败' });
  }
};

// 管理员认证中间件
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
};

// ============================================================
// 异步任务管理
// ============================================================
const tasks = new Map();
let taskCounter = 0;

function ensureDefaultProjectForUser(userId) {
  const db = getDatabase();
  // 查找该用户的任何一个"默认项目"（不管有没有带用户名后缀）
  const existingProject = db.prepare(`
    SELECT * FROM projects
    WHERE user_id = ? AND name LIKE '默认项目%'
    ORDER BY id ASC
    LIMIT 1
  `).get(userId);

  if (existingProject) {
    return existingProject;
  }

  // 获取用户名（仅用于日志）
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);

  return projectService.createProject({
    name: '默认项目',
    description: '单任务生成默认项目',
    user_id: userId,
  });
}

function validateBatchTasks(projectId, taskIds, userId = null, isAdmin = false) {
  const project = projectService.getProjectById(projectId, userId, isAdmin);
  if (!project) {
    return { error: '项目不存在', statusCode: 404 };
  }

  const normalizedTaskIds = [...new Set(taskIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (normalizedTaskIds.length === 0) {
    return { error: '请选择有效任务', statusCode: 400 };
  }

  const invalidTasks = [];
  for (const taskId of normalizedTaskIds) {
    const task = taskService.getTaskById(taskId, userId, isAdmin);
    if (!task) {
      invalidTasks.push({ taskId, prompt: '', reason: '任务不存在' });
      continue;
    }
    if (Number(task.project_id) !== Number(projectId)) {
      invalidTasks.push({ taskId, prompt: task.prompt || '', reason: '任务不属于当前项目' });
      continue;
    }
    if (task.task_kind !== 'draft') {
      invalidTasks.push({ taskId, prompt: task.prompt || '', reason: '只能启动草稿任务' });
      continue;
    }
    if (!String(task.prompt || '').trim()) {
      invalidTasks.push({ taskId, prompt: task.prompt || '', reason: '任务缺少提示词' });
      continue;
    }

    const imageAssets = taskService.getTaskAssets(taskId).filter((asset) => asset.asset_type === 'image');
    if (imageAssets.length === 0) {
      invalidTasks.push({ taskId, prompt: task.prompt || '', reason: '任务缺少图片素材' });
    }
  }

  return {
    project,
    taskIds: normalizedTaskIds,
    invalidTasks,
  };
}

function isOutputTask(task) {
  return task && task.task_kind === 'output';
}

function createTaskId() {
  return `task_${++taskCounter}_${Date.now()}`;
}

// 定期清理内存中过期的同步任务记录
setInterval(() => {
  const now = Date.now();
  for (const [id, task] of tasks) {
    if (now - task.startTime > 30 * 60 * 1000) {
      tasks.delete(id);
    }
  }
}, 60000).unref();

// ============================================================
// Express 路由
// ============================================================

// POST /api/generate-video - 提交任务, 立即返回 taskId
//   multipart/form-data 字段:
//     - files:  参考图片 (image/*), 1~9 张
//     - video:  参考视频 (video/*), 0~3 段 (总时长 <= 15s)
//     - audio:  参考音频 (audio/*), 0~3 段 (总时长 <= 15s)
//   所有文件会先上传到方舟 /api/v3/files 换成 file-xxx, 再作为参数提交生成任务.
app.post(
  '/api/generate-video',
  authenticate,
  upload.fields([
    { name: 'files', maxCount: 9 },
    { name: 'video', maxCount: 3 },
    { name: 'audio', maxCount: 3 },
  ]),
  async (req, res) => {
  const startTime = Date.now();
  let dbTaskId = null;

  try {
    const { prompt, ratio, duration, model } = req.body;
    const fileMap = req.files || {};
    const imageFiles = Array.isArray(fileMap.files) ? fileMap.files : [];
    const videoFiles = Array.isArray(fileMap.video) ? fileMap.video : [];
    const audioFiles = Array.isArray(fileMap.audio) ? fileMap.audio : [];

    if (imageFiles.length === 0 && videoFiles.length === 0 && audioFiles.length === 0 && !(prompt || '').trim()) {
      return res
        .status(400)
        .json({ error: '请至少提供一个素材 (图片/视频/音频) 或文本 Prompt' });
    }

    const taskId = createTaskId();
    const task = {
      id: taskId,
      status: 'processing',
      progress: '正在准备...',
      startTime,
      result: null,
      error: null,
    };
    tasks.set(taskId, task);

    try {
      const defaultProject = ensureDefaultProjectForUser(req.user.id);
      const createdTask = taskService.createTask({
        projectId: defaultProject.id,
        userId: req.user.id,
        prompt: prompt || '',
        taskKind: 'output',
        status: 'generating',
        downloadStatus: 'pending',
        progress: '正在准备...',
        startedAt: new Date().toISOString(),
        duration: parseInt(duration) || 5,
      });
      dbTaskId = createdTask.id;
      console.log(`[生成任务] 数据库记录已创建，db_task_id = ${dbTaskId}, project_id = ${defaultProject.id}`);
    } catch (dbError) {
      console.error('[生成任务] 创建数据库记录失败:', dbError.message);
    }

    console.log(`\n========== [${taskId}] 收到视频生成请求 ==========`);
    console.log(`  prompt: ${(prompt || '').substring(0, 80)}${(prompt || '').length > 80 ? '...' : ''}`);
    console.log(`  model: ${model || 'doubao-seedance-2-0-260128'}, ratio: ${ratio || '16:9'}, duration: ${duration || 5}秒`);
    console.log(`  images=${imageFiles.length} video=${videoFiles.length} audio=${audioFiles.length}`);

    res.json({ taskId, dbTaskId });

    // 先把所有素材上传到方舟 (命中缓存则直接复用 file_id)
    const logProgress = (msg) => {
      task.progress = msg;
      console.log(`[${taskId}] ${msg}`);
      if (dbTaskId) {
        try { taskService.updateTask(dbTaskId, { progress: msg }); } catch (_) {}
      }
    };

    let imageDataUris = [];
    let videoUrls = [];
    let audioUrls = [];
    try {
      // === 图片: base64 data URI (官方支持 URL 或 Base64) ===
      if (imageFiles.length > 0) {
        logProgress(`正在处理 ${imageFiles.length} 张图片...`);
        imageDataUris = imageFiles.map((f, i) => {
          logProgress(`图片 ${i + 1}/${imageFiles.length}: ${f.originalname} → base64`);
          return bufferToDataUri(f.buffer, f.mimetype, f.originalname);
        });
      }

      // === 视频: 上传 TOS → 预签名 URL (Content Generation API 只认公网 URL) ===
      for (let i = 0; i < videoFiles.length; i++) {
        const f = videoFiles[i];
        logProgress(`视频 ${i + 1}/${videoFiles.length}: ${f.originalname} 上传到 TOS...`);
        const r = await getOrUploadToTos(f.buffer, {
          filename: f.originalname,
          mimeType: f.mimetype,
          onProgress: (stage, detail) => {
            if (stage === 'cache_hit') logProgress(`视频 ${i + 1}: TOS 缓存命中`);
            else if (stage === 'uploading') logProgress(`视频 ${i + 1}: ${f.originalname} 上传中...`);
            else if (stage === 'uploaded') logProgress(`视频 ${i + 1}: ✓ 上传完成`);
          },
        });
        videoUrls.push(r.url);
      }

      // === 音频: 同视频, 上传 TOS ===
      for (let i = 0; i < audioFiles.length; i++) {
        const f = audioFiles[i];
        logProgress(`音频 ${i + 1}/${audioFiles.length}: ${f.originalname} 上传到 TOS...`);
        const r = await getOrUploadToTos(f.buffer, {
          filename: f.originalname,
          mimeType: f.mimetype,
          onProgress: (stage, detail) => {
            if (stage === 'cache_hit') logProgress(`音频 ${i + 1}: TOS 缓存命中`);
            else if (stage === 'uploaded') logProgress(`音频 ${i + 1}: ✓ 上传完成`);
          },
        });
        audioUrls.push(r.url);
      }

      logProgress(`素材准备完成 ✓ (图片=${imageDataUris.length} 视频=${videoUrls.length} 音频=${audioUrls.length})`);
    } catch (uploadErr) {
      const msg = `素材准备失败: ${uploadErr.message}`;
      console.error(`[${taskId}] ${msg}`);
      task.status = 'error';
      task.error = msg;
      if (dbTaskId) {
        try { taskService.updateTaskStatus(dbTaskId, 'error', { progress: '', error_message: msg }); } catch (_) {}
      }
      return;
    }

    generateArkVideo({
      model: model || 'doubao-seedance-2-0-260128',
      prompt: prompt || '',
      imageUrls: imageDataUris,
      videoUrls: videoUrls,
      audioUrls: audioUrls,
      ratio: ratio || '16:9',
      duration: parseInt(duration) || 5,
      generateAudio: true,
      watermark: false,
      onProgress: async (progress) => {
        task.progress = progress;
        console.log(`[${taskId}] [ark] ${progress}`);
        if (dbTaskId) {
          try { taskService.updateTask(dbTaskId, { progress }); } catch (_) {}
        }
      },
      onSubmitId: async (submitId) => {
        if (dbTaskId) {
          try {
            taskService.updateTask(dbTaskId, {
              submit_id: submitId,
              submitted_at: new Date().toISOString(),
            });
          } catch (_) {}
        }
      },
      onHistoryId: async (historyId) => {
        if (dbTaskId) {
          try { taskService.updateTask(dbTaskId, { history_id: historyId, status: 'generating' }); } catch (_) {}
        }
      },
      onVideoReady: async (videoUrl) => {
        if (dbTaskId) {
          try { taskService.updateTask(dbTaskId, { video_url: videoUrl }); } catch (_) {}
        }
      },
    })
      .then((result) => {
        task.status = 'done';
        task.result = {
          created: Math.floor(Date.now() / 1000),
          data: [{ url: result.videoUrl, revised_prompt: result.revisedPrompt || prompt || '' }],
        };
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`========== [${taskId}] ✅ 视频生成成功 (${elapsed}秒) ==========\n`);

        if (dbTaskId) {
          try {
            taskService.updateTaskStatus(dbTaskId, 'done', {
              submit_id: result.submitId || null,
              history_id: result.historyId || null,
              item_id: result.itemId || null,
              video_url: result.videoUrl,
              progress: '',
              error_message: null,
            });
          } catch (dbError) {
            console.error('[生成任务] 更新数据库记录失败:', dbError.message);
          }
        }
      })
      .catch((err) => {
        task.status = 'error';
        task.error = err.message || '视频生成失败';
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.error(`========== [${taskId}] ❌ 视频生成失败 (${elapsed}秒): ${err.message} ==========\n`);

        if (dbTaskId) {
          try {
            taskService.updateTaskStatus(dbTaskId, 'error', {
              progress: '',
              error_message: err.message,
            });
          } catch (_) {}
        }
      });
  } catch (error) {
    console.error(`请求处理错误: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || '服务器内部错误' });
    }
  }
  }
);

// GET /api/task/:taskId - 轮询任务状态
app.get('/api/task/:taskId', (req, res) => {
  const task = tasks.get(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }

  const elapsed = Math.floor((Date.now() - task.startTime) / 1000);

  if (task.status === 'done') {
    res.json({ status: 'done', elapsed, result: task.result });
    setTimeout(() => tasks.delete(task.id), 300000);
    return;
  }

  if (task.status === 'error') {
    res.json({ status: 'error', elapsed, error: task.error });
    setTimeout(() => tasks.delete(task.id), 300000);
    return;
  }

  res.json({ status: 'processing', elapsed, progress: task.progress });
});

// GET /api/video-proxy - 代理视频流，绕过 CDN 跨域限制
app.get('/api/video-proxy', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: '缺少 url 参数' });
  }

  try {
    console.log(`[video-proxy] 代理视频: ${videoUrl.substring(0, 100)}...`);

    const response = await fetch(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      console.error(`[video-proxy] 上游错误: ${response.status}`);
      return res.status(response.status).json({ error: `视频获取失败: ${response.status}` });
    }

    // 转发响应头
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const contentLength = response.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // 流式转发视频数据
    const reader = response.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }
        if (!res.write(value)) {
          await new Promise((r) => res.once('drain', r));
        }
      }
    };
    pump().catch((err) => {
      console.error(`[video-proxy] 流传输错误: ${err.message}`);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
  } catch (error) {
    console.error(`[video-proxy] 错误: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: '视频代理失败' });
    }
  }
});

// multer 错误处理
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: '文件大小超过限制 (最大 500MB)' });
    if (err.code === 'LIMIT_FILE_COUNT')
      return res.status(400).json({ error: '文件数量超过限制' });
    return res.status(400).json({ error: `上传错误: ${err.message}` });
  }
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

// ============================================================
// 批量管理功能 API 路由
// ============================================================

// -------------------- 项目管理 --------------------
// GET /api/projects - 获取项目列表
app.get('/api/projects', authenticate, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const projects = projectService.getAllProjects(req.user.id, isAdmin);
    res.json({ success: true, data: projects });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/projects - 创建项目
app.post('/api/projects', authenticate, (req, res) => {
  try {
    const { name, description, settings } = req.body;
    if (!name) {
      return res.status(400).json({ error: '项目名称不能为空' });
    }
    const project = projectService.createProject({ name, description, settings, user_id: req.user.id });
    res.json({ success: true, data: project });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/projects/:id - 获取项目详情
app.get('/api/projects/:id', authenticate, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const project = projectService.getProjectById(req.params.id, req.user.id, isAdmin);
    if (!project) {
      return res.status(404).json({ error: '项目不存在或无权访问' });
    }
    res.json({ success: true, data: project });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/projects/:id - 更新项目
app.put('/api/projects/:id', authenticate, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const project = projectService.getProjectById(req.params.id, req.user.id, isAdmin);
    if (!project) {
      return res.status(404).json({ error: '项目不存在或无权访问' });
    }
    // 非管理员只能更新自己的项目
    if (!isAdmin && project.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权修改此项目' });
    }
    const { name, description, settings, video_save_path, default_concurrent, default_min_interval, default_max_interval } = req.body;
    const updated = projectService.updateProject(req.params.id, {
      name,
      description,
      settings_json: settings ? JSON.stringify(settings) : undefined,
      video_save_path,
      default_concurrent,
      default_min_interval,
      default_max_interval,
    });
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/projects/:id - 删除项目
app.delete('/api/projects/:id', authenticate, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const project = projectService.getProjectById(req.params.id, req.user.id, isAdmin);
    if (!project) {
      return res.status(404).json({ error: '项目不存在或无权访问' });
    }
    // 非管理员只能删除自己的项目
    if (!isAdmin && project.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权删除此项目' });
    }
    projectService.deleteProject(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/projects/:id/tasks - 获取项目下的任务列表
app.get('/api/projects/:id/tasks', authenticate, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const project = projectService.getProjectById(req.params.id, req.user.id, isAdmin);
    if (!project) {
      return res.status(404).json({ success: false, error: '项目不存在或无权访问' });
    }

    const { status, taskKind, sourceTaskId, rowGroupId } = req.query;
    const tasks = taskService.getTasksByProjectId(req.params.id, {
      status: typeof status === 'string' ? status : undefined,
      taskKind: typeof taskKind === 'string' ? taskKind : undefined,
      sourceTaskId: sourceTaskId !== undefined ? Number(sourceTaskId) : undefined,
      rowGroupId: typeof rowGroupId === 'string' ? rowGroupId : undefined,
    }, req.user.id, isAdmin);
    res.json({ success: true, data: tasks });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// -------------------- 任务管理 --------------------
// GET /api/tasks/:id - 获取任务详情
app.get('/api/tasks/:id', authenticate, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }
    res.json({ success: true, data: task });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/projects/:projectId/tasks - 创建任务
app.post('/api/projects/:projectId/tasks', authenticate, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const project = projectService.getProjectById(req.params.projectId, req.user.id, isAdmin);
    if (!project) {
      return res.status(404).json({ success: false, error: '项目不存在或无权访问' });
    }
    // 非管理员只能在自己的项目中创建任务
    if (!isAdmin && project.user_id !== req.user.id) {
      return res.status(403).json({ success: false, error: '无权在此项目中创建任务' });
    }

    const {
      prompt = '',
      taskKind = 'output',
      rowIndex,
      videoCount,
      sourceTaskId,
      rowGroupId,
      outputIndex,
    } = req.body || {};

    if (taskKind !== 'draft' && !String(prompt).trim()) {
      return res.status(400).json({ success: false, error: '任务提示词不能为空' });
    }

    const task = taskService.createTask({
      projectId: req.params.projectId,
      prompt,
      taskKind,
      rowIndex,
      videoCount,
      sourceTaskId,
      rowGroupId,
      outputIndex,
      userId: req.user.id,
    });
    res.json({ success: true, data: task });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/tasks/:id - 更新任务
app.put('/api/tasks/:id', authenticate, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }
    // 非管理员只能更新自己的任务
    if (!isAdmin && task.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权修改此任务' });
    }
    const updates = req.body;
    const updated = taskService.updateTask(req.params.id, updates);
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/tasks/:id - 删除任务
app.delete('/api/tasks/:id', authenticate, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }
    // 非管理员只能删除自己的任务
    if (!isAdmin && task.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权删除此任务' });
    }
    taskService.deleteTask(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/tasks/:id/assets - 添加任务素材
app.post('/api/tasks/:id/assets', authenticate, upload.fields([
  { name: 'images', maxCount: 9 },
  { name: 'videos', maxCount: 3 },
  { name: 'audios', maxCount: 3 },
]), async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }
    // 非管理员只能为自己的任务添加素材
    if (!isAdmin && task.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权为此任务添加素材' });
    }

    const files = req.files || {};
    const results = [];
    const fs = await import('fs');
    const saveDir = path.join(__dirname, '../data/assets/tasks', req.params.id);
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

    const persistGroup = (group, assetType) => {
      if (!files[group]) return;
      for (const file of files[group]) {
        const filename = `${Date.now()}_${file.originalname}`;
        const filePath = path.join(saveDir, filename);
        fs.writeFileSync(filePath, file.buffer);
        const asset = taskService.addTaskAsset(req.params.id, {
          assetType,
          filePath,
          sortOrder: results.filter((r) => r.asset_type === assetType).length,
        });
        results.push(asset);
      }
    };

    persistGroup('images', 'image');
    persistGroup('videos', 'video');
    persistGroup('audios', 'audio');

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tasks/:id/assets - 获取任务素材列表
app.get('/api/tasks/:id/assets', (req, res) => {
  try {
    const assets = taskService.getTaskAssets(req.params.id);
    res.json({ success: true, data: assets });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/tasks/assets/:assetId - 删除任务素材
app.delete('/api/tasks/assets/:assetId', (req, res) => {
  try {
    taskService.deleteTaskAsset(req.params.assetId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/tasks/:id/generate - 单个任务生成
app.post('/api/tasks/:id/generate', authenticate, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }

    if (task.task_kind === 'draft') {
      const validation = validateBatchTasks(task.project_id, [task.id], req.user.id, isAdmin);
      if (validation.error) {
        return res.status(validation.statusCode || 400).json({ success: false, error: validation.error });
      }
      if (validation.invalidTasks.length > 0) {
        return res.status(400).json({
          success: false,
          error: validation.invalidTasks[0]?.reason || '当前任务无法启动生成',
          invalidTasks: validation.invalidTasks,
        });
      }

      const activeOutputTasks = taskService
        .getOutputTasksBySourceTaskId(task.id)
        .filter((outputTask) => !['done', 'error', 'cancelled'].includes(outputTask.status));
      if (activeOutputTasks.length > 0) {
        return res.status(400).json({ success: false, error: '该任务行已有生成中的记录，请等待当前任务结束后再试' });
      }

      const outputTasks = taskService.expandDraftTaskToOutputTasks(task.id);
      if (outputTasks.length === 0) {
        return res.status(400).json({ success: false, error: '没有可启动的输出任务' });
      }

      const batchId = batchService.createBatch({
        projectId: Number(task.project_id),
        taskIds: outputTasks.map((outputTask) => outputTask.id),
        name: `row-${task.id}`,
        concurrent: Math.max(1, Number(task.video_count) || 1),
      });

      await batchService.startBatch(batchId, {
        onProgress: (data) => {
          console.log('[row-batch] 进度更新:', data);
        },
        onTaskComplete: (data) => {
          console.log('[row-batch] 任务完成:', data);
        },
        onBatchComplete: (data) => {
          console.log('[row-batch] 批量任务完成:', data);
        },
      });

      return res.json({
        success: true,
        data: {
          taskId: Number(task.id),
          batchId,
          totalTasks: outputTasks.length,
          outputTaskIds: outputTasks.map((outputTask) => outputTask.id),
          message: '任务生成已启动',
        },
      });
    }

    const assets = taskService.getTaskAssets(req.params.id);
    const imageAssets = assets.filter(a => a.asset_type === 'image');
    const videoAssets = assets.filter(a => a.asset_type === 'video');
    const audioAssets = assets.filter(a => a.asset_type === 'audio');
    const settings = settingsService.getAllSettings();

    if (imageAssets.length === 0 && videoAssets.length === 0 && audioAssets.length === 0 && !(task.prompt || '').trim()) {
      return res.status(400).json({ error: '任务缺少素材或 Prompt, 无法提交' });
    }

    taskService.updateTaskStatus(task.id, 'generating', {
      task_kind: 'output',
      progress: '正在准备...',
      error_message: null,
      submit_id: null,
      history_id: null,
      item_id: null,
      video_url: null,
      completed_at: null,
      submitted_at: null,
    });

    res.json({
      success: true,
      data: {
        taskId: Number(task.id),
        message: '任务生成已启动',
      },
    });

    // 图片: 从磁盘读取转 base64; 视频/音频: 上传 TOS → 预签名 URL
    const { readFileSync } = await import('fs');
    const logTaskProgress = (msg) => {
      console.log(`[task ${task.id}] ${msg}`);
      try { taskService.updateTask(task.id, { progress: msg }); } catch (_) {}
    };

    let imageUrls = [];
    let videoUrls = [];
    let audioUrls = [];
    try {
      // 图片 base64
      imageUrls = imageAssets.map((a, i) => {
        logTaskProgress(`图片 ${i + 1}/${imageAssets.length}: ${path.basename(a.file_path)} → base64`);
        const buf = readFileSync(a.file_path);
        return bufferToDataUri(buf, guessMimeType(a.file_path), path.basename(a.file_path));
      });

      // 视频: 上传 TOS → 预签名 URL
      for (let i = 0; i < videoAssets.length; i++) {
        const a = videoAssets[i];
        logTaskProgress(`视频 ${i + 1}/${videoAssets.length}: ${path.basename(a.file_path)} 上传到 TOS...`);
        const r = await getOrUploadToTosByPath(a.file_path, {
          onProgress: (stage, detail) => {
            if (stage === 'cache_hit') logTaskProgress(`视频 ${i + 1}: TOS 缓存命中`);
            else if (stage === 'uploading') logTaskProgress(`视频 ${i + 1}: 上传中...`);
            else if (stage === 'uploaded') logTaskProgress(`视频 ${i + 1}: ✓ 上传完成`);
          },
        });
        videoUrls.push(r.url);
      }

      // 音频: 上传 TOS → 预签名 URL
      for (let i = 0; i < audioAssets.length; i++) {
        const a = audioAssets[i];
        logTaskProgress(`音频 ${i + 1}/${audioAssets.length}: ${path.basename(a.file_path)} 上传到 TOS...`);
        const r = await getOrUploadToTosByPath(a.file_path, {
          onProgress: (stage, detail) => {
            if (stage === 'cache_hit') logTaskProgress(`音频 ${i + 1}: TOS 缓存命中`);
            else if (stage === 'uploaded') logTaskProgress(`音频 ${i + 1}: ✓ 上传完成`);
          },
        });
        audioUrls.push(r.url);
      }

      logTaskProgress(`素材准备完成 ✓`);
    } catch (uploadErr) {
      const msg = `素材准备失败: ${uploadErr.message}`;
      console.error(`[task ${task.id}] ${msg}`);
      taskService.updateTaskStatus(task.id, 'error', { progress: '', error_message: msg });
      return;
    }

    generateArkVideo({
      model: settings.model || 'doubao-seedance-2-0-260128',
      prompt: task.prompt,
      imageUrls,
      videoUrls,
      audioUrls,
      ratio: settings.ratio || '16:9',
      duration: parseInt(settings.duration) || 5,
      generateAudio: true,
      watermark: false,
      onProgress: async (progress) => {
        console.log(`[task ${task.id}] 进度：${progress}`);
        try { taskService.updateTask(task.id, { progress }); } catch (_) {}
      },
      onSubmitId: async (submitId) => {
        try {
          taskService.updateTask(task.id, {
            submit_id: submitId,
            submitted_at: new Date().toISOString(),
          });
        } catch (_) {}
      },
      onHistoryId: async (historyId) => {
        try {
          taskService.updateTask(task.id, {
            history_id: historyId,
            status: 'generating',
          });
        } catch (_) {}
      },
      onVideoReady: async (videoUrl) => {
        try { taskService.updateTask(task.id, { video_url: videoUrl }); } catch (_) {}
      },
    })
      .then((result) => {
        taskService.updateTaskStatus(task.id, 'done', {
          submit_id: result.submitId || null,
          history_id: result.historyId || null,
          item_id: result.itemId || null,
          video_url: result.videoUrl,
          progress: '',
          error_message: null,
        });
        console.log(`[task ${task.id}] 视频生成成功：${result.videoUrl}`);
      })
      .catch((err) => {
        taskService.updateTaskStatus(task.id, 'error', {
          progress: '',
          error_message: err.message,
        });
        console.error(`[task ${task.id}] 视频生成失败：${err.message}`);
      });
  } catch (error) {
    console.error(`请求处理错误：${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || '服务器内部错误' });
    }
  }
});


// POST /api/tasks/:id/cancel - 取消任务（包括正在生成的任务）
app.post('/api/tasks/:id/cancel', authenticate, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }
    // 非管理员只能取消自己的任务
    if (!isAdmin && task.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权取消此任务' });
    }

    const db = getDatabase();
    const activeBatches = db.prepare(`
      SELECT id, task_ids
      FROM batches
      WHERE status IN ('pending', 'running', 'paused')
      ORDER BY id DESC
    `).all();

    const parentBatch = activeBatches.find((batch) => {
      try {
        const taskIds = JSON.parse(batch.task_ids || '[]').map(Number);
        return taskIds.includes(Number(task.id));
      } catch {
        return false;
      }
    });

    if (parentBatch && await batchService.cancelBatchTask(parentBatch.id, task.id)) {
      res.json({ success: true, message: '任务取消成功' });
      return;
    }

    // 普通任务直接取消
    taskService.updateTaskStatus(req.params.id, 'cancelled', {
      progress: '',
      error_message: '用户取消任务',
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// POST /api/tasks/:id/download - 下载任务视频
app.post('/api/tasks/:id/download', authenticate, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }
    // 非管理员只能下载自己的任务
    if (!isAdmin && task.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权下载此任务' });
    }

    const downloadPath = videoDownloader.getDefaultDownloadPath();
    const result = await videoDownloader.downloadVideoByTaskId(task.id, downloadPath);

    if (result.success) {
      res.json({ success: true, data: result });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/tasks/:id/open-folder - 打开视频所在文件夹
app.post('/api/tasks/:id/open-folder', authenticate, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }
    // 非管理员只能打开自己的任务文件夹
    if (!isAdmin && task.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权访问此任务' });
    }
    if (!task.video_path) {
      return res.status(400).json({ error: '视频尚未下载' });
    }

    const result = await videoDownloader.openVideoFolder(task.video_path);
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------- 任务归档 --------------------
// 单文件 HTML 归档存放目录: data/archives/{task_id}.html
// 归档由客户端在 POST /api/generate-video 返回成功后立即构建并上传,
// 包含提示词 + 输入素材预览 (图片/视频首帧压缩 JPEG, 音频仅文件名).

const ARCHIVE_DIR = path.join(__dirname, '../data/archives');

function ensureArchiveDir() {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
}

// POST /api/tasks/:id/archive - 上传任务归档 HTML (text/html body)
app.post(
  '/api/tasks/:id/archive',
  authenticate,
  express.text({ type: ['text/html', 'text/plain'], limit: '50mb' }),
  (req, res) => {
    try {
      const isAdmin = req.user.role === 'admin';
      const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
      if (!task) {
        return res.status(404).json({ error: '任务不存在或无权访问' });
      }
      const html = typeof req.body === 'string' ? req.body : '';
      if (!html || html.length < 20) {
        return res.status(400).json({ error: '归档内容为空' });
      }
      ensureArchiveDir();
      const filePath = path.join(ARCHIVE_DIR, `${task.id}.html`);
      fs.writeFileSync(filePath, html, 'utf-8');
      taskService.updateTask(task.id, { archive_path: filePath });
      console.log(`[archive] task ${task.id} 归档已保存 (${(html.length / 1024).toFixed(1)} KB) → ${filePath}`);
      res.json({ success: true, size: html.length });
    } catch (error) {
      console.error('[archive] 保存失败:', error);
      res.status(500).json({ error: error.message });
    }
  },
);

// GET /api/tasks/:id/archive - 获取归档 HTML 原文 (直接返回 HTML, 用于前端 fetch blob)
app.get('/api/tasks/:id/archive', authenticate, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }
    if (!task.archive_path || !fs.existsSync(task.archive_path)) {
      return res.status(404).json({ error: '归档不存在' });
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // 允许前端 fetch 读取为 blob 后 URL.createObjectURL 打开新窗
    fs.createReadStream(task.archive_path).pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------- 批量生成 --------------------
// POST /api/batch/generate - 创建并启动批量任务
app.post('/api/batch/generate', authenticate, async (req, res) => {
  try {
    const { projectId, taskIds, name = '', concurrent = 5 } = req.body;
    const isAdmin = req.user.role === 'admin';

    if (!projectId || !Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ success: false, error: '参数不完整' });
    }

    const validation = validateBatchTasks(projectId, taskIds, req.user.id, isAdmin);
    if (validation.error) {
      return res.status(validation.statusCode || 400).json({ success: false, error: validation.error });
    }
    if (validation.invalidTasks.length > 0) {
      return res.status(400).json({
        success: false,
        error: '部分任务无法启动批量生成',
        invalidTasks: validation.invalidTasks,
      });
    }

    const outputTasks = taskService.expandDraftTasksToOutputTasks(validation.taskIds);
    if (outputTasks.length === 0) {
      return res.status(400).json({ success: false, error: '没有可启动的输出任务' });
    }

    const batchId = batchService.createBatch({
      projectId: Number(projectId),
      taskIds: outputTasks.map((task) => task.id),
      name,
      concurrent: Number(concurrent) || 5,
    });

    await batchService.startBatch(batchId, {
      onProgress: (data) => {
        console.log('[batch] 进度更新:', data);
      },
      onTaskComplete: (data) => {
        console.log('[batch] 任务完成:', data);
      },
      onBatchComplete: (data) => {
        console.log('[batch] 批量任务完成:', data);
      },
    });

    res.json({
      success: true,
      data: {
        batchId,
        totalTasks: outputTasks.length,
        draftTaskIds: validation.taskIds,
        outputTaskIds: outputTasks.map((task) => task.id),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/batch/:batchId/status - 获取批量任务状态
app.get('/api/batch/:batchId/status', authenticate, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const status = batchService.getBatchStatus(req.params.batchId, req.user.id, isAdmin);
    if (!status) {
      return res.status(404).json({ success: false, error: '批量任务不存在或无权访问' });
    }
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/batch/:batchId/pause - 暂停批量任务
app.post('/api/batch/:batchId/pause', authenticate, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const batch = batchService.getBatchById(req.params.batchId, req.user.id, isAdmin);
    if (!batch) {
      return res.status(404).json({ success: false, error: '批量任务不存在或无权访问' });
    }

    const result = batchService.pauseBatch(req.params.batchId);
    if (!result) {
      return res.status(404).json({ success: false, error: '批量任务不存在或无权访问' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/batch/:batchId/resume - 恢复批量任务
app.post('/api/batch/:batchId/resume', authenticate, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const batch = batchService.getBatchById(req.params.batchId, req.user.id, isAdmin);
    if (!batch) {
      return res.status(404).json({ success: false, error: '批量任务不存在或无权访问' });
    }

    const result = batchService.resumeBatch(req.params.batchId);
    if (!result) {
      return res.status(404).json({ success: false, error: '批量任务不存在或无权访问' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/batch/:batchId/cancel - 取消批量任务
app.post('/api/batch/:batchId/cancel', authenticate, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const batch = batchService.getBatchById(req.params.batchId, req.user.id, isAdmin);
    if (!batch) {
      return res.status(404).json({ success: false, error: '批量任务不存在或无权访问' });
    }

    const result = batchService.cancelBatch(req.params.batchId);
    if (!result) {
      return res.status(404).json({ success: false, error: '批量任务不存在或无权访问' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// -------------------- 全局设置 --------------------
// GET /api/settings - 获取全局设置
app.get('/api/settings', (req, res) => {
  try {
    const settings = settingsService.getAllSettings();
    res.json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/settings - 更新全局设置
app.put('/api/settings', (req, res) => {
  try {
    const settings = req.body;
    const updated = settingsService.updateSettings(settings);
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/settings/ark-status - 检查方舟 API Key 是否已配置 (只返回是/否, 不泄漏 Key)
app.get('/api/settings/ark-status', authenticate, (_req, res) => {
  const configured = Boolean((process.env.ARK_API_KEY || '').trim());
  res.json({ success: true, data: { configured } });
});

// -------------------- 下载 API --------------------
// GET /api/download/file?path=xxx - 下载文件
app.get('/api/download/file', async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ error: '文件路径不能为空' });
    }

    const fs = await import('fs');
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: '文件不存在' });
    }

    res.download(filePath);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function sendDownloadedVideoFile(res, result) {
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.download(result.filePath, result.filename);
}

// POST /api/download/tasks/:id/file-token - 创建一次性下载 token
app.post('/api/download/tasks/:id/file-token', authenticate, async (req, res) => {
  try {
    const taskId = req.params.id;
    const result = videoDownloader.getDownloadedVideoFileByTaskId(taskId);

    if (!result.success) {
      const statusCode = result.error === '任务不存在'
        ? 404
        : result.error === '任务尚未下载到服务器' || result.error.startsWith('视频文件不存在')
          ? 400
          : 500;
      return res.status(statusCode).json({ error: result.error });
    }

    const token = createDownloadToken(taskId, req.user.id);
    res.json({ success: true, data: { token } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/download/file-by-token - 使用一次性 token 下载服务器本地已保存的视频文件
app.get('/api/download/file-by-token', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    const userIdParam = req.query.userId;
    const userId = userIdParam === undefined || userIdParam === null || userIdParam === ''
      ? null
      : Number(userIdParam);
    if (!token) {
      return res.status(400).json({ error: '下载参数无效' });
    }

    const record = consumeDownloadToken(token, Number.isFinite(userId) ? userId : null);
    if (!record) {
      return res.status(401).json({ error: '下载链接已失效，请重试' });
    }

    const result = videoDownloader.getDownloadedVideoFileByTaskId(record.taskId);
    if (!result.success) {
      const statusCode = result.error === '任务不存在'
        ? 404
        : result.error === '任务尚未下载到服务器' || result.error.startsWith('视频文件不存在')
          ? 400
          : 500;
      return res.status(statusCode).json({ error: result.error });
    }

    sendDownloadedVideoFile(res, result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/download/tasks/:id/stream-token - 创建一次性流式播放 token
// 用于 /download 列表页在线预览本地已保存的视频 (支持 HTTP Range).
// stream token 允许多次 Range 请求, 30 分钟过期.
app.post('/api/download/tasks/:id/stream-token', authenticate, async (req, res) => {
  try {
    const taskId = req.params.id;
    const result = videoDownloader.getDownloadedVideoFileByTaskId(taskId);

    if (!result.success) {
      const statusCode = result.error === '任务不存在'
        ? 404
        : result.error === '任务尚未下载到服务器' || result.error.startsWith('视频文件不存在')
          ? 400
          : 500;
      return res.status(statusCode).json({ error: result.error });
    }

    const token = createDownloadToken(taskId, req.user.id, 'stream');
    res.json({ success: true, data: { token } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/download/stream-by-token?token=xxx - 用 stream token 流式播放本地视频
// 浏览器 <video> 标签会发出多次 Range 请求, 这里用 res.sendFile 让 Express 自动处理 Range.
app.get('/api/download/stream-by-token', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!token) {
      return res.status(400).json({ error: '播放参数无效' });
    }

    // 用 peek 而不是 consume, 因为 <video> 会连续发多次 Range 请求
    const record = peekDownloadToken(token);
    if (!record || record.mode !== 'stream') {
      return res.status(401).json({ error: '播放链接已失效' });
    }

    const result = videoDownloader.getDownloadedVideoFileByTaskId(record.taskId);
    if (!result.success) {
      const statusCode = result.error === '任务不存在'
        ? 404
        : result.error === '任务尚未下载到服务器' || result.error.startsWith('视频文件不存在')
          ? 400
          : 500;
      return res.status(statusCode).json({ error: result.error });
    }

    // 不设置 Content-Disposition: attachment, 让浏览器内嵌播放.
    // res.sendFile 底层的 send 模块会自动处理 Range 请求并返回 206.
    res.sendFile(result.filePath, {
      headers: {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'private, max-age=0, no-cache',
        'Accept-Ranges': 'bytes',
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/download/tasks/:id/file - 下载服务器本地已保存的视频文件
app.get('/api/download/tasks/:id/file', authenticate, async (req, res) => {
  try {
    const taskId = req.params.id;
    const result = videoDownloader.getDownloadedVideoFileByTaskId(taskId);

    if (!result.success) {
      const statusCode = result.error === '任务不存在'
        ? 404
        : result.error === '任务尚未下载到服务器' || result.error.startsWith('视频文件不存在')
          ? 400
          : 500;
      return res.status(statusCode).json({ error: result.error });
    }

    sendDownloadedVideoFile(res, result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 下载管理 API 路由
// ============================================================

// GET /api/download/tasks - 获取下载任务列表
app.get('/api/download/tasks', authenticate, (req, res) => {
  try {
    const { status = 'all', type = 'all', page = 1, pageSize = 20 } = req.query;
    const isAdmin = req.user.role === 'admin';
    const result = videoDownloader.getDownloadTasks({
      status,
      type,
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      userId: req.user.id,
      isAdmin,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// POST /api/download/tasks/:id - 下载单个任务视频
app.post('/api/download/tasks/:id', async (req, res) => {
  try {
    const taskId = req.params.id;
    const db = getDatabase();

    // 获取任务信息
    const task = db.prepare(`
      SELECT t.*, p.name as project_name
      FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.id = ?
    `).get(taskId);

    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }

    if (!task.video_url) {
      return res.status(400).json({ error: '视频仍在生成中，暂时无法下载' });
    }

    // 更新状态为 downloading
    videoDownloader.updateDownloadStatus(taskId, 'downloading');

    // 获取下载路径
    const baseDownloadPath = videoDownloader.getDefaultDownloadPath();

    // 下载视频
    const result = await videoDownloader.downloadVideoByTaskId(taskId, baseDownloadPath);

    if (result.success) {
      videoDownloader.updateDownloadStatus(taskId, 'done', { downloadPath: result.path });
      res.json({ success: true, data: { path: result.path, size: result.size } });
    } else {
      videoDownloader.updateDownloadStatus(taskId, 'failed', { error: result.error });
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/download/batch - 批量下载视频
app.post('/api/download/batch', async (req, res) => {
  try {
    const { taskIds } = req.body;
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ error: 'taskIds 必须是非空数组' });
    }

    const baseDownloadPath = videoDownloader.getDefaultDownloadPath();
    const results = await videoDownloader.batchDownloadVideos(taskIds, baseDownloadPath);

    // 更新下载状态
    const db = getDatabase();
    for (const result of results) {
      if (result.success) {
        videoDownloader.updateDownloadStatus(result.taskId, 'done', { downloadPath: result.path });
      } else {
        videoDownloader.updateDownloadStatus(result.taskId, 'failed', { error: result.error });
      }
    }

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/download/tasks/:id/open - 打开视频所在文件夹
app.post('/api/download/tasks/:id/open', async (req, res) => {
  try {
    const taskId = req.params.id;
    const db = getDatabase();

    const task = db.prepare('SELECT video_path FROM tasks WHERE id = ?').get(taskId);
    if (!task || !task.video_path) {
      return res.status(404).json({ error: '任务不存在或未下载' });
    }

    const result = await videoDownloader.openVideoFolder(task.video_path);
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/download/tasks/:id - 删除任务
app.delete('/api/download/tasks/:id', (req, res) => {
  try {
    const taskId = req.params.id;
    const db = getDatabase();

    // 删除任务（外键会自动删除 task_assets 和 generation_history）
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/download/refresh - 刷新任务状态（检查生成中的任务，自动下载已完成的）
app.post('/api/download/refresh', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    // 查找所有"生成中"或"已有 video_url 但未下载"的任务
    const userFilter = isAdmin ? '' : 'AND t.user_id = ?';
    const params = isAdmin ? [] : [userId];

    // 1. 找出已完成但未下载的任务（有 video_url，download_status 不是 done）
    const pendingTasks = db.prepare(`
      SELECT t.id, t.video_url, t.video_path, t.download_status
      FROM tasks t
      WHERE t.task_kind = 'output'
        AND t.video_url IS NOT NULL
        AND (t.download_status IS NULL OR t.download_status = 'pending')
        ${userFilter}
    `).all(...params);

    // 自动下载已完成但未保存到本地的任务
    let refreshed = 0;
    for (const task of pendingTasks) {
      if (!task.video_path) {
        try {
          const downloadPath = videoDownloader.getDefaultDownloadPath();
          const result = await videoDownloader.downloadVideoByTaskId(task.id, downloadPath);
          if (result.success) {
            videoDownloader.updateDownloadStatus(task.id, 'done', { downloadPath: result.path });
            refreshed++;
          }
        } catch (e) {
          console.error(`[refresh] 自动下载任务 ${task.id} 失败:`, e.message);
        }
      } else {
        refreshed++;
      }
    }

    // 2. 找出仍在生成中的任务
    const generatingTasks = db.prepare(`
      SELECT t.id as taskId, t.history_id as historyId, t.created_at as createdAt
      FROM tasks t
      WHERE t.task_kind = 'output'
        AND (t.status = 'generating' OR (t.history_id IS NOT NULL AND t.video_url IS NULL AND t.status != 'cancelled' AND t.status != 'error'))
        ${userFilter}
      ORDER BY t.created_at DESC
    `).all(...params);

    res.json({
      success: true,
      data: {
        refreshed,
        total: pendingTasks.length + generatingTasks.length,
        generating: generatingTasks.length,
        generatingTasks,
      },
    });
  } catch (error) {
    console.error('[refresh] 刷新失败:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// AI 提示词优化 API
// ============================================================

const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_BASE_URL = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'kimi-k2.5';

// 从 skills 目录读取提示词优化 System Prompt
const PROMPT_OPTIMIZER_SKILL = (() => {
  try {
    const skillPath = path.join(__dirname, '..', 'skills', 'Seedance 2.0 Prompt Checker', 'SKILL.md');
    return fs.readFileSync(skillPath, 'utf-8');
  } catch (e) {
    console.warn('[ai] 未找到提示词优化 Skill 文件，使用默认 system prompt');
    return '你是一个 Seedance 2.0 视频生成提示词优化专家。请帮用户优化提示词，使其更适合 AI 视频生成。直接输出优化后的提示词，不要输出其他内容。';
  }
})();

// POST /api/ai/optimize-prompt - AI 提示词优化（SSE 流式）
app.post('/api/ai/optimize-prompt', authenticate, async (req, res) => {
  if (!LLM_API_KEY || !LLM_BASE_URL) {
    return res.status(503).json({ error: 'LLM API 未配置' });
  }

  const { prompt } = req.body;
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: '提示词不能为空' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);

    req.on('close', () => {
      controller.abort();
      clearTimeout(timer);
    });

    const apiResp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        stream: true,
        messages: [
          { role: 'system', content: PROMPT_OPTIMIZER_SKILL },
          { role: 'user', content: `请整理以下提示词的格式和结构，保留全部原始信息（对话、音效、转场等），直接输出整理后的提示词：\n\n${prompt}` },
        ],
        max_tokens: 4096,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!apiResp.ok) {
      const errBody = await apiResp.text();
      console.error(`[ai] LLM API 错误 (${apiResp.status}):`, errBody);
      res.write(`data: ${JSON.stringify({ error: `LLM API 错误: ${apiResp.status}` })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Stream SSE from LLM to client
    const reader = apiResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          res.write('data: [DONE]\n\n');
          continue;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
          }
        } catch (e) {
          // skip unparseable chunks
        }
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('[ai] 提示词优化失败:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: '提示词优化失败: ' + error.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
});

// ============================================================
// 认证相关 API
// ============================================================

// POST /api/auth/register - 用户注册
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, emailCode } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: '邮箱和密码不能为空' });
    }

    const result = await authService.registerUser(email, password, emailCode);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/auth/login - 用户登录（优先通过 ModelToo 远程验证）
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: '邮箱和密码不能为空' });
    }

    // ── 优先尝试 ModelToo 远程登录 ──
    const modeltooResult = await tryModelTooLogin(email, password);
    if (modeltooResult.success) {
      // 远程验证通过 → 同步账号到本地（不存在则创建，已存在则更新密码）
      syncModelTooUser(email, password);
    }
    // 远程不可用或验证失败时，不阻塞，继续走本地登录

    const result = await authService.loginUser(email, password);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

// POST /api/auth/logout - 用户登出
app.post('/api/auth/logout', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    if (sessionId) {
      await authService.logoutUser(sessionId);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/auth/me - 获取当前用户信息
app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    res.json({ success: true, data: { user: req.user } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/auth/me - 更新当前用户信息
app.put('/api/auth/me', authenticate, async (req, res) => {
  try {
    // 预留扩展功能
    res.json({ success: true, data: { user: req.user } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/auth/password - 修改密码
app.put('/api/auth/password', authenticate, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: '原密码和新密码不能为空' });
    }

    await authService.changePassword(req.user.id, oldPassword, newPassword);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/auth/email-code - 发送邮箱验证码
app.post('/api/auth/email-code', async (req, res) => {
  try {
    const { email, purpose = 'register' } = req.body;

    if (!email) {
      return res.status(400).json({ error: '邮箱不能为空' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    // 获取请求 IP
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

    // 开发环境下返回验证码，生产环境应该发送邮件
    const result = await authService.generateAndSaveVerificationCode(email, purpose, ip);
    res.json(result); // 生产环境不返回 debugCode
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/auth/email-status - 检查邮箱状态
app.post('/api/auth/email-status', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: '邮箱不能为空' });
    }

    const result = await authService.checkEmailStatus(email);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/auth/verify-email-code - 验证邮箱验证码
app.post('/api/auth/verify-email-code', async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: '邮箱和验证码不能为空' });
    }

    const result = await authService.verifyEmailCode(email, code);
    if (result.valid) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: result.message });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/credits/deduct - 扣减积分
app.post('/api/credits/deduct', authenticate, async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: '积分数量无效' });
    }

    const result = await authService.deductCredits(req.user.id, amount);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/credits/add - 充值积分（管理员可用）
app.post('/api/credits/add', authenticate, async (req, res) => {
  try {
    const { userId, amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: '积分数量无效' });
    }

    const targetUserId = userId || req.user.id;
    const result = await authService.rechargeCredits(targetUserId, amount);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/credits/checkin - 每日签到
app.post('/api/credits/checkin', authenticate, async (req, res) => {
  try {
    const result = await authService.checkIn(req.user.id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/credits/checkin/status - 获取签到状态
app.get('/api/credits/checkin/status', authenticate, async (req, res) => {
  try {
    const result = await authService.getCheckInStatus(req.user.id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 管理员 API
// ============================================================

// GET /api/admin/stats - 获取系统统计
app.get('/api/admin/stats', authenticate, requireAdmin, async (req, res) => {
  try {
    const stats = await authService.getSystemStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/users - 管理员直接创建用户 (跳过邮箱验证码)
app.post('/api/admin/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const { email, password, role, credits, status } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: '邮箱和密码不能为空' });
    }
    const user = authService.createUserByAdmin(email, password, { role, credits, status });
    res.json(user);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/admin/users - 获取用户列表
app.get('/api/admin/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, role, status, email } = req.query;
    const result = await authService.getUserList(
      parseInt(page),
      parseInt(pageSize),
      { role, status, email }
    );
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/users/:id - 获取用户详情
app.get('/api/admin/users/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await authService.getUserDetail(userId);

    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/users/:id/status - 更新用户状态
app.put('/api/admin/users/:id/status', authenticate, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { status } = req.body;

    await authService.updateUserStatus(userId, status);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/admin/users/:id/credits - 修改用户积分
app.put('/api/admin/users/:id/credits', authenticate, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { credits, operation = 'set' } = req.body;

    await authService.updateUserCredits(userId, credits, operation);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/admin/users/:id/password - 重置用户密码
app.put('/api/admin/users/:id/password', authenticate, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { newPassword } = req.body;

    await authService.resetUserPassword(userId, newPassword);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/admin/users/:id/role - 修改用户角色
app.put('/api/admin/users/:id/role', authenticate, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { role } = req.body;

    await authService.updateUserRole(userId, role);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/admin/works - 获取作品列表（预留）
app.get('/api/admin/works', authenticate, requireAdmin, async (req, res) => {
  try {
    // 预留作品管理功能
    res.json({ success: true, data: { works: [], pagination: { total: 0 } } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/works/:id/featured - 切换作品推荐状态（预留）
app.put('/api/admin/works/:id/featured', authenticate, requireAdmin, async (req, res) => {
  try {
    // 预留作品推荐功能
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 系统配置接口（SMTP 等）
// ============================================================

// GET /api/admin/config - 获取系统配置
app.get('/api/admin/config', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const configs = db.prepare('SELECT key, value, description FROM system_config').all();
    const configObj = {};
    for (const c of configs) {
      configObj[c.key] = { value: c.value, description: c.description };
    }
    res.json({ success: true, data: configObj });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/config - 保存系统配置
app.post('/api/admin/config', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { configs } = req.body; // { smtp_host: 'value', smtp_port: 'value', ... }

    if (!configs || typeof configs !== 'object') {
      return res.status(400).json({ error: '配置数据格式错误' });
    }

    const smtpConfigKeys = ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_from_name', 'smtp_tls_reject_unauthorized'];
    const descriptions = {
      smtp_host: 'SMTP 服务器地址',
      smtp_port: 'SMTP 端口号',
      smtp_secure: '是否启用 SSL（true/false）',
      smtp_user: 'SMTP 用户名',
      smtp_pass: 'SMTP 密码/授权码',
      smtp_from: '发件人邮箱',
      smtp_from_name: '发件人名称',
      smtp_tls_reject_unauthorized: 'TLS 证书校验（true/false）'
    };

    for (const [key, value] of Object.entries(configs)) {
      if (smtpConfigKeys.includes(key)) {
        const description = descriptions[key] || '';
        db.prepare(`
          INSERT INTO system_config (key, value, description)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = ?, description = ?, updated_at = datetime('now')
        `).run(key, String(value), description, String(value), description);
      }
    }

    // 清除邮件传输器缓存，以便重新加载配置
    const { resetMailTransporterCache } = await import('./services/authService.js');
    if (resetMailTransporterCache) resetMailTransporterCache();

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', mode: 'ark-official-api' });
});

// 生产模式: 提供前端静态文件
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, '../dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('[server] 收到 SIGTERM，正在关闭...');
  closeDatabase();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[server] 收到 SIGINT，正在关闭...');
  closeDatabase();
  process.exit(0);
});

/**
 * 服务启动时扫描未完成的任务, 继续轮询方舟任务状态。
 * 场景: 服务在任务生成中途被重启, 任务在方舟服务端仍在运行,
 *       拿到 task_id (保存在 submit_id 字段) 即可继续拉回结果。
 */
function resumePendingArkTasks() {
  try {
    const db = getDatabase();
    const pending = db.prepare(`
      SELECT id, prompt, submit_id FROM tasks
      WHERE status = 'generating' AND submit_id IS NOT NULL AND (video_url IS NULL OR video_url = '')
    `).all();

    if (pending.length === 0) return;

    console.log(`[resume] 发现 ${pending.length} 个未完成的方舟任务, 尝试恢复轮询...`);

    for (const t of pending) {
      pollArkTaskUntilDone({
        taskId: t.submit_id,
        prompt: t.prompt || '',
        onProgress: (msg) => {
          console.log(`[resume][task ${t.id}] ${msg}`);
          try { taskService.updateTask(t.id, { progress: msg }); } catch (_) {}
        },
        onVideoReady: (url) => {
          try { taskService.updateTask(t.id, { video_url: url }); } catch (_) {}
        },
      }).then((result) => {
        taskService.updateTaskStatus(t.id, 'done', {
          video_url: result.videoUrl,
          history_id: result.historyId || t.submit_id,
          item_id: result.itemId || t.submit_id,
          progress: '',
          error_message: null,
        });
        console.log(`[resume][task ${t.id}] ✅ 恢复完成: ${result.videoUrl}`);
      }).catch((err) => {
        taskService.updateTaskStatus(t.id, 'error', {
          progress: '',
          error_message: `恢复任务失败: ${err.message}`,
        });
        console.error(`[resume][task ${t.id}] ❌ 恢复失败: ${err.message}`);
      });
    }
  } catch (err) {
    console.error('[resume] 扫描未完成任务时出错:', err.message);
  }
}

app.listen(PORT, () => {
  const maskedKey = (() => {
    const k = process.env.ARK_API_KEY || '';
    if (!k) return '未配置';
    return k.length > 6 ? `已配置 (...${k.slice(-6)})` : '已配置';
  })();
  console.log(`\n🚀 服务器已启动: http://localhost:${PORT}`);
  console.log(`🔗 方舟官方 API : https://ark.cn-beijing.volces.com/api/v3`);
  console.log(`🔑 ARK_API_KEY : ${maskedKey}`);
  console.log(`📁 运行模式    : ${process.env.NODE_ENV === 'production' ? '生产' : '开发'}\n`);

  // 启动后清理已过期的 TOS 文件缓存, 并异步恢复未完成的任务
  try {
    const removed = cleanupExpiredTosCache();
    if (removed > 0) console.log(`[tos-cache] 启动清理: 删除过期记录 ${removed} 条`);
  } catch (err) {
    console.warn('[tos-cache] 启动清理失败:', err.message);
  }
  resumePendingArkTasks();
});
