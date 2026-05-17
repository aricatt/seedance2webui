/**
 * Luminia API 视频生成（luminia-2.0 / luminia-2.0-fast）
 */

import { buildSeedanceMediaContent } from './seedanceContentBuilder.js';
import { getLuminiaApiKey, LUMINIA_API_BASE_URL } from './luminiaConfig.js';

export const LUMINIA_TERMINAL_SUCCESS = new Set(['SUCCESS', 'succeeded', 'success']);
const LUMINIA_TERMINAL_FAILURE = new Set(['FAILURE', 'failed', 'failure']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maskApiKey(apiKey) {
  const normalized = String(apiKey || '').trim();
  if (!normalized) return '';
  if (normalized.length <= 6) return '***';
  return `...${normalized.slice(-6)}`;
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

async function luminiaFetch(url, {
  apiKey,
  method = 'GET',
  body,
  timeout = 60000,
  maxAttempts = 3,
  baseDelayMs = 1000,
  onRetry,
}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
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
        const message = data?.error?.message || data?.message || `HTTP ${res.status}: ${res.statusText}`;
        const err = new Error(message);
        err.status = res.status;
        err.response = data;
        throw err;
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isRetryableError(err)) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      if (onRetry) {
        try {
          await onRetry(`[luminia] 第 ${attempt}/${maxAttempts} 次调用失败 (${err.message}), ${delay}ms 后重试`);
        } catch (_) {}
      }
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export function normalizeLuminiaStatus(status) {
  return String(status || '').toUpperCase();
}

export function unwrapPollData(getResult) {
  if (getResult?.data && typeof getResult.data === 'object' && getResult.data.status != null) {
    return getResult.data;
  }
  return getResult;
}

function buildLuminiaCreateBody({
  model,
  prompt,
  imageUrls = [],
  videoUrl = '',
  videoUrls = [],
  audioUrl = '',
  audioUrls = [],
  ratio = '16:9',
  duration = 5,
  resolution,
  seed,
  generateAudio = true,
  watermark = false,
}) {
  const mediaContent = buildSeedanceMediaContent({
    imageUrls,
    videoUrl,
    videoUrls,
    audioUrl,
    audioUrls,
  });

  const metadata = {
    ratio: ratio || '16:9',
    duration: Number(duration) || 5,
    generate_audio: Boolean(generateAudio),
    watermark: Boolean(watermark),
  };

  if (resolution) {
    const res = String(resolution).toLowerCase();
    if (res === '480p' || res === '720p') {
      metadata.resolution = res;
    }
  }
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    metadata.seed = Math.trunc(seed);
  }
  if (mediaContent.length > 0) {
    metadata.content = mediaContent;
  }

  const body = {
    model: String(model || 'luminia-2.0').trim(),
    prompt: String(prompt || ''),
    metadata,
  };

  // 单图且无参考音视频时可用顶层 image 字段
  if (
    mediaContent.length === 1 &&
    mediaContent[0].type === 'image_url' &&
    !videoUrl &&
    (!videoUrls || videoUrls.length === 0) &&
    !audioUrl &&
    (!audioUrls || audioUrls.length === 0)
  ) {
    body.image = mediaContent[0].image_url.url;
    delete metadata.content;
  }

  return body;
}

export async function createLuminiaTask(opts) {
  const apiKey = opts.apiKey || getLuminiaApiKey();
  const baseUrl = (opts.baseUrl || LUMINIA_API_BASE_URL).replace(/\/$/, '');
  const body = buildLuminiaCreateBody(opts);

  const result = await luminiaFetch(`${baseUrl}/v1/video/generations`, {
    apiKey,
    method: 'POST',
    body,
    onRetry: opts.onRetry,
  });

  const taskId = result?.id || result?.task_id;
  if (!taskId) {
    throw new Error(`创建 Luminia 任务失败: 未返回 task_id, raw=${JSON.stringify(result).slice(0, 200)}`);
  }
  return { ...result, id: taskId, task_id: taskId };
}

export async function getLuminiaTask({ apiKey, baseUrl = LUMINIA_API_BASE_URL, taskId, onRetry }) {
  if (!apiKey) throw new Error('LUMINIA_API_KEY 不能为空');
  if (!taskId) throw new Error('taskId 不能为空');
  const url = `${baseUrl.replace(/\/$/, '')}/v1/video/generations/${encodeURIComponent(taskId)}`;
  return luminiaFetch(url, { apiKey, method: 'GET', timeout: 30000, onRetry });
}

export async function pollLuminiaTaskUntilDone({
  apiKey = getLuminiaApiKey(),
  baseUrl = LUMINIA_API_BASE_URL,
  taskId,
  pollIntervalMs = 15000,
  maxWaitMs = 3600 * 1000,
  prompt = '',
  onProgress = () => {},
  onVideoReady = () => {},
}) {
  if (!taskId) throw new Error('taskId 不能为空');

  const deadline = Date.now() + maxWaitMs;
  let lastStatus = '';
  let rawFinal = null;

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);

    let getResult;
    try {
      getResult = await getLuminiaTask({
        apiKey,
        baseUrl,
        taskId,
        onRetry: (msg) => onProgress(msg),
      });
    } catch (err) {
      await onProgress(`查询任务状态失败 (${err.message}), 稍后继续尝试...`);
      continue;
    }

    const data = unwrapPollData(getResult);
    const status = normalizeLuminiaStatus(data?.status);
    rawFinal = getResult;

    if (status !== lastStatus) {
      lastStatus = status;
      const progress = data?.progress != null ? String(data.progress) : '';
      await onProgress(`任务状态: ${status || 'unknown'}${progress ? ` (${progress})` : ''}`);
    }

    if (LUMINIA_TERMINAL_SUCCESS.has(status)) {
      const finalVideoUrl = data?.result_url || '';
      if (!finalVideoUrl) {
        throw new Error('任务已成功, 但接口未返回 result_url');
      }
      await onVideoReady(finalVideoUrl);
      const usage = data?.data?.usage || data?.usage || null;
      return {
        videoUrl: finalVideoUrl,
        submitId: taskId,
        historyId: taskId,
        itemId: taskId,
        revisedPrompt: prompt || '',
        raw: getResult,
        usage,
      };
    }

    if (LUMINIA_TERMINAL_FAILURE.has(status)) {
      const errMsg = data?.fail_reason || data?.message || '未知原因';
      throw new Error(`Luminia 任务失败: ${errMsg}`);
    }
  }

  throw new Error(
    `Luminia 任务轮询超时 (> ${Math.floor(maxWaitMs / 1000)}s), 最后状态=${lastStatus}, raw=${JSON.stringify(rawFinal || {}).slice(0, 200)}`
  );
}

