import type { DownloadTaskList, ApiResponse } from '../types/index';
import { wrapExternalMediaForBrowser } from '../utils/tosImage';
import { getAuthHeaders } from './authService';

const API_BASE = '/api';

export interface DownloadScopeOption {
  id: number | null;
  label: string;
}

export interface DownloadScopeDiagnostics {
  loginIdentifier: string;
  modelTooApiConfigured: boolean;
  groupsFetchedCount: number | null;
  isLeaderInModelToo: boolean;
  ledGroupsCount: number;
  modelTooMemberCount: number;
  mappedLocalUserCount: number;
  usedFallbackUuidScan: boolean;
  tips: string[];
  serverLogHint: string;
}

export interface DownloadScopePayload {
  viewerRole: 'admin' | 'leader' | 'member';
  defaultFilterUserId: number | null;
  filterOptions: DownloadScopeOption[];
  scopeDiagnostics: DownloadScopeDiagnostics | null;
}

export async function fetchDownloadScope(): Promise<DownloadScopePayload> {
  const response = await fetch(`${API_BASE}/download/scope`, {
    headers: getAuthHeaders(),
  });
  const result: ApiResponse<DownloadScopePayload> = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || '获取下载筛选范围失败');
  }
  return result.data!;
}

function buildBrowserDownloadUrl(path: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}t=${Date.now()}`;
}

async function getErrorMessage(response: Response, fallback: string): Promise<string> {
  const contentType = response.headers.get('content-type') || '';

  if (!contentType.includes('application/json')) {
    return fallback;
  }

  try {
    const result: ApiResponse<null> = await response.json();
    return result.error || fallback;
  } catch {
    return fallback;
  }
}

async function createFileDownloadPayload(taskId: number): Promise<{
  token?: string;
  directUrl?: string;
  proxyVideoUrl?: string;
}> {
  const response = await fetch(`${API_BASE}/download/tasks/${taskId}/file-token`, {
    method: 'POST',
    cache: 'no-store',
    headers: getAuthHeaders({
      'Cache-Control': 'no-cache, no-store, max-age=0',
      Pragma: 'no-cache',
    }),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `下载文件失败（HTTP ${response.status}）`));
  }

  const result: ApiResponse<{ token?: string; directUrl?: string; proxyVideoUrl?: string }> =
    await response.json();
  if (
    !result.success
    || (!result.data?.token && !result.data?.directUrl && !result.data?.proxyVideoUrl)
  ) {
    throw new Error(result.error || '下载文件失败');
  }

  return result.data;
}

function getFallbackFilename(taskId: number, fallbackFilename?: string): string {
  return fallbackFilename || `task-${taskId}.mp4`;
}

function triggerBrowserDownload(url: string, fallbackFilename: string): void {
  const link = document.createElement('a');

  link.href = new URL(url, window.location.href).toString();
  link.download = fallbackFilename;
  link.rel = 'noopener noreferrer';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * 获取下载任务列表
 */
export async function getDownloadTasks(
  status: string = 'all',
  type: string = 'all',
  page: number = 1,
  pageSize: number = 20,
  opts?: { filterUserId?: number | null }
): Promise<DownloadTaskList> {
  const params = new URLSearchParams({
    status,
    type,
    page: page.toString(),
    pageSize: pageSize.toString(),
  });
  if (opts?.filterUserId != null && Number.isFinite(opts.filterUserId)) {
    params.set('user_id', String(opts.filterUserId));
  }

  const response = await fetch(`${API_BASE}/download/tasks?${params}`, {
    headers: getAuthHeaders(),
  });
  const result: ApiResponse<DownloadTaskList> = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || '获取下载任务列表失败');
  }
  return result.data!;
}

/**
 * 下载单个任务视频
 */
export async function downloadVideo(taskId: number): Promise<{ path: string; size: number }> {
  const response = await fetch(`${API_BASE}/download/tasks/${taskId}`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const result: ApiResponse<{ path: string; size: number }> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '下载失败');
  }
  return result.data!;
}

/**
 * 批量下载视频
 */
export async function batchDownloadVideos(
  taskIds: number[]
): Promise<Array<{ taskId: number; success: boolean; path?: string; error?: string }>> {
  const response = await fetch(`${API_BASE}/download/batch`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ taskIds }),
  });
  const result: ApiResponse<Array<{ taskId: number; success: boolean; path?: string; error?: string }>> =
    await response.json();
  if (!result.success) {
    throw new Error(result.error || '批量下载失败');
  }
  return result.data!;
}

/**
 * 下载服务器本地已保存的视频到浏览器
 */
export async function downloadLocalVideoFile(taskId: number, fallbackFilename?: string): Promise<void> {
  const data = await createFileDownloadPayload(taskId);
  const name = getFallbackFilename(taskId, fallbackFilename);
  if (data.proxyVideoUrl) {
    triggerBrowserDownload(buildBrowserDownloadUrl(data.proxyVideoUrl), name);
    return;
  }
  if (data.directUrl) {
    triggerBrowserDownload(
      buildBrowserDownloadUrl(wrapExternalMediaForBrowser(data.directUrl)),
      name,
    );
    return;
  }
  if (data.token) {
    const downloadUrl = buildBrowserDownloadUrl(
      `${API_BASE}/download/file-by-token?token=${encodeURIComponent(data.token)}`,
    );
    triggerBrowserDownload(downloadUrl, name);
    return;
  }
  throw new Error('服务器未返回下载链接');
}

/**
 * 创建一次性流式播放 token, 返回可直接喂给 <video src> 的 URL.
 * 该 URL 30 分钟内有效, 支持 HTTP Range (拖动进度条).
 */
export async function createStreamUrl(taskId: number): Promise<string> {
  const response = await fetch(`${API_BASE}/download/tasks/${taskId}/stream-token`, {
    method: 'POST',
    cache: 'no-store',
    headers: getAuthHeaders({
      'Cache-Control': 'no-cache, no-store, max-age=0',
      Pragma: 'no-cache',
    }),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `获取播放链接失败（HTTP ${response.status}）`));
  }

  const result: ApiResponse<{ token?: string; streamUrl?: string; proxyVideoUrl?: string }> =
    await response.json();
  if (
    !result.success
    || (!result.data?.token && !result.data?.streamUrl && !result.data?.proxyVideoUrl)
  ) {
    throw new Error(result.error || '获取播放链接失败');
  }

  if (result.data.proxyVideoUrl) {
    return buildBrowserDownloadUrl(result.data.proxyVideoUrl);
  }

  if (result.data.streamUrl) {
    return wrapExternalMediaForBrowser(result.data.streamUrl);
  }

  return `${API_BASE}/download/stream-by-token?token=${encodeURIComponent(result.data.token!)}`;
}

/**
 * 打开视频所在文件夹
 */
export async function openVideoFolder(taskId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/download/tasks/${taskId}/open`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const result: ApiResponse<null> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '打开文件夹失败');
  }
}

