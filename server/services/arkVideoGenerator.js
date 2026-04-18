/**
 * 方舟 (Volcengine Ark) 官方 API 视频生成服务
 *
 * 直接调用方舟官方的 content generation tasks 接口, 对应 Python SDK:
 *   client.content_generation.tasks.create(...)
 *   client.content_generation.tasks.get(task_id=...)
 *
 * 特点:
 *  - 参考图片 / 视频 / 音频 通过方舟 /api/v3/files 预上传, content 中直接引用 file-xxx
 *    (见 arkFileUploader.js, 无需公网 URL, 适合内网部署)
 *  - 创建任务和查询任务均带指数退避重试 (扛过 429/5xx/网络抖动)
 */

import { ARK_API_BASE_URL, ARK_DEFAULT_MODEL, getArkApiKey } from './arkConfig.js';

export const ARK_MODEL_MAP = {
  // 别名 -> 官方 Model ID (可按需扩展)
  'doubao-seedance-2-0': ARK_DEFAULT_MODEL,
  'doubao-seedance-2-0-fast': 'doubao-seedance-2-0-fast-260128',
};

export function resolveArkModelId(modelKey) {
  const trimmed = String(modelKey || '').trim();
  if (!trimmed) return ARK_DEFAULT_MODEL;
  return ARK_MODEL_MAP[trimmed] || trimmed;
}

// ============================================================
// Base64 编码辅助
// ============================================================

const IMAGE_MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

/**
 * 将图片 buffer 编码为 data URI
 * @param {Buffer} buffer 图片二进制
 * @param {string} mimetype 原始 mimetype, 如 'image/jpeg'
 * @param {string} [originalName] 用于从扩展名兜底推断 mime
 */
export function bufferToDataUri(buffer, mimetype, originalName = '') {
  let mime = (mimetype || '').toLowerCase();
  if (!mime || !mime.startsWith('image/')) {
    const ext = (originalName.split('.').pop() || '').toLowerCase();
    mime = IMAGE_MIME_BY_EXT[ext] || 'image/jpeg';
  }
  const base64 = Buffer.isBuffer(buffer) ? buffer.toString('base64') : Buffer.from(buffer).toString('base64');
  return `data:${mime};base64,${base64}`;
}

function maskApiKey(apiKey) {
  const normalized = String(apiKey || '').trim();
  if (!normalized) return '';
  if (normalized.length <= 6) return '***';
  return `...${normalized.slice(-6)}`;
}

// ============================================================
// 内容构造
// ============================================================

/**
 * 构造方舟 content 列表。
 *
 * 方舟 API 对 image 的 role 有严格规则:
 * - 单图 → 图生视频: role = "first_frame"
 * - 首尾帧: 两张图 role 分别为 "first_frame" / "last_frame" (调用方需显式传入)
 * - 多参考图模式 (2-4 张): 所有图 role 必须统一为 "reference_image", 不能带序号
 *
 * 本函数默认按图片数量自动选择:
 *   1 张 → first_frame
 *   2+ 张 → 全部 reference_image
 *
 * 若调用方已知更精确的角色 (例如首尾帧), 可传入 `[{ url, role }]` 对象数组。
 */
function normalizeUrlList(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  return arr
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean);
}

/**
 * 占位说明:
 * 视频/音频 URL 现在由 TOS 预签名 URL 提供 (真实可下载的 HTTPS URL).
 * 不再需要 file_id / placeholder 机制.
 */

function buildContent({
  prompt,
  imageUrls = [],
  videoUrl = '',
  videoUrls = [],
  audioUrl = '',
  audioUrls = [],
}) {
  const content = [];
  if (prompt && String(prompt).trim()) {
    content.push({ type: 'text', text: String(prompt) });
  }

  const items = imageUrls
    .map((item) => (typeof item === 'string' ? { url: item } : item))
    .filter((item) => item && item.url);

  const hasExplicitRoles = items.some((item) => item.role);
  const defaultRole = items.length <= 1 ? 'first_frame' : 'reference_image';

  items.forEach((item) => {
    content.push({
      type: 'image_url',
      image_url: { url: item.url },
      role: item.role || (hasExplicitRoles ? 'reference_image' : defaultRole),
    });
  });

  // 视频: 直接使用 HTTPS URL (TOS 预签名 URL 或公网 URL)
  const videos = [...normalizeUrlList(videoUrl), ...normalizeUrlList(videoUrls)];
  videos.forEach((url) => {
    content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
  });

  // 音频: 同上
  const audios = [...normalizeUrlList(audioUrl), ...normalizeUrlList(audioUrls)];
  audios.forEach((url) => {
    content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' });
  });
  return content;
}


