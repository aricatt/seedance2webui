import { getArkTask } from './arkVideoGenerator.js';
import { getArkApiKey } from './arkConfig.js';
import {
  getLuminiaTask,
  normalizeLuminiaStatus,
  unwrapPollData,
  LUMINIA_TERMINAL_SUCCESS,
} from './luminiaVideoGenerator.js';
import { getLuminiaApiKey } from './luminiaConfig.js';
import { hasSigningQueryParams, inferPersistObjectKeyFromUrl } from './tosUploader.js';
import { freshPersistVideoUrl } from './legacyPersistResolve.js';
import { getDatabase } from '../database/index.js';

/** 短期缓存，避免下载列表一次拉取大量任务时重复打方舟 */
const REFRESH_CACHE_MS = 30 * 60 * 1000;
const refreshCache = new Map();

function nz(v) {
  return v == null ? '' : String(v).trim();
}

function providerTaskId(task) {
  return nz(task.history_id) || nz(task.submit_id) || nz(task.item_id);
}

/**
 * 判断 TOS 预签名 URL 是否已过期（留 5 分钟安全边际）
 */
export function isTosSignedUrlExpired(url) {
  if (!hasSigningQueryParams(url)) return false;
  try {
    const u = new URL(url);
    const dateStr = u.searchParams.get('X-Tos-Date') || u.searchParams.get('x-tos-date');
    const expiresSec = parseInt(
      u.searchParams.get('X-Tos-Expires') || u.searchParams.get('x-tos-expires') || '0',
      10,
    );
    if (!dateStr || !Number.isFinite(expiresSec) || expiresSec <= 0) return false;
    const m = dateStr.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i);
    if (!m) return false;
    const signedAt = Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
    );
    const expiresAt = signedAt + expiresSec * 1000;
    return Date.now() > expiresAt - 5 * 60 * 1000;
  } catch {
    return false;
  }
}

/** 非自家持久桶、且为方舟/外链临时地址（常见于旧库 video_url） */
export function isExternalProviderVideoUrl(url) {
  const u = nz(url);
  if (!u.startsWith('http')) return false;
  if (inferPersistObjectKeyFromUrl(u)) return false;
  const lower = u.toLowerCase();
  return (
    lower.includes('ark-acg')
    || lower.includes('doubao-seedance')
    || lower.includes('volces.com')
    || hasSigningQueryParams(u)
  );
}

export function shouldRefreshProviderVideoUrl(task) {
  if (!task) return false;
  if (nz(task.persist_video_key) || nz(task.persist_video_tos_url)) return false;
  const pid = providerTaskId(task);
  if (!pid) return false;
  const vu = nz(task.video_url);
  if (!vu) return true;
  if (isExternalProviderVideoUrl(vu)) {
    return isTosSignedUrlExpired(vu) || vu.includes('ark-acg');
  }
  return false;
}

/**
 * 向方舟 / Luminia 查询已完成任务，获取新的 video_url（单次 GET，不轮询）
 */
export async function refreshVideoUrlFromProvider(task) {
  const taskId = task?.id;
  const pid = providerTaskId(task);
  if (!pid) return null;

  if (taskId != null) {
    const hit = refreshCache.get(taskId);
    if (hit && hit.expiresAt > Date.now() && hit.url) return hit.url;
  }

  const provider = nz(task.video_provider) || 'ark';
  let freshUrl = null;

  try {
    if (provider === 'luminia') {
      const raw = await getLuminiaTask({ taskId: pid, apiKey: getLuminiaApiKey() });
      const data = unwrapPollData(raw);
      const status = normalizeLuminiaStatus(data?.status);
      if (LUMINIA_TERMINAL_SUCCESS.has(status)) {
        freshUrl = nz(data?.result_url) || null;
      }
    } else {
      const raw = await getArkTask({ taskId: pid, apiKey: getArkApiKey() });
      if (raw?.status === 'succeeded') {
        freshUrl = nz(raw?.content?.video_url) || null;
      }
    }
  } catch (e) {
    console.warn(`[legacy-refresh] task=${taskId} provider=${provider} 刷新失败:`, e.message);
    return null;
  }

  if (!freshUrl) return null;

  if (taskId != null) {
    refreshCache.set(taskId, { url: freshUrl, expiresAt: Date.now() + REFRESH_CACHE_MS });
    try {
      const db = getDatabase();
      db.prepare('UPDATE tasks SET video_url = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
        freshUrl,
        taskId,
      );
    } catch (e) {
      console.warn(`[legacy-refresh] task=${taskId} 写回 video_url 失败:`, e.message);
    }
  }

  console.log(`[legacy-refresh] task=${taskId} 已从 ${provider} 拉取新视频地址`);
  return freshUrl;
}

/**
 * 解析可用于播放/下载的视频 URL：持久桶重签 → 方舟/Luminia 刷新 → 未过期外链
 */
export async function resolvePlayableVideoUrl(task) {
  if (!task) return null;

  const tosUrl = await freshPersistVideoUrl(task);
  if (tosUrl) return tosUrl;

  if (shouldRefreshProviderVideoUrl(task)) {
    const refreshed = await refreshVideoUrlFromProvider(task);
    if (refreshed) return refreshed;
  }

  const vu = nz(task.video_url);
  if (vu.startsWith('http') && !isTosSignedUrlExpired(vu)) {
    return vu;
  }

  return null;
}