/**
 * 删除任务
 */
export async function deleteTask(taskId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/download/tasks/${taskId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  const result: ApiResponse<null> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '删除任务失败');
  }
}

/**
 * 刷新下载任务列表（获取已生成的视频）
 */
export async function refreshDownloadTasks(opts?: {
  filterUserId?: number | null;
}): Promise<{
  refreshed: number;
  total: number;
  generating?: number;
  generatingTasks?: Array<{
    taskId: number;
    historyId: string;
    createdAt: string;
  }>;
}> {
  let url = `${API_BASE}/download/refresh`;
  if (opts?.filterUserId != null && Number.isFinite(opts.filterUserId)) {
    url += `?user_id=${encodeURIComponent(String(opts.filterUserId))}`;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
  });
  const result: ApiResponse<{
    refreshed: number;
    total: number;
    generating?: number;
    generatingTasks?: Array<{
      taskId: number;
      historyId: string;
      createdAt: string;
    }>;
  }> = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || '刷新任务列表失败');
  }
  return result.data!;
}

/**
 * 从即梦平台同步所有已生成的视频记录
 */
export async function syncFromJimeng(): Promise<{
  synced: number;
  total: number;
  items?: Array<{
    taskId: number;
    historyId: string;
    action: 'created' | 'updated';
    prompt?: string;
  }>;
}> {
  const response = await fetch(`${API_BASE}/download/sync-from-jimeng`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
  });
  const result: ApiResponse<{
    synced: number;
    total: number;
    items?: Array<{
      taskId: number;
      historyId: string;
      action: 'created' | 'updated';
      prompt?: string;
    }>;
  }> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '同步失败');
  }
  return result.data!;
}
