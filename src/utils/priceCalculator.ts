/**
 * 视频生成费用估算（火山方舟 + Luminia）
 * - 方舟：元/百万 tokens
 * - Luminia：元/千 tokens（见 doc/Luminia说明/Luminia_模型价格速查.md）
 */

export interface PriceEstimateOptions {
  model: string;
  resolution: '480p' | '720p' | '1080p';
  duration: number;
  hasVideoInput?: boolean;
  inputVideoDuration?: number;
}

export interface PriceRange {
  minPrice: number;
  maxPrice: number;
  unitPrice: number;
  pricingUnit?: 'per_thousand' | 'per_million';
}

const LUMINIA_2_0_PER_1K = {
  imageText: { sd: 0.0483, '1080p': 0.05355 },
  video: { sd: 0.0294, '1080p': 0.03255 },
};

const LUMINIA_2_0_FAST_PER_1K = {
  imageText: { sd: 0.03885 },
  video: { sd: 0.0231 },
};

const SEEDANCE_2_0_PRICES = {
  '480p': { noVideoInput: 46.0, withVideoInput: 28.0 },
  '720p': { noVideoInput: 46.0, withVideoInput: 28.0 },
  '1080p': { noVideoInput: 51.0, withVideoInput: 31.0 },
};

const SEEDANCE_2_0_FAST_PRICES = {
  '480p': { noVideoInput: 37.0, withVideoInput: 22.0 },
  '720p': { noVideoInput: 37.0, withVideoInput: 22.0 },
  '1080p': { noVideoInput: 0, withVideoInput: 0 },
};

const SEEDANCE_1_5_PRO_PRICES = {
  '480p': { audio: 16.0, noAudio: 8.0 },
  '720p': { audio: 16.0, noAudio: 8.0 },
  '1080p': { audio: 16.0, noAudio: 8.0 },
};

function normalizeModelId(modelId: string): string {
  const m = String(modelId || '').trim();
  if (m === 'doubao-seedance-2.0-260128') return 'doubao-seedance-2-0-260128';
  if (m === 'doubao-seedance-2.0-fast-260128') return 'doubao-seedance-2-0-fast-260128';
  return m;
}

function isLuminiaModel(model: string): boolean {
  const m = normalizeModelId(model);
  return m === 'luminia-2.0' || m === 'luminia-2.0-fast' || m.startsWith('luminia-');
}

function luminiaTier(resolution: string): 'sd' | '1080p' {
  return resolution === '1080p' ? '1080p' : 'sd';
}

type BillingRate = {
  price: number;
  divisor: number;
  pricingUnit: 'per_thousand' | 'per_million';
};

function resolveBillingRate(
  model: string,
  resolution: PriceEstimateOptions['resolution'],
  hasVideoInput: boolean,
): BillingRate | null {
  const id = normalizeModelId(model);

  if (isLuminiaModel(id)) {
    const tier = luminiaTier(resolution);
    if (id === 'luminia-2.0-fast') {
      if (tier === '1080p') return null;
      const table = hasVideoInput ? LUMINIA_2_0_FAST_PER_1K.video : LUMINIA_2_0_FAST_PER_1K.imageText;
      return { price: table.sd, divisor: 1000, pricingUnit: 'per_thousand' };
    }
    const table = hasVideoInput ? LUMINIA_2_0_PER_1K.video : LUMINIA_2_0_PER_1K.imageText;
    const price = table[tier];
    if (price == null) return null;
    return { price, divisor: 1000, pricingUnit: 'per_thousand' };
  }

  if (id === 'doubao-seedance-2-0-fast-260128' && resolution === '1080p') {
    return null;
  }

  if (id === 'doubao-seedance-2-0-260128') {
    const prices = SEEDANCE_2_0_PRICES[resolution];
    return {
      price: hasVideoInput ? prices.withVideoInput : prices.noVideoInput,
      divisor: 1_000_000,
      pricingUnit: 'per_million',
    };
  }
  if (id === 'doubao-seedance-2-0-fast-260128') {
    const prices = SEEDANCE_2_0_FAST_PRICES[resolution];
    return {
      price: hasVideoInput ? prices.withVideoInput : prices.noVideoInput,
      divisor: 1_000_000,
      pricingUnit: 'per_million',
    };
  }
  if (id === 'doubao-seedance-1-5-pro-251215') {
    const prices = SEEDANCE_1_5_PRO_PRICES[resolution];
    return { price: prices.audio, divisor: 1_000_000, pricingUnit: 'per_million' };
  }

  return null;
}

function estimateTokenUsage(options: PriceEstimateOptions): number {
  const { resolution, hasVideoInput = false, inputVideoDuration = 0, duration } = options;

  const resolutionSpecs = {
    '480p': {
      '16:9': { width: 864, height: 496 },
      '4:3': { width: 752, height: 560 },
      '1:1': { width: 640, height: 640 },
      '9:16': { width: 496, height: 864 },
    },
    '720p': {
      '16:9': { width: 1280, height: 720 },
      '4:3': { width: 1112, height: 834 },
      '1:1': { width: 960, height: 960 },
      '9:16': { width: 720, height: 1280 },
    },
    '1080p': {
      '16:9': { width: 1920, height: 1080 },
      '4:3': { width: 1440, height: 1080 },
      '1:1': { width: 1080, height: 1080 },
      '9:16': { width: 1080, height: 1920 },
    },
  };

  const spec = resolutionSpecs[resolution]['16:9'] || resolutionSpecs[resolution]['1:1'];
  const fps = 24;
  const totalDuration = hasVideoInput ? inputVideoDuration + duration : duration;
  return (totalDuration * spec.width * spec.height * fps) / 1024;
}

export function estimatePriceRange(options: PriceEstimateOptions): PriceRange | null {
  const { model, resolution, duration, hasVideoInput = false, inputVideoDuration = 0 } = options;

  const rate = resolveBillingRate(model, resolution, hasVideoInput);
  if (!rate) return null;

  const priceFromInput = (inputDur: number) => {
    const tokenUsage = estimateTokenUsage({
      model,
      resolution,
      duration,
      hasVideoInput,
      inputVideoDuration: inputDur,
    });
    return (tokenUsage / rate.divisor) * rate.price;
  };

  if (hasVideoInput) {
    return {
      minPrice: priceFromInput(2),
      maxPrice: priceFromInput(15),
      unitPrice: rate.price,
      pricingUnit: rate.pricingUnit,
    };
  }

  const price = priceFromInput(0);
  return {
    minPrice: price,
    maxPrice: price * 1.15,
    unitPrice: rate.price,
    pricingUnit: rate.pricingUnit,
  };
}

export function calculatePriceFromTokens(
  totalTokens: number,
  unitPrice: number,
  pricingUnit: 'per_thousand' | 'per_million' = 'per_million',
): number {
  const divisor = pricingUnit === 'per_thousand' ? 1000 : 1_000_000;
  return (totalTokens / divisor) * unitPrice;
}

export function formatPrice(price: number): string {
  return `${price.toFixed(2)} 积分`;
}

export function formatTokens(tokens: number): string {
  if (tokens === 0) return '0';
  if (tokens < 1000) return tokens.toFixed(0);
  return (tokens / 1000).toFixed(1) + 'k';
}
