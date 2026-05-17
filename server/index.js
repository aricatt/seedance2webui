import dotenv from 'dotenv';
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
import * as statsService from './services/statsService.js';
import { fetchModelTooGroups, fetchModelTooGroupUsers } from './services/modelTooAdminClient.js';
import {
  resolveDownloadTaskScope,
  assertDownloadTaskAccessible,
  buildDownloadScopePayload,
  parseOptionalUserId,
  scopeToTaskWhereClause,
} from './services/downloadScopeService.js';
import { findLocalUserIdForModelTooMember } from './services/modelTooLocalUserMatch.js';
import { bufferToDataUri } from './services/arkVideoGenerator.js';
import {
  generateVideo,
  pollVideoUntilDone,
  listAvailableModels,
  assertModelAllowed,
  resolveProvider,
  getProviderFlags,
  assertAnyVideoProviderConfiguredOrExit,
} from './services/videoProviderService.js';
import { isArkApiKeyConfigured } from './services/arkConfig.js';
import { isLuminiaApiKeyConfigured } from './services/luminiaConfig.js';
import {
  calculateCostFromTokens,
  extractCompletionTokensFromResult,
  extractTotalTokensFromResult,
  normalizeModelId,
} from './services/videoPricing.js';
import {
  getOrUploadToTos,
  getOrUploadToTosByPath,
  cleanupExpiredTosCache,
  isTosConfigured,
  isTosPersistConfigured,
  getPresignedUrlForPersistKey,
} from './services/tosUploader.js';
import { schedulePersistGeneratedVideo } from './services/videoPersistPipeline.js';
import * as projectPortraitService from './services/projectPortraitService.js';
import {
  enrichTaskWithPersistUrls,
  enrichTasksWithPersistUrls,
  buildPersistVideoProxyUrl,
} from './services/taskPersistUrls.js';
import { resolvePersistVideoKey, resolvePersistCoverKey } from './services/legacyPersistResolve.js';
import {
  servePersistImageBuffer,
  streamPersistObjectToResponse,
} from './services/persistImageServe.js';
import { resolvePlayableVideoUrl } from './services/legacyVideoUrlRefresh.js';
import { guessMimeType } from './services/arkFileUploader.js';
import { verifyPersistViewTicket } from './services/persistViewTicket.js';
import { verifyPortraitViewTicket } from './services/portraitViewTicket.js';
import { writeIntegrationGenerateVideoArchive } from './services/taskArchiveServer.js';
import {
  saveTaskArchiveHtml,
  pipeTaskArchiveHtml,
  taskHasStoredArchive,
} from './services/archivePersistService.js';
import { getProjectsWithBalance, consumeBudget } from './services/modelTooInternalClient.js';

/** 无论从哪个工作目录启动 node server/index.js，都读取项目根目录 .env（避免读不到 STUDIO_INTEGRATION_*） */
const __serverDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__serverDir, '..', '.env') });

// 启动时至少配置一个视频 API Key
assertAnyVideoProviderConfiguredOrExit();

// 初始化数据库
initDatabase();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const MODELTOO_API_URL = (process.env.MODELTOO_API_URL || '').replace(/\/+$/, '');

/** 解析统计 API 的 days 参数：支持 0 表示全部时间 */
function parseStatsDays(query) {
  const raw = query.days;
  if (raw === undefined || raw === '') return 30;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 30;
}

/**
 * 根据 ModelToo 分组 ID，解析本地 SQLite 中对应用户的 id 列表。
 * 与下载页组长范围共用 modelTooLocalUserMatch：users.email 列为历史命名，实际存登录账号名（与 ModelToo username/email 对齐）。
 */
async function resolveFilterUserIdsFromModelTooGroup(groupId) {
  const gid = String(groupId || '').trim();
  if (!gid) return null;
  if (!MODELTOO_API_URL) {
    throw new Error('未配置 MODELTOO_API_URL，无法按分组统计');
  }
  const mtUsers = await fetchModelTooGroupUsers(MODELTOO_API_URL, gid);
  const list = Array.isArray(mtUsers) ? mtUsers : [];
  const seen = new Set();
  const ids = [];

  for (const u of list) {
    const localId = findLocalUserIdForModelTooMember(u);
    if (localId != null && !seen.has(localId)) {
      seen.add(localId);
      ids.push(localId);
    }
  }

  if (list.length > 0 && ids.length === 0) {
    console.warn(
      `[stats] 分组 ${gid} ModelToo 返回 ${list.length} 名成员，但本地 users 未匹配到任何账号（请确认 SD 用户曾用与 ModelToo 一致的账号名登录过；本地存在 users.email 列）`
    );
  }

  return { userIds: ids, modelTooMemberCount: list.length };
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── ModelToo 远程账号验证 ──────────────────────────────────

/**
 * 尝试通过 ModelToo 远程 API 验证账号密码。
 * 成功返回 { success: true }，任何失败（网络/401/超时）都返回 { success: false }。
 */
async function tryModelTooLogin(username, password) {
  if (!MODELTOO_API_URL) return { success: false, remoteUser: null };
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
    if (!resp.ok) {
      console.log(`[auth] ModelToo 远程验证失败 (HTTP ${resp.status}): ${username}`);
      return { success: false, remoteUser: null };
    }
    const data = await resp.json().catch(() => ({}));
    const u = data && typeof data === 'object' ? data.user : null;
    let remoteUser = null;
    if (u && typeof u === 'object') {
      remoteUser = {
        username: String(u.username || '').trim(),
        email: String(u.email || '').trim(),
        display_name: String(u.display_name ?? u.displayName ?? '').trim(),
      };
    }
    console.log(`[auth] ModelToo 远程验证成功: ${username}`);
    return { success: true, remoteUser };
  } catch (err) {
    console.log(`[auth] ModelToo 远程不可用: ${err.message}`);
    return { success: false, remoteUser: null };
  }
}

/**
 * 从 ModelToo 登录响应推导展示名：优先 MT display_name，否则 username。
 */
function displayNameFromModelTooRemote(remoteUser) {
  if (!remoteUser || typeof remoteUser !== 'object') return '';
  const fromProfile = String(remoteUser.display_name ?? '').trim();
  if (fromProfile) return authService.clampDisplayName(fromProfile);
  return authService.clampDisplayName(String(remoteUser.username ?? '').trim());
}

/**
 * 将 ModelToo 验证通过的账号同步到本地 SQLite。
 * - 本地不存在 → 新建用户 (role=user, credits=10)，并写入 display_name
 * - 本地已存在 → 更新密码哈希；若有 remoteUser 则同步 display_name
 */
