/**
 * Luminia 素材库 API（/v1/assets/*）
 */

import { getLuminiaApiKey, LUMINIA_API_BASE_URL } from './luminiaConfig.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') return true;
  if (!err.status) return true;
  if (err.status === 429) return true;
  if (err.status >= 500 && err.status < 600) return true;
  return false;
}

async function luminiaAssetFetch(url, {
  apiKey = getLuminiaApiKey(),
  method = 'POST',
  body,
  timeout = 60000,
  maxAttempts = 3,
  baseDelayMs = 1000,
  credentialId,
}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const headers = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      };
      if (credentialId) {
        headers['X-Credential-Id'] = credentialId;
      }
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        const message = data?.error?.message || data?.message || data?.Message || `HTTP ${res.status}`;
        const err = new Error(message);
        err.status = res.status;
        err.response = data;
        throw err;
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isRetryableError(err)) throw err;
      await sleep(baseDelayMs * Math.pow(2, attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function unwrapResult(data) {
  return data?.Result ?? data?.result ?? data;
}

export function normalizeLuminiaAssetStatus(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'processing';
  const upper = s.toUpperCase();
  if (upper === 'ACTIVE' || upper === 'SUCCEEDED' || upper === 'SUCCESS') return 'active';
  if (upper === 'FAILED' || upper === 'FAILURE') return 'failed';
  if (upper === 'PROCESSING' || upper === 'NOT_START' || upper === 'SUBMITTED' || upper === 'QUEUED' || upper === 'IN_PROGRESS') {
    return 'processing';
  }
  return 'processing';
}

export async function createLuminiaAsset({ url, name = '', assetType = 'Image', groupId, credentialId, apiKey, baseUrl }) {
  const root = (baseUrl || LUMINIA_API_BASE_URL).replace(/\/$/, '');
  const body = { url, asset_type: assetType };
  if (name) body.name = name;
  if (groupId) body.group_id = groupId;

  const data = await luminiaAssetFetch(`${root}/v1/assets/create`, {
    apiKey,
    body,
    credentialId,
  });
  const result = unwrapResult(data);
  const id = result?.Id || result?.id || data?.id;
  if (!id) {
    throw new Error(`Luminia 素材创建未返回 Id: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { id: String(id), raw: data };
}

export async function getLuminiaAsset({ id, credentialId, apiKey, baseUrl }) {
  const root = (baseUrl || LUMINIA_API_BASE_URL).replace(/\/$/, '');
  const data = await luminiaAssetFetch(`${root}/v1/assets/get`, {
    apiKey,
    body: { id },
    credentialId,
  });
  const result = unwrapResult(data);
  const status = normalizeLuminiaAssetStatus(result?.Status || result?.status);
  return {
    id: String(result?.Id || result?.id || id),
    status,
    failReason: result?.FailReason || result?.fail_reason || result?.Message || '',
    raw: data,
  };
}

export async function deleteLuminiaAsset({ id, credentialId, apiKey, baseUrl }) {
  const root = (baseUrl || LUMINIA_API_BASE_URL).replace(/\/$/, '');
  return luminiaAssetFetch(`${root}/v1/assets/delete`, {
    apiKey,
    body: { id },
    credentialId,
  });
}

export async function pollLuminiaAssetUntilActive({
  id,
  timeoutMs = 120000,
  intervalMs = 5000,
  credentialId,
  onProgress,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const info = await getLuminiaAsset({ id, credentialId });
    if (info.status !== lastStatus) {
      lastStatus = info.status;
      if (onProgress) await onProgress(info.status);
    }
    if (info.status === 'active') return info;
    if (info.status === 'failed') {
      throw new Error(info.failReason || 'Luminia 素材预处理失败');
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待素材 Active 超时 (${Math.floor(timeoutMs / 1000)}s)`);
}

export default {
  createLuminiaAsset,
  getLuminiaAsset,
  deleteLuminiaAsset,
  pollLuminiaAssetUntilActive,
  normalizeLuminiaAssetStatus,
};
