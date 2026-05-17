/**
 * 视频生成模型注册表（第一期：Seedance 2.0 四款）
 */

export const PROVIDERS = {
  ARK: 'ark',
  LUMINIA: 'luminia',
};

/** @type {import('./modelRegistry.types.js').VideoModelDefinition[]} */
export const VIDEO_MODEL_REGISTRY = [
  {
    id: 'luminia-2.0',
    label: 'Seedance 2.0 (Luminia)',
    description: 'Luminia 高品质 Seedance 2.0，支持图生视频与多模态参考',
    provider: PROVIDERS.LUMINIA,
    paramProfile: 'seedance20',
    resolutions: ['480p', '720p'],
    supports1080p: false,
  },
  {
    id: 'luminia-2.0-fast',
    label: 'Seedance 2.0 Fast (Luminia)',
    description: 'Luminia 快速版，适合批量出稿',
    provider: PROVIDERS.LUMINIA,
    paramProfile: 'seedance20',
    resolutions: ['480p', '720p'],
    supports1080p: false,
  },
  {
    id: 'doubao-seedance-2-0-260128',
    label: 'Seedance 2.0 (火山方舟)',
    description: '火山方舟官方 Seedance 2.0，内网 file 上传',
    provider: PROVIDERS.ARK,
    paramProfile: 'seedance20',
    resolutions: ['480p', '720p'],
    supports1080p: false,
  },
  {
    id: 'doubao-seedance-2-0-fast-260128',
    label: 'Seedance 2.0 Fast (火山方舟)',
    description: '火山方舟快速版，适合应急与内网场景',
    provider: PROVIDERS.ARK,
    paramProfile: 'seedance20',
    resolutions: ['480p', '720p'],
    supports1080p: false,
  },
];

export function getModelDefinition(modelId) {
  const trimmed = String(modelId || '').trim();
  return VIDEO_MODEL_REGISTRY.find((m) => m.id === trimmed) || null;
}

export function resolveProviderForModel(modelId) {
  const def = getModelDefinition(modelId);
  if (def) return def.provider;
  // 兼容历史/别名
  const lower = String(modelId || '').toLowerCase();
  if (lower.startsWith('luminia')) return PROVIDERS.LUMINIA;
  if (lower.includes('doubao') || lower.includes('seedance')) return PROVIDERS.ARK;
  return null;
}

export function isModelAllowed(modelId, { arkEnabled, luminiaEnabled, arkKeyConfigured, luminiaKeyConfigured }) {
  const def = getModelDefinition(modelId);
  if (!def) return false;
  if (def.provider === PROVIDERS.ARK) {
    return arkEnabled && arkKeyConfigured;
  }
  if (def.provider === PROVIDERS.LUMINIA) {
    return luminiaEnabled && luminiaKeyConfigured;
  }
  return false;
}
