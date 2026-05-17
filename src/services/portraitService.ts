import { getAuthHeaders } from './authService';

const API_BASE = '/api';

export type PortraitStatus =
  | 'uploading'
  | 'registering'
  | 'processing'
  | 'active'
  | 'failed';

export interface ProjectPortrait {
  id: number;
  userId: number;
  mtProjectId: string;
  name: string;
  previewUrl: string;
  luminiaAssetId: string;
  status: PortraitStatus;
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
}

function projectHeaders(mtProjectId: string): Record<string, string> {
  return {
    ...getAuthHeaders(),
    'X-Project-Id': mtProjectId,
  };
}

export async function fetchPortraits(mtProjectId: string): Promise<ProjectPortrait[]> {
  const qs = new URLSearchParams({ mt_project_id: mtProjectId });
  const response = await fetch(`${API_BASE}/portraits?${qs}`, {
    headers: projectHeaders(mtProjectId),
  });
  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || '加载人像库失败');
  }
  return (result.data || []) as ProjectPortrait[];
}

export async function uploadPortrait(
  mtProjectId: string,
  file: File,
  name?: string,
): Promise<ProjectPortrait> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('mt_project_id', mtProjectId);
  if (name?.trim()) formData.append('name', name.trim());

  const response = await fetch(`${API_BASE}/portraits`, {
    method: 'POST',
    headers: projectHeaders(mtProjectId),
    body: formData,
  });
  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || '上传人像失败');
  }
  return result.data as ProjectPortrait;
}

export async function deletePortrait(
  mtProjectId: string,
  portraitId: number,
): Promise<void> {
  const qs = new URLSearchParams({ mt_project_id: mtProjectId });
  const response = await fetch(`${API_BASE}/portraits/${portraitId}?${qs}`, {
    method: 'DELETE',
    headers: projectHeaders(mtProjectId),
  });
  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || '删除人像失败');
  }
}