// ============================================================
// HTTP 调用 + 重试
// ============================================================

/**
 * 判断错误是否值得重试
 * - 网络错误 / 超时: 重试
 * - HTTP 429 (限流), 5xx (服务端抖动): 重试
 * - HTTP 4xx (除 429): 不重试 (参数错, 认证错)
 */
function isRetryableError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true; // 本端超时
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') return true;
  if (!err.status) return true; // fetch 层错误 (无 HTTP 状态)
  if (err.status === 429) return true;
  if (err.status >= 500 && err.status < 600) return true;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带指数退避重试的 fetch 封装
 * @param {object} opts
 * @param {number} [opts.maxAttempts=3] 最多尝试次数
 * @param {number} [opts.baseDelayMs=1000] 初始等待
 * @param {number} [opts.timeout=60000] 单次请求超时
 * @param {(msg:string)=>any} [opts.onRetry]
 */
async function arkFetch(url, {
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
      try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }

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
        try { await onRetry(`[ark] 第 ${attempt}/${maxAttempts} 次调用失败 (${err.message}), ${delay}ms 后重试`); } catch (_) {}
      }
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// ============================================================
// 主要 API
// ============================================================

/**
 * 创建生成任务
 */
export async function createArkTask({
  apiKey,
  baseUrl = ARK_API_BASE_URL,
  model,
  prompt,
  imageUrls = [],
  videoUrl = '',
  videoUrls = [],
  audioUrl = '',
  audioUrls = [],
  ratio = '16:9',
  duration = 5,
  generateAudio = true,
  watermark = false,
  onRetry,
}) {
  if (!apiKey) throw new Error('ARK_API_KEY 不能为空');

  const payload = {
    model: resolveArkModelId(model),
    content: buildContent({ prompt, imageUrls, videoUrl, videoUrls, audioUrl, audioUrls }),
    ratio,
    duration: Number(duration) || 5,
    generate_audio: Boolean(generateAudio),
    watermark: Boolean(watermark),
  };

  // 日志: 截断 data URI / 长 URL, 避免刷屏
  const safeContent = payload.content.map((c) => {
    const out = { ...c };
    for (const k of ['image_url', 'video_url', 'audio_url']) {
      if (out[k]?.url && out[k].url.length > 120) {
        out[k] = { ...out[k], url: out[k].url.slice(0, 80) + '...[truncated]' };
      }
    }
    if (out.type === 'text' && out.text && out.text.length > 120) {
      out.text = out.text.slice(0, 80) + '...[truncated]';
    }
    return out;
  });
  console.log('[ark] createArkTask payload:', JSON.stringify({ ...payload, content: safeContent }, null, 2));

  return arkFetch(`${baseUrl.replace(/\/$/, '')}/contents/generations/tasks`, {
    apiKey,
    method: 'POST',
    body: payload,
    onRetry,
  });
}

/**
 * 查询任务状态
 */
export async function getArkTask({ apiKey, baseUrl = ARK_API_BASE_URL, taskId, onRetry }) {
  if (!apiKey) throw new Error('ARK_API_KEY 不能为空');
  if (!taskId) throw new Error('taskId 不能为空');
  return arkFetch(`${baseUrl.replace(/\/$/, '')}/contents/generations/tasks/${taskId}`, {
    apiKey,
    method: 'GET',
    timeout: 30000,
    onRetry,
  });
}

/**
 * 一体化: 创建任务 + 轮询直至完成
 *
 * @param {object} opts
 * @param {string} [opts.apiKey]          方舟 API Key (缺省则从环境变量读取)
 * @param {string} [opts.baseUrl]
 * @param {string} [opts.model]
 * @param {string} opts.prompt
 * @param {string[]} [opts.imageUrls]     参考图片 URL 列表 (http(s) 或 data:image/xxx;base64,...)
 * @param {string} [opts.videoUrl]
 * @param {string} [opts.audioUrl]
 * @param {string} [opts.ratio]           画面比例, 默认 16:9
 * @param {number} [opts.duration]        时长 (秒), 默认 5
 * @param {boolean} [opts.generateAudio]  是否生成音频
 * @param {boolean} [opts.watermark]      是否水印
 * @param {number} [opts.pollIntervalMs]  轮询间隔, 默认 15s
 * @param {number} [opts.maxWaitMs]       最大等待, 默认 15 分钟
 * @param {(progress:string)=>any} [opts.onProgress]
 * @param {(taskId:string)=>any}   [opts.onSubmitId]
 * @param {(taskId:string)=>any}   [opts.onHistoryId]
 * @param {(url:string)=>any}      [opts.onVideoReady]
 */
