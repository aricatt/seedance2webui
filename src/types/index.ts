/**
 * 原有类型定义（从 types.ts 迁移过来）
 */
export type AspectRatio = '21:9' | '16:9' | '4:3' | '1:1' | '3:4' | '9:16';

export type Duration = 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

/**
 * 方舟官方视频生成模型 ID
 * 参考: https://www.volcengine.com/docs/82379
 */
export type ModelId =
  | 'doubao-seedance-2-0-260128'       // Seedance 2.0 (完整版)
  | 'doubao-seedance-2-0-fast-260128'; // Seedance 2.0 Fast (更快但画质略低)

// ============================================================
// 用户认证类型
// ============================================================

export interface User {
  id: number;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'disabled';
  credits: number;
  createdAt?: string;
  updatedAt?: string;
  lastCheckInAt?: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterCredentials {
  email: string;
  password: string;
  emailCode: string;
}

export interface AuthResponse {
  sessionId: string;
  user: User;
}

export interface ModelOption {
  value: ModelId;
  label: string;
  description: string;
}

export interface AppViewOption {
  id: AppView;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  accent?: string;
}

export enum AppView {
  LOGIN = 'LOGIN',
  REGISTER = 'REGISTER',
  SINGLE_TASK = 'SINGLE_TASK',
  BATCH_MANAGEMENT = 'BATCH_MANAGEMENT',
  DOWNLOAD_MANAGEMENT = 'DOWNLOAD_MANAGEMENT',
  SETTINGS = 'SETTINGS',
  ADMIN = 'ADMIN',
  PROFILE = 'PROFILE',
}



export interface UploadedImage {
  id: string;
  file: File;
  previewUrl: string;
  index: number;
}

export interface GenerateVideoRequest {
  prompt: string;
  model: ModelId;
  ratio: AspectRatio;
  duration: Duration;
  /** 参考图片, 官方允许 1~9 张 */
  files: File[];
  /** 参考视频, 官方允许 0~3 段, 总时长 <= 15s */
  videoFiles?: File[];
  /** 参考音频, 官方允许 0~3 段, 总时长 <= 15s */
  audioFiles?: File[];
}

export interface VideoGenerationResponse {
  created: number;
  data: Array<{
    url: string;
    revised_prompt: string;
  }>;
}

export type GenerationStatus = 'idle' | 'generating' | 'success' | 'error';

export interface GenerationState {
  status: GenerationStatus;
  progress?: string;
  result?: VideoGenerationResponse;
  error?: string;
}

export interface RatioOption {
  value: AspectRatio;
  label: string;
  widthRatio: number;
  heightRatio: number;
}

export const RATIO_OPTIONS: RatioOption[] = [
  { value: '21:9', label: '21:9', widthRatio: 21, heightRatio: 9 },
  { value: '16:9', label: '16:9', widthRatio: 16, heightRatio: 9 },
  { value: '4:3', label: '4:3', widthRatio: 4, heightRatio: 3 },
  { value: '1:1', label: '1:1', widthRatio: 1, heightRatio: 1 },
  { value: '3:4', label: '3:4', widthRatio: 3, heightRatio: 4 },
  { value: '9:16', label: '9:16', widthRatio: 9, heightRatio: 16 },
];

export const DURATION_OPTIONS: Duration[] = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];



export const MODEL_OPTIONS: ModelOption[] = [
  {
    value: 'doubao-seedance-2-0-260128',
    label: 'Seedance 2.0',
    description: '火山方舟官方 Seedance 2.0, 默认画质最好, 支持图生视频与音视频一体化',
  },
  {
    value: 'doubao-seedance-2-0-fast-260128',
    label: 'Seedance 2.0 Fast',
    description: '更快的推理速度, 适合批量快速出稿, 画面细节略低于完整版',
  },
];

/**
 * 项目管理相关类型定义（新增）
 */

/**
 * 项目
 */
export interface Project {
  id: number;
  name: string;
  description?: string;
  settings_json?: string;
  video_save_path?: string;
  default_concurrent?: number;
  default_min_interval?: number;
  default_max_interval?: number;
  task_count?: number;
  completed_count?: number;
  created_at: string;
  updated_at: string;
}

/**
 * 项目设置
 */
export interface ProjectSettings {
  model?: string;
  ratio?: string;
  duration?: number;
  referenceMode?: string;
}

/**
 * 任务
 */