export async function generateLuminiaVideo(opts) {
  const {
    apiKey = getLuminiaApiKey(),
    baseUrl = LUMINIA_API_BASE_URL,
    model = 'luminia-2.0',
    pollIntervalMs = 15000,
    maxWaitMs = 3600 * 1000,
    onProgress = () => {},
    onSubmitId = () => {},
    onHistoryId = () => {},
    onVideoReady = () => {},
    prompt = '',
    ...createOpts
  } = opts;

  await onProgress(`正在创建 Luminia 生成任务 (model=${model}, api_key=${maskApiKey(apiKey)})`);

  const createResult = await createLuminiaTask({
    apiKey,
    baseUrl,
    model,
    prompt,
    ...createOpts,
    onRetry: (msg) => onProgress(msg),
  });

  const taskId = createResult.id;
  await onSubmitId(taskId);
  await onHistoryId(taskId);
  await onProgress(`任务已提交, taskId=${taskId}, 正在等待生成...`);

  return pollLuminiaTaskUntilDone({
    apiKey,
    baseUrl,
    taskId,
    pollIntervalMs,
    maxWaitMs,
    prompt,
    onProgress,
    onVideoReady,
  });
}

export default {
  generateLuminiaVideo,
  pollLuminiaTaskUntilDone,
  createLuminiaTask,
  getLuminiaTask,
};
