/**
 * 方舟文件上传服务
 *
 * 职责:
 *  1. 将本地文件 (图片 / 视频 / 音频) 上传到方舟官方 /api/v3/files 接口;
 *  2. 按文件 SHA-256 去重, 命中缓存 (在有效期内) 则直接复用 file_id;
 *  3. 缓存记录过期后自动失效, 下次自动重新上传.
 *
 * 生成任务中的 content 数组里, image_url / video_url / audio_url 字段的
 * "url" 位置可以直接填 "file-xxx" (即此接口返回的 file_id), 见官方示例文档.
 */

import crypto from 'crypto';
import { readFileSync, statSync } from 'fs';
import path from 'path';
import { getDatabase } from '../database/index.js';
import { ARK_API_BASE_URL, getArkApiKey } from './arkConfig.js';

// ============================================================
// MIME 推断
// ============================================================

const EXT_MIME_MAP = {
  // 图片
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  // 视频
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  // 音频
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
};

export function guessMimeType(filename, fallback = 'application/octet-stream') {
  const ext = (String(filename || '').split('.').pop() || '').toLowerCase();
  return EXT_MIME_MAP[ext] || fallback;
}

export function classifyMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'other';
}

// ============================================================
// 缓存层 (SQLite)
// ============================================================

/**
 * 过期前多少秒就当作已过期 (安全边际, 避免在即将过期时提交给 Ark 被拒).
 */
const EXPIRE_SAFETY_MARGIN_SEC = 60 * 60; // 1 小时

/**
 * 对 Ark 返回的 expire_at 再打折存入本地 DB.
 * 原则: 最大化 API 使用效率, 但宁可重新上传也不踩即将过期的 file_id.
 * 例如 Ark 返回 7 天有效, 我们只认 3.5 天. 若本地记录已过期, 下次自动重新上传.
 */
const LOCAL_EXPIRE_DISCOUNT = 0.5;

function discountExpireAt(arkExpireAt) {
  const now = nowSec();
  const remaining = Math.max(0, Number(arkExpireAt) - now);
  // 若 Ark 返回明显异常 (剩余 <= 0), 直接记成现在, 触发下次重新上传.
  if (remaining <= 0) return now;
  return now + Math.floor(remaining * LOCAL_EXPIRE_DISCOUNT);
}

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function selectCacheByHash(hash) {
  const db = getDatabase();
  return db.prepare('SELECT * FROM ark_file_cache WHERE content_hash = ?').get(hash);
}

