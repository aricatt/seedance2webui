import {
  inferPersistObjectKeyFromUrl,
  getPresignedUrlForPersistKey,
  DOWNLOAD_LIST_X_TOS_PROCESS,
  isTosPersistConfigured,
} from './tosUploader.js';

function nz(value) {
  return value == null ? '' : String(value).trim();
}

/**
 * 从任务字段解析持久视频 object key（DB key 优先，否则从 TOS URL 推断）。
 */
export function resolvePersistVideoKey(task) {
  if (!task) return null;
  const dbKey = nz(task.persist_video_key);
  if (dbKey) return dbKey;
  for (const field of ['persist_video_tos_url', 'video_url']) {
    const u = nz(task[field]);
    if (!u.startsWith('http')) continue;
    const inferred = inferPersistObjectKeyFromUrl(u);
    if (inferred) return inferred;
  }
  return null;
}

/**
 * 从任务字段解析持久封面 object key。
 */
export function resolvePersistCoverKey(task) {
  if (!task) return null;
  const dbKey = nz(task.persist_cover_key);
  if (dbKey) return dbKey;
  for (const field of ['persist_cover_tos_url']) {
    const u = nz(task[field]);
    if (!u.startsWith('http')) continue;
    const inferred = inferPersistObjectKeyFromUrl(u);
    if (inferred) return inferred;
  }
  return null;
}

/** 是否库内已写入 persist_*_key（同源 ticket 代理仅在此情况下使用） */
export function hasDbPersistVideoKey(task) {
  return !!nz(task?.persist_video_key);
}

export function hasDbPersistCoverKey(task) {
  return !!nz(task?.persist_cover_key);
}

/**
 * 为播放/下载生成新的视频预签名 URL（含历史仅存过期 TOS 链接的行）。
 */
export async function freshPersistVideoUrl(task) {
  if (!isTosPersistConfigured()) return null;
  const key = resolvePersistVideoKey(task);
  if (!key) return null;
  try {
    return await getPresignedUrlForPersistKey(key);
  } catch (e) {
    console.warn('[legacy-persist] 视频重签失败:', e.message);
    return null;
  }
}

/**
 * 为列表封面生成预签名 URL；列表场景带 x-tos-process 缩小体积。
 */
export async function freshPersistCoverListUrl(task) {
  if (!isTosPersistConfigured()) return null;
  const key = resolvePersistCoverKey(task);
  if (!key) return null;
  try {
    return await getPresignedUrlForPersistKey(key, undefined, {
      'x-tos-process': DOWNLOAD_LIST_X_TOS_PROCESS,
    });
  } catch (e) {
    console.warn('[legacy-persist] 封面列表重签失败:', e.message);
    return null;
  }
}
