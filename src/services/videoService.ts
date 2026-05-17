import type { GenerateVideoRequest, VideoGenerationResponse } from '../types';
import { getAuthHeaders } from './authService';

/** 提交接口偶发空 body 时避免 json() 抛错 */
async function parseSubmitResponseBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function submitFailureMessage(status: number, data: Record<string, unknown>): string {
  const serverMsg =
    (typeof data.message === 'string' && data.message.trim()) ||
    (typeof data.error === 'string' && data.error.trim()) ||
    '';

  if (status === 402) {
    return serverMsg ? `未加入项目/积分不足。（${serverMsg}）` : '未加入项目/积分不足。';
  }

  return serverMsg || `提交失败 (HTTP ${status})`;
}

export async function generateVideo(
  request: GenerateVideoRequest,
  onProgress?: (message: string) => void,
  /** 提交成功后立即回调，用于触发客户端归档等副作用 */
  onTaskSubmitted?: (ids: { taskId: string; dbTaskId?: number }) => void,
  projectId?: string,
  estimatedPrice?: number,
): Promise<VideoGenerationResponse> {
  const formData = new FormData();
  formData.append('prompt', request.prompt);
  formData.append('model', request.model);
  formData.append('ratio', request.ratio);
  formData.append('duration', String(request.duration));
  if (request.resolution) formData.append('resolution', request.resolution);
  if (typeof request.seed === 'number' && Number.isFinite(request.seed)) {
    formData.append('seed', String(request.seed));
  }
  if (typeof request.watermark === 'boolean') {
    formData.append('watermark', String(request.watermark));
  }
  if (typeof request.generateAudio === 'boolean') {
    formData.append('generate_audio', String(request.generateAudio));
  }

  for (const file of request.files) {
    formData.append('files', file);
  }
  for (const v of request.videoFiles || []) {
    formData.append('video', v);
  }
  for (const a of request.audioFiles || []) {
    formData.append('audio', a);
  }
  if (request.portraitIds?.length) {
    formData.append('portrait_ids', JSON.stringify(request.portraitIds));
  }

  // 第1步: 提交任务
  onProgress?.('正在提交视频生成请求...');
  const headers = getAuthHeaders();
  if (projectId) {
    headers['X-Project-Id'] = projectId;
  }
  if (estimatedPrice !== undefined) {
    headers['X-Estimated-Price'] = String(estimatedPrice);
  }
  
  const submitRes = await fetch('/api/generate-video', {
    method: 'POST',
    headers,
    body: formData,
  });

  const submitData = await parseSubmitResponseBody(submitRes);
  if (!submitRes.ok) {
    throw new Error(submitFailureMessage(submitRes.status, submitData));
  }

  const { taskId, dbTaskId } = submitData as { taskId?: string; dbTaskId?: number };
  if (!taskId) {
    throw new Error('服务器未返回任务ID');
  }
  onTaskSubmitted?.({ taskId, dbTaskId });

  // 第2步: 轮询获取结果
  onProgress?.('已提交，等待AI生成视频...');

  const maxPollTime = 25 * 60 * 1000; // 25 分钟
  const pollInterval = 3000; // 3 秒
  const startTime = Date.now();

  while (Date.now() - startTime < maxPollTime) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const pollRes = await fetch(`/api/task/${taskId}`);
    const pollData = await pollRes.json();

    if (pollData.status === 'done') {
      const result = pollData.result;
      if (result?.data?.[0]?.url) {
        return result;
      }
      throw new Error('未获取到视频结果');
    }

    if (pollData.status === 'error') {
      throw new Error(pollData.error || '视频生成失败');
    }

    if (pollData.progress) {
      onProgress?.(pollData.progress);
    }
  }

  throw new Error('视频生成超时，请稍后重试');
}