function upsertCache({ hash, fileId, filename, mimeType, bytes, purpose, expiresAt }) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO ark_file_cache (content_hash, file_id, filename, mime_type, bytes, purpose, uploaded_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_hash) DO UPDATE SET
      file_id = excluded.file_id,
      filename = excluded.filename,
      mime_type = excluded.mime_type,
      bytes = excluded.bytes,
      purpose = excluded.purpose,
      uploaded_at = excluded.uploaded_at,
      expires_at = excluded.expires_at
  `);
  stmt.run(
    hash,
    fileId,
    filename || null,
    mimeType || null,
    bytes || 0,
    purpose || 'user_data',
    nowSec(),
    Number(expiresAt) || nowSec() + 24 * 3600
  );
}

function isCacheFresh(row) {
  if (!row) return false;
  return Number(row.expires_at) - nowSec() > EXPIRE_SAFETY_MARGIN_SEC;
}

/**
 * 清理过期或即将过期的缓存记录 (定期/启动调用).
 */
export function cleanupExpiredCache() {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM ark_file_cache WHERE expires_at <= ?');
  const res = stmt.run(nowSec());
  return res.changes || 0;
}

// ============================================================
// HTTP: 上传到方舟
// ============================================================

/**
 * 上传文件到方舟 /api/v3/files
 *
 * @param {object} opts
 * @param {Buffer} opts.buffer           文件字节
 * @param {string} opts.filename         文件名 (含扩展名)
 * @param {string} [opts.mimeType]       MIME, 缺省根据扩展名推断
 * @param {string} [opts.purpose='user_data']
 * @param {object} [opts.preprocessConfigs]  例如 { video: { fps: 0.3 } }
 * @param {string} [opts.apiKey]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeout=120000]
 * @returns {Promise<{fileId:string,expireAt:number,mimeType:string,bytes:number,raw:object}>}
 */
export async function uploadArkFile({
  buffer,
  filename,
  mimeType,
  purpose = 'user_data',
  preprocessConfigs,
  apiKey = getArkApiKey(),
  baseUrl = ARK_API_BASE_URL,
  timeout = 120000,
}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('uploadArkFile: buffer 不能为空');
  }
  const safeName = filename || `upload-${Date.now()}`;
  const mime = mimeType || guessMimeType(safeName);

  // Node 18+ 原生 FormData / Blob
  const form = new FormData();
  const blob = new Blob([buffer], { type: mime });
  form.append('file', blob, safeName);
  form.append('purpose', purpose);

  if (preprocessConfigs && typeof preprocessConfigs === 'object') {
    // 按 Ark 文档的 multipart key 格式: preprocess_configs[video][fps]=0.3
    for (const [group, cfg] of Object.entries(preprocessConfigs)) {
      if (!cfg || typeof cfg !== 'object') continue;
      for (const [k, v] of Object.entries(cfg)) {
        form.append(`preprocess_configs[${group}][${k}]`, String(v));
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!res.ok) {
    const message = data?.error?.message || data?.message || `HTTP ${res.status}`;
    const err = new Error(`方舟文件上传失败: ${message}`);
    err.status = res.status;
    err.response = data;
    throw err;
  }

  const fileId = data?.id;
  if (!fileId || !String(fileId).startsWith('file-')) {
    throw new Error(`方舟文件上传响应缺少 file_id: ${JSON.stringify(data).slice(0, 200)}`);
  }

  return {
    fileId,
    expireAt: Number(data?.expire_at) || nowSec() + 7 * 24 * 3600,
    mimeType: data?.mime_type || mime,
    bytes: Number(data?.bytes) || buffer.length,
    status: data?.status || 'processing',
    raw: data,
  };
}

/**
 * 检索文件状态 (GET /api/v3/files/:id)
 */
export async function retrieveArkFile(fileId, { apiKey = getArkApiKey(), baseUrl = ARK_API_BASE_URL } = {}) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/files/${fileId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`方舟文件检索失败 (${fileId}): ${data?.error?.message || res.status}`);
  }
  return data;
}

/**
 * 等待文件变为 active 状态.
 * Files API 上传后 status='processing', 需要轮询直到变为 'active'.
 *
 * @param {string} fileId
 * @param {object} [opts]
 * @param {number} [opts.maxWaitMs=30000]     最长等待毫秒
 * @param {number} [opts.pollIntervalMs=1500] 轮询间隔
 * @param {function} [opts.onPoll]            每次轮询回调 (status, elapsed)
 * @returns {Promise<object>} 文件信息对象
 */
export async function waitForActive(fileId, {
  apiKey,
  baseUrl,
  maxWaitMs = 30000,
  pollIntervalMs = 1500,
  onPoll,
} = {}) {
  const start = Date.now();
  while (true) {
    const info = await retrieveArkFile(fileId, { apiKey, baseUrl });
    const elapsed = Date.now() - start;
    if (onPoll) onPoll(info.status, elapsed, info);

    if (info.status === 'active') {
      return info;
    }
    if (info.status === 'error' || info.status === 'failed') {
      throw new Error(`方舟文件处理失败 (${fileId}): status=${info.status}`);
    }
    if (elapsed >= maxWaitMs) {
      throw new Error(`方舟文件等待超时 (${fileId}): 已等待 ${(elapsed / 1000).toFixed(1)}s, status=${info.status}`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

// ============================================================
// 对外主入口: 命中缓存 / 否则上传
// ============================================================

/**
 * 根据文件内容 (buffer) 获取或上传到方舟, 返回 file_id.
 * 新上传的文件会等待状态变为 active 后再返回.
 *
 * @param {Buffer} buffer
 * @param {object} opts 参见 uploadArkFile
 * @param {function} [opts.onProgress] 上传进度回调 (stage, detail)
 * @returns {Promise<{fileId:string,expireAt:number,mimeType:string,bytes:number,fromCache:boolean}>}
 */
export async function getOrUploadArkFile(buffer, opts = {}) {
  const hash = sha256Hex(buffer);
  const cached = selectCacheByHash(hash);
  if (isCacheFresh(cached)) {
    if (opts.onProgress) opts.onProgress('cache_hit', { fileId: cached.file_id });
    return {
      fileId: cached.file_id,
      expireAt: Number(cached.expires_at),
      mimeType: cached.mime_type,
      bytes: Number(cached.bytes),
      fromCache: true,
    };
  }

  // 上传
  if (opts.onProgress) opts.onProgress('uploading', { filename: opts.filename });
  const result = await uploadArkFile({ buffer, ...opts });

  // 等待文件变为 active
  if (opts.onProgress) opts.onProgress('processing', { fileId: result.fileId });
  await waitForActive(result.fileId, {
    maxWaitMs: 60000,
    pollIntervalMs: 1500,
    onPoll: (status, elapsed) => {
      if (opts.onProgress) opts.onProgress('processing', { fileId: result.fileId, status, elapsed });
    },
  });

  const localExpireAt = discountExpireAt(result.expireAt);
  upsertCache({
    hash,
    fileId: result.fileId,
    filename: opts.filename || null,
    mimeType: result.mimeType,
    bytes: result.bytes,
    purpose: opts.purpose || 'user_data',
    expiresAt: localExpireAt,
  });
  console.log(
    `[ark-file-cache] uploaded & active: ${result.fileId} (${result.bytes}B) ` +
    `ark_expire=${new Date(result.expireAt * 1000).toISOString()} ` +
    `local_expire=${new Date(localExpireAt * 1000).toISOString()} (${LOCAL_EXPIRE_DISCOUNT * 100}%)`
  );
  if (opts.onProgress) opts.onProgress('active', { fileId: result.fileId });
  return { ...result, fromCache: false, localExpireAt };
}

/**
 * 对磁盘文件的便捷封装: 读取 -> getOrUploadArkFile.
 *
 * @param {string} filePath 绝对或相对磁盘路径
 * @param {object} [opts]
 * @returns {Promise<{fileId:string,expireAt:number,mimeType:string,bytes:number,fromCache:boolean}>}
 */
export async function getOrUploadArkFileByPath(filePath, opts = {}) {
  const buffer = readFileSync(filePath);
  const filename = opts.filename || path.basename(filePath);
  const mimeType = opts.mimeType || guessMimeType(filename);
  const stat = (() => { try { return statSync(filePath); } catch { return null; } })();
  const sizeHint = stat ? stat.size : buffer.length;
  return getOrUploadArkFile(buffer, {
    ...opts,
    filename,
    mimeType,
    _sizeHint: sizeHint,
  });
}

export default {
  uploadArkFile,
  retrieveArkFile,
  waitForActive,
  getOrUploadArkFile,
  getOrUploadArkFileByPath,
  cleanupExpiredCache,
  guessMimeType,
  classifyMime,
  sha256Hex,
};
