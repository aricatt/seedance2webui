import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import * as downloadService from '../services/downloadService';
import type { DownloadScopePayload } from '../services/downloadService';
import type { DownloadTask } from '../types/index';
import { useToast } from '../components/Toast';
import { useApp } from '../context/AppContext';
import { getAuthHeaders } from '../services/authService';
import { formatDbTime, parseDbTimeMs } from '../utils/datetime';
import { wrapExternalMediaForBrowser } from '../utils/tosImage';
import { formatTokens, formatPrice } from '../utils/priceCalculator';

/** 能否从远端拉取视频（方舟 URL 或已写入持久桶） */
function taskHasArchive(
  task: Pick<DownloadTask, 'archive_path' | 'persist_archive_key'>,
): boolean {
  return !!(
    String(task.persist_archive_key || '').trim() ||
    String(task.archive_path || '').trim()
  );
}

function taskHasRemoteVideo(
  task: Pick<DownloadTask, 'video_url' | 'persist_video_key' | 'persist_video_tos_url'>,
): boolean {
  return !!(
    String(task.video_url || '').trim() ||
    task.persist_video_key ||
    String(task.persist_video_tos_url || '').trim().startsWith('http')
  );
}

/**
 * 详情 / 播放提示 / 预览脚注：只展示 TOS 持久化 canonical；
 * 未落 TOS 的老任务才退回方舟 video_url（不展示预签名展示链）。
 */
function videoReferenceCanonicalOrLegacy(
  task: Pick<DownloadTask, 'persist_video_tos_url' | 'video_url'>,
): string {
  const canon = String(task.persist_video_tos_url || '').trim();
  if (canon.startsWith('http')) return canon;
  return String(task.video_url || '').trim();
}

/** 封面 canonical URL（无签名，与库内 persist_cover_tos_url 一致） */
function sdCoverCanonicalUrl(task: DownloadTask): string {
  return String(task.persist_cover_tos_url || '').trim();
}

/** 列表缩略图：仅用同源 /api/tos/persist-image（勿把 TOS 预签名给 img 直连） */
function sdCoverListImgSrc(task: DownloadTask): string | null {
  const src = String(task.persist_cover_display_url || '').trim();
  if (!src.startsWith('/api/tos/persist-image')) return null;
  return src;
}

/** 旧任务无封面：视频首帧经 video-proxy，避免浏览器直连方舟/TOS */
function sdCoverListVideoThumbSrc(task: DownloadTask): string | null {
  const u = String(task.legacy_video_thumb_url || '').trim();
  if (!u) return null;
  return wrapExternalMediaForBrowser(u);
}

/** 列表封面悬停：只展示无签名对象地址（不展示预签名 img.src） */
function sdCoverHoverTitle(task: DownloadTask): string {
  const canon = sdCoverCanonicalUrl(task);
  if (canon.startsWith('http')) return canon;
  return '暂无封面对象地址（持久化未完成或未生成首帧）';
}

/** 打开归档悬停：TOS canonical / 本地路径 + 接口地址 */
function archiveHoverHint(task: DownloadTask): string {
  const lines: string[] = [];
  const canon = String(task.persist_archive_tos_url || '').trim();
  const key = String(task.persist_archive_key || '').trim();
  const path = String(task.archive_path || '').trim();

  if (canon.startsWith('http')) {
    lines.push(canon);
  } else if (key) {
    lines.push(`TOS 对象 key：${key}`);
  } else if (path.startsWith('http')) {
    lines.push(path);
  } else if (path) {
    lines.push(`本地路径：${path}`);
  } else {
    lines.push('暂无归档地址');
  }

  lines.push(`打开方式：/api/tasks/${task.id}/archive（需登录）`);
  return lines.join('\n');
}

/** 播放按钮悬停：仅 TOS canonical；无持久化时展示方舟 URL（老数据） */
function playbackHoverHint(task: DownloadTask): string {
  const lines: string[] = [];
  const canon = String(task.persist_video_tos_url || '').trim();
  const ark = String(task.video_url || '').trim();
  if (canon.startsWith('http')) {
    lines.push(canon);
  } else if (ark.startsWith('http')) {
    lines.push(`历史任务（未落 TOS）：${ark}`);
  } else {
    lines.push('暂无持久化对象地址（任务可能仍在处理）');
  }
  lines.push('实际播放使用本页临时链接');
  return lines.join('\n');
}

interface DownloadState {
  tasks: DownloadTask[];
  total: number;
  page: number;
  pageSize: number;
  statusFilter: string;
  typeFilter: string;
  selectedTaskIds: number[];
  isLoading: boolean;
  downloadingIds: Set<number>;
}

interface GeneratingTask {
  taskId: number;
  historyId: string;
  createdAt: string;
  elapsedSeconds: number;
}

interface PreviewState {
  taskId: number;
  title: string;
  url: string;
  /** 弹窗内展示的播放地址说明（含实际 video.src） */
  footerLines?: string[];
}

interface DetailState {
  task: DownloadTask;
}

