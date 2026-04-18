import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import * as projectService from '../services/projectService';
import * as taskService from '../services/taskService';
import type { InvalidBatchTask, Task, TaskAsset, TaskStatus } from '../types/index';
import { useToast } from '../components/Toast';
import {
  ARK_LIMITS,
  validateImageFile,
  validateVideoFile,
  validateAudioFile,
} from '../utils/arkFileLimits';

interface BatchManagementState {
  selectedProjectId: number | null;
  isCreatingProject: boolean;
}

const DEFAULT_DRAFT_ROWS = 1;
const VIDEO_COUNT_OPTIONS = [1, 2, 3, 4] as const;
const TERMINAL_OUTPUT_STATUSES: TaskStatus[] = ['done', 'error', 'cancelled'];

function sortDraftTasks(list: Task[]) {
  return [...list].sort((a, b) => {
    const aRow = typeof a.row_index === 'number' ? a.row_index : Number.MAX_SAFE_INTEGER;
    const bRow = typeof b.row_index === 'number' ? b.row_index : Number.MAX_SAFE_INTEGER;

    if (aRow !== bRow) {
      return aRow - bRow;
    }

    return a.id - b.id;
  });
}

function getImageCount(assets: TaskAsset[] = []) {
  return assets.filter((asset) => asset.asset_type === 'image').length;
}

function getAudioCount(assets: TaskAsset[] = []) {
  return assets.filter((asset) => asset.asset_type === 'audio').length;
}

function getVideoCount(assets: TaskAsset[] = []) {
  return assets.filter((asset) => asset.asset_type === 'video').length;
}

function isDraftConfigured(task: Task, assets: TaskAsset[] = []) {
  return Boolean(
    String(task.prompt || '').trim() ||
    assets.length > 0 ||
    Number(task.video_count || 1) !== 1,
  );
}

function groupOutputTasksBySourceTask(tasks: Task[] = []) {
  const grouped = tasks.reduce<Record<number, Task[]>>((acc, task) => {
    if (typeof task.source_task_id !== 'number') {
      return acc;
    }

    if (!acc[task.source_task_id]) {
      acc[task.source_task_id] = [];
    }

    acc[task.source_task_id].push(task);
    return acc;
  }, {});

  for (const taskGroup of Object.values(grouped)) {
    taskGroup.sort(
      (a, b) =>
        (a.output_index ?? Number.MAX_SAFE_INTEGER) - (b.output_index ?? Number.MAX_SAFE_INTEGER) ||
        a.id - b.id,
    );
  }

  return grouped;
}

function hasActiveOutputTasks(tasks: Task[] = []) {
  return tasks.some((task) => !TERMINAL_OUTPUT_STATUSES.includes(task.status));
}

