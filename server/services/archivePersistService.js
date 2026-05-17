/**
 * 任务归档 HTML → TOS_PERSIST_BUCKET（与成片持久化同桶）
 * 配置持久桶且未关闭时不再落盘 data/archives，仅保留库内 key + canonical URL。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  isTosPersistConfigured,
  getTosPersistBucket,
  persistKeyPrefix,
  buildCanonicalPersistObjectUrl,
  putPersistObject,
  getPersistObjectV2,
} from './tosUploader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = path.join(__dirname, '../../data/archives');

function parseBoolEnv(name, defaultValue = true) {
  const v = (process.env[name] || '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  return defaultValue;
}

export function isArchivePersistEnabled() {
  if (!isTosPersistConfigured()) return false;
  return parseBoolEnv('ARCHIVE_PERSIST_ENABLED', true);
}

export function buildArchivePersistObjectKey(taskId) {
  const prefix = persistKeyPrefix().replace(/^\/+|\/+$/g, '');
  return `${prefix}/archives/task-${taskId}.html`;
}

function ensureArchiveDir() {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
}

function localArchivePath(taskId) {
  return path.join(ARCHIVE_DIR, `${taskId}.html`);
}

function removeLocalArchiveIfExists(taskId) {
  const p = localArchivePath(taskId);
  if (fs.existsSync(p)) {
    try {
      fs.unlinkSync(p);
      console.log(`[archive-persist] 已删除本地归档 task=${taskId}`);
    } catch (e) {
      console.warn(`[archive-persist] 删除本地归档失败 task=${taskId}:`, e.message);
    }
  }
}

/**
 * @returns {{ persist_archive_key?: string, persist_archive_tos_url?: string, archive_path: string, size: number }}
 */
export async function saveTaskArchiveHtml(taskId, html) {
  const text = typeof html === 'string' ? html : '';
  if (text.length < 20) {
    throw new Error('归档内容为空');
  }

  if (isArchivePersistEnabled()) {
    const key = buildArchivePersistObjectKey(taskId);
    const bucket = getTosPersistBucket();
    const body = Buffer.from(text, 'utf-8');

    await putPersistObject({
      key,
      body,
      contentType: 'text/html; charset=utf-8',
    });

    const canonicalUrl = buildCanonicalPersistObjectUrl(key);
    removeLocalArchiveIfExists(taskId);

    console.log(
      `[archive-persist] task=${taskId} 已上传 TOS bucket=${bucket} key=${key} (${(body.length / 1024).toFixed(1)} KB)`,
    );

    return {
      persist_archive_key: key,
      persist_archive_tos_url: canonicalUrl,
      archive_path: canonicalUrl,
      size: body.length,
    };
  }

  ensureArchiveDir();
  const filePath = localArchivePath(taskId);
  fs.writeFileSync(filePath, text, 'utf-8');
  console.log(`[archive] task ${taskId} 归档已保存本地 (${(text.length / 1024).toFixed(1)} KB) → ${filePath}`);

  return {
    archive_path: filePath,
    size: text.length,
  };
}

export function taskHasStoredArchive(task) {
  if (!task) return false;
  if (String(task.persist_archive_key || '').trim()) return true;
  const ap = String(task.archive_path || '').trim();
  if (!ap) return false;
  if (ap.startsWith('http://') || ap.startsWith('https://')) {
    // 落 TOS 后 archive_path 常为 canonical URL，须配合 persist_archive_key 读取
    return false;
  }
  return fs.existsSync(ap);
}

async function readPersistStreamToBuffer(content) {
  if (!content) {
    throw new Error('TOS 对象无内容');
  }
  const chunks = [];
  if (typeof content[Symbol.asyncIterator] === 'function') {
    for await (const chunk of content) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } else if (Buffer.isBuffer(content)) {
    chunks.push(content);
  } else if (typeof content.read === 'function') {
    let chunk;
    while ((chunk = content.read()) !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } else {
    chunks.push(Buffer.from(await content));
  }
  return Buffer.concat(chunks);
}

/**
 * 将归档 HTML 写入 HTTP 响应（TOS 优先，本地兜底）
 */
export async function pipeTaskArchiveHtml(task, res) {
  const key = String(task.persist_archive_key || '').trim();
  if (key && isTosPersistConfigured()) {
    const result = await getPersistObjectV2(key);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const buf = await readPersistStreamToBuffer(result?.data?.content);
    res.end(buf);
    return;
  }

  const ap = String(task.archive_path || '').trim();
  if (!ap || !fs.existsSync(ap)) {
    const err = new Error('归档不存在');
    err.statusCode = 404;
    throw err;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  fs.createReadStream(ap).pipe(res);
}