export default function DownloadManagementPage() {
  const { toast, confirm } = useToast();
  const { currentUser } = useApp();
  const isAdmin = currentUser?.role === 'admin';
  const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
  const [state, setState] = useState<DownloadState>({
    tasks: [],
    total: 0,
    page: 1,
    pageSize: 20,
    statusFilter: 'all',
    typeFilter: 'all',
    selectedTaskIds: [],
    isLoading: false,
    downloadingIds: new Set(),
  });

  const { tasks, total, page, pageSize, statusFilter, typeFilter, selectedTaskIds, isLoading, downloadingIds } = state;

  // 轮询引用
  const pollIntervalRef = useRef<number | null>(null);
  const hasInitializedRef = useRef(false);
  const [generatingTasks, setGeneratingTasks] = useState<GeneratingTask[]>([]);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [downloadScope, setDownloadScope] = useState<DownloadScopePayload | null>(null);
  /** null = 全员（管理员 / 组长默认） */
  const [downloadFilterUserId, setDownloadFilterUserId] = useState<number | null>(null);

  // Esc 关闭详情/预览
  useEffect(() => {
    if (!detail && !preview) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (detail) setDetail(null);
        else if (preview) setPreview(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [detail, preview]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await downloadService.fetchDownloadScope();
        if (cancelled) return;
        setDownloadScope(data);
        setDownloadFilterUserId(
          data.defaultFilterUserId === undefined || data.defaultFilterUserId === null
            ? null
            : data.defaultFilterUserId
        );
      } catch (e) {
        console.error('加载下载筛选范围失败:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toGeneratingTasks = (items: Array<{ taskId: number; historyId: string; createdAt: string }> = []) =>
    items.map((task) => {
      const createdMs = parseDbTimeMs(task.createdAt);
      return {
        taskId: task.taskId,
        historyId: task.historyId,
        createdAt: task.createdAt,
        // SQLite 的 created_at 是 UTC 无时区字符串，必须按 UTC 解析，否则会偏 8 小时
        elapsedSeconds: Number.isNaN(createdMs)
          ? 0
          : Math.max(0, Math.floor((Date.now() - createdMs) / 1000)),
      };
    });

  // 手动添加单个任务到轮询列表
  const handleWatchTask = (taskId: number, historyId: string, createdAt: string) => {
    setGeneratingTasks((prev) => {
      if (prev.some((t) => t.taskId === taskId)) {
        return prev;
      }
      const createdMs = parseDbTimeMs(createdAt);
      return [
        ...prev,
        {
          taskId,
          historyId,
          createdAt,
          elapsedSeconds: Number.isNaN(createdMs)
            ? 0
            : Math.max(0, Math.floor((Date.now() - createdMs) / 1000)),
        },
      ];
    });
  };

  // 加载下载任务列表
  const loadTasks = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true }));
    try {
      const result = await downloadService.getDownloadTasks(statusFilter, typeFilter, page, pageSize, {
        filterUserId: downloadFilterUserId,
      });
      setState((prev) => ({
        ...prev,
        tasks: result.tasks,
        total: result.total,
        isLoading: false,
      }));
    } catch (error) {
      toast.error(`加载任务列表失败：${error instanceof Error ? error.message : error}`);
      setState((prev) => ({ ...prev, isLoading: false }));
    }
  }, [statusFilter, typeFilter, page, pageSize, downloadFilterUserId]);

  const refreshGeneratingState = useCallback(async ({
    showSummary = false,
    showCompletedNotice = false,
    silentError = false,
  }: {
    showSummary?: boolean;
    showCompletedNotice?: boolean;
    silentError?: boolean;
  } = {}) => {
    try {
      const result = await downloadService.refreshDownloadTasks({
        filterUserId: downloadFilterUserId,
      });
      setGeneratingTasks(toGeneratingTasks(result.generatingTasks ?? []));
      await loadTasks();

      if (showSummary) {
        toast.success(`刷新完成：已更新 ${result.refreshed} 个任务，${result.generating || 0} 个任务仍在生成中`);
      } else if (showCompletedNotice && result.refreshed > 0) {
        toast.success(`有 ${result.refreshed} 个视频已生成完成！`);
      }

      return result;
    } catch (error) {
      if (!silentError) {
        toast.error(`刷新失败：${error instanceof Error ? error.message : error}`);
      }
      throw error;
    }
  }, [loadTasks, downloadFilterUserId]);

  useEffect(() => {
    const initializeOrLoad = async () => {
      if (!hasInitializedRef.current) {
        hasInitializedRef.current = true;
        try {
          await refreshGeneratingState({ silentError: true });
        } catch (error) {
          console.error('初始化刷新失败:', error);
          await loadTasks();
        }
        return;
      }

      await loadTasks();
    };

    void initializeOrLoad();
  }, [loadTasks, refreshGeneratingState]);

  // 刷新任务列表（获取已生成的视频）
  const handleRefresh = async () => {
    try {
      await refreshGeneratingState({ showSummary: true });
    } catch (error) {
      console.error('手动刷新失败:', error);
    }
  };

  // 轮询生成中的任务
  const pollGeneratingTasks = useCallback(async () => {
    if (generatingTasks.length === 0) return;

    try {
      await refreshGeneratingState({ showCompletedNotice: true, silentError: true });
    } catch (error) {
      console.error('轮询失败:', error);
    }
  }, [generatingTasks.length, refreshGeneratingState]);

  // 启动轮询
  useEffect(() => {
    if (generatingTasks.length > 0) {
      pollGeneratingTasks();
      pollIntervalRef.current = window.setInterval(pollGeneratingTasks, 5000);
    }

    return () => {
      if (pollIntervalRef.current !== null) {
        window.clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [generatingTasks.length, pollGeneratingTasks]);



  // 计算生成时长
  const formatElapsed = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}分${secs.toString().padStart(2, '0')}秒`;
  };
  const withDownloadingState = async (taskId: number, action: () => Promise<void>) => {
    if (downloadingIds.has(taskId)) return;

    setState((prev) => ({
      ...prev,
      downloadingIds: new Set(prev.downloadingIds).add(taskId),
    }));

    try {
      await action();
    } finally {
      setState((prev) => {
        const newSet = new Set(prev.downloadingIds);
        newSet.delete(taskId);
        return { ...prev, downloadingIds: newSet };
      });
    }
  };

  const handleDownload = async (taskId: number) => {
    await withDownloadingState(taskId, async () => {
      try {
        await downloadService.downloadVideo(taskId);
        toast.success('下载成功');
        loadTasks();
      } catch (error) {
        toast.error(`下载失败：${error instanceof Error ? error.message : error}`);
      }
    });
  };

  const handleBrowserDownload = async (task: DownloadTask) => {
    await withDownloadingState(task.id, async () => {
      try {
        const fallbackFilename = task.video_path?.split('/').pop() || `${task.project_name || 'video'}_task${task.id}.mp4`;
        await downloadService.downloadLocalVideoFile(task.id, fallbackFilename);
      } catch (error) {
        toast.error(`下载到本地失败：${error instanceof Error ? error.message : error}`);
      }
    });
  };

  // 批量下载
  const handleBatchDownload = async () => {
    if (selectedTaskIds.length === 0) {
      toast.warning('请先选择要下载的任务');
      return;
    }

    try {
      const results = await downloadService.batchDownloadVideos(selectedTaskIds);
      const successCount = results.filter((r) => r.success).length;
      toast.success(`批量下载完成：成功 ${successCount} 个，失败 ${results.length - successCount} 个`);
      loadTasks();
    } catch (error) {
      toast.error(`批量下载失败：${error instanceof Error ? error.message : error}`);
    }
  };

  // 下载全部待下载
  const handleDownloadAllPending = async () => {
    const pendingIds = tasks
      .filter((t) => t.effective_download_status === 'pending' && taskHasRemoteVideo(t))
      .map((t) => t.id);
    if (pendingIds.length === 0) {
      toast.info('没有待下载的任务');
      return;
    }

    try {
      const results = await downloadService.batchDownloadVideos(pendingIds);
      const successCount = results.filter((r) => r.success).length;
      toast.success(`下载完成：成功 ${successCount} 个，失败 ${results.length - successCount} 个`);
      loadTasks();
    } catch (error) {
      toast.error(`批量下载失败：${error instanceof Error ? error.message : error}`);
    }
  };

  // 在线预览：拉取一次性 stream token，直接喂给 <video src>（不触发下载）
  const handlePreview = async (task: DownloadTask) => {
    try {
      const url = await downloadService.createStreamUrl(task.id);
      const title = task.video_path?.split('/').pop() || `任务 ${task.id}`;
      const footerLines: string[] = [];
      const canon = String(task.persist_video_tos_url || '').trim();
      const ark = String(task.video_url || '').trim();
      if (canon.startsWith('http')) {
        footerLines.push(`持久化对象地址：${canon}`);
      } else if (ark.startsWith('http')) {
        footerLines.push(`历史数据源（未落 TOS）：${ark}`);
      }
      footerLines.push('播放器使用本页临时 stream（支持 Range）；完整播放地址不在此列出');
      setPreview({ taskId: task.id, title, url, footerLines });
    } catch (error) {
      toast.error(`预览失败：${error instanceof Error ? error.message : error}`);
    }
  };

  // 打开文件夹
  const handleOpenFolder = async (taskId: number) => {
    try {
      await downloadService.openVideoFolder(taskId);
    } catch (error) {
      toast.error(`打开文件夹失败：${error instanceof Error ? error.message : error}`);
    }
  };

  // 查看归档：拉取 HTML → blob URL → 新窗打开（绕过需要 auth header 的限制）
  const handleOpenArchive = async (taskId: number) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/archive`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank', 'noopener,noreferrer');
      if (!win) {
        toast.error('浏览器拦截了弹窗，请允许后重试');
      }
      // 交给新窗口后 60s 释放 blob URL，避免即时释放导致空白页
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      toast.error(`查看归档失败：${error instanceof Error ? error.message : error}`);
    }
  };

  // 下载归档到本地
  const handleDownloadArchive = async (task: DownloadTask) => {
    try {
      const res = await fetch(`/api/tasks/${task.id}/archive`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `archive_task${task.id}_${task.project_name || 'project'}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast.error(`下载归档失败：${error instanceof Error ? error.message : error}`);
    }
  };

  // 删除任务
  const handleDeleteTask = async (taskId: number) => {
    const ok = await confirm({ message: '确定要删除此任务吗？', danger: true, confirmText: '删除' });
    if (!ok) return;

    try {
      await downloadService.deleteTask(taskId);
      loadTasks();
    } catch (error) {
      toast.error(`删除任务失败：${error instanceof Error ? error.message : error}`);
    }
  };

  // 切换任务选择
  const toggleTaskSelection = (taskId: number) => {
    setState((prev) => ({
      ...prev,
      selectedTaskIds: prev.selectedTaskIds.includes(taskId)
        ? prev.selectedTaskIds.filter((id) => id !== taskId)
        : [...prev.selectedTaskIds, taskId],
    }));
  };

  // 全选/取消全选
  const toggleSelectAll = () => {
    if (selectedTaskIds.length === tasks.length) {
      setState((prev) => ({ ...prev, selectedTaskIds: [] }));
    } else {
      setState((prev) => ({
        ...prev,
        selectedTaskIds: tasks.map((t) => t.id),
      }));
    }
  };

  // 分页
  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="p-6 w-full max-w-[min(1680px,calc(100vw-2rem))] mx-auto bg-[#0f111a] min-h-screen">
      {/* 标题 */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">下载管理</h1>
        <p className="text-gray-400 text-sm mt-1">
          管理已完成任务的下载与结果文件
          {generatingTasks.length > 0 && (
            <span className="ml-2 text-yellow-400">
              · 正在监听 {generatingTasks.length} 个生成中的任务
            </span>
          )}
        </p>
      </div>

      {/* 生成中任务监控面板 */}
      {generatingTasks.length > 0 && (
        <div className="mb-6 bg-gradient-to-r from-yellow-500/10 to-orange-500/10 border border-yellow-500/30 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-yellow-400 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <h2 className="text-lg font-semibold text-yellow-400">正在监听生成中的任务</h2>
            </div>
            <button
              onClick={() => setGeneratingTasks([])}
              className="text-xs text-gray-400 hover:text-gray-300 transition-colors"
            >
              停止监听
            </button>
          </div>
          <div className="space-y-2">
            {generatingTasks.slice(0, 5).map((task) => (
              <div
                key={task.taskId}
                className="flex items-center justify-between bg-[#0f111a]/50 rounded px-3 py-2"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-500 font-mono">#{task.taskId}</span>
                  <span className="text-xs text-gray-400">History: {task.historyId}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-yellow-400">
                    已等待 {formatElapsed(task.elapsedSeconds)}
                  </span>
                  <span className="text-xs text-gray-500">·</span>
                  <span className="text-xs text-gray-400">每 5 秒自动刷新</span>
                </div>
              </div>
            ))}
            {generatingTasks.length > 5 && (
              <div className="text-xs text-gray-500 text-center">
                还有 {generatingTasks.length - 5} 个任务正在生成中...
              </div>
            )}
          </div>
        </div>
      )}

      {/* 下载范围说明（组长 / 组员匹配情况；无需找浏览器控制台里的 [download-scope]） */}
      {downloadScope?.scopeDiagnostics && downloadScope.viewerRole !== 'admin' && (
        <div className="mb-3 text-xs text-amber-200/90 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2 space-y-1 max-w-4xl">
          <div className="text-amber-100/80">
            当前登录标识（users.email 列）: <span className="font-mono">{downloadScope.scopeDiagnostics.loginIdentifier}</span>
            {' · '}
            ModelToo: {downloadScope.scopeDiagnostics.modelTooApiConfigured ? '已配置' : '未配置'}
            {downloadScope.scopeDiagnostics.groupsFetchedCount != null &&
              ` · 拉取分组数 ${downloadScope.scopeDiagnostics.groupsFetchedCount}`}
            {downloadScope.scopeDiagnostics.isLeaderInModelToo
              ? ` · 在 ModelToo 中识别为组长（${downloadScope.scopeDiagnostics.ledGroupsCount} 个组，组内共 ${downloadScope.scopeDiagnostics.modelTooMemberCount} 人）`
              : ' · 在 ModelToo 中未识别为组长'}
            {` · 本地已匹配账号数 ${downloadScope.scopeDiagnostics.mappedLocalUserCount}`}
          </div>
          {downloadScope.scopeDiagnostics.tips.length > 0 && (
            <ul className="list-disc pl-4 text-amber-200/80">
              {downloadScope.scopeDiagnostics.tips.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          )}
          <p className="text-gray-500">{downloadScope.scopeDiagnostics.serverLogHint}</p>
        </div>
      )}

      {/* 筛选器和操作栏 */}
      <div className="mb-4 flex flex-wrap gap-3 items-center justify-between">
        <div className="flex gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setState((prev) => ({ ...prev, statusFilter: e.target.value, page: 1 }))}
            className="px-3 py-1.5 border border-gray-700 rounded-md text-sm bg-[#1c1f2e] text-gray-300 focus:outline-none focus:border-purple-500"
          >
            <option value="all">全部状态</option>
            <option value="generating">生成中</option>
            <option value="pending">待下载</option>
            <option value="downloading">下载中</option>
            <option value="done">已下载</option>
            <option value="failed">下载失败</option>
          </select>

          <select
            value={typeFilter}
            onChange={(e) => setState((prev) => ({ ...prev, typeFilter: e.target.value, page: 1 }))}
            className="px-3 py-1.5 border border-gray-700 rounded-md text-sm bg-[#1c1f2e] text-gray-300 focus:outline-none focus:border-purple-500"
          >
            <option value="all">全部类型</option>
            <option value="video">视频</option>
            <option value="image">图片</option>
          </select>

          {downloadScope?.viewerRole === 'member' ? (
            <span className="px-3 py-1.5 text-sm text-gray-400 border border-gray-700 rounded-md bg-[#1c1f2e]/80">
              用户：{downloadScope.filterOptions[0]?.label ?? currentUser?.email ?? '—'}
            </span>
          ) : downloadScope ? (
            <select
              value={downloadFilterUserId === null ? '' : String(downloadFilterUserId)}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '') setDownloadFilterUserId(null);
                else {
                  const n = parseInt(v, 10);
                  setDownloadFilterUserId(Number.isFinite(n) ? n : null);
                }
                setState((prev) => ({ ...prev, page: 1 }));
              }}
              className="px-3 py-1.5 border border-gray-700 rounded-md text-sm bg-[#1c1f2e] text-gray-300 focus:outline-none focus:border-purple-500 min-w-[200px]"
              title={
                downloadScope.viewerRole === 'leader'
                  ? '组长默认查看本组已在 SD 登录过的成员；未匹配的 ModelToo 成员不会出现在列表中'
                  : '按用户筛选下载任务'
              }
            >
              {downloadScope.filterOptions.map((opt) => (
                <option key={opt.id === null ? '__all__' : opt.id} value={opt.id === null ? '' : String(opt.id)}>
                  {opt.label}
                </option>
              ))}
            </select>
          ) : null}
        </div>

        <div className="flex gap-2">

          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className="px-4 py-1.5 bg-purple-600 text-white rounded-md text-sm hover:bg-purple-500 disabled:opacity-50 flex items-center gap-1 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            刷新
          </button>

          <button
            onClick={handleDownloadAllPending}
            disabled={isLoading}
            className="px-4 py-1.5 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-500 disabled:opacity-50 flex items-center gap-1 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            下载全部待下载
          </button>

          <button
            onClick={handleBatchDownload}
            disabled={selectedTaskIds.length === 0 || isLoading}
            className="px-4 py-1.5 bg-indigo-600 text-white rounded-md text-sm hover:bg-indigo-500 disabled:opacity-50 flex items-center gap-1 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            批量下载 ({selectedTaskIds.length})
          </button>
        </div>
      </div>

      {/* 任务列表表格（宽屏拉满上面容器；窄屏横向滚动） */}
      <div className="bg-[#1c1f2e] rounded-lg border border-gray-800 overflow-x-auto">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400">加载中...</div>
        ) : tasks.length === 0 ? (
          <div className="p-8 text-center text-gray-400">暂无任务</div>
        ) : (
          <table className="w-full min-w-[1100px]">
            <thead className="bg-[#0f111a] border-b border-gray-800">
              <tr>
                <th className="px-4 py-3 text-left">
                  <input
                    type="checkbox"
                    checked={selectedTaskIds.length === tasks.length && tasks.length > 0}
                    onChange={toggleSelectAll}
                    className="rounded border-gray-700 bg-[#1c1f2e] text-purple-600 focus:ring-purple-500 focus:ring-offset-0"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase w-[52px]">封面</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase whitespace-nowrap w-[88px]">
                  任务 ID
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase min-w-[120px]">
                  项目
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase min-w-[90px]">
                  创建人
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase min-w-[100px]">
                  提示词
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">类型</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">时长</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase whitespace-nowrap">
                  分辨率
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">状态</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">创建时间</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Tokens</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">费用</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-400 uppercase whitespace-nowrap min-w-[200px]">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {tasks.map((task) => (
                <tr key={task.id} className="hover:bg-[#0f111a]/50 transition-colors">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedTaskIds.includes(task.id)}
                      onChange={() => toggleTaskSelection(task.id)}
                      className="rounded border-gray-700 bg-[#1c1f2e] text-purple-600 focus:ring-purple-500 focus:ring-offset-0"
                      disabled={task.effective_download_status !== 'pending'}
                    />
                  </td>
                  <td className="px-4 py-3 align-middle">
                    {task.model_type === 'video' ? (
                      (() => {
                        const display = sdCoverListImgSrc(task);
                        const videoThumb = sdCoverListVideoThumbSrc(task);
                        if (videoThumb && !display) {
                          return (
                            <video
                              src={videoThumb}
                              muted
                              playsInline
                              preload="metadata"
                              className="w-10 h-10 rounded object-cover bg-white/5 ring-1 ring-gray-800 shrink-0"
                              title="历史任务：视频首帧预览"
                            />
                          );
                        }
                        return display ? (
                          <img
                            src={display}
                            alt=""
                            width={40}
                            height={40}
                            className="w-10 h-10 rounded object-cover bg-white/5 ring-1 ring-gray-800 shrink-0"
                            loading="lazy"
                            title={sdCoverHoverTitle(task)}
                          />
                        ) : (
                          <div
                            className="w-10 h-10 rounded bg-white/5 flex items-center justify-center text-[10px] text-gray-600 text-center leading-tight ring-1 ring-gray-800"
                            title="暂无封面（持久化未完成或未生成首帧）"
                          >
                            —
                          </div>
                        );
                      })()
                    ) : (
                      <span className="text-gray-600 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300 font-mono">
                    {task.id.toString().padStart(6, '0')}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300 max-w-[220px]">
                    <span className="block truncate" title={task.project_name || ''}>
                      {task.project_name || '-'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-400 max-w-[130px]" title={task.user_email || ''}>
                    <span className="block truncate">{task.user_email || '-'}</span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300 max-w-xs truncate" title={task.prompt}>
                    {task.prompt
                      ? `${task.prompt.substring(0, 10)}${task.prompt.length > 10 ? '...' : ''}`
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300">
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      task.model_type === 'video' ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                    }`}>
                      {task.model_type === 'video' ? '视频' : '图片'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300">
                    {task.duration ? `${task.duration}s` : '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300 whitespace-nowrap" title={task.model_type === 'video' ? task.resolution || '未记录（可能为接口默认）' : ''}>
                    {task.model_type === 'video'
                      ? task.resolution?.trim()
                        ? task.resolution.trim()
                        : '—'
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <span className={`px-2 py-0.5 rounded text-xs border ${
                      task.effective_download_status === 'generating'
                        ? 'bg-gray-500/20 text-gray-300 border-gray-500/30'
                        : task.effective_download_status === 'pending'
                        ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
                        : task.effective_download_status === 'downloading'
                        ? 'bg-blue-500/20 text-blue-400 border-blue-500/30'
                        : task.effective_download_status === 'done'
                        ? 'bg-green-500/20 text-green-400 border-green-500/30'
                        : 'bg-red-500/20 text-red-400 border-red-500/30'
                    }`}>
                      {task.effective_download_status === 'generating' && '生成中'}
                      {task.effective_download_status === 'pending' && '待下载'}
                      {task.effective_download_status === 'downloading' && '下载中'}
                      {task.effective_download_status === 'done' && '已下载'}
                      {task.effective_download_status === 'failed' && '失败'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-400">
                    {formatDbTime(task.created_at)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300">
                    {task.total_tokens !== null && task.total_tokens !== undefined ? formatTokens(task.total_tokens) : '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300">
                    {task.cost !== null && task.cost !== undefined ? formatPrice(task.cost) : '-'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      {/* 详情按钮：所有任务都可点；失败任务高亮红色，提示有错误信息 */}
                      <button
                        onClick={() => setDetail({ task })}
                        className={`p-1 rounded transition-colors ${
                          task.effective_download_status === 'failed'
                            ? 'text-red-400 hover:bg-red-500/10'
                            : task.revised_prompt
                              ? 'text-cyan-400 hover:bg-cyan-500/10'
                              : 'text-gray-400 hover:bg-gray-500/10'
                        }`}
                        title={
                          task.effective_download_status === 'failed'
                            ? '查看失败原因'
                            : task.revised_prompt
                              ? '查看任务详情（含模型改写后的提示词）'
                              : '查看任务详情'
                        }
                      >
                        {task.effective_download_status === 'failed' ? (
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
                          </svg>
                        ) : (
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        )}
                      </button>
                      {/* 生成中的任务：显示"继续监听"按钮 */}
                      {task.effective_download_status === 'generating' && task.history_id && (
                        <button
                          onClick={() => handleWatchTask(task.id, task.history_id!, task.created_at)}
                          className="p-1 text-yellow-400 hover:bg-yellow-500/10 rounded transition-colors"
                          title="继续监听生成进度"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                        </button>
                      )}
                      {task.effective_download_status === 'pending' && taskHasRemoteVideo(task) && (
                        <button
                          onClick={() => handleDownload(task.id)}
                          disabled={downloadingIds.has(task.id)}
                          className="p-1 text-blue-400 hover:bg-blue-500/10 rounded disabled:opacity-50 transition-colors"
                          title="下载"
                        >
                          {downloadingIds.has(task.id) ? (
                            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                          ) : (
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                          )}
                        </button>
                      )}
                      {task.effective_download_status === 'done' &&
                        (task.video_path ||
                          task.persist_video_key ||
                          String(task.persist_video_tos_url || '').trim().startsWith('http')) && (
                        <>
                          <button
                            onClick={() => handlePreview(task)}
                            className="p-1 text-purple-400 hover:bg-purple-500/10 rounded transition-colors"
                            title={playbackHoverHint(task)}
                          >
                            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M8 5v14l11-7z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => handleBrowserDownload(task)}
                            disabled={downloadingIds.has(task.id)}
                            className="p-1 text-blue-400 hover:bg-blue-500/10 rounded disabled:opacity-50 transition-colors"
                            title="下载到本机"
                          >
                            {downloadingIds.has(task.id) ? (
                              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                              </svg>
                            ) : (
                              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                              </svg>
                            )}
                          </button>
                          {isLocalhost && (
                          <button
                            onClick={() => handleOpenFolder(task.id)}
                            className="p-1 text-green-400 hover:bg-green-500/10 rounded transition-colors"
                            title="打开文件夹"
                          >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                            </svg>
                          </button>
                          )}
                        </>
                      )}
                      {/* 归档：任务提交时已生成的 HTML（含提示词 + 素材预览），离线可看 */}
                      {taskHasArchive(task) && (
                        <>
                          <button
                            onClick={() => handleOpenArchive(task.id)}
                            className="p-1 text-cyan-400 hover:bg-cyan-500/10 rounded transition-colors"
                            title={archiveHoverHint(task)}
                          >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => handleDownloadArchive(task)}
                            className="p-1 text-indigo-400 hover:bg-indigo-500/10 rounded transition-colors"
                            title="下载归档 HTML 到本地"
                          >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h4l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                            </svg>
                          </button>
                        </>
                      )}
                      {isAdmin && (
                      <button
                        onClick={() => handleDeleteTask(task.id)}
                        className="p-1 text-red-400 hover:bg-red-500/10 rounded transition-colors"
                        title="删除"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="mt-4 flex justify-between items-center">
          <div className="text-sm text-gray-400">
            共 {total} 条，第 {page} 页 / 共 {totalPages} 页
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setState((prev) => ({ ...prev, page: prev.page - 1 }))}
              disabled={page === 1}
              className="px-3 py-1 border border-gray-700 rounded text-sm text-gray-300 hover:bg-[#1c1f2e] disabled:opacity-50 transition-colors"
            >
              上一页
            </button>
            <button
              onClick={() => setState((prev) => ({ ...prev, page: prev.page + 1 }))}
              disabled={page >= totalPages}
              className="px-3 py-1 border border-gray-700 rounded text-sm text-gray-300 hover:bg-[#1c1f2e] disabled:opacity-50 transition-colors"
            >
              下一页
            </button>
          </div>
        </div>
      )}

      {/* 任务详情弹窗：失败原因 / 模型改写后的提示词 / 元数据 */}
      {detail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={() => setDetail(null)}
        >
          <div
            className="relative w-full max-w-2xl max-h-[88vh] bg-[#0f111a] rounded-2xl border border-gray-800 shadow-2xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800 flex-shrink-0">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-200">
                <svg className="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                任务详情 #{detail.task.id.toString().padStart(6, '0')}
                <span
                  className={`ml-2 px-2 py-0.5 rounded text-xs border ${
                    detail.task.effective_download_status === 'failed'
                      ? 'bg-red-500/20 text-red-400 border-red-500/30'
                      : detail.task.effective_download_status === 'done'
                        ? 'bg-green-500/20 text-green-400 border-green-500/30'
                        : detail.task.effective_download_status === 'generating'
                          ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
                          : 'bg-gray-500/20 text-gray-300 border-gray-500/30'
                  }`}
                >
                  {detail.task.effective_download_status === 'generating' && '生成中'}
                  {detail.task.effective_download_status === 'pending' && '待下载'}
                  {detail.task.effective_download_status === 'downloading' && '下载中'}
                  {detail.task.effective_download_status === 'done' && '已下载'}
                  {detail.task.effective_download_status === 'failed' && '失败'}
                </span>
              </div>
              <button
                onClick={() => setDetail(null)}
                className="p-1.5 text-gray-400 hover:bg-gray-800 rounded-lg transition-colors"
                title="关闭 (Esc)"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-4 text-sm">
              {/* 失败原因 */}
              {detail.task.error_message && (
                <section>
                  <h3 className="text-xs font-bold text-red-400 uppercase tracking-wider mb-2 flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
                    </svg>
                    失败原因
                  </h3>
                  <div className="bg-red-900/20 border border-red-700/50 rounded-lg p-3 text-red-200 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                    {detail.task.error_message}
                  </div>
                  <div className="text-[11px] text-gray-500 mt-1">
                    错误信息直接来自方舟生成接口，可作为联系客服或重试时的依据
                  </div>
                </section>
              )}
              {/* 元数据 */}
              <section>
                <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">元数据</h3>
                <div className="bg-[#1c1f2e] border border-gray-800 rounded-lg overflow-hidden text-xs">
                  <DetailRow label="项目" value={detail.task.project_name || '-'} />
                  <DetailRow label="创建人" value={detail.task.user_email || '-'} />
                  <DetailRow label="时长" value={detail.task.duration ? `${detail.task.duration}s` : '-'} />
                  <DetailRow
                    label="分辨率"
                    value={
                      detail.task.model_type === 'video'
                        ? detail.task.resolution?.trim() || '—（旧任务或未记录）'
                        : '—'
                    }
                  />
                  <DetailRow label="提交时间" value={formatDbTime(detail.task.created_at)} />
                  {detail.task.completed_at && (
                    <DetailRow label="完成时间" value={formatDbTime(detail.task.completed_at)} />
                  )}
                  {detail.task.history_id && (
                    <DetailRow label="History ID" value={detail.task.history_id} mono />
                  )}
                  {videoReferenceCanonicalOrLegacy(detail.task).startsWith('http') && (
                    <DetailRow
                      label={
                        String(detail.task.persist_video_tos_url || '').trim().startsWith('http')
                          ? '视频对象地址（TOS）'
                          : '视频 URL（历史，未落 TOS）'
                      }
                      value={
                        <span
                          className="text-purple-200 break-all font-mono text-[11px]"
                          title={
                            String(detail.task.persist_video_tos_url || '').trim().startsWith('http')
                              ? '持久桶对象路径；各系统通过 AK/SK 或 SD 服务端接口访问'
                              : '早期任务仅保留方舟返回链接'
                          }
                        >
                          {videoReferenceCanonicalOrLegacy(detail.task)}
                        </span>
                      }
                    />
                  )}
                  {sdCoverCanonicalUrl(detail.task).startsWith('http') && (
                    <DetailRow
                      label="封面 canonical"
                      value={
                        <span className="text-cyan-300 break-all font-mono text-[11px]" title="对象路径；浏览器访问需经服务端授权">
                          {sdCoverCanonicalUrl(detail.task)}
                        </span>
                      }
                    />
                  )}
                </div>
              </section>
              {/* 原始提示词 */}
              <section>
                <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">原始提示词</h3>
                <div className="bg-[#1c1f2e] border border-gray-800 rounded-lg p-3 whitespace-pre-wrap break-words text-gray-200 leading-relaxed">
                  {detail.task.prompt || <span className="text-gray-600">(空)</span>}
                </div>
              </section>
              {/* 模型改写后的提示词 */}
              {detail.task.revised_prompt && detail.task.revised_prompt !== detail.task.prompt && (
                <section>
                  <h3 className="text-xs font-bold text-cyan-400 uppercase tracking-wider mb-2 flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                    </svg>
                    模型改写后的提示词
                  </h3>
                  <div className="bg-cyan-900/10 border border-cyan-800/40 rounded-lg p-3 whitespace-pre-wrap break-words text-cyan-100 leading-relaxed">
                    {detail.task.revised_prompt}
                  </div>
                  <div className="text-[11px] text-gray-500 mt-1">
                    方舟会按内部规则微调提示词以适配模型；这是实际用于生成的最终文本
                  </div>
                </section>
              )}
              {!detail.task.error_message &&
                (!detail.task.revised_prompt || detail.task.revised_prompt === detail.task.prompt) && (
                  <div className="text-xs text-gray-500 text-center py-2">
                    本任务暂无失败原因或额外的模型改写信息
                  </div>
                )}
            </div>
          </div>
        </div>
      )}

      {/* 视频在线预览弹窗 */}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={() => setPreview(null)}
        >
          <div
            className="relative w-full max-w-5xl bg-[#0f111a] rounded-2xl border border-gray-800 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <div className="text-sm text-gray-300 truncate pr-4" title={preview.title}>
                {preview.title}
              </div>
              <button
                onClick={() => setPreview(null)}
                className="p-1.5 text-gray-400 hover:bg-gray-800 rounded-lg transition-colors"
                title="关闭"
                aria-label="关闭"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="bg-black">
              <video
                src={preview.url}
                controls
                autoPlay
                className="w-full max-h-[80vh] mx-auto block"
              />
            </div>
            {preview.footerLines && preview.footerLines.length > 0 && (
              <div className="px-4 py-3 border-t border-gray-800 bg-[#151929] max-h-[min(40vh,280px)] overflow-y-auto">
                <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-2">
                  参考地址（实际播放为临时链接）
                </div>
                <pre className="text-[11px] text-gray-400 whitespace-pre-wrap break-all font-mono leading-relaxed">
                  {preview.footerLines.join('\n')}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 px-3 py-2 border-b border-gray-800 last:border-b-0">
      <div className="w-20 flex-shrink-0 text-gray-500">{label}</div>
      <div className={`flex-1 min-w-0 text-gray-200 break-words ${mono ? 'font-mono text-[11px]' : ''}`}>
        {value}
      </div>
    </div>
  );
}
