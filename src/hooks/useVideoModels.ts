import { useEffect, useState, useCallback } from 'react';
import type { ModelOption, Resolution } from '../types/index';
import { MODEL_OPTIONS, RESOLUTION_OPTIONS } from '../types/index';
import { fetchAvailableModels } from '../services/modelService';

export function getResolutionsForModel(
  modelId: string,
  models: ModelOption[]
): Resolution[] {
  const def = models.find((m) => m.value === modelId);
  if (def?.resolutions?.length) {
    return def.resolutions as Resolution[];
  }
  const lower = modelId.toLowerCase();
  if (lower.includes('fast') || lower.startsWith('luminia') || lower.includes('doubao') || lower.includes('seedance')) {
    return ['480p', '720p'];
  }
  return RESOLUTION_OPTIONS.filter((r) => r !== '1080p');
}

export function useVideoModels() {
  const [models, setModels] = useState<ModelOption[]>(MODEL_OPTIONS);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchAvailableModels();
      setModels(data.models);
    } catch {
      setModels(MODEL_OPTIONS);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { models, loading, reload };
}
