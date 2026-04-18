import type { Settings, ApiResponse } from '../types/index';
import { getAuthHeaders } from './authService';

const API_BASE = '/api';

/**
 * 获取全局设置
 */
export async function getSettings(): Promise<Settings> {
  const response = await fetch(`${API_BASE}/settings`);
  const result: ApiResponse<Settings> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '获取设置失败');
  }
  return result.data || {};
}

/**
 * 更新全局设置
 */
export async function updateSettings(
  settings: Record<string, string>
): Promise<Settings> {
  const response = await fetch(`${API_BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  const result: ApiResponse<Settings> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '更新设置失败');
  }
  return result.data!;
}

/**
 * 查询服务端方舟 API Key 是否已配置 (不会返回 Key 本身)
 */
export async function getArkStatus(): Promise<{ configured: boolean }> {
  const response = await fetch(`${API_BASE}/settings/ark-status`, {
    headers: getAuthHeaders(),
  });
  const result: ApiResponse<{ configured: boolean }> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '获取方舟配置状态失败');
  }
  return result.data!;
}

export default {
  getSettings,
  updateSettings,
  getArkStatus,
};