export interface Task {
  id: number;
  project_id: number;
  batch_id?: number;
  prompt: string;
  task_kind: TaskKind;
  source_task_id?: number | null;
  row_group_id?: string | null;
  row_index?: number | null;
  video_count: number;
  output_index?: number | null;
  status: TaskStatus;
  submit_id?: string | null;
  history_id?: string | null;
  item_id?: string | null;
  video_url?: string | null;
  video_path?: string | null;
  download_status?: DownloadStatus | null;
  download_path?: string | null;
  downloaded_at?: string | null;
  submitted_at?: string | null;
  account_info?: string | null;
  progress?: string | null;
  audio_path?: string;
  audio_uri?: string;
  send_count?: number;
  last_sent_at?: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  error_message?: string | null;
  retry_count?: number;
  project_name?: string;
  assets?: TaskAsset[];
}

export type TaskKind = 'draft' | 'output';

/**
 * 任务状态
 */
export type TaskStatus =
  | 'pending'     // 等待中
  | 'generating'  // 生成中
  | 'done'        // 已完成
  | 'error'       // 出错
  | 'cancelled';  // 已取消

/**
 * 任务素材
 */
export interface TaskAsset {
  id: number;
  task_id: number;
  asset_type: 'image' | 'audio';
  file_path: string;
  image_uri?: string;
  sort_order: number;
}

/**
 * 批量任务
 */
export interface Batch {
  id: number;
  name?: string;
  project_id: number;
  task_ids: string; // JSON 数组
  status: BatchStatus;
  total_count: number;
  completed_count: number;
  failed_count: number;
  cancelled_count: number;
  concurrent_count: number;
  min_interval: number;
  max_interval: number;
  created_at: string;
  started_at?: string;
  completed_at?: string;
}

/**
 * 批量任务状态
 */
export type BatchStatus =
  | 'pending'    // 等待中
  | 'running'    // 运行中
  | 'paused'     // 已暂停
  | 'done'       // 已完成
  | 'error'      // 出错
  | 'cancelled'; // 已取消

export interface BatchTaskSnapshot {
  taskId: number;
  prompt: string;
  status: TaskStatus;
  progress?: string;
  errorMessage?: string;
  submitId?: string;
  historyId?: string;
  itemId?: string;
  videoUrl?: string;
  sourceTaskId?: number;
  rowGroupId?: string;
  outputIndex?: number;
  assetCount?: number;
}

export interface BatchStatusDetail {
  batchId: number;
  projectId: number;
  name?: string;
  status: BatchStatus;
  totalCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  currentRunning: number;
  queueLength: number;
  concurrentCount: number;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  tasks: BatchTaskSnapshot[];
}

export interface InvalidBatchTask {
  taskId: number;
  prompt: string;
  reason: string;
}

export interface BatchStartResult {
  batchId: number;
  totalTasks: number;
}

/**
 * 全局设置
 */
export interface Settings {
  model?: string;
  ratio?: string;
  duration?: string;
  download_path?: string;
  max_concurrent?: string;
  min_interval?: string;
  max_interval?: string;
}

/**
 * 定时任务
 */
export interface Schedule {
  id: number;
  name: string;
  project_id?: number;
  task_ids?: string; // JSON 数组
  cron_expression: string;
  enabled: number;
  last_run_at?: string;
  next_run_at?: string;
  created_at: string;
}

/**
 * API 响应
 */
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * 生成历史
 */
export interface GenerationHistory {
  id: number;
  task_id: number;
  batch_id?: string;
  request_data?: string;
  response_data?: string;
  created_at: string;
}

/**
 * 下载管理相关类型定义（新增）
 */

/**
 * 下载状态
 */
export type DownloadStatus =
  | 'pending'     // 待下载
  | 'downloading' // 下载中
  | 'done'        // 已下载
  | 'failed'      // 下载失败
  | 'generating'; // 生成中

/**
 * 下载任务
 */
export interface DownloadTask {
  id: number;
  prompt: string;
  status: TaskStatus;
  download_status: DownloadStatus;
  video_url?: string;
  video_path?: string;
  download_path?: string;
  downloaded_at?: string;
  account_info?: string;
  submit_id?: string;
  history_id?: string;
  created_at: string;
  completed_at?: string;
  project_name?: string;
  user_email?: string;
  hasHistory: boolean;
  model_type: 'image' | 'video';
  effective_download_status: DownloadStatus;
}

/**
 * 下载任务列表（分页）
 */
export interface DownloadTaskList {
  tasks: DownloadTask[];
  total: number;
  page: number;
  pageSize: number;
}
