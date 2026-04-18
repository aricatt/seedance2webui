import type { Project, Task, TaskKind, ApiResponse } from '../types/index';
import { getAuthHeaders } from './authService';

const API_BASE = '/api';

export interface GetProjectTasksOptions {
  status?: string;
  taskKind?: TaskKind;
}

/**
 * 获取所有项目
 */
export async function getProjects(): Promise<Project[]> {
  const response = await fetch(`${API_BASE}/projects`, {
    headers: getAuthHeaders(),
  });
  const result: ApiResponse<Project[]> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '获取项目列表失败');
  }
  return result.data || [];
}

/**
 * 获取项目详情
 */
export async function getProject(id: number): Promise<Project> {
  const response = await fetch(`${API_BASE}/projects/${id}`, {
    headers: getAuthHeaders(),
  });
  const result: ApiResponse<Project> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '获取项目详情失败');
  }
  return result.data!;
}

/**
 * 创建项目
 */
export async function createProject(
  name: string,
  description?: string,
  settings?: Record<string, any>
): Promise<Project> {
  const response = await fetch(`${API_BASE}/projects`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name, description, settings }),
  });
  const result: ApiResponse<Project> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '创建项目失败');
  }
  return result.data!;
}

/**
 * 更新项目
 */
export async function updateProject(
  id: number,
  data: {
    name?: string;
    description?: string;
    settings?: Record<string, any>;
    video_save_path?: string;
    default_concurrent?: number;
    default_min_interval?: number;
    default_max_interval?: number;
  }
): Promise<Project> {
  const response = await fetch(`${API_BASE}/projects/${id}`, {
    method: 'PUT',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(data),
  });
  const result: ApiResponse<Project> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '更新项目失败');
  }
  return result.data!;
}

/**
 * 删除项目
 */
export async function deleteProject(id: number): Promise<void> {
  const response = await fetch(`${API_BASE}/projects/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  const result: ApiResponse = await response.json();
  if (!result.success) {
    throw new Error(result.error || '删除项目失败');
  }
}

/**
 * 获取项目下的任务列表
 */
export async function getProjectTasks(
  id: number,
  options: GetProjectTasksOptions = {}
): Promise<Task[]> {
  const url = new URL(`${API_BASE}/projects/${id}/tasks`, window.location.origin);
  if (options.status) {
    url.searchParams.set('status', options.status);
  }
  if (options.taskKind) {
    url.searchParams.set('taskKind', options.taskKind);
  }
  const response = await fetch(`${url.pathname}${url.search}`, {
    headers: getAuthHeaders(),
  });
  const result: ApiResponse<Task[]> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '获取任务列表失败');
  }
  return result.data || [];
}

export default {
  getProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  getProjectTasks,
};