export default function BatchManagementPage() {
  const { toast, confirm } = useToast();
  const {
    state,
    createProjectAction,
    deleteProjectAction,
    selectProject,
    loadProjectTasks,
    createTaskAction,
    updateTaskAction,
    deleteTaskAction,
  } = useApp();
  const { projects, tasks } = state;

  const [localState, setLocalState] = useState<BatchManagementState>({
    selectedProjectId: null,
    isCreatingProject: false,
  });
  const [newProjectName, setNewProjectName] = useState('');
  const [pageError, setPageError] = useState<string | null>(null);
  const [invalidTasks, setInvalidTasks] = useState<InvalidBatchTask[]>([]);
  const [taskAssets, setTaskAssets] = useState<Record<number, TaskAsset[]>>({});
  const [promptDrafts, setPromptDrafts] = useState<Record<number, string>>({});
  const [uploadingImageTaskIds, setUploadingImageTaskIds] = useState<number[]>([]);
  const [uploadingAudioTaskIds, setUploadingAudioTaskIds] = useState<number[]>([]);
  const [uploadingVideoTaskIds, setUploadingVideoTaskIds] = useState<number[]>([]);
  const [generatingTaskIds, setGeneratingTaskIds] = useState<Set<number>>(new Set());
  const [isInitializingRows, setIsInitializingRows] = useState(false);
  const [isLoadingAssets, setIsLoadingAssets] = useState(false);
  const [outputTasks, setOutputTasks] = useState<Task[]>([]);
  const savingPromptPromisesRef = useRef<Record<number, Promise<boolean>>>({});

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === localState.selectedProjectId) ?? null,
    [projects, localState.selectedProjectId],
  );

  const draftTasks = useMemo(() => sortDraftTasks(tasks), [tasks]);

  const configuredDraftTasks = useMemo(
    () => draftTasks.filter((task) => isDraftConfigured(task, taskAssets[task.id] ?? [])),
    [draftTasks, taskAssets],
  );

  const outputTasksBySourceTask = useMemo(
    () => groupOutputTasksBySourceTask(outputTasks),
    [outputTasks],
  );

  const draftTaskIdsKey = useMemo(
    () => draftTasks.map((task) => task.id).join(','),
    [draftTasks],
  );

  const shouldPollOutputTasks = useMemo(
    () => hasActiveOutputTasks(outputTasks),
    [outputTasks],
  );

  const resetProjectViewState = () => {
    setPageError(null);
    setInvalidTasks([]);
    setTaskAssets({});
    setPromptDrafts({});
    setOutputTasks([]);
    setGeneratingTaskIds(new Set());
    setUploadingImageTaskIds([]);
    setUploadingAudioTaskIds([]);
    setIsInitializingRows(false);
    setIsLoadingAssets(false);
    savingPromptPromisesRef.current = {};
  };

  useEffect(() => {
    if (!localState.selectedProjectId) {
      resetProjectViewState();
      return;
    }

    let cancelled = false;

    const ensureDraftRows = async () => {
      setIsInitializingRows(true);
      setPageError(null);

      try {
        const existingDrafts = sortDraftTasks(
          await projectService.getProjectTasks(localState.selectedProjectId!, { taskKind: 'draft' }),
        );

        if (cancelled) {
          return;
        }

        if (existingDrafts.length === 0) {
          await Promise.all(
            Array.from({ length: DEFAULT_DRAFT_ROWS }, (_, index) =>
              createTaskAction(localState.selectedProjectId!, {
                prompt: '',
                taskKind: 'draft',
                rowIndex: index + 1,
                videoCount: 1,
              }),
            ),
          );

          if (cancelled) {
            return;
          }
        }

        await loadProjectTasks(localState.selectedProjectId!, { taskKind: 'draft' });
      } catch (error) {
        if (!cancelled) {
          setPageError(error instanceof Error ? error.message : '初始化草稿任务失败');
        }
      } finally {
        if (!cancelled) {
          setIsInitializingRows(false);
        }
      }
    };

    void ensureDraftRows();

    return () => {
      cancelled = true;
    };
  }, [localState.selectedProjectId, createTaskAction, loadProjectTasks]);

  useEffect(() => {
    setPromptDrafts((prev) => {
      const next: Record<number, string> = {};
      let changed = false;

      for (const task of draftTasks) {
        next[task.id] = prev[task.id] ?? task.prompt ?? '';
        if (next[task.id] !== prev[task.id]) {
          changed = true;
        }
      }

      if (!changed && Object.keys(prev).length === draftTasks.length) {
        return prev;
      }

      return next;
    });
  }, [draftTasks]);

  useEffect(() => {
    if (!localState.selectedProjectId || draftTasks.length === 0) {
      setTaskAssets({});
      setIsLoadingAssets(false);
      return;
    }

    let cancelled = false;

    const loadAssets = async () => {
      setIsLoadingAssets(true);

      try {
        const entries = await Promise.all(
          draftTasks.map(async (task) => [task.id, await taskService.getTaskAssets(task.id)] as const),
        );

        if (!cancelled) {
          setTaskAssets(Object.fromEntries(entries));
        }
      } catch (error) {
        if (!cancelled) {
          setPageError(error instanceof Error ? error.message : '加载任务素材失败');
        }
      } finally {
        if (!cancelled) {
          setIsLoadingAssets(false);
        }
      }
    };

    void loadAssets();

    return () => {
      cancelled = true;
    };
  }, [localState.selectedProjectId, draftTaskIdsKey]);

  useEffect(() => {
    if (!localState.selectedProjectId) {
      setOutputTasks([]);
      return;
    }

    let cancelled = false;
    let pollTimer: number | null = null;
    let requestInFlight = false;

    const loadOutputTasks = async (allowPoll: boolean) => {
      if (requestInFlight) {
        return;
      }

      requestInFlight = true;

      try {
        const nextOutputTasks = await projectService.getProjectTasks(localState.selectedProjectId!, {
          taskKind: 'output',
        });

        if (cancelled) {
          return;
        }

        setOutputTasks((prev) => {
          if (
            prev.length === nextOutputTasks.length &&
            prev.every((task, index) => {
              const nextTask = nextOutputTasks[index];
              return (
                nextTask &&
                task.id === nextTask.id &&
                task.status === nextTask.status &&
                task.progress === nextTask.progress &&
                task.video_url === nextTask.video_url &&
                task.error_message === nextTask.error_message &&
                task.submit_id === nextTask.submit_id &&
                task.history_id === nextTask.history_id
              );
            })
          ) {
            return prev;
          }

          return nextOutputTasks;
        });

        if (allowPoll && hasActiveOutputTasks(nextOutputTasks)) {
          pollTimer = window.setTimeout(() => {
            void loadOutputTasks(true);
          }, 3000);
        }
      } catch (error) {
        if (!cancelled) {
          setPageError(error instanceof Error ? error.message : '加载输出任务失败');
        }
      } finally {
        requestInFlight = false;
      }
    };

    void loadOutputTasks(shouldPollOutputTasks);

    return () => {
      cancelled = true;
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
      }
    };
  }, [localState.selectedProjectId, shouldPollOutputTasks]);

  const refreshOutputTasks = async (projectId: number | null = localState.selectedProjectId) => {
    if (!projectId) {
      return;
    }

    const nextOutputTasks = await projectService.getProjectTasks(projectId, { taskKind: 'output' });
    setOutputTasks(nextOutputTasks);
  };

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) {
      return;
    }

    try {
      const project = await createProjectAction(newProjectName.trim());
      setNewProjectName('');
      setLocalState((prev) => ({ ...prev, isCreatingProject: false }));
      handleSelectProject(project);
    } catch (error) {
      toast.error(`创建项目失败：${error instanceof Error ? error.message : error}`);
    }
  };

  const handleSelectProject = (project: typeof projects[number]) => {
    setLocalState({
      selectedProjectId: project.id,
      isCreatingProject: false,
    });
    resetProjectViewState();
    selectProject(project);
  };

  const handleDeleteProject = async (projectId: number, projectName: string) => {
    const ok = await confirm({
      title: '删除项目',
      message: `确定要删除项目 "${projectName}" 吗？该项目下的所有任务也将被删除。`,
      danger: true,
      confirmText: '删除',
    });
    if (!ok) {
      return;
    }

    try {
      await deleteProjectAction(projectId);
      if (localState.selectedProjectId === projectId) {
        selectProject(null);
        setLocalState({
          selectedProjectId: null,
          isCreatingProject: false,
        });
        resetProjectViewState();
      }
    } catch (error) {
      toast.error(`删除项目失败：${error instanceof Error ? error.message : error}`);
    }
  };

  const handleAddDraftRow = async () => {
    if (!localState.selectedProjectId) {
      toast.warning('请先选择项目');
      return;
    }

    const nextRowIndex = draftTasks.reduce((max, task) => {
      const rowIndex = typeof task.row_index === 'number' ? task.row_index : 0;
      return Math.max(max, rowIndex);
    }, 0) + 1;

    try {
      await createTaskAction(localState.selectedProjectId, {
        prompt: '',
        taskKind: 'draft',
        rowIndex: nextRowIndex,
        videoCount: 1,
      });
    } catch (error) {
      toast.error(`新增任务行失败：${error instanceof Error ? error.message : error}`);
    }
  };

  const handleDeleteDraftRow = async (task: Task) => {
    const rowNumber = task.row_index ?? task.id;
    const ok = await confirm({
      message: `确定要删除任务行 #${rowNumber} 吗？`,
      danger: true,
      confirmText: '删除',
    });
    if (!ok) {
      return;
    }

    try {
      await deleteTaskAction(task.id);
      setInvalidTasks((prev) => prev.filter((item) => item.taskId !== task.id));
      setTaskAssets((prev) => {
        if (!(task.id in prev)) {
          return prev;
        }

        const next = { ...prev };
        delete next[task.id];
        return next;
      });
      setPromptDrafts((prev) => {
        if (!(task.id in prev)) {
          return prev;
        }

        const next = { ...prev };
        delete next[task.id];
        return next;
      });
      setGeneratingTaskIds((prev) => {
        if (!prev.has(task.id)) {
          return prev;
        }

        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
      setUploadingImageTaskIds((prev) => prev.filter((id) => id !== task.id));
      setUploadingAudioTaskIds((prev) => prev.filter((id) => id !== task.id));
      setOutputTasks((prev) => prev.filter((outputTask) => outputTask.source_task_id !== task.id));
      delete savingPromptPromisesRef.current[task.id];
    } catch (error) {
      toast.error(`删除任务行失败：${error instanceof Error ? error.message : error}`);
    }
  };

  const handleSavePrompt = async (task: Task): Promise<boolean> => {
    const nextPrompt = promptDrafts[task.id] ?? task.prompt ?? '';
    if (nextPrompt === (task.prompt ?? '')) {
      return true;
    }

    const existingPromise = savingPromptPromisesRef.current[task.id];
    if (existingPromise) {
      return existingPromise;
    }

    const savePromise = (async () => {
      try {
        await updateTaskAction(task.id, { prompt: nextPrompt });
        setInvalidTasks((prev) => prev.filter((item) => item.taskId !== task.id));
        return true;
      } catch (error) {
        setPromptDrafts((prev) => ({ ...prev, [task.id]: task.prompt ?? '' }));
        toast.error(`保存提示词失败：${error instanceof Error ? error.message : error}`);
        return false;
      } finally {
        delete savingPromptPromisesRef.current[task.id];
      }
    })();

    savingPromptPromisesRef.current[task.id] = savePromise;
    return savePromise;
  };

  const handleVideoCountChange = async (taskId: number, value: number) => {
    try {
      await updateTaskAction(taskId, { video_count: value });
      setInvalidTasks((prev) => prev.filter((item) => item.taskId !== taskId));
    } catch (error) {
      toast.error(`更新视频数量失败：${error instanceof Error ? error.message : error}`);
    }
  };

  const refreshTaskAssets = async (taskId: number) => {
    const latestAssets = await taskService.getTaskAssets(taskId);
    setTaskAssets((prev) => ({
      ...prev,
      [taskId]: latestAssets,
    }));
  };

  const handleUploadAssets = async (
    taskId: number,
    files: FileList | null,
    assetType: 'images' | 'audios' | 'videos',
  ) => {
    if (!files || files.length === 0) {
      return;
    }

    const list = Array.from(files);
    const currentAssets = taskAssets[taskId] ?? [];
    const setUploading =
      assetType === 'images'
        ? setUploadingImageTaskIds
        : assetType === 'videos'
        ? setUploadingVideoTaskIds
        : setUploadingAudioTaskIds;

    // 数量限制检查
    if (assetType === 'images') {
      const existing = getImageCount(currentAssets);
      const max = ARK_LIMITS.image.countMax;
      if (existing + list.length > max) {
        toast.warning(`图片最多 ${max} 张（当前 ${existing}，还可添加 ${Math.max(0, max - existing)}）`);
        return;
      }
    } else if (assetType === 'videos') {
      const existing = getVideoCount(currentAssets);
      const max = ARK_LIMITS.video.countMax;
      if (existing + list.length > max) {
        toast.warning(`视频最多 ${max} 个（当前 ${existing}，还可添加 ${Math.max(0, max - existing)}）`);
        return;
      }
    } else {
      const existing = getAudioCount(currentAssets);
      const max = ARK_LIMITS.audio.countMax;
      if (existing + list.length > max) {
        toast.warning(`音频最多 ${max} 个（当前 ${existing}，还可添加 ${Math.max(0, max - existing)}）`);
        return;
      }
    }

    // 逐个文件校验
    const validFiles: File[] = [];
    for (const file of list) {
      if (assetType === 'images') {
        const result = await validateImageFile(file);
        if (!result.ok) {
          toast.error(result.reason);
          continue;
        }
      } else if (assetType === 'videos') {
        const result = await validateVideoFile(file);
        if (!result.ok) {
          toast.error(result.reason);
          continue;
        }
      } else {
        const result = await validateAudioFile(file);
        if (!result.ok) {
          toast.error(result.reason);
          continue;
        }
      }
      validFiles.push(file);
    }

    if (validFiles.length === 0) return;

    try {
      setUploading((prev) => [...prev, taskId]);
      if (assetType === 'images') {
        await taskService.addTaskAssets(taskId, validFiles);
      } else if (assetType === 'videos') {
        await taskService.addTaskAssets(taskId, undefined, undefined, validFiles);
      } else {
        await taskService.addTaskAssets(taskId, undefined, validFiles);
      }
      await refreshTaskAssets(taskId);
      setInvalidTasks((prev) => prev.filter((item) => item.taskId !== taskId));
    } catch (error) {
      toast.error(`上传素材失败：${error instanceof Error ? error.message : error}`);
    } finally {
      setUploading((prev) => prev.filter((id) => id !== taskId));
    }
  };

  const handleGenerateTask = async (task: Task) => {
    if (!localState.selectedProjectId) {
      toast.warning('请先选择项目');
      return;
    }

    if (generatingTaskIds.has(task.id) || hasActiveOutputTasks(outputTasksBySourceTask[task.id] ?? [])) {
      return;
    }

    const saved = await handleSavePrompt(task);
    if (!saved) {
      return;
    }

    setGeneratingTaskIds((prev) => new Set(prev).add(task.id));
    setInvalidTasks((prev) => prev.filter((item) => item.taskId !== task.id));

    try {
      await taskService.generateTaskVideo(task.id);
      await refreshOutputTasks(localState.selectedProjectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : '生成视频失败';
      setInvalidTasks((prev) => [
        ...prev.filter((item) => item.taskId !== task.id),
        {
          taskId: task.id,
          prompt: promptDrafts[task.id] ?? task.prompt ?? '',
          reason: message,
        },
      ]);
      toast.error(`启动生成失败：${message}`);
    } finally {
      setGeneratingTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
  };

  const getStatusClass = (status: string) => {
    switch (status) {
      case 'done':
        return 'bg-green-500/20 text-green-400 border-green-500/30';
      case 'generating':
      case 'running':
        return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
      case 'paused':
        return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
      case 'error':
        return 'bg-red-500/20 text-red-400 border-red-500/30';
      case 'cancelled':
        return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
      default:
        return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'done':
        return '已完成';
      case 'generating':
      case 'running':
        return '运行中';
      case 'paused':
        return '已暂停';
      case 'error':
        return '出错';
      case 'cancelled':
        return '已取消';
      default:
        return '等待中';
    }
  };

  return (
    <div className="h-screen flex bg-[#0f111a] text-white">
      <div className="w-64 border-r border-gray-800 flex flex-col">
        <div className="p-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-lg font-bold">项目列表</h2>
          <button
            onClick={() => setLocalState((prev) => ({ ...prev, isCreatingProject: true }))}
            className="p-1.5 bg-purple-600 hover:bg-purple-500 rounded-lg transition-colors"
            title="创建项目"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {projects.length === 0 ? (
            <div className="p-4 text-center text-gray-500 text-sm">暂无项目，点击右上角创建</div>
          ) : (
            projects.map((project) => (
              <div
                key={project.id}
                className={`p-3 border-b border-gray-800 cursor-pointer transition-colors ${localState.selectedProjectId === project.id
                    ? 'bg-purple-600/20 border-purple-500/50'
                    : 'hover:bg-gray-800/50'
                  }`}
                onClick={() => handleSelectProject(project)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm truncate">{project.name}</span>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleDeleteProject(project.id, project.name);
                    }}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-red-500/10 hover:text-red-400 transition-colors"
                    title="删除项目"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {project.task_count || 0} 个任务 · {project.completed_count || 0} 已完成
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="p-4 border-b border-gray-800 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-lg font-bold">{selectedProject ? selectedProject.name : '请选择项目'}</h2>
            {selectedProject && (
              <p className="mt-1 text-xs text-gray-500">
                已配置 {configuredDraftTasks.length} 行，可继续补齐到 {Math.max(DEFAULT_DRAFT_ROWS, draftTasks.length)} 行。
              </p>
            )}
          </div>
        </div>

        {selectedProject && (
          <div className="mx-4 mt-4 rounded-xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-xs text-blue-100">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span>默认创建 1 行草稿任务，可直接编辑提示词、图片、音频和视频数量。点击下方「+ 添加任务行」增加更多。</span>
              <span>每一行都可以单独点击“生成”异步提交，不会阻塞其他任务行。</span>
              <span>音频仅保存，生成记录可到下载管理继续查看和下载。</span>
            </div>
          </div>
        )}

        {(pageError || invalidTasks.length > 0) && (
          <div className="mx-4 mt-4 space-y-3">
            {pageError && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
                {pageError}
              </div>
            )}
            {invalidTasks.length > 0 && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
                <h3 className="text-sm font-semibold text-red-300 mb-2">以下任务行无法启动生成</h3>
                <div className="space-y-2">
                  {invalidTasks.map((task) => (
                    <div key={task.taskId} className="text-xs text-red-200">
                      <span className="font-medium">任务 #{task.taskId}</span>
                      <span className="text-red-300"> · {task.reason}</span>
                      <p className="text-red-100/80 mt-1 line-clamp-2">{task.prompt}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {!localState.selectedProjectId ? (
            <div className="h-full flex items-center justify-center text-gray-500">请从左侧选择一个项目</div>
          ) : isInitializingRows ? (
            <div className="h-full flex items-center justify-center text-gray-500">正在初始化草稿任务...</div>
          ) : (
            <div className="space-y-4 pb-6">
              {draftTasks.map((task, index) => {
                const assets = taskAssets[task.id] ?? [];
                const imageCount = getImageCount(assets);
                const audioCount = getAudioCount(assets);
                const isUploadingImages = uploadingImageTaskIds.includes(task.id);
                const isUploadingAudios = uploadingAudioTaskIds.includes(task.id);
                const runtimeTasks = outputTasksBySourceTask[task.id] ?? [];
                const isGenerating = generatingTaskIds.has(task.id);
                const hasRunningOutputs = hasActiveOutputTasks(runtimeTasks);
                const isGenerateDisabled =
                  isGenerating ||
                  isUploadingImages ||
                  isUploadingAudios ||
                  isInitializingRows ||
                  isLoadingAssets ||
                  hasRunningOutputs;
                const isInvalidTask = invalidTasks.some((item) => item.taskId === task.id);
                const promptValue = promptDrafts[task.id] ?? task.prompt ?? '';
                const rowNumber = task.row_index ?? index + 1;
                const rowStatusClass =
                  isGenerating || hasRunningOutputs
                    ? getStatusClass('generating')
                    : getStatusClass(task.status);
                const rowStatusText = isGenerating
                  ? '提交中'
                  : hasRunningOutputs
                    ? '生成中'
                    : task.status === 'pending'
                      ? '待提交'
                      : getStatusText(task.status);

                return (
                  <div
                    key={task.id}
                    className={`rounded-2xl border p-4 ${isInvalidTask
                        ? 'border-red-500/40 bg-red-500/5'
                        : 'border-gray-800 bg-[#121625]'
                      }`}
                  >
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-xl bg-purple-600/20 text-purple-300 flex items-center justify-center text-sm font-semibold">
                          {rowNumber}
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold">任务行 #{rowNumber}</h3>
                          <div className="mt-1 flex items-center gap-2 flex-wrap text-xs text-gray-500">
                            <span className={`px-2 py-0.5 rounded border ${rowStatusClass}`}>{rowStatusText}</span>
                            <span>{imageCount} 张图片</span>
                            <span>{audioCount} 个音频</span>
                            <span>{task.video_count || 1} 个输出</span>
                            <span>{runtimeTasks.length} 条记录</span>
                          </div>
                        </div>
                      </div>

                      <div className="text-xs text-gray-500 flex flex-col items-end gap-1">
                        {hasRunningOutputs && <span>当前行已有生成中的记录</span>}
                        {task.submit_id && <span>Submit ID: {task.submit_id}</span>}
                        {task.history_id && <span>History ID: {task.history_id}</span>}
                      </div>
                    </div>

                    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr),360px]">
                      <div>
                        <label className="block text-xs text-gray-400 mb-2">提示词</label>
                        <textarea
                          value={promptValue}
                          onChange={(event) => {
                            const value = event.target.value;
                            setPromptDrafts((prev) => ({ ...prev, [task.id]: value }));
                          }}
                          onBlur={() => {
                            void handleSavePrompt(task);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                              event.currentTarget.blur();
                            }
                          }}
                          placeholder="填写该行提示词，点击下方生成后会提交当前行任务"
                          className="w-full min-h-[112px] resize-y bg-[#0f111a] border border-gray-700 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-purple-500"
                        />
                        <p className="mt-2 text-[11px] text-gray-500">失焦后自动保存，按 Ctrl/Cmd + Enter 也可立即保存。</p>
                      </div>

                      <div className="space-y-4">
                        <div>
                          <label className="block text-xs text-gray-400 mb-2">生成数量</label>
                          <select
                            value={task.video_count || 1}
                            onChange={(event) => {
                              void handleVideoCountChange(task.id, Number(event.target.value));
                            }}
                            className="w-full bg-[#0f111a] border border-gray-700 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-purple-500"
                          >
                            {VIDEO_COUNT_OPTIONS.map((count) => (
                              <option key={count} value={count}>
                                生成 {count} 个视频
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                          <label className="rounded-xl border border-gray-700 bg-[#0f111a] px-3 py-3 text-sm cursor-pointer hover:border-purple-500 transition-colors">
                            <div className="font-medium">上传图片</div>
                            <div className="mt-1 text-xs text-gray-500">
                              {isUploadingImages ? '上传中...' : `当前 ${imageCount} 张，最多 ${ARK_LIMITS.image.countMax} 张`}
                            </div>
                            <input
                              type="file"
                              accept="image/*"
                              multiple
                              className="hidden"
                              disabled={isUploadingImages}
                              onChange={(event) => {
                                void handleUploadAssets(task.id, event.target.files, 'images');
                                event.target.value = '';
                              }}
                            />
                          </label>

                          <label className="rounded-xl border border-gray-700 bg-[#0f111a] px-3 py-3 text-sm cursor-pointer hover:border-purple-500 transition-colors">
                            <div className="font-medium">上传视频</div>
                            <div className="mt-1 text-xs text-gray-500">
                              {uploadingVideoTaskIds.includes(task.id) ? '上传中...' : `当前 ${getVideoCount(assets)} 个，最多 ${ARK_LIMITS.video.countMax} 个`}
                            </div>
                            <input
                              type="file"
                              accept="video/mp4,video/quicktime"
                              multiple
                              className="hidden"
                              disabled={uploadingVideoTaskIds.includes(task.id)}
                              onChange={(event) => {
                                void handleUploadAssets(task.id, event.target.files, 'videos');
                                event.target.value = '';
                              }}
                            />
                          </label>

                          <label className="rounded-xl border border-gray-700 bg-[#0f111a] px-3 py-3 text-sm cursor-pointer hover:border-purple-500 transition-colors">
                            <div className="font-medium">上传音频</div>
                            <div className="mt-1 text-xs text-gray-500">
                              {isUploadingAudios ? '上传中...' : `当前 ${audioCount} 个，最多 ${ARK_LIMITS.audio.countMax} 个`}
                            </div>
                            <input
                              type="file"
                              accept="audio/mpeg,audio/wav"
                              multiple
                              className="hidden"
                              disabled={isUploadingAudios}
                              onChange={(event) => {
                                void handleUploadAssets(task.id, event.target.files, 'audios');
                                event.target.value = '';
                              }}
                            />
                          </label>
                        </div>

                        <div className="rounded-xl border border-gray-800 bg-[#0f111a] px-3 py-3">
                          <div className="text-xs text-gray-400 mb-2">当前状态</div>
                          <div className="flex flex-wrap gap-2 text-xs">
                            <span className={`px-2 py-1 rounded border ${imageCount > 0 ? 'border-green-500/30 text-green-300 bg-green-500/10' : 'border-amber-500/30 text-amber-300 bg-amber-500/10'}`}>
                              图片 {imageCount}
                            </span>
                            <span className={`px-2 py-1 rounded border ${getVideoCount(assets) > 0 ? 'border-purple-500/30 text-purple-300 bg-purple-500/10' : 'border-gray-700 text-gray-400 bg-gray-800/30'}`}>
                              视频 {getVideoCount(assets)}
                            </span>
                            <span className={`px-2 py-1 rounded border ${audioCount > 0 ? 'border-blue-500/30 text-blue-300 bg-blue-500/10' : 'border-gray-700 text-gray-400 bg-gray-800/30'}`}>
                              音频 {audioCount}
                            </span>
                            <span className="px-2 py-1 rounded border border-gray-700 text-gray-300 bg-gray-800/30">
                              输出 {task.video_count || 1}
                            </span>
                          </div>
                          {isInvalidTask && (
                            <p className="mt-3 text-xs text-red-300">当前行启动前校验未通过，请补齐提示词或图片素材。</p>
                          )}
                        </div>
                      </div>
                    </div>

                    {runtimeTasks.length > 0 && (
                      <div className="mt-4 rounded-xl border border-gray-800 bg-[#0f111a] px-3 py-3">
                        <div className="text-xs text-gray-400 mb-3">输出记录</div>
                        <div className="space-y-2">
                          {runtimeTasks.map((runtimeTask) => (
                            <div key={runtimeTask.id} className="rounded-lg border border-gray-800 bg-[#151929] px-3 py-2">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className={`text-xs px-2 py-0.5 rounded border ${getStatusClass(runtimeTask.status)}`}>
                                  {getStatusText(runtimeTask.status)}
                                </span>
                                {typeof runtimeTask.output_index === 'number' && (
                                  <span className="text-xs text-gray-400">输出 #{runtimeTask.output_index}</span>
                                )}
                                {runtimeTask.submit_id && (
                                  <span className="text-xs text-gray-500">Submit ID: {runtimeTask.submit_id}</span>
                                )}
                                {runtimeTask.history_id && (
                                  <span className="text-xs text-gray-500">History ID: {runtimeTask.history_id}</span>
                                )}
                              </div>
                              {runtimeTask.progress && (
                                <p className="mt-2 text-xs text-blue-300">{runtimeTask.progress}</p>
                              )}
                              {runtimeTask.error_message && (
                                <p className="mt-2 text-xs text-red-300">{runtimeTask.error_message}</p>
                              )}
                              {runtimeTask.video_url && (
                                <p className="mt-2 text-xs text-green-300">已返回视频结果，可到下载管理继续查看。</p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <button
                        onClick={() => {
                          void handleGenerateTask(task);
                        }}
                        disabled={isGenerateDisabled}
                        className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 px-4 py-2 text-sm font-medium transition-all hover:from-purple-500 hover:to-indigo-500 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500"
                      >
                        {isGenerating ? (
                          <>
                            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                            提交中...
                          </>
                        ) : hasRunningOutputs ? (
                          '生成中...'
                        ) : (
                          '生成'
                        )}
                      </button>
                      <button
                        onClick={() => {
                          void handleDeleteDraftRow(task);
                        }}
                        className="rounded-lg border border-gray-700 bg-[#0f111a] px-4 py-2 text-sm text-gray-200 transition-colors hover:border-red-500/40 hover:text-red-400"
                      >
                        删除
                      </button>
                      {hasRunningOutputs && (
                        <span className="text-xs text-gray-500">当前行已有任务在后台运行，可继续操作其他任务行。</span>
                      )}
                    </div>
                  </div>
                );
              })}

              <button
                onClick={() => {
                  void handleAddDraftRow();
                }}
                className="w-full rounded-2xl border border-dashed border-purple-500/40 bg-purple-500/5 px-4 py-4 text-sm text-purple-200 hover:bg-purple-500/10 hover:border-purple-400/60 transition-colors"
              >
                + 新增任务行
              </button>
            </div>
          )}
        </div>
      </div>

      {localState.isCreatingProject && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#1c1f2e] rounded-xl p-6 w-full max-w-md border border-gray-800">
            <h3 className="text-lg font-bold mb-4">创建新项目</h3>
            <input
              type="text"
              value={newProjectName}
              onChange={(event) => setNewProjectName(event.target.value)}
              placeholder="输入项目名称"
              className="w-full bg-[#0f111a] border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500 mb-4"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void handleCreateProject();
                }
              }}
              autoFocus
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setLocalState((prev) => ({ ...prev, isCreatingProject: false }));
                  setNewProjectName('');
                }}
                className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleCreateProject}
                disabled={!newProjectName.trim()}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 rounded-lg transition-colors"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
