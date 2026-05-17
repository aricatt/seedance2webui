import { getAuthHeaders } from './authService';

const API_BASE = '/api';

export interface ModelTooProjectWithBalance {
  project_id: string;
  project_name: string;
  group_id: string;
  balance: number;
  is_member: boolean;
}

export interface ModelTooProjectsWithBalanceResponse {
  items: ModelTooProjectWithBalance[];
}

/**
 * 获取用户在 ModelToo 中的项目列表及余额（通过 SD 后端代理）
 */
export async function getModelTooProjectsWithBalance(): Promise<ModelTooProjectWithBalance[]> {
  const response = await fetch(
    `${API_BASE}/modeltoo/projects-with-balance`,
    {
      headers: getAuthHeaders(),
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: '获取项目列表失败' }));
    throw new Error(error.error || `获取项目列表失败: ${response.status}`);
  }

  const result: ModelTooProjectsWithBalanceResponse = await response.json();
  return result.items || [];
}

export default {
  getModelTooProjectsWithBalance,
};
