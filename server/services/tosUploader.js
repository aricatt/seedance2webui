/**
 * TOS (火山引擎对象存储) 上传服务
 *
 * 职责:
 *  1. 将视频 / 音频文件上传到 TOS 私有桶;
 *  2. 生成带时效的预签名 URL, 供方舟 Content Generation API 下载素材;
 *  3. 按文件 SHA-256 去重, 命中缓存 (在有效期内) 则直接复用 URL;
 *
 * 为什么不用 Files API?
 *  Files API 是为 Responses API (多模态理解) 设计的,
 *  Content Generation API (视频生成) 不支持 file_id, 只认公网 HTTPS URL.
 */

import { TosClient } from '@volcengine/tos-sdk';
import crypto from 'crypto';
import path from 'path';
import { readFileSync, statSync } from 'fs';
import { getDatabase } from '../database/index.js';

// ============================================================
// 配置
// ============================================================

function getTosConfig() {
  return {
    accessKeyId: process.env.TOS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.TOS_SECRET_ACCESS_KEY || '',
    region: process.env.TOS_REGION || 'cn-guangzhou',
    endpoint: process.env.TOS_ENDPOINT || 'tos-cn-guangzhou.volces.com',
    bucket: process.env.TOS_BUCKET || 'seedance-cache',
  };
}

let _tosClient = null;

function getTosClient() {
  if (_tosClient) return _tosClient;
  const cfg = getTosConfig();
  if (!cfg.accessKeyId || !cfg.secretAccessKey) {
    throw new Error('TOS 配置缺失: 请在 .env 中设置 TOS_ACCESS_KEY_ID 和 TOS_SECRET_ACCESS_KEY');
  }
  // TOS SDK 的 endpoint 不带 https:// 前缀, SDK 内部自动处理
  const endpoint = cfg.endpoint.replace(/^https?:\/\//, '');
  _tosClient = new TosClient({
    accessKeyId: cfg.accessKeyId,
    accessKeySecret: cfg.secretAccessKey,
    region: cfg.region,
    endpoint: endpoint,
    secure: true,
    requestTimeout: 120000,   // 请求超时 120 秒 (大文件上传需要时间)
    connectionTimeout: 30000, // 连接超时 30 秒
  });
  return _tosClient;
}

// ============================================================
// 工具函数
// ============================================================

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

const EXT_MIME_MAP = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
};

export function guessMimeType(filename, fallback = 'application/octet-stream') {
  const ext = (String(filename || '').split('.').pop() || '').toLowerCase();
  return EXT_MIME_MAP[ext] || fallback;
}

// ============================================================
// 缓存层 (SQLite) — 复用 ark_file_cache 或新建 tos_file_cache
// ============================================================

/** 预签名 URL 有效期 (秒). 设为 1 小时, 方舟下载绰绰有余. */
const PRESIGN_EXPIRY_SEC = 3600;

/** 本地缓存的安全边际: URL 即将过期前 10 分钟就当过期 */
const CACHE_SAFETY_MARGIN_SEC = 600;

/** TOS 对象在桶里的存活时间, 1 天后由生命周期规则自动清理 */
const TOS_OBJECT_TTL_SEC = 1 * 24 * 3600;

function ensureTosTableExists() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS tos_file_cache (
      content_hash TEXT PRIMARY KEY,
      tos_key TEXT NOT NULL,
      filename TEXT,
      mime_type TEXT,
      bytes INTEGER DEFAULT 0,
      uploaded_at INTEGER NOT NULL,
      tos_expires_at INTEGER NOT NULL
    )
  `);
}

let _tableReady = false;
function ensureTable() {
  if (!_tableReady) {
    ensureTosTableExists();
    _tableReady = true;
  }
}

function selectCacheByHash(hash) {
  ensureTable();
  const db = getDatabase();
  return db.prepare('SELECT * FROM tos_file_cache WHERE content_hash = ?').get(hash);
}

function upsertCache({ hash, tosKey, filename, mimeType, bytes, tosExpiresAt }) {
  ensureTable();
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO tos_file_cache (content_hash, tos_key, filename, mime_type, bytes, uploaded_at, tos_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_hash) DO UPDATE SET
      tos_key = excluded.tos_key,
      filename = excluded.filename,
      mime_type = excluded.mime_type,
      bytes = excluded.bytes,
      uploaded_at = excluded.uploaded_at,
      tos_expires_at = excluded.tos_expires_at
  `);
  stmt.run(hash, tosKey, filename || null, mimeType || null, bytes || 0, nowSec(), tosExpiresAt);
}

function isCacheFresh(row) {
  if (!row) return false;
  // TOS 对象还没过期 (留安全边际)
  return Number(row.tos_expires_at) - nowSec() > CACHE_SAFETY_MARGIN_SEC;
}

/**
 * HEAD 请求检查 TOS 对象是否真实存在
 * @param {string} tosKey
 * @returns {Promise<boolean>}
 */
async function checkTosObjectExists(tosKey) {
  try {
    const client = getTosClient();
    const cfg = getTosConfig();
    await client.headObject({
      bucket: cfg.bucket,
      key: tosKey,
    });
    return true;
  } catch (err) {
    // 404 或其他错误都视为不存在
    console.log(`[tos] HEAD 检查: ${tosKey} → 不存在或已过期 (${err.statusCode || err.message})`);
    return false;
  }
}

