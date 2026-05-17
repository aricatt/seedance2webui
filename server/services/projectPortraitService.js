/**
 * 项目虚拟人像库（本地映射 + Luminia assets）
 */

import sharp from 'sharp';
import { getDatabase } from '../database/index.js';
import {
  isTosPersistConfigured,
  uploadBufferToPersistBucket,
  getPresignedUrlForPersistKey,
  getPersistObjectV2,
  persistKeyPrefix,
} from './tosUploader.js';
import { signPortraitViewTicket } from './portraitViewTicket.js';
import { guessMimeType } from './arkFileUploader.js';
import {
  createLuminiaAsset,
  deleteLuminiaAsset,
  getLuminiaAsset,
  pollLuminiaAssetUntilActive,
  normalizeLuminiaAssetStatus,
} from './luminiaAssetService.js';
import { isLuminiaApiKeyConfigured } from './luminiaConfig.js';
import { resolveProviderForModel, PROVIDERS } from '../config/modelRegistry.js';

const TERMINAL = new Set(['active', 'failed']);

function rowToPortrait(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    mtProjectId: row.mt_project_id,
    name: row.name || '',
    previewUrl: row.preview_url || '',
    luminiaAssetId: row.luminia_asset_id || '',
    /** 仅服务端用于生成同源预览 URL，不返回给前端 */
    tosPersistKey: row.tos_persist_key || '',
    status: row.status,
    errorMessage: row.error_message || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function updatePortraitRow(id, fields) {
  const db = getDatabase();
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k]);
  db.prepare(
    `UPDATE project_portraits SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(...values, id);
}

/** Luminia 拉取入库图时的预签名有效期（秒） */
const LUMINIA_INGEST_PRESIGN_SEC = 7 * 24 * 3600;

function portraitPersistKeyPrefix(mtProjectId) {
  const safe = String(mtProjectId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
  return `${persistKeyPrefix()}/portraits/${safe}`;
}

/** 列表/选人区 img 使用同源代理；浏览器不得直连 TOS 预签名 */
export function buildPortraitPreviewDisplayUrl(portrait, viewerUserId, viewerIsAdmin = false) {
  if (!portrait?.id || !portrait?.tosPersistKey || !viewerUserId) {
    return '';
  }
  const mtProjectId = String(portrait.mtProjectId || '').trim();
  if (!mtProjectId) return '';

  const ticket = signPortraitViewTicket(portrait.id, mtProjectId, viewerUserId, viewerIsAdmin);
  const qs = new URLSearchParams({
    ticket,
    mt_project_id: mtProjectId,
  });
  return `/api/portraits/${portrait.id}/preview?${qs.toString()}`;
}

function toClientPortrait(portrait) {
  if (!portrait) return portrait;
  const { tosPersistKey: _omit, ...rest } = portrait;
  return rest;
}

function enrichPortraitForViewer(portrait, viewerUserId, viewerIsAdmin) {
  if (!portrait) return portrait;
  const key = String(portrait.tosPersistKey || '').trim();
  if (key && viewerUserId) {
    const display = buildPortraitPreviewDisplayUrl(portrait, viewerUserId, viewerIsAdmin);
    if (display) {
      return toClientPortrait({ ...portrait, previewUrl: display });
    }
  }
  // 勿把 DB 里存的 TOS 预签名下发给浏览器（远程环境无法直连 volces.com）
  return toClientPortrait({ ...portrait, previewUrl: '' });
}

/** 按 ModelToo 项目列出人像（同项目成员共享，不按上传者隔离） */
export async function listPortraits({ mtProjectId, viewerUserId = null, viewerIsAdmin = false }) {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM project_portraits
    WHERE mt_project_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(String(mtProjectId));
  const portraits = rows.map(rowToPortrait);
  return portraits.map((p) => enrichPortraitForViewer(p, viewerUserId, viewerIsAdmin));
}

export function getPortraitById(id) {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM project_portraits WHERE id = ?').get(id);
  return rowToPortrait(row);
}

export async function syncPortraitStatus(portrait) {
  if (!portrait?.luminiaAssetId || TERMINAL.has(portrait.status)) {
    return portrait;
  }
  try {
    const info = await getLuminiaAsset({ id: portrait.luminiaAssetId });
    const nextStatus = info.status;
    const patch = { status: nextStatus };
    if (nextStatus === 'failed') {
      patch.error_message = info.failReason || '预处理失败';
    } else if (nextStatus === 'active') {
      patch.error_message = null;
    }
    updatePortraitRow(portrait.id, patch);
    return getPortraitById(portrait.id);
  } catch (err) {
    return portrait;
  }
}

export async function syncProcessingPortraits({
  mtProjectId,
  viewerUserId = null,
  viewerIsAdmin = false,
}) {
  const all = await listPortraits({ mtProjectId, viewerUserId, viewerIsAdmin });
  const processing = all.filter((p) => p.status === 'processing' && p.luminiaAssetId);
  for (const p of processing) {
    await syncPortraitStatus(p);
  }
  return listPortraits({ mtProjectId, viewerUserId, viewerIsAdmin });
}

export function getPortraitsForGeneration({ ids, mtProjectId }) {
  if (!ids?.length) return [];
  const db = getDatabase();
  const portraits = [];
  for (const rawId of ids) {
    const id = Number(rawId);
    if (!Number.isFinite(id)) continue;
    const row = db.prepare(`
      SELECT * FROM project_portraits
      WHERE id = ? AND mt_project_id = ?
    `).get(id, String(mtProjectId));
    const p = rowToPortrait(row);
    if (!p) throw new Error(`人像 #${id} 不存在或不属于当前项目`);
    if (p.status !== 'active') {
      throw new Error(`人像「${p.name || id}」尚未就绪（状态: ${p.status}）`);
    }
    if (!p.luminiaAssetId) {
      throw new Error(`人像「${p.name || id}」缺少 luminia_asset_id`);
    }
    portraits.push(p);
  }
  return portraits;
}

