import type { Task, TaskAsset, ApiResponse, TaskKind } from '../types/index';
import { getAuthHeaders } from './authService';

const API_BASE = '/api';

export interface CreateTaskPayload {
  prompt?: string;
  taskKind?: TaskKind;
  rowIndex?: number;
  videoCount?: number;
}

/**
 * 获取任务详情
 */
export async function getTask(id: number): Promise<Task> {
  const response = await fetch(`${API_BASE}/tasks/${id}`, {
    headers: getAuthHeaders(),
  });
  const result: ApiResponse<Task> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '获取任务详情失败');
  }
  return result.data!;
}

/**
 * 创建任务
 */
export async function createTask(
  projectId: number,
  payload: CreateTaskPayload
): Promise<Task> {
  const response = await fetch(`${API_BASE}/projects/${projectId}/tasks`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      prompt: payload.prompt ?? '',
      taskKind: payload.taskKind,
      rowIndex: payload.rowIndex,
      videoCount: payload.videoCount,
    }),
  });
  const result: ApiResponse<Task> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '创建任务失败');
  }
  return result.data!;
}

/**
 * 更新任务
 */
export async function updateTask(
  id: number,
  data: Partial<Task>
): Promise<Task> {
  const response = await fetch(`${API_BASE}/tasks/${id}`, {
    method: 'PUT',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(data),
  });
  const result: ApiResponse<Task> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '更新任务失败');
  }
  return result.data!;
}

/**
 * 删除任务
 */
export async function deleteTask(id: number): Promise<void> {
  const response = await fetch(`${API_BASE}/tasks/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  const result: ApiResponse = await response.json();
  if (!result.success) {
    throw new Error(result.error || '删除任务失败');
  }
}

/**
 * 添加任务素材
 */
export async function addTaskAssets(
  taskId: number,
  images?: File[],
  audios?: File[],
  videos?: File[],
): Promise<TaskAsset[]> {
  const formData = new FormData();
  images?.forEach((file) => formData.append('images', file));
  audios?.forEach((file) => formData.append('audios', file));
  videos?.forEach((file) => formData.append('videos', file));

  const response = await fetch(`${API_BASE}/tasks/${taskId}/assets`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: formData,
  });
  const result: ApiResponse<TaskAsset[]> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '添加素材失败');
  }
  return result.data || [];
}

/**
 * 获取任务素材列表
 */
export async function getTaskAssets(taskId: number): Promise<TaskAsset[]> {
  const response = await fetch(`${API_BASE}/tasks/${taskId}/assets`, {
    headers: getAuthHeaders(),
  });
  const result: ApiResponse<TaskAsset[]> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '获取素材列表失败');
  }
  return result.data || [];
}

/**
 * 删除任务素材
 */
export async function deleteTaskAsset(assetId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/tasks/assets/${assetId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  const result: ApiResponse = await response.json();
  if (!result.success) {
    throw new Error(result.error || '删除素材失败');
  }
}

/**
 * 生成任务视频
 */
export async function generateTaskVideo(taskId: number): Promise<{
  success: boolean;
  taskId: number;
  batchId?: number;
  totalTasks?: number;
  outputTaskIds?: number[];
  message?: string;
}> {
  const response = await fetch(`${API_BASE}/tasks/${taskId}/generate`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const result: ApiResponse<{
    success: boolean;
    taskId: number;
    batchId?: number;
    totalTasks?: number;
    outputTaskIds?: number[];
    message?: string;
  }> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '生成视频失败');
  }
  return result.data!;
}

/**
 * 取消任务
 */
export async function cancelTask(taskId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/tasks/${taskId}/cancel`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const result: ApiResponse = await response.json();
  if (!result.success) {
    throw new Error(result.error || '取消任务失败');
  }
}

/**
 * 下载任务视频
 */
export async function downloadTaskVideo(
  taskId: number
): Promise<{ success: boolean; path: string; size: number }> {
  const response = await fetch(`${API_BASE}/tasks/${taskId}/download`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const result: ApiResponse<{ success: boolean; path: string; size: number }> =
    await response.json();
  if (!result.success) {
    throw new Error(result.error || '下载视频失败');
  }
  return result.data!;
}

/**
 * 打开视频所在文件夹
 */
export async function openTaskVideoFolder(taskId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/tasks/${taskId}/open-folder`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const result: ApiResponse = await response.json();
  if (!result.success) {
    throw new Error(result.error || '打开文件夹失败');
  }
}

/**
 * 二次采集任务视频（重新获取视频 URL）
 */
export async function collectTaskVideo(taskId: number): Promise<{
  success: boolean;
  videoUrl?: string;
}> {
  const response = await fetch(`${API_BASE}/tasks/${taskId}/collect`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const result: ApiResponse<{ success: boolean; videoUrl?: string }> =
    await response.json();
  if (!result.success) {
    throw new Error(result.error || '采集视频失败');
  }
  return result.data!;
}

export default {
  getTask,
  createTask,
  updateTask,
  deleteTask,
  addTaskAssets,
  getTaskAssets,
  deleteTaskAsset,
  generateTaskVideo,
  cancelTask,
  downloadTaskVideo,
  openTaskVideoFolder,
  collectTaskVideo,
};
