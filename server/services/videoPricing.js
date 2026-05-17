/**
 * 视频生成费用估算与结算（火山方舟 + Luminia）
 * - 方舟：元/百万 tokens（见 doc/火山引擎官方说明/模型价格.md）
 * - Luminia：元/千 tokens（见 doc/Luminia说明/Luminia_模型价格速查.md）
 */

import { resolveProviderForModel, PROVIDERS } from '../config/modelRegistry.js';

/** @typedef {'per_thousand' | 'per_million'} PricingUnit */

/**
 * Luminia Seedance 2.0 — 元/千 tokens
 * 480p 与 720p 同档
 */
const LUMINIA_2_0_PER_1K = {
  imageText: { sd: 0.0483, '1080p': 0.05355 },
  video: { sd: 0.0294, '1080p': 0.03255 },
};

const LUMINIA_2_0_FAST_PER_1K = {
  imageText: { sd: 0.03885 },
  video: { sd: 0.0231 },
};

/** 方舟 Seedance — 元/百万 tokens */
const ARK_2_0_PER_1M = {
  '480p': { noVideoInput: 46.0, withVideoInput: 28.0 },
  '720p': { noVideoInput: 46.0, withVideoInput: 28.0 },
  '1080p': { noVideoInput: 51.0, withVideoInput: 31.0 },
};

const ARK_2_0_FAST_PER_1M = {
  '480p': { noVideoInput: 37.0, withVideoInput: 22.0 },
  '720p': { noVideoInput: 37.0, withVideoInput: 22.0 },
  '1080p': { noVideoInput: 0, withVideoInput: 0 },
};

const ARK_1_5_PRO_PER_1M = {
  '480p': { audio: 16.0, noAudio: 8.0 },
  '720p': { audio: 16.0, noAudio: 8.0 },
  '1080p': { audio: 16.0, noAudio: 8.0 },
};

export function normalizeModelId(modelId) {
  const m = String(modelId || '').trim();
  if (m === 'doubao-seedance-2.0-260128') return 'doubao-seedance-2-0-260128';
  if (m === 'doubao-seedance-2.0-fast-260128') return 'doubao-seedance-2-0-fast-260128';
  return m;
}

function luminiaResolutionTier(resolution) {
  return resolution === '1080p' ? '1080p' : 'sd';
}

/**
 * @returns {{ price: number, divisor: number, pricingUnit: PricingUnit, provider: string } | null}
 */
export function resolveBillingRate(modelId, { resolution = '720p', hasVideoInput = false } = {}) {
  const model = normalizeModelId(modelId);
  const provider = resolveProviderForModel(model);

  if (provider === PROVIDERS.LUMINIA) {
    const tier = luminiaResolutionTier(resolution);
    if (model === 'luminia-2.0-fast') {
      if (tier === '1080p') return null;
      const table = hasVideoInput ? LUMINIA_2_0_FAST_PER_1K.video : LUMINIA_2_0_FAST_PER_1K.imageText;
      return {
        price: table.sd,
        divisor: 1000,
        pricingUnit: 'per_thousand',
        provider: PROVIDERS.LUMINIA,
      };
    }
    if (model === 'luminia-2.0' || model.startsWith('luminia')) {
      const table = hasVideoInput ? LUMINIA_2_0_PER_1K.video : LUMINIA_2_0_PER_1K.imageText;
      const price = table[tier];
      if (price == null) return null;
      return {
        price,
        divisor: 1000,
        pricingUnit: 'per_thousand',
        provider: PROVIDERS.LUMINIA,
      };
    }
    return null;
  }

  if (model === 'doubao-seedance-2-0-260128') {
    const prices = ARK_2_0_PER_1M[resolution] || ARK_2_0_PER_1M['720p'];
    const price = hasVideoInput ? prices.withVideoInput : prices.noVideoInput;
    return { price, divisor: 1_000_000, pricingUnit: 'per_million', provider: PROVIDERS.ARK };
  }
  if (model === 'doubao-seedance-2-0-fast-260128') {
    if (resolution === '1080p') return null;
    const prices = ARK_2_0_FAST_PER_1M[resolution] || ARK_2_0_FAST_PER_1M['720p'];
    const price = hasVideoInput ? prices.withVideoInput : prices.noVideoInput;
    return { price, divisor: 1_000_000, pricingUnit: 'per_million', provider: PROVIDERS.ARK };
  }
  if (model === 'doubao-seedance-1-5-pro-251215') {
    const prices = ARK_1_5_PRO_PER_1M[resolution] || ARK_1_5_PRO_PER_1M['720p'];
    return {
      price: prices.audio,
      divisor: 1_000_000,
      pricingUnit: 'per_million',
      provider: PROVIDERS.ARK,
    };
  }

  return null;
}