export function buildPortraitAssetUrls(portraits) {
  return portraits.map((p) => `asset://${p.luminiaAssetId}`);
}

function assertPortraitInProject(id, mtProjectId) {
  const portrait = getPortraitById(id);
  if (!portrait || String(portrait.mtProjectId) !== String(mtProjectId)) {
    const err = new Error('人像不存在或不属于当前项目');
    err.statusCode = 404;
    throw err;
  }
  if (!portrait.tosPersistKey) {
    const err = new Error('人像预览尚未就绪');
    err.statusCode = 404;
    throw err;
  }
  return portrait;
}

async function readPortraitObjectBuffer(tosPersistKey) {
  const result = await getPersistObjectV2(tosPersistKey);
  const content = result?.data?.content;
  if (!content) {
    throw new Error('无法读取人像对象');
  }

  const chunks = [];
  if (typeof content[Symbol.asyncIterator] === 'function') {
    for await (const chunk of content) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } else if (Buffer.isBuffer(content)) {
    chunks.push(content);
  } else {
    chunks.push(Buffer.from(await content));
  }
  return Buffer.concat(chunks);
}

async function resizePortraitBuffer(raw, { maxSide, format }) {
  const pipeline = sharp(raw).resize(maxSide, maxSide, {
    fit: 'inside',
    withoutEnlargement: true,
  });
  if (format === 'webp') {
    return pipeline.webp({ quality: 80 }).toBuffer();
  }
  return pipeline.jpeg({ quality: 75 }).toBuffer();
}

/** 列表/选人区预览：服务端拉图并缩放，浏览器只访问同源 /api/portraits/:id/preview */
export async function getPortraitListPreviewBuffer({ id, mtProjectId }) {
  const portrait = assertPortraitInProject(id, mtProjectId);
  const raw = await readPortraitObjectBuffer(portrait.tosPersistKey);
  return resizePortraitBuffer(raw, { maxSide: 128, format: 'webp' });
}

