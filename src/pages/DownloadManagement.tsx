import { useState, useEffect, useRef, useCallback } from 'react';
import * as downloadService from '../services/downloadService';
import type { DownloadTask } from '../types/index';
import { useToast } from '../components/Toast';

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

export default function DownloadManagementPage() {
  const { toast, confirm } = useToast();
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

  const toGeneratingTasks = (items: Array<{ taskId: number; historyId: string; createdAt: string }> = []) =>
    items.map((task) => ({
      taskId: task.taskId,
      historyId: task.historyId,
      createdAt: task.createdAt,
      elapsedSeconds: Math.floor((Date.now() - new Date(task.createdAt).getTime()) / 1000),
    }));

  // 手动添加单个任务到轮询列表
  const handleWatchTask = (taskId: number, historyId: string, createdAt: string) => {
    setGeneratingTasks((prev) => {
      if (prev.some((t) => t.taskId === taskId)) {
        return prev;
      }
      return [
        ...prev,
        {
          taskId,
          historyId,
          createdAt,
          elapsedSeconds: Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000),
        },
      ];
    });
  };

  // 加载下载任务列表
  const loadTasks = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true }));
    try {
      const result = await downloadService.getDownloadTasks(statusFilter, typeFilter, page, pageSize);
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
  }, [statusFilter, typeFilter, page, pageSize]);

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
      const result = await downloadService.refreshDownloadTasks();
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
  }, [loadTasks]);

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
      .filter((t) => t.effective_download_status === 'pending' && !!t.video_url)
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

  // 打开文件夹
  const handleOpenFolder = async (taskId: number) => {
    try {
      await downloadService.openVideoFolder(taskId);
    } catch (error) {
      toast.error(`打开文件夹失败：${error instanceof Error ? error.message : error}`);
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
    <div className="p-6 max-w-7xl mx-auto bg-[#0f111a] min-h-screen">
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

      {/* 任务列表表格 */}
      <div className="bg-[#1c1f2e] rounded-lg border border-gray-800 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400">加载中...</div>
        ) : tasks.length === 0 ? (
          <div className="p-8 text-center text-gray-400">暂无任务</div>
        ) : (
          <table className="w-full">
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
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">任务 ID</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">项目</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">创建人</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">提示词</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">类型</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">状态</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">创建时间</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-400 uppercase">操作</th>
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
                  <td className="px-4 py-3 text-sm text-gray-300 font-mono">
                    {task.id.toString().padStart(6, '0')}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300">
                    {task.project_name || '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-400 truncate max-w-[140px]" title={task.user_email || ''}>
                    {task.user_email || '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300 max-w-xs truncate" title={task.prompt}>
                    {task.prompt.substring(0, 30)}{task.prompt.length > 30 ? '...' : ''}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300">
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      task.model_type === 'video' ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                    }`}>
                      {task.model_type === 'video' ? '视频' : '图片'}
                    </span>
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
                    {new Date(task.created_at).toLocaleString('zh-CN')}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
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
                      {task.effective_download_status === 'pending' && !!task.video_url && (
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
                      {task.effective_download_status === 'done' && task.video_path && (
                        <>
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
                          <button
                            onClick={() => handleOpenFolder(task.id)}
                            className="p-1 text-green-400 hover:bg-green-500/10 rounded transition-colors"
                            title="打开文件夹"
                          >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                            </svg>
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => handleDeleteTask(task.id)}
                        className="p-1 text-red-400 hover:bg-red-500/10 rounded transition-colors"
                        title="删除"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
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
    </div>
  );
}