/**
 * Token 用量估算（与方舟文档公式一致，Luminia Seedance 2.0 同族可复用）
 */
export function estimateTokenUsage({
  resolution = '720p',
  duration = 5,
  hasVideoInput = false,
  inputVideoDuration = 0,
}) {
  const resolutionSpecs = {
    '480p': { '16:9': { width: 864, height: 496 } },
    '720p': { '16:9': { width: 1280, height: 720 } },
    '1080p': { '16:9': { width: 1920, height: 1080 } },
  };
  const spec = resolutionSpecs[resolution]?.['16:9'] || resolutionSpecs['720p']['16:9'];
  const fps = 24;
  const totalDuration = hasVideoInput ? Number(inputVideoDuration) + Number(duration) : Number(duration);
  return (totalDuration * spec.width * spec.height * fps) / 1024;
}

/**
 * 前端预估费用区间（返回值为元，与积分 1:1）
 */
export function estimatePriceRange({
  model,
  resolution = '720p',
  duration = 5,
  hasVideoInput = false,
  inputVideoDuration = 0,
}) {
  const rate = resolveBillingRate(normalizeModelId(model), { resolution, hasVideoInput });
  if (!rate) return null;

  const calc = (inputDur) => {
    const tokens = estimateTokenUsage({
      resolution,
      duration,
      hasVideoInput,
      inputVideoDuration: inputDur,
    });
    return (tokens / rate.divisor) * rate.price;
  };

  if (hasVideoInput) {
    const minPrice = calc(2);
    const maxPrice = calc(15);
    return {
      minPrice,
      maxPrice,
      unitPrice: rate.price,
      pricingUnit: rate.pricingUnit,
    };
  }

  const price = calc(0);
  return {
    minPrice: price,
    maxPrice: price * 1.15,
    unitPrice: rate.price,
    pricingUnit: rate.pricingUnit,
  };
}

export function calculateCostFromTokens(totalTokens, modelId, opts = {}) {
  const rate = resolveBillingRate(normalizeModelId(modelId), opts);
  if (!rate || totalTokens == null || !Number.isFinite(Number(totalTokens))) {
    return { cost: null, unitPrice: null, pricingUnit: null, provider: null };
  }
  const tokens = Number(totalTokens);
  const cost = (tokens / rate.divisor) * rate.price;
  return {
    cost,
    unitPrice: rate.price,
    pricingUnit: rate.pricingUnit,
    provider: rate.provider,
  };
}

export function extractTotalTokensFromResult(result) {
  if (!result) return null;
  const v =
    result.raw?.usage?.total_tokens ??
    result.usage?.total_tokens ??
    result.raw?.data?.usage?.total_tokens ??
    null;
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}

export function extractCompletionTokensFromResult(result) {
  if (!result) return null;
  const v =
    result.raw?.usage?.completion_tokens ??
    result.usage?.completion_tokens ??
    result.raw?.data?.usage?.completion_tokens ??
    null;
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}

export default {
  normalizeModelId,
  resolveBillingRate,
  estimateTokenUsage,
  estimatePriceRange,
  calculateCostFromTokens,
  extractTotalTokensFromResult,
  extractCompletionTokensFromResult,
};
