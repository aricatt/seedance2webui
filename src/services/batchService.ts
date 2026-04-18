import type {
  ApiResponse,
  BatchStartResult,
  BatchStatus,
  BatchStatusDetail,
  BatchTaskSnapshot,
  InvalidBatchTask,
  TaskStatus,
} from '../types/index';
import { getAuthHeaders } from './authService';

const API_BASE = '/api';

export class BatchServiceError extends Error {
  invalidTasks: InvalidBatchTask[];

  constructor(message: string, invalidTasks: InvalidBatchTask[] = []) {
    super(message);
    this.name = 'BatchServiceError';
    this.invalidTasks = invalidTasks;
  }
}

function normalizeBatchStatus(status: string | undefined): BatchStatus {
  switch (status) {
    case 'running':
    case 'paused':
    case 'done':
    case 'error':
    case 'cancelled':
    case 'pending':
      return status;
    case 'completed':
      return 'done';
    default:
      return 'pending';
  }
}

function normalizeTaskStatus(status: string | undefined): TaskStatus {
  switch (status) {
    case 'generating':
    case 'done':
    case 'error':
    case 'cancelled':
    case 'pending':
      return status;
    case 'completed':
      return 'done';
    default:
      return 'pending';
  }
}

function normalizeBatchTask(task: any): BatchTaskSnapshot {
  return {
    taskId: Number(task.taskId ?? task.task_id ?? 0),
    prompt: task.prompt ?? '',
    status: normalizeTaskStatus(task.status),
    progress: task.progress ?? undefined,
    errorMessage: task.errorMessage ?? task.error_message ?? undefined,
    submitId: task.submitId ?? task.submit_id ?? undefined,
    historyId: task.historyId ?? task.history_id ?? undefined,
    itemId: task.itemId ?? task.item_id ?? undefined,
    videoUrl: task.videoUrl ?? task.video_url ?? undefined,
    sourceTaskId: typeof (task.sourceTaskId ?? task.source_task_id) === 'number'
      ? Number(task.sourceTaskId ?? task.source_task_id)
      : undefined,
    rowGroupId: task.rowGroupId ?? task.row_group_id ?? undefined,
    outputIndex: typeof (task.outputIndex ?? task.output_index) === 'number'
      ? Number(task.outputIndex ?? task.output_index)
      : undefined,
    assetCount: typeof task.assetCount === 'number'
      ? task.assetCount
      : typeof task.asset_count === 'number'
        ? task.asset_count
        : undefined,
  };
}

function normalizeBatchStatusDetail(data: any): BatchStatusDetail {
  return {
    batchId: Number(data.batchId ?? data.batch_id ?? 0),
    projectId: Number(data.projectId ?? data.project_id ?? 0),
    name: data.name ?? undefined,
    status: normalizeBatchStatus(data.status),
    totalCount: Number(data.totalCount ?? data.total_count ?? 0),
    completedCount: Number(data.completedCount ?? data.completed_count ?? 0),
    failedCount: Number(data.failedCount ?? data.failed_count ?? 0),
    cancelledCount: Number(data.cancelledCount ?? data.cancelled_count ?? 0),
    currentRunning: Number(data.currentRunning ?? data.current_running ?? 0),
    queueLength: Number(data.queueLength ?? data.queue_length ?? 0),
    concurrentCount: Number(data.concurrentCount ?? data.concurrent_count ?? 0),
    createdAt: data.createdAt ?? data.created_at ?? undefined,
    startedAt: data.startedAt ?? data.started_at ?? undefined,
    completedAt: data.completedAt ?? data.completed_at ?? undefined,
    tasks: Array.isArray(data.tasks) ? data.tasks.map(normalizeBatchTask) : [],
  };
}

function extractInvalidTasks(result: ApiResponse | (ApiResponse & { invalidTasks?: InvalidBatchTask[] })): InvalidBatchTask[] {
  const invalidTasks = (result as { invalidTasks?: InvalidBatchTask[] }).invalidTasks;
  return Array.isArray(invalidTasks) ? invalidTasks : [];
}

/**
 * 创建并启动批量任务
 */
export async function startBatchGenerate(
  projectId: number,
  taskIds: number[],
  options?: {
    name?: string;
    concurrent?: number;
  }
): Promise<BatchStartResult> {
  const response = await fetch(`${API_BASE}/batch/generate`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      projectId,
      taskIds,
      name: options?.name || '',
      concurrent: options?.concurrent || 5,
    }),
  });
  const result: ApiResponse<BatchStartResult> & { invalidTasks?: InvalidBatchTask[] } =
    await response.json();
  if (!response.ok || !result.success) {
    throw new BatchServiceError(
      result.error || '批量生成失败',
      extractInvalidTasks(result),
    );
  }
  return result.data!;
}

/**
 * 获取批量任务状态
 */
export async function getBatchStatus(batchId: number): Promise<BatchStatusDetail> {
  const response = await fetch(`${API_BASE}/batch/${batchId}/status`, {
    headers: getAuthHeaders(),
  });
  const result: ApiResponse<Record<string, unknown>> = await response.json();
  if (!response.ok || !result.success || !result.data) {
    throw new Error(result.error || '获取批量状态失败');
  }
  return normalizeBatchStatusDetail(result.data);
}

/**
 * 暂停批量任务
 */
export async function pauseBatch(batchId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/batch/${batchId}/pause`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const result: ApiResponse = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || '暂停批量任务失败');
  }
}

/**
 * 恢复批量任务
 */
export async function resumeBatch(batchId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/batch/${batchId}/resume`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const result: ApiResponse = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || '恢复批量任务失败');
  }
}

/**
 * 取消批量任务
 */
export async function cancelBatch(batchId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/batch/${batchId}/cancel`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const result: ApiResponse = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || '取消批量任务失败');
  }
}

/**
 * 批量二次采集视频（重新获取视频 URL）
 */
export async function collectBatchVideos(batchId: number): Promise<{
  success: boolean;
  collectedCount: number;
}> {
  const response = await fetch(`${API_BASE}/batch/${batchId}/collect`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const result: ApiResponse<{ success: boolean; collectedCount: number }> =
    await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || '批量采集视频失败');
  }
  return result.data!;
}

export default {
  startBatchGenerate,
  getBatchStatus,
  pauseBatch,
  resumeBatch,
  cancelBatch,
  collectBatchVideos,
};
