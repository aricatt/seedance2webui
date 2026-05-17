import {
  isTosPersistConfigured,
  getPresignedUrlForPersistKey,
  DOWNLOAD_LIST_X_TOS_PROCESS,
} from './tosUploader.js';
import { signPersistViewTicket } from './persistViewTicket.js';
import { resolvePersistVideoKey, resolvePersistCoverKey } from './legacyPersistResolve.js';
import { resolvePlayableVideoUrl } from './legacyVideoUrlRefresh.js';

/**
 * 为任务附加持久桶对象的 GET 预签名 URL
 *
 * 优先使用同源代理（/api/tos/persist-image），避免签名过期。
 * 同源代理依赖 DB 中的 persist_*_key；历史行仅存过期预签名 URL 时从 URL 解析 key 再重签。
 */
export async function enrichTaskWithPersistUrls(task, viewerUserId = null, viewerIsAdmin = false) {
  if (!task) return task;
  const out = { ...task };
  if (!isTosPersistConfigured()) return out;

  const videoKey = resolvePersistVideoKey(task);
  const coverKey = resolvePersistCoverKey(task);

  try {
    if (viewerUserId && task.id) {
      const ticket = signPersistViewTicket(task.id, viewerUserId, viewerIsAdmin);
      const qtk = encodeURIComponent(ticket);

      if (videoKey) {
        out.persist_video_display_url = `/api/tos/persist-image?ticket=${qtk}&variant=video`;
      }
      if (coverKey) {
        out.persist_cover_display_url = `/api/tos/persist-image?ticket=${qtk}&variant=cover`;
      }
    }

    // 无登录 viewer 时无法签发 ticket，仅服务端场景可回退预签名（浏览器列表勿依赖此路径）
    if (!out.persist_video_display_url && videoKey && !viewerUserId) {
      out.persist_video_display_url = await getPresignedUrlForPersistKey(videoKey);
    }
    if (!out.persist_cover_display_url && coverKey && !viewerUserId) {
      out.persist_cover_display_url = await getPresignedUrlForPersistKey(coverKey, undefined, {
        'x-tos-process': DOWNLOAD_LIST_X_TOS_PROCESS,
      });
    }

    if (!out.persist_cover_display_url && !coverKey && !out.persist_video_display_url && !videoKey) {
      const playable = await resolvePlayableVideoUrl(task);
      if (playable) {
        out.legacy_video_thumb_url = `/api/video-proxy?url=${encodeURIComponent(playable)}`;
      }
    }
  } catch (e) {
    console.warn('[persist-urls] 处理失败:', e.message);
  }
  return out;
}

export async function enrichTasksWithPersistUrls(tasks, viewerUserId = null, viewerIsAdmin = false) {
  if (!Array.isArray(tasks)) return tasks;
  return Promise.all(tasks.map((t) => enrichTaskWithPersistUrls(t, viewerUserId, viewerIsAdmin)));
}

/** 浏览器下载/预览持久视频：同源 ticket，勿下发 TOS 预签名直链 */
export function buildPersistVideoProxyUrl(taskId, viewerUserId, viewerIsAdmin = false, opts = {}) {
  const ticket = signPersistViewTicket(taskId, viewerUserId, viewerIsAdmin);
  const qtk = encodeURIComponent(ticket);
  let url = `/api/tos/persist-image?ticket=${qtk}&variant=video`;
  if (opts.disposition === 'attachment') {
    url += '&disposition=attachment';
  }
  return url;
}
