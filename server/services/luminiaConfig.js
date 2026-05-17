/**
 * Luminia API 配置
 */

export const LUMINIA_API_BASE_URL =
  (process.env.LUMINIA_API_BASE_URL || 'https://luapi.hagoot.com').replace(/\/$/, '');

export function getLuminiaApiKey() {
  const key = (process.env.LUMINIA_API_KEY || '').trim();
  if (!key) {
    throw new Error(
      'LUMINIA_API_KEY 未配置。请在服务端 .env 中设置 Luminia API Key。'
    );
  }
  return key;
}

export function isLuminiaApiKeyConfigured() {
  return Boolean((process.env.LUMINIA_API_KEY || '').trim());
}