function syncModelTooUser(loginIdentifier, password, remoteUser) {
  const db = getDatabase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(loginIdentifier);
  const passwordHash = authService.hashPassword(password);
  const displayName = displayNameFromModelTooRemote(remoteUser);
  if (!existing) {
    db.prepare(
      `INSERT INTO users (email, display_name, password_hash, role, status, credits) VALUES (?, ?, ?, 'user', 'active', 10)`
    ).run(loginIdentifier, displayName, passwordHash);
    console.log(`[auth] 已为 ModelToo 用户 "${loginIdentifier}" 创建本地账号`);
  } else {
    if (displayName) {
      db.prepare(
        `UPDATE users SET password_hash = ?, display_name = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(passwordHash, displayName, existing.id);
      console.log(`[auth] 已同步 ModelToo 用户 "${loginIdentifier}" 的密码与展示名`);
    } else {
      db.prepare(
        `UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(passwordHash, existing.id);
      console.log(`[auth] 已同步 ModelToo 用户 "${loginIdentifier}" 的密码`);
    }
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
const DOWNLOAD_TOKEN_TTL_MS = 5 * 60 * 1000;
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
  // Studio / 其它后端服务：Bearer 与 STUDIO_INTEGRATION_TOKEN 一致时，挂到固定集成用户（任务仍落库，便于排障）
  const integrationToken = (process.env.STUDIO_INTEGRATION_TOKEN || '').trim();
  const authz = (req.headers.authorization || '').trim();
  const bearerMatch = /^Bearer\s+(\S+)/i.exec(authz);
  const bearerToken = bearerMatch ? bearerMatch[1].trim() : '';
  if (integrationToken && bearerToken === integrationToken) {
    const email = (process.env.STUDIO_INTEGRATION_USER_EMAIL || '').trim();
    if (!email) {
      return res
        .status(500)
        .json({ error: '服务器未配置 STUDIO_INTEGRATION_USER_EMAIL，无法使用集成鉴权' });
    }
    try {
      const db = getDatabase();
      const user = db
        .prepare(
          'SELECT id, email, display_name, role, status, credits FROM users WHERE email = ?'
        )
        .get(email);
      if (!user) {
        return res.status(403).json({
          error: `集成用户不存在，请在 ModelTooSD 先注册/创建账号: ${email}`,
        });
      }
      if (user.status !== 'active') {
        return res.status(403).json({ error: '集成用户未启用' });
      }
      req.user = {
        id: user.id,
        email: user.email,
        displayName: String(user.display_name ?? '').trim(),
        role: user.role,
        status: user.status,
        credits: user.credits,
      };
      req.sessionId = 'integration';
      const actor = String(req.headers['x-studio-actor'] || '').trim().slice(0, 200);
      req.studioActorLabel = actor || null;
      return next();
    } catch (e) {
      return res.status(500).json({ error: e.message || '集成鉴权失败' });
    }
  }

  if (!integrationToken && bearerToken) {
    console.warn(
      '[auth] 收到 Bearer 但未加载 STUDIO_INTEGRATION_TOKEN（请确认项目根 .env 与启动顺序）；将按 Session 校验 → 易 401'
    );
  } else if (integrationToken && bearerToken && bearerToken !== integrationToken) {
    console.warn(
      `[auth] Bearer 与 STUDIO_INTEGRATION_TOKEN 不一致（长度 ${bearerToken.length} vs ${integrationToken.length}）`
    );
  }

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

  // Extract X-Project-Id header for ModelToo budget tracking
  const projectIdHeader = req.headers['x-project-id'];
  const estimatedPriceHeader = req.headers['x-estimated-price'];
  let mtProjectId = null;
  let mtIdempotencyKey = null;

  try {
    const {
      prompt,
      ratio,
      duration,
      model,
      resolution,
      seed,
      watermark: watermarkRaw,
      generate_audio: generateAudioRaw,
    } = req.body;
    const parseBool = (v, fallback) => {
      if (v === undefined || v === null || v === '') return fallback;
      if (typeof v === 'boolean') return v;
      const s = String(v).toLowerCase();
      return s === '1' || s === 'true' || s === 'yes' || s === 'on';
    };
    const watermark = parseBool(watermarkRaw, false);
    const generateAudio = parseBool(generateAudioRaw, true);
    const seedNum =
      seed === undefined || seed === null || seed === ''
        ? undefined
        : Number.isFinite(Number(seed))
          ? Math.trunc(Number(seed))
          : undefined;
    const fileMap = req.files || {};
    const imageFiles = Array.isArray(fileMap.files) ? fileMap.files : [];
    const videoFiles = Array.isArray(fileMap.video) ? fileMap.video : [];
    const audioFiles = Array.isArray(fileMap.audio) ? fileMap.audio : [];

    let portraitIds = [];
    try {
      const rawPortraitIds = req.body.portrait_ids;
      if (rawPortraitIds) {
        portraitIds = typeof rawPortraitIds === 'string' ? JSON.parse(rawPortraitIds) : rawPortraitIds;
      }
    } catch {
      return res.status(400).json({ error: 'portrait_ids 格式无效，应为 JSON 数组' });
    }
    if (!Array.isArray(portraitIds)) portraitIds = [];

    if (portraitIds.length + imageFiles.length > 9) {
      return res.status(400).json({ error: '参考图片与人像库合计最多 9 张' });
    }

    if (
      portraitIds.length === 0 &&
      imageFiles.length === 0 &&
      videoFiles.length === 0 &&
      audioFiles.length === 0 &&
      !(prompt || '').trim()
    ) {
      return res
        .status(400)
        .json({ error: '请至少提供一个素材 (图片/视频/音频/人像库) 或文本 Prompt' });
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
      const accountInfo =
        req.studioActorLabel != null && req.studioActorLabel !== ''
          ? JSON.stringify({ creator_label: req.studioActorLabel, via: 'studio' })
          : null;
      
      // 提交时只校验余额（不扣费），扣费推迟到任务完成后按实际费用结算
      if (projectIdHeader) {
        console.log('[generate-video] X-Project-Id header found:', projectIdHeader);
        console.log('[generate-video] X-Estimated-Price header:', estimatedPriceHeader);

        try {
          const { getProjectsWithBalance } = await import('./services/modelTooInternalClient.js');
          const newTaskId = createTaskId();
          mtIdempotencyKey = `sd-${newTaskId}`;
          mtProjectId = projectIdHeader;

          // 估算所需金额（使用前端预估的最大值）
          let requiredAmount = parseFloat(estimatedPriceHeader) || 0;
          if (!requiredAmount || isNaN(requiredAmount)) {
            const durationSeconds = parseInt(duration) || 5;
            requiredAmount = (durationSeconds / 5) * 1.85;
          }

          // 查询当前用户在该项目下的可用余额
          const projects = await getProjectsWithBalance(req.user.email);
          const proj = (projects || []).find((p) => String(p.project_id) === String(projectIdHeader));
          if (!proj) {
            console.warn('[generate-video] 用户在项目中未找到余额信息，project_id=', projectIdHeader);
            return res.status(402).json({
              code: 'INSUFFICIENT_BUDGET',
              message: '未在项目中找到您的额度信息',
            });
          }

          // 优先使用成员个人额度（如果是成员），否则使用项目池余额
          const isMember = !!proj.is_member;
          const availableBalance = Number(proj.balance || 0);

          console.log('[generate-video] 余额校验:', {
            projectId: projectIdHeader,
            requiredAmount,
            availableBalance,
            isMember,
          });

          if (availableBalance < requiredAmount) {
            console.log('[generate-video] 余额不足，拒绝提交');
            return res.status(402).json({
              code: isMember ? 'INSUFFICIENT_MEMBER_BUDGET' : 'INSUFFICIENT_BUDGET',
              message: isMember ? '成员个人额度不足' : '余额不足',
              balance: availableBalance,
              required: requiredAmount,
            });
          }
        } catch (checkError) {
          console.error('[generate-video] 余额校验失败:', checkError.message);
          // 校验失败时不扣费但允许继续（避免 ModelToo 暂时不可用阻塞业务）
          if (checkError.status === 402) {
            return res.status(402).json(checkError.detail || { error: '余额不足' });
          }
          // 其它错误：保留 mtProjectId/mtIdempotencyKey 以便结算
        }
      } else {
        console.log('[generate-video] No X-Project-Id header found');
      }
      
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
        resolution:
          resolution !== undefined && resolution !== null && String(resolution).trim() !== ''
            ? String(resolution).trim()
            : null,
        accountInfo,
        mtProjectId,
        mtIdempotencyKey,
      });
      dbTaskId = createdTask.id;
      console.log(`[生成任务] 数据库记录已创建，db_task_id = ${dbTaskId}, project_id = ${defaultProject.id}`);
    } catch (dbError) {
      console.error('[生成任务] 创建数据库记录失败:', dbError.message);
    }

    console.log(`\n========== [${taskId}] 收到视频生成请求 ==========`);
    console.log(`  prompt: ${(prompt || '').substring(0, 80)}${(prompt || '').length > 80 ? '...' : ''}`);
    console.log(`  model: ${model || 'doubao-seedance-2-0-260128'}, ratio: ${ratio || '16:9'}, duration: ${duration || 5}秒, resolution: ${resolution || '(默认)'}`);
    console.log(`  seed=${seedNum ?? '(random)'} watermark=${watermark} generate_audio=${generateAudio}`);
    console.log(`  images=${imageFiles.length} video=${videoFiles.length} audio=${audioFiles.length}`);

    // 显式 Content-Length + Connection:close，避免 chunked 响应与后续同步重负载叠加时 httpx 侧 ReadError
    const payload = JSON.stringify({ taskId, dbTaskId });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(payload, 'utf8'));
    res.setHeader('Connection', 'close');
    res.end(payload);

    await new Promise((resolve) => setImmediate(resolve));

    // Studio 集成（小云雀代提交）无浏览器归档：服务端写入 HTML 归档，内容与前台「提交即归档」一致思路（缩略图 + 提示词 + 参数）
    if (dbTaskId && req.sessionId === 'integration') {
      try {
        await writeIntegrationGenerateVideoArchive(dbTaskId, {
          prompt: prompt || '',
          model: model || 'doubao-seedance-2-0-260128',
          ratio: ratio || '16:9',
          duration: parseInt(duration) || 5,
          resolution: resolution || '',
          seed: seedNum,
          watermark,
          generateAudio,
          creatorLabel: req.studioActorLabel || '',
          portraitIds,
          mtProjectId: projectIdHeader || '',
          imageFiles,
          videoFiles,
          audioFiles,
        });
      } catch (arcErr) {
        console.warn(`[archive] 集成任务 ${dbTaskId} 服务端归档失败（不影响生成）:`, arcErr.message || arcErr);
      }
    }

    // 先把所有素材上传到方舟 (命中缓存则直接复用 file_id)
    const logProgress = (msg) => {
      task.progress = msg;
      console.log(`[${taskId}] ${msg}`);
      if (dbTaskId) {
        try { taskService.updateTask(dbTaskId, { progress: msg }); } catch (_) {}
      }
    };

    let imageUrls = [];
    let videoUrls = [];
    let audioUrls = [];
    try {
      let modelIdForPortrait = model || settingsService.getSetting('model') || 'luminia-2.0';
      if (portraitIds.length > 0) {
        if (!projectIdHeader) {
          throw new Error('使用虚拟人像库需先选择 ModelToo 项目');
        }
        projectPortraitService.assertPortraitsAllowedForModel(modelIdForPortrait);
        const portraits = projectPortraitService.getPortraitsForGeneration({
          ids: portraitIds,
          mtProjectId: projectIdHeader,
        });
        imageUrls.push(...projectPortraitService.buildPortraitAssetUrls(portraits));
        logProgress(`已引用 ${portraits.length} 个库中人像 (asset://)`);
      }

      // === 图片: 上传 TOS → 预签名 URL (避免 payload too large) ===
      for (let i = 0; i < imageFiles.length; i++) {
        const f = imageFiles[i];
        logProgress(`图片 ${i + 1}/${imageFiles.length}: ${f.originalname} 上传到 TOS...`);
        const r = await getOrUploadToTos(f.buffer, {
          filename: f.originalname,
          mimeType: f.mimetype,
          onProgress: (stage, detail) => {
            if (stage === 'cache_hit') logProgress(`图片 ${i + 1}: TOS 缓存命中`);
            else if (stage === 'uploading') logProgress(`图片 ${i + 1}: ${f.originalname} 上传中...`);
            else if (stage === 'uploaded') logProgress(`图片 ${i + 1}: ✓ 上传完成`);
          },
        });
        imageUrls.push(r.url);
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

      logProgress(`素材准备完成 ✓ (图片=${imageUrls.length} 视频=${videoUrls.length} 音频=${audioUrls.length})`);
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

    let modelId;
    let videoProvider;
    try {
      modelId = model || settingsService.getSetting('model') || 'luminia-2.0';
      assertModelAllowed(modelId);
      videoProvider = resolveProvider(modelId);
    } catch (modelErr) {
      const msg = modelErr.message || '模型不可用';
      task.status = 'error';
      task.error = msg;
      if (dbTaskId) {
        try { taskService.updateTaskStatus(dbTaskId, 'error', { progress: '', error_message: msg }); } catch (_) {}
      }
      return;
    }

    generateVideo({
      model: modelId,
      prompt: prompt || '',
      imageUrls: imageUrls,
      videoUrls: videoUrls,
      audioUrls: audioUrls,
      ratio: ratio || '16:9',
      duration: parseInt(duration) || 5,
      resolution: resolution || undefined,
      seed: seedNum,
      generateAudio,
      watermark,
      onProgress: async (progress) => {
        task.progress = progress;
        console.log(`[${taskId}] [${videoProvider}] ${progress}`);
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
              video_provider: videoProvider,
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
            const totalTokens = extractTotalTokensFromResult(result);
            const completionTokens = extractCompletionTokensFromResult(result);
            console.log(`[${taskId}] tokens 提取: total_tokens=${totalTokens}, completion_tokens=${completionTokens}, usage=${JSON.stringify(result.raw?.usage || result.usage || {})}`);
            if (totalTokens == null) {
              console.warn(`[${taskId}] ⚠️ 未返回 usage.total_tokens，raw.keys=${Object.keys(result.raw || {}).join(',')}`);
            }

            const modelId = normalizeModelId(model || 'doubao-seedance-2-0-260128');
            const outputResolution =
              resolution && String(resolution).trim() ? String(resolution).trim() : '720p';
            const hasVideoInput = videoUrls.length > 0;
            const { cost, unitPrice, pricingUnit, provider: pricingProvider } = calculateCostFromTokens(
              totalTokens,
              modelId,
              { resolution: outputResolution, hasVideoInput },
            );
            if (totalTokens != null && unitPrice == null) {
              console.warn(
                `[${taskId}] ⚠️ 无法确定单价 model=${modelId} resolution=${outputResolution} hasVideoInput=${hasVideoInput}`,
              );
            } else if (cost != null) {
              console.log(
                `[${taskId}] cost 计算: total_tokens=${totalTokens}, unit_price=${unitPrice} (${pricingUnit}), provider=${pricingProvider}, cost=${cost}`,
              );
            }

            console.log(`[${taskId}] 准备更新数据库: db_task_id=${dbTaskId}, total_tokens=${totalTokens}, cost=${cost}, unit_price=${unitPrice}`);
            try {
              taskService.updateTaskStatus(dbTaskId, 'done', {
                submit_id: result.submitId || null,
                history_id: result.historyId || null,
                item_id: result.itemId || null,
                video_url: result.videoUrl,
                progress: '',
                error_message: null,
                revised_prompt: result.revisedPrompt || null,
                total_tokens: totalTokens,
                completion_tokens: completionTokens,
                cost: cost,
                unit_price: unitPrice,
              });
              console.log(`[${taskId}] 数据库更新成功`);

              // 结算：按实际费用扣一次费用（allow_negative=true，允许负余额）
              if (cost !== null && cost > 0 && mtProjectId) {
                console.log(`[${taskId}] 开始结算扣费: ${cost}`);
                (async () => {
                  try {
                    const { consumeBudget } = await import('./services/modelTooInternalClient.js');
                    const settleResult = await consumeBudget({
                      projectId: mtProjectId,
                      amount: cost,
                      idempotencyKey: mtIdempotencyKey,
                      userId: req.user.email,
                      actorUserId: req.user.email,
                      source: 'sd',
                      metadata: {
                        service: 'sd-video',
                        task_id: dbTaskId,
                        model: modelId,
                        total_tokens: totalTokens,
                        unit_price: unitPrice,
                        pricing_unit: pricingUnit,
                        provider: pricingProvider,
                      },
                      allowNegative: true,
                    });
                    console.log(`[${taskId}] 结算扣费成功: ${cost}, 余额: ${settleResult.balance}`);
                  } catch (settleError) {
                    console.error(`[${taskId}] 结算扣费失败:`, settleError.message);
                  }
                })();
              }

              schedulePersistGeneratedVideo(dbTaskId, result.videoUrl);
            } catch (dbError) {
              console.error('[生成任务] 更新数据库记录失败:', dbError.message);
            }
          } catch (error) {
            console.error('[生成任务] 处理 tokens 和 cost 失败:', error.message);
          }
        }
      })
      .catch((err) => {
        task.status = 'error';
// ...
        task.error = err.message || '视频生成失败';
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.error(`========== [${taskId}] ❌ 视频生成失败 (${elapsed}秒): ${err.message} ==========\n`);

        if (dbTaskId) {
          try {
            taskService.updateTaskStatus(dbTaskId, 'error', {
              progress: '',
              error_message: err.message || '视频生成失败',
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

// GET /api/tos/persist-image - 同源代理：服务端拉图/缩放后输出（勿 307 到 volces，远程机才能看封面）
app.get('/api/tos/persist-image', async (req, res) => {
  const { ticket, variant = 'full' } = req.query;

  if (!ticket || typeof ticket !== 'string') {
    console.log('[tos-persist-image] 缺少 ticket 参数');
    return res.status(400).json({ error: '缺少 ticket 参数' });
  }

  if (!['full', 'list', 'download', 'video', 'cover'].includes(variant)) {
    console.log('[tos-persist-image] 无效的 variant 参数:', variant);
    return res.status(400).json({ error: '无效的 variant 参数' });
  }

  // 验证 ticket
  const payload = verifyPersistViewTicket(ticket);
  if (!payload) {
    console.log('[tos-persist-image] ticket 验证失败');
    return res.status(401).json({ error: '无效或已过期的 ticket' });
  }

  const { tid: taskId, vid: viewerId, adm: isAdmin } = payload;
  console.log(`[tos-persist-image] ticket 验证成功: taskId=${taskId}, viewerId=${viewerId}, isAdmin=${isAdmin}`);

  try {
    const db = getDatabase();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);

    if (!task) {
      console.log(`[tos-persist-image] 任务不存在: taskId=${taskId}`);
      return res.status(404).json({ error: '任务不存在' });
    }

    console.log(`[tos-persist-image] 找到任务: user_id=${task.user_id}, persist_video_key=${task.persist_video_key ? 'yes' : 'no'}, persist_cover_key=${task.persist_cover_key ? 'yes' : 'no'}`);

    // 权限检查：使用与下载页面相同的权限逻辑（支持组长查看组内成员任务）
    const mockReq = { user: { id: viewerId, role: isAdmin ? 'admin' : 'member' } };
    await assertDownloadTaskAccessible(mockReq, task.user_id);
    console.log(`[tos-persist-image] 权限检查通过`);

    const isVideoVariant = variant === 'video';
    const key = isVideoVariant
      ? resolvePersistVideoKey(task)
      : resolvePersistCoverKey(task);
    if (!key) {
      console.log(`[tos-persist-image] 任务未持久化到 TOS: taskId=${taskId}, variant=${variant}`);
      return res.status(404).json({ error: '任务未持久化到 TOS' });
    }

    const bucket = process.env.TOS_PERSIST_BUCKET || '';
    if (!bucket) {
      console.log('[tos-persist-image] 未配置持久桶');
      return res.status(503).json({ error: '未配置持久桶' });
    }

    if (variant === 'video') {
      console.log(`[tos-persist-image] 流式转发视频 task=${taskId} key=${key}`);
      if (req.query.disposition === 'attachment') {
        const name =
          (task.video_path && String(task.video_path).split(/[/\\]/).pop())
          || `task-${taskId}.mp4`;
        res.setHeader(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        );
      }
      await streamPersistObjectToResponse(res, key);
      return;
    }

    const imageVariant =
      variant === 'cover' || variant === 'download' || variant === 'list' ? variant : 'full';
    const { buffer, contentType } = await servePersistImageBuffer(key, imageVariant);
    console.log(`[tos-persist-image] 流式出图 task=${taskId} variant=${variant} bytes=${buffer.length}`);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (error) {
    if (error.statusCode === 403) {
      console.log(`[tos-persist-image] 权限检查失败: ${error.message}`);
      return res.status(403).json({ error: '无权查看该资源' });
    }
    console.error('[tos-persist-image] 错误:', error);
    res.status(502).json({ error: 'TOS 预签名失败' });
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

// -------------------- 虚拟人像库（Luminia assets，按 ModelToo 项目隔离）--------------------
app.get('/api/portraits', authenticate, async (req, res) => {
  try {
    const mtProjectId = String(req.query.mt_project_id || req.headers['x-project-id'] || '').trim();
    if (!mtProjectId) {
      return res.status(400).json({ error: '缺少 mt_project_id（或请求头 X-Project-Id）' });
    }
    const list = await projectPortraitService.syncProcessingPortraits({
      mtProjectId,
      viewerUserId: req.user.id,
      viewerIsAdmin: req.user.role === 'admin',
    });
    res.json({ success: true, data: list });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post(
  '/api/portraits',
  authenticate,
  upload.single('file'),
  async (req, res) => {
    try {
      const mtProjectId = String(req.body.mt_project_id || req.headers['x-project-id'] || '').trim();
      if (!mtProjectId) {
        return res.status(400).json({ error: '缺少 mt_project_id（或请求头 X-Project-Id）' });
      }
      if (!req.file?.buffer) {
        return res.status(400).json({ error: '请上传人像图片文件' });
      }
      const name = String(req.body.name || req.file.originalname || '未命名人像').trim();
      const portrait = await projectPortraitService.registerPortraitFromUpload({
        userId: req.user.id,
        mtProjectId,
        name,
        buffer: req.file.buffer,
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
      });
      const data = projectPortraitService.enrichPortraitForViewer(
        portrait,
        req.user.id,
        req.user.role === 'admin',
      );
      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// GET /api/portraits/:id/preview — 同源代理列表预览（ticket，img 无法带 Bearer）
app.get('/api/portraits/:id/preview', async (req, res) => {
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
  const mtProjectId = String(req.query.mt_project_id || '').trim();
  const portraitId = Number(req.params.id);

  if (!ticket) {
    return res.status(400).json({ error: '缺少 ticket 参数' });
  }
  if (!mtProjectId) {
    return res.status(400).json({ error: '缺少 mt_project_id 参数' });
  }
  if (!Number.isFinite(portraitId)) {
    return res.status(400).json({ error: '无效的人像 ID' });
  }

  const payload = verifyPortraitViewTicket(ticket);
  if (!payload) {
    return res.status(401).json({ error: '无效或已过期的 ticket' });
  }
  if (String(payload.pid) !== String(portraitId) || String(payload.proj) !== mtProjectId) {
    return res.status(401).json({ error: 'ticket 与人像不匹配' });
  }

  try {
    const buf = await projectPortraitService.getPortraitListPreviewBuffer({
      id: portraitId,
      mtProjectId,
    });
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch (error) {
    const code = error.statusCode || 502;
    if (code >= 500) {
      console.error('[portrait-preview] 错误:', error);
    }
    res.status(code).json({ error: error.message || '预览失败' });
  }
});

// 归档：拉取人像库缩略图（同源鉴权，避免浏览器直连 TOS 预签名 CORS）
app.get('/api/portraits/:id/archive-thumb', authenticate, async (req, res) => {
  try {
    const mtProjectId = String(req.query.mt_project_id || req.headers['x-project-id'] || '').trim();
    if (!mtProjectId) {
      return res.status(400).json({ error: '缺少 mt_project_id（或请求头 X-Project-Id）' });
    }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: '无效的人像 ID' });
    }
    const buf = await projectPortraitService.getPortraitArchiveThumbBuffer({ id, mtProjectId });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch (error) {
    const code = error.statusCode || 500;
    res.status(code).json({ error: error.message });
  }
});

app.delete('/api/portraits/:id', authenticate, async (req, res) => {
  try {
    const mtProjectId = String(req.query.mt_project_id || req.headers['x-project-id'] || '').trim();
    if (!mtProjectId) {
      return res.status(400).json({ error: '缺少 mt_project_id（或请求头 X-Project-Id）' });
    }
    await projectPortraitService.deletePortrait({
      id: Number(req.params.id),
      mtProjectId,
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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
app.get('/api/projects/:id/tasks', authenticate, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const project = projectService.getProjectById(req.params.id, req.user.id, isAdmin);
    if (!project) {
      return res.status(404).json({ success: false, error: '项目不存在或无权访问' });
    }

    const { status, taskKind, sourceTaskId, rowGroupId } = req.query;
    let tasks = taskService.getTasksByProjectId(req.params.id, {
      status: typeof status === 'string' ? status : undefined,
      taskKind: typeof taskKind === 'string' ? taskKind : undefined,
      sourceTaskId: sourceTaskId !== undefined ? Number(sourceTaskId) : undefined,
      rowGroupId: typeof rowGroupId === 'string' ? rowGroupId : undefined,
    }, req.user.id, isAdmin);
    tasks = await enrichTasksWithPersistUrls(tasks, req.user.id, isAdmin);
    res.json({ success: true, data: tasks });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// -------------------- 任务管理 --------------------
// GET /api/tasks/:id - 获取任务详情
app.get('/api/tasks/:id', authenticate, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    let task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }
    task = await enrichTaskWithPersistUrls(task, req.user.id, isAdmin);
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

    // 获取选中的项目
    const selectedProjectId = req.body.project_id || req.query.project_id;
    if (!selectedProjectId) {
      return res.status(400).json({ error: '请先选择项目' });
    }

    // 检查项目余额
    try {
      const projects = await getProjectsWithBalance(req.user.email);
      const project = projects.find(p => p.project_id === selectedProjectId);
      if (!project) {
        return res.status(400).json({ error: '未找到选中的项目' });
      }
      
      // 估算任务成本（简化版：假设每个任务至少消耗 0.5 元）
      const estimatedCost = 0.5;
      if (project.balance < estimatedCost) {
        return res.status(402).json({ 
          error: '余额不足',
          detail: `当前余额: ${project.balance} 点，预估需要: ${estimatedCost} 点`
        });
      }
    } catch (error) {
      console.error('检查余额失败:', error);
      return res.status(503).json({ error: '无法检查余额，请稍后重试' });
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

    const outputResolution =
      settings.resolution != null && String(settings.resolution).trim() !== ''
        ? String(settings.resolution).trim()
        : null;

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
      resolution: outputResolution,
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

    const modelId = settings.model || 'luminia-2.0';
    let videoProvider;
    try {
      assertModelAllowed(modelId);
      videoProvider = resolveProvider(modelId);
    } catch (modelErr) {
      taskService.updateTaskStatus(task.id, 'error', {
        progress: '',
        error_message: modelErr.message || '模型不可用',
      });
      return;
    }

    generateVideo({
      model: modelId,
      prompt: task.prompt,
      imageUrls,
      videoUrls,
      audioUrls,
      ratio: settings.ratio || '16:9',
      duration: parseInt(settings.duration) || 5,
      resolution: outputResolution || undefined,
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
            video_provider: videoProvider,
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
        const totalTokens = extractTotalTokensFromResult(result);
        const completionTokens = extractCompletionTokensFromResult(result);
        const billingModelId = normalizeModelId(modelId);
        const taskResolution = outputResolution || settings.resolution || '720p';
        const hasVideoInput = videoUrls.length > 0;
        const { cost, unitPrice, pricingUnit, provider: pricingProvider } = calculateCostFromTokens(
          totalTokens,
          billingModelId,
          { resolution: taskResolution, hasVideoInput },
        );

        taskService.updateTaskStatus(task.id, 'done', {
          submit_id: result.submitId || null,
          history_id: result.historyId || null,
          item_id: result.itemId || null,
          video_url: result.videoUrl,
          progress: '',
          error_message: null,
          total_tokens: totalTokens,
          completion_tokens: completionTokens,
          cost: cost,
          unit_price: unitPrice,
        });
        schedulePersistGeneratedVideo(task.id, result.videoUrl);
        console.log(`[task ${task.id}] 视频生成成功：${result.videoUrl}`);

        // 结算：按实际费用扣一次费用（allow_negative=true）
        if (cost !== null && cost > 0 && selectedProjectId) {
          (async () => {
            try {
              const settleResult = await consumeBudget({
                projectId: selectedProjectId,
                amount: cost,
                idempotencyKey: `task-${task.id}-settle`,
                userId: req.user.email,
                actorUserId: req.user.email,
                source: 'sd',
                metadata: {
                  task_id: task.id,
                  model: billingModelId,
                  total_tokens: totalTokens,
                  unit_price: unitPrice,
                  pricing_unit: pricingUnit,
                  provider: pricingProvider,
                },
                allowNegative: true,
              });
              console.log(`[task ${task.id}] 结算扣费成功: ${cost}, 余额: ${settleResult.balance}`);
            } catch (settleError) {
              console.error(`[task ${task.id}] 结算扣费失败:`, settleError.message);
            }
          })();
        }
      })
      .catch((err) => {
        const totalTokens = err.raw?.usage?.total_tokens || 0;

        taskService.updateTaskStatus(task.id, 'error', {
          progress: '',
          error_message: err.message,
          total_tokens: totalTokens,
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
// 配置 TOS_PERSIST_BUCKET 时 HTML 写入持久桶（见 archivePersistService），否则落盘 data/archives/

// POST /api/tasks/:id/archive - 上传任务归档 HTML (text/html body)
app.post(
  '/api/tasks/:id/archive',
  authenticate,
  express.text({ type: ['text/html', 'text/plain'], limit: '50mb' }),
  async (req, res) => {
    try {
      const isAdmin = req.user.role === 'admin';
      const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
      if (!task) {
        return res.status(404).json({ error: '任务不存在或无权访问' });
      }
      const html = typeof req.body === 'string' ? req.body : '';
      const saved = await saveTaskArchiveHtml(task.id, html);
      taskService.updateTask(task.id, saved);
      res.json({ success: true, size: saved.size, persisted: !!saved.persist_archive_key });
    } catch (error) {
      console.error('[archive] 保存失败:', error);
      const code = error.message === '归档内容为空' ? 400 : 500;
      res.status(code).json({ error: error.message });
    }
  },
);

// GET /api/tasks/:id/archive - 获取归档 HTML 原文 (直接返回 HTML, 用于前端 fetch blob)
app.get('/api/tasks/:id/archive', authenticate, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }
    if (!taskHasStoredArchive(task)) {
      return res.status(404).json({ error: '归档不存在' });
    }
    await pipeTaskArchiveHtml(task, res);
  } catch (error) {
    const code = error.statusCode || 500;
    res.status(code).json({ error: error.message });
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
app.put('/api/settings', authenticate, (req, res) => {
  try {
    const settings = req.body || {};
    const isAdmin = req.user?.role === 'admin';
    const hasAdminKeys = Object.keys(settings).some((k) => settingsService.isAdminSettingKey(k));
    if (hasAdminKeys && !isAdmin) {
      return res.status(403).json({ error: '仅管理员可修改平台开关' });
    }
    const updated = settingsService.updateSettings(settings, { allowAdminKeys: isAdmin });
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/models - 可用视频模型（已按平台开关与 Key 过滤）
app.get('/api/models', authenticate, (_req, res) => {
  try {
    const models = listAvailableModels();
    const flags = getProviderFlags();
    res.json({
      success: true,
      data: {
        models,
        providers: {
          ark: {
            enabled: flags.arkEnabled,
            keyConfigured: flags.arkKeyConfigured,
          },
          luminia: {
            enabled: flags.luminiaEnabled,
            keyConfigured: flags.luminiaKeyConfigured,
          },
        },
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/settings/ark-status - 检查方舟 API Key 是否已配置 (只返回是/否, 不泄漏 Key)
app.get('/api/settings/ark-status', authenticate, (_req, res) => {
  res.json({ success: true, data: { configured: isArkApiKeyConfigured() } });
});

// GET /api/settings/luminia-status
app.get('/api/settings/luminia-status', authenticate, (_req, res) => {
  res.json({ success: true, data: { configured: isLuminiaApiKeyConfigured() } });
});

// GET /api/settings/provider-status - 平台开关 + Key 状态
app.get('/api/settings/provider-status', authenticate, (_req, res) => {
  const flags = getProviderFlags();
  res.json({
    success: true,
    data: {
      provider_ark_enabled: flags.arkEnabled,
      provider_luminia_enabled: flags.luminiaEnabled,
      arkKeyConfigured: flags.arkKeyConfigured,
      luminiaKeyConfigured: flags.luminiaKeyConfigured,
    },
  });
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

function buildVideoProxyPath(externalUrl) {
  return `/api/video-proxy?url=${encodeURIComponent(externalUrl)}`;
}

/** 本地 video_path 失效时，用已落 TOS 的 key 同源出流（download token 已校验权限） */
async function tryStreamPersistVideoForTask(res, taskId, opts = {}) {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT persist_video_key, persist_video_tos_url, video_url,
      history_id, submit_id, item_id, video_provider
    FROM tasks WHERE id = ?
  `).get(taskId);
  if (!row) return false;
  const videoKey = resolvePersistVideoKey({ ...row, id: Number(taskId) });
  if (!videoKey || !isTosPersistConfigured()) return false;
  if (opts.attachment) {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`task-${taskId}.mp4`)}`,
    );
  }
  await streamPersistObjectToResponse(res, videoKey);
  return true;
}

// POST /api/download/tasks/:id/file-token - 创建一次性下载 token
app.post('/api/download/tasks/:id/file-token', authenticate, async (req, res) => {
  try {
    const taskId = req.params.id;
    const db = getDatabase();
    const row = db.prepare(`
      SELECT user_id, persist_video_key, persist_video_tos_url, video_url,
        history_id, submit_id, item_id, video_provider
      FROM tasks WHERE id = ?
    `).get(taskId);
    if (!row) {
      return res.status(404).json({ success: false, error: '任务不存在' });
    }
    await assertDownloadTaskAccessible(req, row.user_id);

    const result = videoDownloader.getDownloadedVideoFileByTaskId(taskId);

    if (result.success) {
      const token = createDownloadToken(taskId, req.user.id);
      return res.json({ success: true, data: { token } });
    }

    const videoKey = resolvePersistVideoKey({ ...row, id: Number(taskId) });
    if (videoKey && isTosPersistConfigured()) {
      const proxyVideoUrl = buildPersistVideoProxyUrl(
        taskId,
        req.user.id,
        req.user.role === 'admin',
        { disposition: 'attachment' },
      );
      return res.json({ success: true, data: { proxyVideoUrl } });
    }

    const playable = await resolvePlayableVideoUrl({ ...row, id: Number(taskId) });
    if (playable) {
      return res.json({ success: true, data: { directUrl: buildVideoProxyPath(playable) } });
    }

    const statusCode = result.error === '任务不存在'
      ? 404
      : result.error === '任务尚未下载到服务器' || result.error.startsWith('视频文件不存在')
        ? 400
        : 500;
    return res.status(statusCode).json({ error: result.error || '暂无可下载的视频地址' });
  } catch (error) {
    const code = error.statusCode || 500;
    res.status(code).json({ success: false, error: error.message });
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
      if (await tryStreamPersistVideoForTask(res, record.taskId, { attachment: true })) {
        return;
      }
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
    const db = getDatabase();
    const row = db.prepare(`
      SELECT user_id, persist_video_key, persist_video_tos_url, video_url,
        history_id, submit_id, item_id, video_provider
      FROM tasks WHERE id = ?
    `).get(taskId);
    if (!row) {
      return res.status(404).json({ success: false, error: '任务不存在' });
    }
    await assertDownloadTaskAccessible(req, row.user_id);

    const local = videoDownloader.getDownloadedVideoFileByTaskId(taskId);

    if (local.success) {
      const token = createDownloadToken(taskId, req.user.id, 'stream');
      return res.json({ success: true, data: { token } });
    }

    const videoKey = resolvePersistVideoKey({ ...row, id: Number(taskId) });
    if (videoKey && isTosPersistConfigured()) {
      const proxyVideoUrl = buildPersistVideoProxyUrl(
        taskId,
        req.user.id,
        req.user.role === 'admin',
      );
      return res.json({ success: true, data: { proxyVideoUrl } });
    }

    const playable = await resolvePlayableVideoUrl({ ...row, id: Number(taskId) });
    if (playable) {
      return res.json({ success: true, data: { streamUrl: buildVideoProxyPath(playable) } });
    }

    const errMsg = local.error || '暂无可预览的视频地址';
    const statusCode =
      errMsg === '任务不存在'
        ? 404
        : errMsg === '任务尚未下载到服务器' || errMsg.startsWith('视频文件不存在')
          ? 400
          : 500;
    return res.status(statusCode).json({ error: errMsg });
  } catch (error) {
    const code = error.statusCode || 500;
    res.status(code).json({ success: false, error: error.message });
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
      if (await tryStreamPersistVideoForTask(res, record.taskId)) {
        return;
      }
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
    const db = getDatabase();
    const row = db.prepare('SELECT user_id FROM tasks WHERE id = ?').get(taskId);
    if (!row) {
      return res.status(404).json({ success: false, error: '任务不存在' });
    }
    await assertDownloadTaskAccessible(req, row.user_id);

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
    const code = error.statusCode || 500;
    res.status(code).json({ success: false, error: error.message });
  }
});

// ============================================================
// 下载管理 API 路由
// ============================================================

// GET /api/download/scope - 下载页筛选范围（管理员 / 组长 / 普通成员）
app.get('/api/download/scope', authenticate, async (req, res) => {
  try {
    const data = await buildDownloadScopePayload(req.user);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/download/tasks - 获取下载任务列表
app.get('/api/download/tasks', authenticate, async (req, res) => {
  try {
    const { status = 'all', type = 'all', page = 1, pageSize = 20 } = req.query;
    const requested = parseOptionalUserId(req.query.user_id);
    const userScope = await resolveDownloadTaskScope(req.user, requested);
    const result = videoDownloader.getDownloadTasks({
      status,
      type,
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      userScope,
    });
    const isAdmin = req.user.role === 'admin';
    result.tasks = await enrichTasksWithPersistUrls(result.tasks, req.user.id, isAdmin);
    res.json({ success: true, data: result });
  } catch (error) {
    const code = error.statusCode || 500;
    res.status(code).json({ success: false, error: error.message });
  }
});


// POST /api/download/tasks/:id - 下载单个任务视频
app.post('/api/download/tasks/:id', authenticate, async (req, res) => {
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

    await assertDownloadTaskAccessible(req, task.user_id);

    const hasPersistUrl = String(task.persist_video_tos_url || '').trim().startsWith('http');
    if (!task.video_url && !task.persist_video_key && !hasPersistUrl) {
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
    const code = error.statusCode || 500;
    res.status(code).json({ error: error.message });
  }
});

// POST /api/download/batch - 批量下载视频
app.post('/api/download/batch', authenticate, async (req, res) => {
  try {
    const { taskIds } = req.body;
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ error: 'taskIds 必须是非空数组' });
    }

    const db = getDatabase();
    for (const tid of taskIds) {
      const row = db.prepare('SELECT user_id FROM tasks WHERE id = ?').get(tid);
      if (!row) {
        return res.status(404).json({ error: `任务不存在: ${tid}` });
      }
      await assertDownloadTaskAccessible(req, row.user_id);
    }

    const baseDownloadPath = videoDownloader.getDefaultDownloadPath();
    const results = await videoDownloader.batchDownloadVideos(taskIds, baseDownloadPath);

    // 更新下载状态
    for (const result of results) {
      if (result.success) {
        videoDownloader.updateDownloadStatus(result.taskId, 'done', { downloadPath: result.path });
      } else {
        videoDownloader.updateDownloadStatus(result.taskId, 'failed', { error: result.error });
      }
    }

    res.json({ success: true, data: results });
  } catch (error) {
    const code = error.statusCode || 500;
    res.status(code).json({ error: error.message });
  }
});

// POST /api/download/tasks/:id/open - 打开视频所在文件夹
app.post('/api/download/tasks/:id/open', authenticate, async (req, res) => {
  try {
    const taskId = req.params.id;
    const db = getDatabase();

    const task = db.prepare('SELECT video_path, user_id FROM tasks WHERE id = ?').get(taskId);
    if (!task || !task.video_path) {
      return res.status(404).json({ error: '任务不存在或未下载' });
    }

    await assertDownloadTaskAccessible(req, task.user_id);

    const result = await videoDownloader.openVideoFolder(task.video_path);
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    const code = error.statusCode || 500;
    res.status(code).json({ error: error.message });
  }
});

// DELETE /api/download/tasks/:id - 删除任务
app.delete('/api/download/tasks/:id', authenticate, async (req, res) => {
  try {
    const taskId = req.params.id;
    const db = getDatabase();

    const row = db.prepare('SELECT user_id FROM tasks WHERE id = ?').get(taskId);
    if (!row) {
      return res.status(404).json({ error: '任务不存在' });
    }
    await assertDownloadTaskAccessible(req, row.user_id);

    // 删除任务（外键会自动删除 task_assets 和 generation_history）
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);

    res.json({ success: true });
  } catch (error) {
    const code = error.statusCode || 500;
    res.status(code).json({ error: error.message });
  }
});

// POST /api/download/refresh - 刷新任务状态（检查生成中的任务，自动下载已完成的）
app.post('/api/download/refresh', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const requested = parseOptionalUserId(req.query.user_id);
    const scope = await resolveDownloadTaskScope(req.user, requested);
    const { clause: scopeClause, params: scopeParams } = scopeToTaskWhereClause(scope, 't');

    // 查找所有"生成中"或"已有 video_url 但未下载"的任务
    // 1. 找出已完成但未下载的任务（有 video_url，download_status 不是 done）
    const pendingTasks = db.prepare(`
      SELECT t.id, t.video_url, t.video_path, t.download_status
      FROM tasks t
      WHERE t.task_kind = 'output'
        AND t.video_url IS NOT NULL
        AND (t.download_status IS NULL OR t.download_status = 'pending')
        ${scopeClause}
    `).all(...scopeParams);

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
        ${scopeClause}
      ORDER BY t.created_at DESC
    `).all(...scopeParams);

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
      // 远程验证通过 → 同步账号到本地（不存在则创建；展示名来自 ModelToo user）
      syncModelTooUser(email, password, modeltooResult.remoteUser);
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

// ============================================================
// ModelToo 分组代理（MODELTOO_ADMIN_TOKEN 或 用户名密码自动登录）
// ============================================================

app.get('/api/admin/modeltoo/groups', authenticate, requireAdmin, async (req, res) => {
  try {
    if (!MODELTOO_API_URL) {
      return res.status(503).json({
        error: '未配置 MODELTOO_API_URL，请在 .env 中设置后重启服务',
      });
    }
    const items = await fetchModelTooGroups(MODELTOO_API_URL);
    res.json({ success: true, data: items });
  } catch (error) {
    console.error('[modeltoo] groups error:', error);
    // 503：本机 SD 正常，但上游 ModelToo 不可用（与 Vite 连不上后端时的 502 区分）
    res.status(503).json({
      error: error.message || '拉取 ModelToo 分组失败',
      code: 'MODELTOO_UPSTREAM',
    });
  }
});

// GET /api/modeltoo/projects-with-balance - 获取当前用户的 ModelToo 项目列表及余额
app.get('/api/modeltoo/projects-with-balance', authenticate, async (req, res) => {
  try {
    if (!MODELTOO_API_URL) {
      return res.status(503).json({
        error: '未配置 MODELTOO_API_URL，请在 .env 中设置后重启服务',
      });
    }
    if (!process.env.MODELTOO_INTERNAL_TOKEN) {
      return res.status(503).json({
        error: '未配置 MODELTOO_INTERNAL_TOKEN，请在 .env 中设置后重启服务',
      });
    }
    
    // Get current user
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: '未授权' });
    }

    // Try to get ModelToo user ID by querying ModelToo's user list
    // For now, we'll use the email as a fallback and let ModelToo handle the lookup
    // In a production system, we should have a proper user mapping
    const items = await getProjectsWithBalance(user.email);
    res.json({ items });
  } catch (error) {
    console.error('[modeltoo] projects-with-balance error:', error);
    res.status(503).json({
      error: error.message || '获取 ModelToo 项目列表失败',
      code: 'MODELTOO_UPSTREAM',
    });
  }
});

// ============================================================
// 视频生成统计接口（基于本地 tasks 表；可选 group_id 过滤）
// ============================================================

// GET /api/admin/stats/generation - 获取生成统计汇总 + 用户列表
app.get('/api/admin/stats/generation', authenticate, requireAdmin, async (req, res) => {
  try {
    const days = parseStatsDays(req.query);
    let filterUserIds = null;
    let groupMeta = null;
    const groupId = String(req.query.group_id || '').trim();
    if (groupId) {
      const resolved = await resolveFilterUserIdsFromModelTooGroup(groupId);
      filterUserIds = resolved.userIds;
      groupMeta = {
        groupId,
        modelTooMemberCount: resolved.modelTooMemberCount,
        matchedLocalUsers: resolved.userIds.length,
      };
    }

    const summary = statsService.getGlobalGenerationSummary(days, filterUserIds);
    const userStats = statsService.getUserGenerationStats(days, filterUserIds);

    res.json({
      success: true,
      data: {
        summary,
        users: userStats,
        groupFilter: groupMeta,
      },
    });
  } catch (error) {
    console.error('[stats] generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/stats/error-distribution - 获取失败原因分布（A 阶段）
app.get('/api/admin/stats/error-distribution', authenticate, requireAdmin, async (req, res) => {
  try {
    const days = parseStatsDays(req.query);
    let filterUserIds = null;
    const groupId = String(req.query.group_id || '').trim();
    if (groupId) {
      const resolved = await resolveFilterUserIdsFromModelTooGroup(groupId);
      filterUserIds = resolved.userIds;
    }

    const distribution = statsService.getErrorDistribution(days, filterUserIds);
    res.json({ success: true, data: distribution });
  } catch (error) {
    console.error('[stats] error-distribution error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/users - 管理员直接创建用户 (跳过邮箱验证码)
app.post('/api/admin/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const { email, password, role, credits, status, displayName, display_name } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: '邮箱和密码不能为空' });
    }
    const user = authService.createUserByAdmin(email, password, {
      role,
      credits,
      status,
      displayName: displayName ?? display_name,
    });
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
function resumePendingVideoTasks() {
  try {
    const db = getDatabase();
    const pending = db.prepare(`
      SELECT id, prompt, submit_id, video_provider, mt_project_id, mt_idempotency_key, user_id FROM tasks
      WHERE status = 'generating' AND submit_id IS NOT NULL AND (video_url IS NULL OR video_url = '')
    `).all();

    if (pending.length === 0) return;

    console.log(`[resume] 发现 ${pending.length} 个未完成的视频任务, 尝试恢复轮询...`);

    for (const t of pending) {
      const provider = t.video_provider || 'ark';
      pollVideoUntilDone({
        provider,
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
        const totalTokens = extractTotalTokensFromResult(result);
        const completionTokens = extractCompletionTokensFromResult(result);
        const resumeModelId = normalizeModelId(
          settingsService.getSetting('model') ||
            (provider === 'luminia' ? 'luminia-2.0' : 'doubao-seedance-2-0-260128'),
        );
        const taskResolution = t.resolution || settingsService.getSetting('resolution') || '720p';
        const { cost, unitPrice, pricingUnit, provider: pricingProvider } = calculateCostFromTokens(
          totalTokens,
          resumeModelId,
          { resolution: taskResolution, hasVideoInput: false },
        );

        taskService.updateTaskStatus(t.id, 'done', {
          video_url: result.videoUrl,
          history_id: result.historyId || t.submit_id,
          item_id: result.itemId || t.submit_id,
          progress: '',
          error_message: null,
          revised_prompt: result.revisedPrompt || null,
          total_tokens: totalTokens,
          completion_tokens: completionTokens,
          cost: cost,
          unit_price: unitPrice,
        });
        schedulePersistGeneratedVideo(t.id, result.videoUrl);
        console.log(`[resume][task ${t.id}] ✅ 恢复完成: ${result.videoUrl}`);

        // 结算：按实际费用扣一次（allow_negative=true）
        if (cost !== null && cost > 0 && t.mt_project_id && t.mt_idempotency_key) {
          (async () => {
            try {
              // 通过 user_id 查 email 作为扣费 user_id
              const userRow = db.prepare('SELECT email FROM users WHERE id = ?').get(t.user_id);
              const userEmail = userRow?.email;
              if (!userEmail) {
                console.warn(`[resume][task ${t.id}] 找不到用户 email，跳过结算`);
                return;
              }
              const settleResult = await consumeBudget({
                projectId: t.mt_project_id,
                amount: cost,
                idempotencyKey: t.mt_idempotency_key,
                userId: userEmail,
                actorUserId: userEmail,
                source: 'sd',
                metadata: {
                  task_id: t.id,
                  model: resumeModelId,
                  total_tokens: totalTokens,
                  unit_price: unitPrice,
                  pricing_unit: pricingUnit,
                  provider: pricingProvider,
                  resumed: true,
                },
                allowNegative: true,
              });
              console.log(`[resume][task ${t.id}] 结算扣费成功: ${cost}, 余额: ${settleResult.balance}`);
            } catch (settleError) {
              console.error(`[resume][task ${t.id}] 结算扣费失败:`, settleError.message);
            }
          })();
        }
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
  const maskKey = (envName) => {
    const k = process.env[envName] || '';
    if (!k) return '未配置';
    return k.length > 6 ? `已配置 (...${k.slice(-6)})` : '已配置';
  };
  console.log(`\n🚀 服务器已启动: http://localhost:${PORT}`);
  console.log(`🔗 方舟官方 API : https://ark.cn-beijing.volces.com/api/v3`);
  console.log(`🔑 ARK_API_KEY    : ${maskKey('ARK_API_KEY')}`);
  console.log(`🔗 Luminia API    : ${process.env.LUMINIA_API_BASE_URL || 'https://luapi.hagoot.com'}`);
  console.log(`🔑 LUMINIA_API_KEY: ${maskKey('LUMINIA_API_KEY')}`);
  const intTok = (process.env.STUDIO_INTEGRATION_TOKEN || '').trim();
  const intMail = (process.env.STUDIO_INTEGRATION_USER_EMAIL || '').trim();
  if (intTok) {
    console.log(
      `🔌 Studio 集成    : 已启用（${intMail ? 'STUDIO_INTEGRATION_USER_EMAIL 已配置' : '⚠️ 缺少 STUDIO_INTEGRATION_USER_EMAIL，Bearer 匹配后将 500'}）`
    );
  } else {
    console.log('🔌 Studio 集成    : 未启用 — 未读到 STUDIO_INTEGRATION_TOKEN（小云雀代提交视频将 401）');
  }
  console.log(`📁 运行模式    : ${process.env.NODE_ENV === 'production' ? '生产' : '开发'}\n`);

  // 启动后清理已过期的 TOS 文件缓存；先清扫僵尸 generating，再恢复方舟轮询
  try {
    const removed = cleanupExpiredTosCache();
    if (removed > 0) console.log(`[tos-cache] 启动清理: 删除过期记录 ${removed} 条`);
  } catch (err) {
    console.warn('[tos-cache] 启动清理失败:', err.message);
  }
  try {
    const r = taskService.sweepStaleGeneratingTasks();
    if (r.marked > 0) {
      console.warn(`[sweep-stale-generating] 启动时已将 ${r.marked} 条超时 generating 标为 error（共检查 ${r.checked} 条）`);
    }
  } catch (err) {
    console.warn('[sweep-stale-generating] 启动清扫失败:', err.message);
  }
  resumePendingVideoTasks();

  const sweepIntervalMs = Math.max(
    60_000,
    Number(process.env.STALE_GENERATING_SWEEP_INTERVAL_MS || 10 * 60 * 1000) || 10 * 60 * 1000,
  );
  setInterval(() => {
    try {
      taskService.sweepStaleGeneratingTasks();
    } catch (e) {
      console.warn('[sweep-stale-generating] 定时清扫失败:', e.message);
    }
  }, sweepIntervalMs).unref();
});
