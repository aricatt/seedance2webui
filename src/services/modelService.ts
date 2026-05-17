import type { ModelOption } from '../types/index';
import { MODEL_OPTIONS } from '../types/index';
import { getAuthHeaders } from './authService';

const API_BASE = '/api';

export interface ProviderStatus {
  provider_ark_enabled: boolean;
  provider_luminia_enabled: boolean;
  arkKeyConfigured: boolean;
  luminiaKeyConfigured: boolean;
}

export interface ModelsApiResponse {
  models: ModelOption[];
  providers: {
    ark: { enabled: boolean; keyConfigured: boolean };
    luminia: { enabled: boolean; keyConfigured: boolean };
  };
}

export async function fetchAvailableModels(): Promise<ModelsApiResponse> {
  const response = await fetch(`${API_BASE}/models`, { headers: getAuthHeaders() });
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || '获取模型列表失败');
  }
  const data = result.data || {};
  return {
    models: data.models?.length ? data.models : MODEL_OPTIONS,
    providers: data.providers || {
      ark: { enabled: true, keyConfigured: false },
      luminia: { enabled: true, keyConfigured: false },
    },
  };
}

export async function fetchProviderStatus(): Promise<ProviderStatus> {
  const response = await fetch(`${API_BASE}/settings/provider-status`, {
    headers: getAuthHeaders(),
  });
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || '获取平台状态失败');
  }
  const d = result.data || {};
  return {
    provider_ark_enabled: Boolean(d.provider_ark_enabled),
    provider_luminia_enabled: Boolean(d.provider_luminia_enabled),
    arkKeyConfigured: Boolean(d.arkKeyConfigured),
    luminiaKeyConfigured: Boolean(d.luminiaKeyConfigured),
  };
}

export default {
  fetchAvailableModels,
  fetchProviderStatus,
};