/** 任务归档用：从持久桶读取人像并压成 JPEG（与 archiveService 320px 一致） */
export async function getPortraitArchiveThumbBuffer({ id, mtProjectId }) {
  const portrait = assertPortraitInProject(id, mtProjectId);
  const raw = await readPortraitObjectBuffer(portrait.tosPersistKey);
  return resizePortraitBuffer(raw, { maxSide: 320, format: 'jpeg' });
}

export async function registerPortraitFromUpload({
  userId,
  mtProjectId,
  name,
  buffer,
  filename,
  mimeType,
}) {
  if (!isLuminiaApiKeyConfigured()) {
    throw new Error('LUMINIA_API_KEY 未配置，无法入库虚拟人像');
  }
  if (!isTosPersistConfigured()) {
    throw new Error('TOS_PERSIST_BUCKET 未配置，人像库需要持久桶存储预览图');
  }

  const db = getDatabase();
  const insert = db.prepare(`
    INSERT INTO project_portraits (user_id, mt_project_id, name, status)
    VALUES (?, ?, ?, 'uploading')
  `);
  const result = insert.run(userId, String(mtProjectId), name || filename || '未命名人像');
  const portraitId = result.lastInsertRowid;

  try {
    const { key: tosPersistKey } = await uploadBufferToPersistBucket(buffer, {
      filename: filename || 'portrait.jpg',
      mimeType: mimeType || guessMimeType(filename),
      keyPrefix: portraitPersistKeyPrefix(mtProjectId),
    });
    const previewUrl = await getPresignedUrlForPersistKey(tosPersistKey);
    const luminiaIngestUrl = await getPresignedUrlForPersistKey(
      tosPersistKey,
      LUMINIA_INGEST_PRESIGN_SEC
    );
    updatePortraitRow(portraitId, {
      preview_url: previewUrl,
      tos_persist_key: tosPersistKey,
      status: 'registering',
    });

    const created = await createLuminiaAsset({
      url: luminiaIngestUrl,
      name: name || filename || '',
    });
    updatePortraitRow(portraitId, {
      luminia_asset_id: created.id,
      status: 'processing',
    });

    pollLuminiaAssetUntilActive({
      id: created.id,
      timeoutMs: 180000,
      intervalMs: 5000,
    })
      .then(() => {
        updatePortraitRow(portraitId, { status: 'active', error_message: null });
      })
      .catch((err) => {
        updatePortraitRow(portraitId, {
          status: 'failed',
          error_message: err.message || '预处理失败',
        });
      });

    return getPortraitById(portraitId);
  } catch (err) {
    updatePortraitRow(portraitId, {
      status: 'failed',
      error_message: err.message || '入库失败',
    });
    throw err;
  }
}

export async function deletePortrait({ id, mtProjectId }) {
  const portrait = getPortraitById(id);
  if (!portrait || portrait.mtProjectId !== String(mtProjectId)) {
    throw new Error('人像不存在或不属于当前项目');
  }
  if (portrait.luminiaAssetId) {
    try {
      await deleteLuminiaAsset({ id: portrait.luminiaAssetId });
    } catch (err) {
      console.warn(`[portrait] Luminia 删除素材失败 id=${portrait.luminiaAssetId}:`, err.message);
    }
  }
  const db = getDatabase();
  db.prepare('DELETE FROM project_portraits WHERE id = ?').run(id);
  return { success: true };
}

export function assertPortraitsAllowedForModel(modelId) {
  const provider = resolveProviderForModel(modelId);
  if (provider !== PROVIDERS.LUMINIA) {
    throw new Error('虚拟人像库仅支持 Luminia 模型（luminia-2.0 / luminia-2.0-fast）');
  }
}

export default {
  listPortraits,
  getPortraitById,
  syncProcessingPortraits,
  getPortraitsForGeneration,
  buildPortraitAssetUrls,
  buildPortraitPreviewDisplayUrl,
  enrichPortraitForViewer,
  getPortraitListPreviewBuffer,
  getPortraitArchiveThumbBuffer,
  registerPortraitFromUpload,
  deletePortrait,
  assertPortraitsAllowedForModel,
};