/**
 * 清理过期缓存记录
 */
export function cleanupExpiredTosCache() {
  ensureTable();
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM tos_file_cache WHERE tos_expires_at <= ?');
  const res = stmt.run(nowSec());
  return res.changes || 0;
}

// ============================================================
// TOS 上传 + 预签名 URL
// ============================================================

/**
 * 上传 buffer 到 TOS
 * @param {Buffer} buffer 文件内容
 * @param {string} filename 文件名
 * @param {string} [mimeType] MIME 类型
 * @returns {Promise<{tosKey: string, tosExpiresAt: number}>}
 */
async function uploadToTos(buffer, filename, mimeType) {
  const client = getTosClient();
  const cfg = getTosConfig();

  const ext = path.extname(filename) || '';
  const ts = Date.now();
  const hash = sha256Hex(buffer).slice(0, 12);
  const tosKey = `seedance/${ts}-${hash}${ext}`;

  const mime = mimeType || guessMimeType(filename);
  const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);

  console.log(`[tos] 开始上传: ${tosKey} (${sizeMB} MB, mime=${mime}, bucket=${cfg.bucket})`);

  try {
    await client.putObject({
      bucket: cfg.bucket,
      key: tosKey,
      body: buffer,
      contentType: mime,
    });
  } catch (err) {
    console.error(`[tos] 上传失败: ${err.message}`);
    console.error(`[tos]   endpoint: ${cfg.endpoint}, bucket: ${cfg.bucket}, key: ${tosKey}`);
    console.error(`[tos]   文件大小: ${sizeMB} MB`);
    throw err;
  }

  const tosExpiresAt = nowSec() + TOS_OBJECT_TTL_SEC;
  console.log(`[tos] 上传成功: ${tosKey} (${sizeMB} MB)`);
  return { tosKey, tosExpiresAt };
}

/**
 * 为 TOS 对象生成预签名 URL
 * @param {string} tosKey 对象 key
 * @param {number} [expirySec] URL 有效期 (秒), 默认 1 小时
 * @returns {Promise<string>} 预签名 HTTPS URL
 */
async function getPresignedUrl(tosKey, expirySec = PRESIGN_EXPIRY_SEC) {
  const client = getTosClient();
  const cfg = getTosConfig();

  const result = await client.getPreSignedUrl({
    bucket: cfg.bucket,
    key: tosKey,
    expires: expirySec,
  });

  return result;
}

// ============================================================
// 对外主入口: 命中缓存 / 否则上传, 返回预签名 URL
// ============================================================

/**
 * 获取或上传文件到 TOS, 返回预签名 URL.
 *
 * @param {Buffer} buffer 文件内容
 * @param {object} opts
 * @param {string} opts.filename 文件名
 * @param {string} [opts.mimeType] MIME 类型
 * @param {function} [opts.onProgress] 进度回调
 * @returns {Promise<{url: string, tosKey: string, fromCache: boolean}>}
 */
export async function getOrUploadToTos(buffer, opts = {}) {
  const hash = sha256Hex(buffer);
  const cached = selectCacheByHash(hash);

  if (isCacheFresh(cached)) {
    // 本地缓存未过期, 但还要 HEAD 请求确认 TOS 上的文件真实存在
    const exists = await checkTosObjectExists(cached.tos_key);
    if (exists) {
      if (opts.onProgress) opts.onProgress('cache_hit', { tosKey: cached.tos_key });
      const url = await getPresignedUrl(cached.tos_key);
      return { url, tosKey: cached.tos_key, fromCache: true };
    }
    // TOS 上已不存在, 清掉本地缓存, 重新上传
    console.log(`[tos] 缓存记录存在但 TOS 对象已失效, 重新上传: ${cached.tos_key}`);
  }

  // 上传
  if (opts.onProgress) opts.onProgress('uploading', { filename: opts.filename });
  const { tosKey, tosExpiresAt } = await uploadToTos(
    buffer,
    opts.filename || `upload-${Date.now()}`,
    opts.mimeType
  );

  // 写缓存
  upsertCache({
    hash,
    tosKey,
    filename: opts.filename || null,
    mimeType: opts.mimeType || guessMimeType(opts.filename || ''),
    bytes: buffer.length,
    tosExpiresAt,
  });

  if (opts.onProgress) opts.onProgress('uploaded', { tosKey });

  // 生成预签名 URL
  const url = await getPresignedUrl(tosKey);
  return { url, tosKey, fromCache: false };
}

/**
 * 从磁盘文件路径上传到 TOS
 */
export async function getOrUploadToTosByPath(filePath, opts = {}) {
  const buffer = readFileSync(filePath);
  const filename = opts.filename || path.basename(filePath);
  const mimeType = opts.mimeType || guessMimeType(filename);
  return getOrUploadToTos(buffer, { ...opts, filename, mimeType });
}

/**
 * 检查 TOS 是否已配置
 */
export function isTosConfigured() {
  const cfg = getTosConfig();
  return !!(cfg.accessKeyId && cfg.secretAccessKey && cfg.bucket);
}

export default {
  getOrUploadToTos,
  getOrUploadToTosByPath,
  cleanupExpiredTosCache,
  isTosConfigured,
  guessMimeType,
  sha256Hex,
};