export async function generateArkVideo(opts) {
  const {
    apiKey = getArkApiKey(),
    baseUrl = ARK_API_BASE_URL,
    model,
    prompt,
    imageUrls = [],
    videoUrl: refVideoUrl = '',
    videoUrls = [],
    audioUrl = '',
    audioUrls = [],
    ratio = '16:9',
    duration = 5,
    generateAudio = true,
    watermark = false,
    pollIntervalMs = 15000,
    maxWaitMs = 15 * 60 * 1000,
    onProgress = () => {},
    onSubmitId = () => {},
    onHistoryId = () => {},
    onVideoReady = () => {},
  } = opts;

  const resolvedModel = resolveArkModelId(model);
  const handleRetry = (msg) => onProgress(msg);

  await onProgress(`正在创建方舟生成任务 (model=${resolvedModel}, api_key=${maskApiKey(apiKey)})`);

  const createResult = await createArkTask({
    apiKey,
    baseUrl,
    model,
    prompt,
    imageUrls,
    videoUrl: refVideoUrl,
    videoUrls,
    audioUrl,
    audioUrls,
    ratio,
    duration,
    generateAudio,
    watermark,
    onRetry: handleRetry,
  });

  const taskId = createResult?.id;
  if (!taskId) {
    throw new Error(`创建任务失败: 接口未返回 task id, raw=${JSON.stringify(createResult).slice(0, 200)}`);
  }

  await onSubmitId(taskId);
  await onHistoryId(taskId);
  await onProgress(`任务已提交, taskId=${taskId}, 正在等待生成...`);

  return pollArkTaskUntilDone({
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

/**
 * 独立的轮询函数: 用于服务启动时恢复未完成的任务, 或重试已创建的任务
 */
export async function pollArkTaskUntilDone({
  apiKey = getArkApiKey(),
  baseUrl = ARK_API_BASE_URL,
  taskId,
  pollIntervalMs = 15000,
  maxWaitMs = 15 * 60 * 1000,
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
      getResult = await getArkTask({
        apiKey, baseUrl, taskId,
        onRetry: (msg) => onProgress(msg),
      });
    } catch (err) {
      await onProgress(`查询任务状态失败 (${err.message}), 稍后继续尝试...`);
      continue;
    }

    const status = getResult?.status || '';
    rawFinal = getResult;

    if (status !== lastStatus) {
      lastStatus = status;
      await onProgress(`任务状态: ${status || 'unknown'}`);
    }

    if (status === 'succeeded') {
      const finalVideoUrl = getResult?.content?.video_url || '';
      if (!finalVideoUrl) {
        throw new Error('任务已成功, 但接口未返回 video_url');
      }
      await onVideoReady(finalVideoUrl);
      return {
        videoUrl: finalVideoUrl,
        submitId: taskId,
        historyId: taskId,
        itemId: taskId,
        revisedPrompt: getResult?.content?.revised_prompt || prompt || '',
        raw: getResult,
      };
    }
    if (status === 'failed') {
      const errMsg = getResult?.error?.message || getResult?.error?.code || JSON.stringify(getResult?.error || {});
      throw new Error(`方舟任务失败: ${errMsg || '未知原因'}`);
    }
    if (status === 'cancelled') {
      throw new Error('方舟任务已被取消');
    }
  }

  throw new Error(
    `方舟任务轮询超时 (> ${Math.floor(maxWaitMs / 1000)}s), 最后状态=${lastStatus}, raw=${JSON.stringify(rawFinal || {}).slice(0, 200)}`
  );
}

export default {
  generateArkVideo,
  pollArkTaskUntilDone,
  createArkTask,
  getArkTask,
  resolveArkModelId,
  bufferToDataUri,
  ARK_MODEL_MAP,
};
