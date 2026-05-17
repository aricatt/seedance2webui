/**
 * 视频生成多平台：模型列表、开关、统一提交/轮询入口
 */

import { generateArkVideo, pollArkTaskUntilDone } from './arkVideoGenerator.js';
import { generateLuminiaVideo, pollLuminiaTaskUntilDone } from './luminiaVideoGenerator.js';
import { isArkApiKeyConfigured } from './arkConfig.js';
import { isLuminiaApiKeyConfigured } from './luminiaConfig.js';
import * as settingsService from './settingsService.js';
import {
  VIDEO_MODEL_REGISTRY,
  getModelDefinition,
  resolveProviderForModel,
  isModelAllowed,
  PROVIDERS,
} from '../config/modelRegistry.js';

function parseBoolSetting(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const s = String(value).trim().toLowerCase();
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return true;
}

export function getProviderFlags(settings = settingsService.getAllSettings()) {
  return {
    arkEnabled: parseBoolSetting(settings.provider_ark_enabled, true),
    luminiaEnabled: parseBoolSetting(settings.provider_luminia_enabled, true),
    arkKeyConfigured: isArkApiKeyConfigured(),
    luminiaKeyConfigured: isLuminiaApiKeyConfigured(),
  };
}

export function listAvailableModels(settings) {
  const flags = getProviderFlags(settings);
  return VIDEO_MODEL_REGISTRY.filter((m) =>
    isModelAllowed(m.id, flags)
  ).map((m) => ({
    value: m.id,
    label: m.label,
    description: m.description,
    provider: m.provider,
    paramProfile: m.paramProfile,
    resolutions: m.resolutions,
    supports1080p: m.supports1080p,
  }));
}

export function assertModelAllowed(modelId, settings) {
  const def = getModelDefinition(modelId);
  if (!def) {
    throw new Error(`不支持的模型: ${modelId}`);
  }
  const flags = getProviderFlags(settings);
  if (!isModelAllowed(modelId, flags)) {
    const reason =
      def.provider === PROVIDERS.ARK
        ? !flags.arkKeyConfigured
          ? '火山方舟 API Key 未配置'
          : '火山方舟平台已在后台关闭'
        : !flags.luminiaKeyConfigured
          ? 'Luminia API Key 未配置'
          : 'Luminia 平台已在后台关闭';
    throw new Error(`模型 ${def.label} 不可用: ${reason}`);
  }
  return def;
}

export function resolveProvider(modelId, settings) {
  assertModelAllowed(modelId, settings);
  return resolveProviderForModel(modelId);
}

/**
 * 统一创建并轮询视频任务
 */
export async function generateVideo(opts) {
  const { model, ...rest } = opts;
  const settings = settingsService.getAllSettings();
  const def = assertModelAllowed(model || settings.model || 'luminia-2.0', settings);
  const modelId = model || def.id;

  if (def.provider === PROVIDERS.LUMINIA) {
    return generateLuminiaVideo({ ...rest, model: modelId });
  }
  return generateArkVideo({ ...rest, model: modelId });
}

/**
 * 恢复未完成任务时按 provider 轮询
 */
export async function pollVideoUntilDone({ provider, model, taskId, ...opts }) {
  const resolved =
    provider ||
    resolveProviderForModel(model) ||
    PROVIDERS.ARK;

  if (resolved === PROVIDERS.LUMINIA) {
    return pollLuminiaTaskUntilDone({ taskId, ...opts });
  }
  return pollArkTaskUntilDone({ taskId, ...opts });
}

export function assertAnyVideoProviderConfiguredOrExit() {
  const ark = isArkApiKeyConfigured();
  const lum = isLuminiaApiKeyConfigured();
  if (!ark && !lum) {
    console.error(
      '\n❌ 未配置任何视频 API Key。请在 .env 中设置 LUMINIA_API_KEY 和/或 ARK_API_KEY。\n'
    );
    process.exit(1);
  }
  if (ark) console.log('[startup] ✓ ARK_API_KEY 已配置');
  if (lum) console.log('[startup] ✓ LUMINIA_API_KEY 已配置');
}

export default {
  listAvailableModels,
  assertModelAllowed,
  generateVideo,
  pollVideoUntilDone,
  getProviderFlags,
  assertAnyVideoProviderConfiguredOrExit,
};
