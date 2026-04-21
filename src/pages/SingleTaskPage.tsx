import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { PromptEditor, AssetStrip, type AssetItem, type PromptEditorHandle } from '../components/PromptEditor';
import type {
  AspectRatio,
  Duration,
  ModelId,
  Resolution,
  UploadedImage,
  GenerationState,
} from '../types/index';
import { RATIO_OPTIONS, DURATION_OPTIONS, MODEL_OPTIONS, RESOLUTION_OPTIONS } from '../types/index';
import { generateVideo } from '../services/videoService';
import { archiveTask } from '../services/archiveService';
import VideoPlayer from '../components/VideoPlayer';
import PresetPanel from '../components/PresetPanel';
import { useToast } from '../components/Toast';
import {
  GearIcon,
  PlusIcon,
  CloseIcon,
  SparkleIcon,
  HistoryIcon,
  PackageIcon,
  CheckIcon,
  FilmIcon,
} from '../components/Icons';
import { useNavigate } from 'react-router-dom';
import { getAuthSessionId } from '../services/authService';
import {
  ARK_LIMITS,
  validateImageFile,
  validateVideoFile,
  validateAudioFile,
  validateImageCount,
  validateMediaGroup,
} from '../utils/arkFileLimits';
import {
  fileToAssetSnapshot,
  savePreset,
  pushHistory,
  saveDraft,
  loadDraft,
  clearDraft,
  isSnapshotEmpty,
  matchesSnapshot,
  initStorage,
  prewarmBlob,
  reconstructFile,
  type ConfigSnapshot,
  type AssetSnapshot,
} from '../services/configPresetService';

let nextId = 0;

interface VideoItem {
  id: string;
  file: File;
  previewUrl: string;
  duration: number;
  width: number;
  height: number;
}
interface AudioItem {
  id: string;
  file: File;
  duration: number;
}

/**
 * 紧凑型 Toggle 芯片：整块按钮可点击切换，带视觉状态。
 * 适用于"有声视频 / 固定镜头 / 水印"这类布尔开关，节省纵向空间。
 */
function ToggleChip({
  label,
  tooltip,
  checked,
  onChange,
}: {
  label: string;
  tooltip?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      title={tooltip}
      className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg border text-xs transition-all ${
        checked
          ? 'border-purple-500 bg-purple-500/10 text-purple-300'
          : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
      }`}
    >
      <span className="truncate">{label}</span>
      <span
        className={`relative inline-flex h-4 w-7 flex-shrink-0 rounded-full transition-colors ${
          checked ? 'bg-purple-500' : 'bg-gray-700'
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-3.5' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  );
}

/**
 * 右上角视频结果预览卡片（放大版）：
 * - 空闲：占位图，提示"生成结果将在此处预览"
 * - 生成中：spinner + 简短标签；下方 status line 显示完整 progress 文本
 * - 失败：红色感叹号；下方 status line 显示错误简述 + "点击查看详情"
 * - 成功：autoplay+muted+loop 的视频缩略图，hover 显示放大图标；下方 status line 显示"✓ 生成完成"
 * 整块（视频缩略 + 状态行）均可点击 → 触发 onOpen 弹窗放大
 */
function ResultPreview({
  videoUrl,
  isGenerating,
  hasError,
  error,
  progress,
  onOpen,
}: {
  videoUrl: string | null;
  isGenerating: boolean;
  hasError: boolean;
  error?: string;
  progress?: string;
  onOpen: () => void;
}) {
  const proxied = videoUrl ? `/api/video-proxy?url=${encodeURIComponent(videoUrl)}` : '';
  const interactive = isGenerating || hasError || !!videoUrl;

  const title = videoUrl
    ? '点击放大播放'
    : isGenerating
      ? `点击查看生成进度${progress ? '：' + progress : ''}`
      : hasError
        ? '点击查看错误详情'
        : '生成结果将在此处显示';

  // 下方状态行的文字 / 颜色
  const statusText = videoUrl
    ? '✓ 视频已生成 · 点击放大播放'
    : isGenerating
      ? progress || '正在生成视频...'
      : hasError
        ? `✕ ${error || '生成失败'}`
        : '生成结果将在此处预览';
  const statusColor = videoUrl
    ? 'text-green-300'
    : isGenerating
      ? 'text-purple-200'
      : hasError
        ? 'text-red-300'
        : 'text-gray-500';

  return (
    <div className="w-full h-full flex flex-col gap-2 min-h-0">
      {/* 预览画面：撑满父容器剩余空间 */}
      <button
        type="button"
        onClick={interactive ? onOpen : undefined}
        disabled={!interactive}
        title={title}
        className={`relative w-full flex-1 min-h-[260px] rounded-xl overflow-hidden border transition-all flex items-center justify-center group ${
          videoUrl
            ? 'bg-black border-purple-500/60 shadow-[0_0_0_1px_rgba(168,85,247,0.15)] cursor-zoom-in'
            : isGenerating
              ? 'bg-[#1c1f2e] border-purple-500/40 cursor-pointer'
              : hasError
                ? 'bg-red-950/30 border-red-500/40 cursor-pointer'
                : 'bg-[#1c1f2e] border-gray-800 cursor-default'
        }`}
      >
        {videoUrl ? (
          <>
            <video
              src={proxied}
              muted
              loop
              autoPlay
              playsInline
              className="w-full h-full object-contain bg-black pointer-events-none"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
              <svg
                className="w-12 h-12 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-lg"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
            </div>
          </>
        ) : isGenerating ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="w-12 h-12 border-[3px] border-purple-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-purple-200">正在生成中…</span>
          </div>
        ) : hasError ? (
          <div className="flex flex-col items-center justify-center gap-2 text-center px-6">
            <div className="w-14 h-14 rounded-full bg-red-500/20 border border-red-500/50 flex items-center justify-center text-red-300 font-bold text-2xl leading-none">
              !
            </div>
            <span className="text-sm text-red-300">生成失败 · 点击查看</span>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 opacity-60">
            <FilmIcon className="w-12 h-12 text-gray-500" />
            <span className="text-sm text-gray-500">视频结果预览</span>
          </div>
        )}
      </button>

      {/* 状态 / 进度文字行（保留之前"生成过程描述"的体验） */}
      <button
        type="button"
        onClick={interactive ? onOpen : undefined}
        disabled={!interactive}
        className={`w-full text-left text-xs leading-snug px-3 py-2 rounded-md border bg-[#1c1f2e] border-gray-800 min-h-[40px] flex items-start gap-2 flex-shrink-0 ${
          interactive ? 'hover:border-purple-500/40 cursor-pointer' : 'cursor-default'
        }`}
        title={statusText}
      >
        {isGenerating && (
          <span className="inline-block w-2 h-2 rounded-full bg-purple-400 animate-pulse mt-[5px] flex-shrink-0" />
        )}
        <span className={`${statusColor} line-clamp-2 break-words flex-1`}>{statusText}</span>
      </button>
    </div>
  );
}

/**
 * 单个视频预览 tile：与参考图片一致的 80×80 方块。
 * - 用 muted/autoPlay/loop 做静音循环缩略，方便识别视频内容
 * - 左下角小标签显示时长，hover 出现移除按钮
 * - 仍保留 onLoadedMetadata 回填原始宽高（用于后续接口与草稿恢复）
 */
function VideoTile({
  item,
  onRemove,
  onUpdateDims,
}: {
  item: VideoItem;
  onRemove: () => void;
  onUpdateDims: (width: number, height: number) => void;
}) {
  const hasDims = item.width > 0 && item.height > 0;
  return (
    <div
      className="relative group w-20 h-20 flex-shrink-0"
      title={`${item.file.name} · ${item.duration.toFixed(1)}s · ${(item.file.size / 1024 / 1024).toFixed(1)} MB`}
    >
      <video
        src={item.previewUrl}
        muted
        autoPlay
        loop
        playsInline
        preload="metadata"
        className="w-full h-full object-cover rounded-xl border border-gray-700 bg-black"
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          if (el.videoWidth > 0 && el.videoHeight > 0 && !hasDims) {
            onUpdateDims(el.videoWidth, el.videoHeight);
          }
        }}
      />
      <span className="absolute bottom-0 left-0 bg-black/70 text-[10px] text-cyan-300 px-1.5 py-0.5 rounded-br-xl rounded-tl-xl font-medium tabular-nums">
        {item.duration.toFixed(1)}s
      </span>
      <button
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-800 border border-gray-700 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 hover:border-red-600"
        title="移除"
      >
        <CloseIcon className="w-3 h-3 text-white" />
      </button>
    </div>
  );
}

export default function SingleTaskPage() {
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [videoItems, setVideoItems] = useState<VideoItem[]>([]);
  const [audioItems, setAudioItems] = useState<AudioItem[]>([]);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<ModelId>(MODEL_OPTIONS[0].value);
  const [ratio, setRatio] = useState<AspectRatio>('9:16');
  const [duration, setDuration] = useState<Duration>(5);
  // 新暴露的 Seedance 2.0 原生参数
  const [resolution, setResolution] = useState<Resolution>('720p');
  /** 种子值；'' 表示随机（模型自动） */
  const [seedInput, setSeedInput] = useState<string>('');
  const [cameraFixed, setCameraFixed] = useState<boolean>(false);
  const [watermark, setWatermark] = useState<boolean>(false);
  const [generateAudio, setGenerateAudio] = useState<boolean>(true);
  /** 视频预览弹窗是否打开；生成成功/失败时会自动打开 */
  const [playerOpen, setPlayerOpen] = useState<boolean>(false);
  const [generation, setGeneration] = useState<GenerationState>({
    status: 'idle',
  });
  // 校验 / 上传错误提示 (UI 顶部横幅)
  const [uploadError, setUploadError] = useState<string>('');
  const [uploadWarning, setUploadWarning] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const maxImages = ARK_LIMITS.image.countMax;
  const maxVideos = ARK_LIMITS.video.countMax;
  const maxAudios = ARK_LIMITS.audio.countMax;
  const navigate = useNavigate();

  // 提示词编辑弹窗
  const [showPromptModal, setShowPromptModal] = useState(false);
  const [modalPrompt, setModalPrompt] = useState('');
  const [aiOptimizing, setAiOptimizing] = useState(false);
  const [aiOutput, setAiOutput] = useState('');
  const aiAbortRef = useRef<AbortController | null>(null);
  const promptEditorRef = useRef<PromptEditorHandle>(null);

  // 配置预设相关
  const { toast, prompt: showPrompt } = useToast();
  const [showPresetPanel, setShowPresetPanel] = useState(false);
  const [presetReloadToken, setPresetReloadToken] = useState(0);
  /** 从预设/历史加载后待补全的素材清单（按原 kind 分组，按 label 顺序） */
  const [pending, setPending] = useState<{
    images: AssetSnapshot[];
    videos: AssetSnapshot[];
    audios: AssetSnapshot[];
  } | null>(null);
  /** 未提交的 draft 快照：挂载时询问是否恢复 */
  const [draftToRestore, setDraftToRestore] = useState<ConfigSnapshot | null>(null);
  const [draftRestoreTs, setDraftRestoreTs] = useState<number | null>(null);

  // 弹窗顶部素材条 & 编辑器需要的统一 AssetItem 列表
  const modalAssets = useMemo<AssetItem[]>(() => {
    const items: AssetItem[] = [];
    images.forEach((img) => {
      items.push({
        kind: 'image',
        id: img.id,
        label: `图${img.index}`,
        thumb: img.previewUrl,
      });
    });
    videoItems.forEach((v, i) => {
      items.push({
        kind: 'video',
        id: v.id,
        label: `视频${i + 1}`,
        thumb: v.previewUrl,
      });
    });
    audioItems.forEach((a, i) => {
      items.push({
        kind: 'audio',
        id: a.id,
        label: `音频${i + 1}`,
      });
    });
    return items;
  }, [images, videoItems, audioItems]);

  // ==========================================================
  // Pending 匹配：看哪些期望素材已经被用户重新选择补齐
  // ==========================================================
  const pendingMatches = useMemo(() => {
    if (!pending) return null;
    const imageHit = pending.images.map((snap) =>
      images.some((img) => matchesSnapshot(img.file, snap)),
    );
    const videoHit = pending.videos.map((snap) =>
      videoItems.some((v) => matchesSnapshot(v.file, snap)),
    );
    const audioHit = pending.audios.map((snap) =>
      audioItems.some((a) => matchesSnapshot(a.file, snap)),
    );
    const totalExpected =
      pending.images.length + pending.videos.length + pending.audios.length;
    const totalHit =
      imageHit.filter(Boolean).length +
      videoHit.filter(Boolean).length +
      audioHit.filter(Boolean).length;
    return { imageHit, videoHit, audioHit, totalExpected, totalHit };
  }, [pending, images, videoItems, audioItems]);

  // ==========================================================
  // 当前配置 → ConfigSnapshot（异步，需要生成缩略图）
  // ==========================================================
  const buildCurrentSnapshot = useCallback(async (): Promise<ConfigSnapshot> => {
    const imageSnaps = await Promise.all(
      images.map((img) =>
        fileToAssetSnapshot(img.file, 'image', { label: `图${img.index}` }),
      ),
    );
    const videoSnaps = await Promise.all(
      videoItems.map((v, i) =>
        fileToAssetSnapshot(v.file, 'video', {
          label: `视频${i + 1}`,
          durationSeconds: v.duration,
          width: v.width,
          height: v.height,
        }),
      ),
    );
    const audioSnaps = await Promise.all(
      audioItems.map((a, i) =>
        fileToAssetSnapshot(a.file, 'audio', {
          label: `音频${i + 1}`,
          durationSeconds: a.duration,
        }),
      ),
    );
    const seedNum = seedInput.trim() === '' ? null : Number(seedInput);
    return {
      prompt,
      model,
      ratio,
      duration,
      resolution,
      seed: Number.isFinite(seedNum as number) ? (seedNum as number) : null,
      cameraFixed,
      watermark,
      generateAudio,
      images: imageSnaps,
      videos: videoSnaps,
      audios: audioSnaps,
    };
  }, [
    prompt,
    model,
    ratio,
    duration,
    resolution,
    seedInput,
    cameraFixed,
    watermark,
    generateAudio,
    images,
    videoItems,
    audioItems,
  ]);

  // ==========================================================
  // 加载一个快照回填到 UI：清空现有素材 + 恢复参数 + 从 Blob 仓库重建文件
  // 未能重建的素材（哈希缺失或已 GC）进入 pending 提示区
  // ==========================================================
  const applySnapshot = useCallback(
    async (snap: ConfigSnapshot) => {
      // 清理现有素材 URL
      images.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      videoItems.forEach((v) => URL.revokeObjectURL(v.previewUrl));
      setImages([]);
      setVideoItems([]);
      setAudioItems([]);
      setUploadError('');
      setUploadWarning('');

      // 恢复文本/参数
      setPrompt(snap.prompt || '');
      if (snap.model) setModel(snap.model as ModelId);
      if (snap.ratio) setRatio(snap.ratio as AspectRatio);
      if (typeof snap.duration === 'number') setDuration(snap.duration as Duration);
      if (snap.resolution === '480p' || snap.resolution === '720p') {
        setResolution(snap.resolution);
      }
      if (typeof snap.seed === 'number' && Number.isFinite(snap.seed)) {
        setSeedInput(String(snap.seed));
      } else {
        setSeedInput('');
      }
      if (typeof snap.cameraFixed === 'boolean') setCameraFixed(snap.cameraFixed);
      if (typeof snap.watermark === 'boolean') setWatermark(snap.watermark);
      if (typeof snap.generateAudio === 'boolean') setGenerateAudio(snap.generateAudio);

      // 并发尝试重建每个素材
      const imageResults = await Promise.all(
        snap.images.map(async (s, i) => ({ snap: s, idx: i, file: await reconstructFile(s) })),
      );
      const videoResults = await Promise.all(
        snap.videos.map(async (s, i) => ({ snap: s, idx: i, file: await reconstructFile(s) })),
      );
      const audioResults = await Promise.all(
        snap.audios.map(async (s, i) => ({ snap: s, idx: i, file: await reconstructFile(s) })),
      );

      const restoredImages: UploadedImage[] = [];
      const missingImages: AssetSnapshot[] = [];
      imageResults.forEach((r) => {
        if (r.file) {
          restoredImages.push({
            id: `img-${++nextId}`,
            file: r.file,
            previewUrl: URL.createObjectURL(r.file),
            index: restoredImages.length + 1,
          });
        } else {
          missingImages.push(r.snap);
        }
      });

      const restoredVideos: VideoItem[] = [];
      const missingVideos: AssetSnapshot[] = [];
      videoResults.forEach((r) => {
        if (r.file) {
          restoredVideos.push({
            id: `vid-${++nextId}`,
            file: r.file,
            previewUrl: URL.createObjectURL(r.file),
            duration: r.snap.durationSeconds ?? 0,
            width: r.snap.width ?? 0,
            height: r.snap.height ?? 0,
          });
        } else {
          missingVideos.push(r.snap);
        }
      });

      const restoredAudios: AudioItem[] = [];
      const missingAudios: AssetSnapshot[] = [];
      audioResults.forEach((r) => {
        if (r.file) {
          restoredAudios.push({
            id: `aud-${++nextId}`,
            file: r.file,
            duration: r.snap.durationSeconds ?? 0,
          });
        } else {
          missingAudios.push(r.snap);
        }
      });

      setImages(restoredImages);
      setVideoItems(restoredVideos);
      setAudioItems(restoredAudios);

      const hasMissing =
        missingImages.length > 0 || missingVideos.length > 0 || missingAudios.length > 0;
      setPending(
        hasMissing
          ? { images: missingImages, videos: missingVideos, audios: missingAudios }
          : null,
      );

      setGeneration({ status: 'idle' });
      setDraftToRestore(null);
      setDraftRestoreTs(null);
    },
    [images, videoItems],
  );

  // ==========================================================
  // 挂载时：初始化存储（持久化申请 + GC）并尝试恢复未提交的 draft
  // ==========================================================
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await initStorage();
        if (cancelled) return;
        const entry = await loadDraft();
        if (cancelled || !entry) return;
        if (isSnapshotEmpty(entry.snapshot)) {
          void clearDraft();
          return;
        }
        setDraftToRestore(entry.snapshot);
        setDraftRestoreTs(entry.createdAt);
      } catch (e) {
        console.warn('[preset] 初始化或加载 draft 失败', e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 只在首次挂载运行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ==========================================================
  // 自动保存 draft：变更后 3 秒无操作就把完整快照（含哈希引用）写入
  // 因为素材添加时已 prewarmBlob 预热，哈希基本已就绪，buildCurrentSnapshot 很快
  // ==========================================================
  useEffect(() => {
    const hasAnything =
      prompt.trim() ||
      images.length > 0 ||
      videoItems.length > 0 ||
      audioItems.length > 0;
    if (!hasAnything) {
      // 清空状态就丢掉 draft
      void clearDraft();
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const snap = await buildCurrentSnapshot();
          await saveDraft(snap);
        } catch (e) {
          console.warn('[preset] 自动保存 draft 失败', e);
        }
      })();
    }, 3000);
    return () => clearTimeout(timer);
  }, [prompt, model, ratio, duration, images, videoItems, audioItems, buildCurrentSnapshot]);

  // ==========================================================
  // 手动保存为预设
  // ==========================================================
  const handleSavePreset = useCallback(async () => {
    const hasAnything =
      prompt.trim() ||
      images.length > 0 ||
      videoItems.length > 0 ||
      audioItems.length > 0;
    if (!hasAnything) {
      toast.warning('当前配置为空，无需保存');
      return;
    }
    const defaultName = `预设 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
    const name = await showPrompt({
      title: '保存为预设',
      message: '为当前配置命名，之后可随时加载复用。',
      defaultValue: defaultName,
      placeholder: '例如：产品广告 · 3D 风格',
      confirmText: '保存',
    });
    if (name === null) return;
    try {
      const snap = await buildCurrentSnapshot();
      await savePreset(name, snap);
      setPresetReloadToken((n) => n + 1);
      toast.success('已保存为预设');
    } catch (e) {
      console.error('[preset] 保存预设失败', e);
      toast.error('保存失败：' + (e instanceof Error ? e.message : '未知错误'));
    }
  }, [prompt, images, videoItems, audioItems, buildCurrentSnapshot, toast, showPrompt]);

  const dismissPending = useCallback(() => setPending(null), []);
  const dismissDraftRestore = useCallback(() => {
    setDraftToRestore(null);
    setDraftRestoreTs(null);
    void clearDraft();
  }, []);
  const doRestoreDraft = useCallback(() => {
    if (!draftToRestore) return;
    void applySnapshot(draftToRestore).then(() => {
      setDraftToRestore(null);
      setDraftRestoreTs(null);
      void clearDraft();
      toast.success('已恢复上次未提交的配置');
    });
  }, [draftToRestore, applySnapshot, toast]);

  // ==========================================================
  // 图片: 异步逐张校验, 失败的跳过并记录原因
  // ==========================================================
  const addFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList) return;
      setUploadError('');
      setUploadWarning('');
      const incoming = Array.from(fileList);

      const countErr = validateImageCount(images.length, incoming.length);
      if (countErr) {
        setUploadError(countErr);
      }

      const allowed = incoming.slice(0, Math.max(0, maxImages - images.length));
      const accepted: UploadedImage[] = [];
      const errors: string[] = [];
      const warnings: string[] = [];
      for (const file of allowed) {
        const result = await validateImageFile(file);
        if (!result.ok) {
          errors.push(result.reason);
          continue;
        }
        warnings.push(...result.warnings);
        accepted.push({
          id: `img-${++nextId}`,
          file,
          previewUrl: URL.createObjectURL(file),
          index: images.length + accepted.length + 1,
        });
        prewarmBlob(file);
      }

      if (errors.length > 0) {
        setUploadError((prev) => [prev, ...errors].filter(Boolean).join('; '));
      }
      if (warnings.length > 0) {
        setUploadWarning(warnings.join('; '));
      }
      if (accepted.length > 0) {
        setImages([...images, ...accepted]);
      }
    },
    [images, maxImages]
  );

  const removeImage = useCallback(
    (id: string) => {
      const removed = images.find((img) => img.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);

      const updated = images
        .filter((img) => img.id !== id)
        .map((img, i) => ({ ...img, index: i + 1 }));
      setImages(updated);
    },
    [images]
  );

  const clearAllImages = useCallback(() => {
    images.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    setImages([]);
  }, [images]);

  // ==========================================================
  // 视频: 多段, 每段独立校验 + 聚合总时长校验
  // ==========================================================
  const addVideos = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList) return;
      setUploadError('');
      setUploadWarning('');
      const incoming = Array.from(fileList);
      const accepted: VideoItem[] = [];
      const errors: string[] = [];
      const warnings: string[] = [];

      for (const file of incoming) {
        if (videoItems.length + accepted.length >= maxVideos) {
          errors.push(`视频最多 ${maxVideos} 段`);
          break;
        }
        const r = await validateVideoFile(file);
        if (!r.ok) {
          errors.push(r.reason);
          continue;
        }
        const groupErr = validateMediaGroup(
          'video',
          [...videoItems, ...accepted].map((v) => ({ duration: v.duration })),
          { duration: r.meta.duration }
        );
        if (groupErr) {
          errors.push(groupErr);
          continue;
        }
        warnings.push(...r.warnings);
        accepted.push({
          id: `vid-${++nextId}`,
          file,
          previewUrl: URL.createObjectURL(file),
          duration: r.meta.duration,
          width: r.meta.width,
          height: r.meta.height,
        });
        prewarmBlob(file);
      }

      if (errors.length) setUploadError(errors.join('; '));
      if (warnings.length) setUploadWarning(warnings.join('; '));
      if (accepted.length) setVideoItems([...videoItems, ...accepted]);
    },
    [videoItems, maxVideos]
  );

  const removeVideo = useCallback(
    (id: string) => {
      const removed = videoItems.find((v) => v.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      setVideoItems(videoItems.filter((v) => v.id !== id));
    },
    [videoItems]
  );

  // ==========================================================
  // 音频: 多段, 每段独立校验 + 聚合总时长校验
  // ==========================================================
  const addAudios = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList) return;
      setUploadError('');
      setUploadWarning('');
      const incoming = Array.from(fileList);
      const accepted: AudioItem[] = [];
      const errors: string[] = [];

      for (const file of incoming) {
        if (audioItems.length + accepted.length >= maxAudios) {
          errors.push(`音频最多 ${maxAudios} 段`);
          break;
        }
        const r = await validateAudioFile(file);
        if (!r.ok) {
          errors.push(r.reason);
          continue;
        }
        const groupErr = validateMediaGroup(
          'audio',
          [...audioItems, ...accepted].map((a) => ({ duration: a.duration })),
          { duration: r.meta.duration }
        );
        if (groupErr) {
          errors.push(groupErr);
          continue;
        }
        accepted.push({ id: `aud-${++nextId}`, file, duration: r.meta.duration });
        prewarmBlob(file);
      }

      if (errors.length) setUploadError(errors.join('; '));
      if (accepted.length) setAudioItems([...audioItems, ...accepted]);
    },
    [audioItems, maxAudios]
  );

  const removeAudio = useCallback(
    (id: string) => {
      setAudioItems(audioItems.filter((a) => a.id !== id));
    },
    [audioItems]
  );

  const clearAllMedia = useCallback(() => {
    videoItems.forEach((v) => URL.revokeObjectURL(v.previewUrl));
    setVideoItems([]);
    setAudioItems([]);
  }, [videoItems]);

  const handleGenerate = useCallback(async () => {
    if (
      !prompt.trim() &&
      images.length === 0 &&
      videoItems.length === 0 &&
      audioItems.length === 0
    )
      return;
    if (generation.status === 'generating') return;

    setGeneration({
      status: 'generating',
      progress: '正在提交视频生成请求...',
    });

    // 捕获归档所需的素材快照（稍后用户可能清空状态）
    const archiveImages = images.map((img) => ({
      file: img.file,
      label: `图${img.index}`,
      originalName: img.file.name,
    }));
    const archiveVideos = videoItems.map((v, i) => ({
      file: v.file,
      label: `视频${i + 1}`,
      originalName: v.file.name,
      durationSeconds: v.duration,
    }));
    const archiveAudios = audioItems.map((a, i) => ({
      label: `音频${i + 1}`,
      originalName: a.file.name,
      bytes: a.file.size,
    }));

    try {
      const seedNum = seedInput.trim() === '' ? undefined : Number(seedInput);
      const result = await generateVideo(
        {
          prompt,
          model,
          ratio,
          duration,
          resolution,
          seed: Number.isFinite(seedNum as number) ? (seedNum as number) : undefined,
          cameraFixed,
          watermark,
          generateAudio,
          files: images.map((img) => img.file),
          videoFiles: videoItems.map((v) => v.file),
          audioFiles: audioItems.map((a) => a.file),
        },
        (progress) => {
          setGeneration((prev) => ({ ...prev, progress }));
        },
        // 任务提交成功后立即触发客户端归档（fire-and-forget，失败不影响主流程）
        ({ dbTaskId }) => {
          if (!dbTaskId) return;
          void archiveTask({
            prompt,
            images: archiveImages,
            videos: archiveVideos,
            audios: archiveAudios,
            meta: {
              taskId: dbTaskId,
              submittedAt: new Date().toISOString(),
              model,
              ratio,
              duration,
            },
          });
          // 提交成功 → 把当前配置写入"最近历史"，并清掉 draft
          void (async () => {
            try {
              const snap = await buildCurrentSnapshot();
              if (!isSnapshotEmpty(snap)) {
                await pushHistory(snap);
                setPresetReloadToken((n) => n + 1);
              }
              await clearDraft();
            } catch (e) {
              console.warn('[preset] 写入历史失败（不影响主流程）', e);
            }
          })();
        },
      );

      if (result.data && result.data.length > 0 && result.data[0].url) {
        setGeneration({ status: 'success', result });
      } else {
        setGeneration({
          status: 'error',
          error: '未获取到视频结果，请重试',
        });
      }
    } catch (error) {
      setGeneration({
        status: 'error',
        error: error instanceof Error ? error.message : '未知错误',
      });
    }
  }, [
    prompt,
    images,
    videoItems,
    audioItems,
    model,
    ratio,
    duration,
    resolution,
    seedInput,
    cameraFixed,
    watermark,
    generateAudio,
    generation.status,
    buildCurrentSnapshot,
  ]);

  const handleReset = () => {
    setPrompt('');
    clearAllImages();
    clearAllMedia();
    setUploadError('');
    setUploadWarning('');
    setGeneration({ status: 'idle' });
    setPending(null);
    // 仅重置核心输入；不强制复位模型/比例/分辨率/时长/开关（用户预期保留偏好）
    setSeedInput('');
  };

  const videoUrl =
    generation.status === 'success' && generation.result?.data?.[0]?.url
      ? generation.result.data[0].url
      : null;

  // 生成完成或出错时，自动弹出视频预览弹窗，确保用户能看到结果
  useEffect(() => {
    if (generation.status === 'success' || generation.status === 'error') {
      setPlayerOpen(true);
    }
  }, [generation.status]);

  // Esc 关闭视频弹窗
  useEffect(() => {
    if (!playerOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPlayerOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [playerOpen]);

  const revisedPrompt =
    generation.status === 'success'
      ? generation.result?.data?.[0]?.revised_prompt
      : undefined;

  const isGenerating = generation.status === 'generating';
  const canGenerate =
    (prompt.trim() ||
      images.length > 0 ||
      videoItems.length > 0 ||
      audioItems.length > 0) &&
    !isGenerating;

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[#0f111a] text-white">
      {/* Mobile Header */}
      <div className="md:hidden sticky top-0 z-40 bg-[#0f111a]/95 backdrop-blur-sm px-4 py-3 flex items-center justify-between border-b border-gray-800">
        <h1 className="text-lg font-bold">{MODEL_OPTIONS.find(m => m.value === model)?.label || 'Seedance 2.0'}</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPlayerOpen(true)}
            disabled={!isGenerating && !videoUrl && generation.status !== 'error'}
            className={`p-2 rounded-lg transition-colors ${
              videoUrl
                ? 'text-purple-300 hover:bg-purple-500/10'
                : isGenerating
                  ? 'text-purple-400 hover:bg-purple-500/10'
                  : generation.status === 'error'
                    ? 'text-red-400 hover:bg-red-500/10'
                    : 'text-gray-600 cursor-not-allowed'
            }`}
            title="查看视频结果"
          >
            <FilmIcon className="w-5 h-5" />
          </button>
          <button
            onClick={() => navigate('/settings')}
            className="p-2 rounded-lg hover:bg-gray-800 transition-colors"
          >
            <GearIcon className="w-5 h-5 text-gray-400" />
          </button>
        </div>
      </div>

      {/* 主面板 — 配置（右侧 VideoPlayer 已改为弹窗，此处占满整屏） */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 md:p-6 bg-[#0f111a]">
        {/* 内容最大宽度约束，避免在超宽屏上行太长 */}
        <div className="mx-auto w-full max-w-[1400px]">
        {/* Desktop Header：仅标题 + 齿轮（视频预览已搬至右列大块区域） */}
        <div className="hidden md:flex items-center justify-between gap-4 mb-4">
          <h2 className="text-xl font-bold">{MODEL_OPTIONS.find(m => m.value === model)?.label || 'Seedance 2.0'} 视频配置</h2>
          <button
            onClick={() => navigate('/settings')}
            className="p-2 rounded-lg hover:bg-gray-800 transition-colors"
            title="设置"
          >
            <GearIcon className="w-5 h-5 text-gray-400" />
          </button>
        </div>


        {/* 草稿恢复横幅 */}
        {draftToRestore && (
          <div className="mb-4 bg-indigo-900/30 border border-indigo-700/60 rounded-xl px-3 py-2.5 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-indigo-200">
                发现上次未提交的配置
                {draftRestoreTs && (
                  <span className="text-gray-400 font-normal ml-1">
                    · {new Date(draftRestoreTs).toLocaleString('zh-CN', { hour12: false })}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-gray-400 mt-0.5 truncate">
                恢复后会覆盖当前所有参数与素材条目（素材本体仍需重新选择）
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={doRestoreDraft}
                className="px-3 py-1 bg-indigo-500/30 hover:bg-indigo-500/50 text-indigo-100 rounded-md text-xs font-medium transition-colors"
              >
                恢复
              </button>
              <button
                onClick={dismissDraftRestore}
                className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-md text-xs transition-colors"
                title="忽略"
              >
                <CloseIcon className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}

        {/* 待补全素材横幅 */}
        {pending && pendingMatches && pendingMatches.totalExpected > 0 && (
          <div className="mb-4 bg-amber-900/20 border border-amber-700/50 rounded-xl px-3 py-3">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <div className="text-xs font-medium text-amber-200">
                  配置已恢复 · 待补全素材 {pendingMatches.totalHit}/{pendingMatches.totalExpected}
                </div>
                <div className="text-[11px] text-gray-400 mt-0.5">
                  浏览器安全限制无法自动读取本地文件；请按相同顺序重新选择以下素材，系统会按文件名+大小自动识别并标记已补全
                </div>
              </div>
              <button
                onClick={dismissPending}
                className="flex-shrink-0 px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-md text-xs transition-colors"
                title="关闭提示"
              >
                <CloseIcon className="w-3 h-3" />
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {pending.images.map((snap, i) => {
                const hit = pendingMatches.imageHit[i];
                return (
                  <div
                    key={`p-img-${i}`}
                    className={`flex items-center gap-1.5 bg-[#1c1f2e] border rounded-md px-2 py-1 transition-opacity ${
                      hit ? 'border-green-600/60 opacity-60' : 'border-amber-600/40'
                    }`}
                    title={`${snap.name}  (${(snap.size / 1024 / 1024).toFixed(2)} MB)`}
                  >
                    {snap.thumbDataUrl ? (
                      <img
                        src={snap.thumbDataUrl}
                        alt={snap.name}
                        className={`w-6 h-6 object-cover rounded-sm ${hit ? '' : 'ring-1 ring-amber-500/40'}`}
                      />
                    ) : (
                      <div className="w-6 h-6 bg-gray-800 rounded-sm" />
                    )}
                    <span className="text-[11px] text-purple-300 font-medium">
                      {snap.label || `图${i + 1}`}
                    </span>
                    <span className="text-[11px] text-gray-400 max-w-[120px] truncate">
                      {snap.name}
                    </span>
                    {hit && <CheckIcon className="w-3 h-3 text-green-400 flex-shrink-0" />}
                  </div>
                );
              })}
              {pending.videos.map((snap, i) => {
                const hit = pendingMatches.videoHit[i];
                return (
                  <div
                    key={`p-vid-${i}`}
                    className={`flex items-center gap-1.5 bg-[#1c1f2e] border rounded-md px-2 py-1 transition-opacity ${
                      hit ? 'border-green-600/60 opacity-60' : 'border-cyan-600/40'
                    }`}
                    title={`${snap.name}  (${(snap.size / 1024 / 1024).toFixed(2)} MB${
                      snap.durationSeconds ? `, ${snap.durationSeconds.toFixed(1)}s` : ''
                    })`}
                  >
                    {snap.thumbDataUrl ? (
                      <img
                        src={snap.thumbDataUrl}
                        alt={snap.name}
                        className="w-6 h-6 object-cover rounded-sm"
                      />
                    ) : (
                      <div className="w-6 h-6 bg-gray-800 rounded-sm" />
                    )}
                    <span className="text-[11px] text-cyan-300 font-medium">
                      {snap.label || `视频${i + 1}`}
                    </span>
                    <span className="text-[11px] text-gray-400 max-w-[120px] truncate">
                      {snap.name}
                    </span>
                    {hit && <CheckIcon className="w-3 h-3 text-green-400 flex-shrink-0" />}
                  </div>
                );
              })}
              {pending.audios.map((snap, i) => {
                const hit = pendingMatches.audioHit[i];
                return (
                  <div
                    key={`p-aud-${i}`}
                    className={`flex items-center gap-1.5 bg-[#1c1f2e] border rounded-md px-2 py-1 transition-opacity ${
                      hit ? 'border-green-600/60 opacity-60' : 'border-blue-600/40'
                    }`}
                    title={`${snap.name}  (${(snap.size / 1024 / 1024).toFixed(2)} MB${
                      snap.durationSeconds ? `, ${snap.durationSeconds.toFixed(1)}s` : ''
                    })`}
                  >
                    <span className="w-6 h-6 bg-gray-800 rounded-sm flex items-center justify-center text-blue-300 text-xs">♪</span>
                    <span className="text-[11px] text-blue-300 font-medium">
                      {snap.label || `音频${i + 1}`}
                    </span>
                    <span className="text-[11px] text-gray-400 max-w-[120px] truncate">
                      {snap.name}
                    </span>
                    {hit && <CheckIcon className="w-3 h-3 text-green-400 flex-shrink-0" />}
                  </div>
                );
              })}
            </div>
            {pendingMatches.totalHit === pendingMatches.totalExpected && (
              <div className="mt-2 text-[11px] text-green-400 flex items-center gap-1">
                <CheckIcon className="w-3 h-3" />
                全部素材已补全
              </div>
            )}
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(380px,520px)] lg:gap-6 items-start">
          {/* 左列：全部输入 + 参数配置（提示词下方即 Settings） */}
          <div className="space-y-5 min-w-0">
          {/* 配置管理按钮（紧凑：放在左列顶端，而不是横跨整条顶栏） */}
          <div className="flex items-center gap-2 -mb-1">
            <button
              onClick={() => setShowPresetPanel(true)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-[#1c1f2e] hover:bg-[#25293d] border border-gray-800 hover:border-purple-500/40 rounded-md text-xs text-gray-300 transition-all"
              title="查看保存的预设和最近提交历史"
            >
              <HistoryIcon className="w-3.5 h-3.5 text-purple-400" />
              加载配置
            </button>
            <button
              onClick={handleSavePreset}
              disabled={isGenerating}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-[#1c1f2e] hover:bg-[#25293d] border border-gray-800 hover:border-purple-500/40 rounded-md text-xs text-gray-300 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              title="把当前配置保存为可复用的预设"
            >
              <PackageIcon className="w-3.5 h-3.5 text-purple-400" />
              保存预设
            </button>
          </div>
          {/* Reference Images */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="text-sm font-bold text-gray-300">
                参考图片 (全能参考)
              </label>
              {images.length > 0 && (
                <button
                  onClick={clearAllImages}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                  清除全部
                </button>
              )}
            </div>

            {/* Thumbnails + inline 上传 tile */}
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                addFiles(e.dataTransfer.files);
              }}
              className="flex flex-wrap gap-3"
            >
              {images.map((img) => (
                <div
                  key={img.id}
                  className="relative group w-20 h-20 flex-shrink-0"
                >
                  <img
                    src={img.previewUrl}
                    alt={`参考图 ${img.index}`}
                    className="w-full h-full object-cover rounded-xl border border-gray-700"
                  />
                  <span className="absolute bottom-0 left-0 bg-black/70 text-[10px] text-purple-400 px-1.5 py-0.5 rounded-br-xl rounded-tl-xl font-medium">
                    @{img.index}
                  </span>
                  <button
                    onClick={() => removeImage(img.id)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-800 border border-gray-700 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 hover:border-red-600"
                  >
                    <CloseIcon className="w-3 h-3 text-white" />
                  </button>
                </div>
              ))}

              {/* 内联上传 tile，排在末尾，满了自动隐藏 */}
              {images.length < maxImages && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-20 h-20 flex-shrink-0 border border-dashed border-gray-700 rounded-xl flex flex-col items-center justify-center bg-[#1c1f2e] cursor-pointer hover:border-purple-500/50 hover:bg-[#25293d] transition-all text-gray-500"
                  title="点击或拖拽上传参考图（最多 9 张）"
                >
                  <PlusIcon className="w-5 h-5" />
                  <span className="text-[10px] mt-1">
                    {images.length === 0 ? '添加图片' : `${images.length}/${maxImages}`}
                  </span>
                </button>
              )}
            </div>
            {images.length === 0 && (
              <div className="text-[10px] text-gray-600 mt-1.5">
                不上传则为纯文生视频
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          {/* 校验提示横幅 */}
          {(uploadError || uploadWarning) && (
            <div className="space-y-2">
              {uploadError && (
                <div className="text-xs text-red-300 bg-red-900/30 border border-red-800 rounded-lg px-3 py-2">
                  {uploadError}
                </div>
              )}
              {uploadWarning && (
                <div className="text-xs text-amber-300 bg-amber-900/20 border border-amber-800/60 rounded-lg px-3 py-2">
                  {uploadWarning}
                </div>
              )}
            </div>
          )}

          {/* 参考视频 + 参考音频：并排两列 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Reference Videos (optional, 最多 maxVideos 段, 总 <=15s) */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="text-sm font-bold text-gray-300">
                参考视频 ({videoItems.length}/{maxVideos}, 总 {videoItems.reduce((s, v) => s + v.duration, 0).toFixed(1)}s / 15s)
              </label>
              {videoItems.length > 0 && (
                <button
                  onClick={() => {
                    videoItems.forEach((v) => URL.revokeObjectURL(v.previewUrl));
                    setVideoItems([]);
                  }}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  清除全部
                </button>
              )}
            </div>

            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                addVideos(e.dataTransfer.files);
              }}
              className="flex flex-wrap gap-2 items-stretch"
            >
              {videoItems.map((v) => (
                <VideoTile
                  key={v.id}
                  item={v}
                  onUpdateDims={(w, h) =>
                    setVideoItems((prev) =>
                      prev.map((it) =>
                        it.id === v.id ? { ...it, width: w, height: h } : it
                      )
                    )
                  }
                  onRemove={() => removeVideo(v.id)}
                />
              ))}

              {videoItems.length < maxVideos && (
                <button
                  type="button"
                  onClick={() => videoInputRef.current?.click()}
                  className="w-20 h-20 flex-shrink-0 border border-dashed border-gray-700 rounded-xl flex flex-col items-center justify-center bg-[#1c1f2e] cursor-pointer hover:border-purple-500/50 hover:bg-[#25293d] transition-all text-gray-500"
                  title="点击上传参考视频 (mp4/mov · 单段 2-15s, ≤50MB)"
                >
                  <PlusIcon className="w-5 h-5" />
                  <span className="text-[10px] mt-1">
                    {videoItems.length === 0 ? '添加视频' : `${videoItems.length}/${maxVideos}`}
                  </span>
                </button>
              )}
            </div>

            <input
              ref={videoInputRef}
              type="file"
              accept="video/mp4,video/quicktime"
              multiple
              className="hidden"
              onChange={(e) => {
                addVideos(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          {/* Reference Audios (optional, 最多 maxAudios 段, 总 <=15s) */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="text-sm font-bold text-gray-300">
                参考音频 ({audioItems.length}/{maxAudios}, 总 {audioItems.reduce((s, a) => s + a.duration, 0).toFixed(1)}s / 15s)
              </label>
              {audioItems.length > 0 && (
                <button
                  onClick={() => setAudioItems([])}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  清除全部
                </button>
              )}
            </div>

            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                addAudios(e.dataTransfer.files);
              }}
              className="flex flex-wrap gap-2 items-stretch"
            >
              {audioItems.map((a) => (
                <div
                  key={a.id}
                  className="relative group bg-[#1c1f2e] rounded-xl border border-gray-700 px-3 py-2 text-xs text-gray-300 flex items-center gap-2"
                  style={{ maxWidth: 260 }}
                  title={a.file.name}
                >
                  <div className="min-w-0">
                    <div className="truncate max-w-[200px]">{a.file.name}</div>
                    <div className="text-gray-500 mt-0.5">
                      {a.duration.toFixed(1)}s · {(a.file.size / 1024 / 1024).toFixed(2)} MB
                    </div>
                  </div>
                  <button
                    onClick={() => removeAudio(a.id)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-800 border border-gray-700 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 hover:border-red-600"
                    title="移除"
                  >
                    <CloseIcon className="w-3 h-3 text-white" />
                  </button>
                </div>
              ))}

              {audioItems.length < maxAudios && (
                <button
                  type="button"
                  onClick={() => audioInputRef.current?.click()}
                  className="flex-shrink-0 border border-dashed border-gray-700 rounded-xl flex items-center gap-1.5 px-4 py-2 bg-[#1c1f2e] cursor-pointer hover:border-purple-500/50 transition-all text-xs text-gray-500"
                  title="点击上传参考音频 (mp3/wav · 单段 2-15s, ≤15MB)"
                >
                  <PlusIcon className="w-4 h-4" />
                  {audioItems.length === 0 ? '添加音频' : `${audioItems.length}/${maxAudios}`}
                </button>
              )}
            </div>

            <input
              ref={audioInputRef}
              type="file"
              accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav"
              multiple
              className="hidden"
              onChange={(e) => {
                addAudios(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
          </div>

          {/* Prompt */}
          <div
            className="bg-[#1c1f2e] rounded-2xl p-3 border border-gray-800 cursor-pointer hover:border-purple-500/40 transition-all group"
            onClick={() => {
              if (!isGenerating) {
                setModalPrompt(prompt);
                setAiOutput('');
                setShowPromptModal(true);
              }
            }}
          >
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-sm font-bold text-gray-300">
                提示词
              </label>
              <span className="text-xs text-purple-400 opacity-0 group-hover:opacity-100 transition-opacity">点击展开编辑</span>
            </div>
            <div className="w-full bg-transparent text-sm min-h-[40px] max-h-[60px] overflow-hidden text-gray-200 leading-snug whitespace-pre-wrap">
              {prompt || <span className="text-gray-600">点击此处编辑提示词...</span>}
            </div>
            <div className="text-right text-[10px] text-gray-500 mt-1">
              {prompt.length}/5000
            </div>
          </div>

          {/* Seedance 参数配置（紧接提示词下方，同属左列） */}
          <div className="bg-[#1c1f2e] rounded-2xl p-3 border border-gray-800 space-y-2.5">
            {/* 模型（紧凑：两个选项水平并列） */}
            <div>
              <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1.5">
                选择模型
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {MODEL_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setModel(opt.value)}
                    title={opt.description}
                    className={`text-left px-2.5 py-1.5 rounded-lg border transition-all ${
                      model === opt.value
                        ? 'border-purple-500 bg-purple-500/10'
                        : 'border-gray-700 bg-[#161824] hover:border-gray-600'
                    }`}
                  >
                    <div
                      className={`text-xs font-medium truncate leading-tight ${
                        model === opt.value ? 'text-purple-400' : 'text-gray-300'
                      }`}
                    >
                      {opt.label}
                    </div>
                    <div className="text-[10px] text-gray-500 mt-0 line-clamp-1 leading-tight">
                      {opt.value === 'doubao-seedance-2-0-260128'
                        ? '画质更好'
                        : '更快，适合批量出稿'}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* 画面比例（7 个按钮，一行 flex-wrap） */}
            <div>
              <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1.5">
                画面比例
              </label>
              <div className="grid grid-cols-7 gap-1">
                {RATIO_OPTIONS.map((opt) => {
                  const isSelected = opt.value === ratio;
                  const isAdaptive = opt.value === 'adaptive';
                  const maxDim = 18;
                  let w = 0,
                    h = 0;
                  if (!isAdaptive) {
                    const scale = maxDim / Math.max(opt.widthRatio, opt.heightRatio);
                    w = Math.round(opt.widthRatio * scale);
                    h = Math.round(opt.heightRatio * scale);
                  }
                  return (
                    <button
                      key={opt.value}
                      onClick={() => setRatio(opt.value)}
                      title={isAdaptive ? '自适应：由模型根据素材自动决定比例' : opt.label}
                      className={`flex flex-col items-center gap-0.5 py-1 rounded-lg border transition-all ${
                        isSelected
                          ? 'border-purple-500 bg-purple-500/10'
                          : 'border-gray-700 bg-[#161824] hover:border-gray-600'
                      }`}
                    >
                      <div className="flex items-center justify-center w-5 h-5">
                        {isAdaptive ? (
                          <span
                            className={`text-[9px] font-bold tracking-tight ${
                              isSelected ? 'text-purple-400' : 'text-gray-400'
                            }`}
                          >
                            AUTO
                          </span>
                        ) : (
                          <div
                            className={`rounded-sm border ${
                              isSelected ? 'border-purple-400' : 'border-gray-500'
                            }`}
                            style={{ width: `${w}px`, height: `${h}px` }}
                          />
                        )}
                      </div>
                      <span
                        className={`text-[10px] leading-none ${
                          isSelected ? 'text-purple-400' : 'text-gray-400'
                        }`}
                      >
                        {isAdaptive ? '自适应' : opt.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 时长 + 分辨率 并排 */}
            <div className="grid grid-cols-5 gap-3">
              <div className="col-span-3">
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">
                    视频时长
                  </label>
                  <span className="text-[11px] text-purple-400 font-semibold tabular-nums">
                    {duration}s
                  </span>
                </div>
                <input
                  type="range"
                  min={DURATION_OPTIONS[0]}
                  max={DURATION_OPTIONS[DURATION_OPTIONS.length - 1]}
                  step={1}
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value) as Duration)}
                  className="w-full h-1.5 accent-purple-500 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                />
                <div className="flex justify-between text-[9px] text-gray-500 mt-0 px-0.5 leading-none">
                  <span>4s</span>
                  <span>15s</span>
                </div>
              </div>
              <div className="col-span-2">
                <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1.5">
                  分辨率
                </label>
                <div className="grid grid-cols-2 gap-1.5">
                  {RESOLUTION_OPTIONS.map((r) => {
                    const selected = resolution === r;
                    return (
                      <button
                        key={r}
                        onClick={() => setResolution(r)}
                        className={`px-2 py-1 rounded-lg text-xs font-medium border transition-all ${
                          selected
                            ? 'border-purple-500 bg-purple-500/10 text-purple-400'
                            : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                        }`}
                      >
                        {r}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* 开关行：有声视频 · 固定镜头 · 水印 */}
            <div className="grid grid-cols-3 gap-1.5">
              <ToggleChip
                label="有声视频"
                tooltip="是否生成带音轨的视频（generate_audio）"
                checked={generateAudio}
                onChange={setGenerateAudio}
              />
              <ToggleChip
                label="固定镜头"
                tooltip="固定摄像头，不允许运镜（camera_fixed）"
                checked={cameraFixed}
                onChange={setCameraFixed}
              />
              <ToggleChip
                label="添加水印"
                tooltip="是否在输出视频上添加平台水印（watermark）"
                checked={watermark}
                onChange={setWatermark}
              />
            </div>

            {/* 种子（可选：空=随机） */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">
                  种子 (Seed)
                </label>
                <span className="text-[10px] text-gray-500">空=随机，固定值可复现</span>
              </div>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  inputMode="numeric"
                  value={seedInput}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^\d-]/g, '');
                    setSeedInput(v);
                  }}
                  placeholder="留空随机"
                  className="flex-1 px-2.5 py-1 bg-[#161824] border border-gray-700 rounded-lg text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-purple-500 tabular-nums"
                />
                <button
                  type="button"
                  onClick={() => setSeedInput(String(Math.floor(Math.random() * 2147483647)))}
                  className="px-2.5 py-1 bg-[#161824] border border-gray-700 rounded-lg text-xs text-gray-300 hover:border-purple-500/60 hover:text-purple-300 transition-all"
                  title="生成一个随机种子"
                >
                  随机
                </button>
                {seedInput && (
                  <button
                    type="button"
                    onClick={() => setSeedInput('')}
                    className="px-2.5 py-1 bg-[#161824] border border-gray-700 rounded-lg text-xs text-gray-500 hover:text-gray-300 transition-all"
                    title="清空（=随机）"
                  >
                    清空
                  </button>
                )}
              </div>
            </div>
          </div>
          </div>
          {/* 右列：视频预览 + 生成/重置 — 视频区拉长填满剩余空间，lg 下吸附在视口内 */}
          <div className="flex flex-col gap-4 min-w-0 pb-6 md:pb-0 lg:sticky lg:top-4 lg:self-start lg:h-[calc(100vh-6rem)] lg:min-h-[520px]">
            <div className="flex-1 min-h-[260px] flex flex-col">
              <ResultPreview
                videoUrl={videoUrl}
                isGenerating={isGenerating}
                hasError={generation.status === 'error'}
                error={generation.status === 'error' ? generation.error : undefined}
                progress={generation.progress}
                onOpen={() => setPlayerOpen(true)}
              />
            </div>

            {/* 生成 / 重置 按钮 */}
            <div className="flex gap-3 flex-shrink-0">
              <button
                onClick={handleGenerate}
                disabled={!canGenerate}
                className="flex-1 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 text-white font-bold py-3.5 rounded-xl transition-all shadow-lg shadow-purple-900/20 flex items-center justify-center gap-2"
              >
                {isGenerating ? (
                  <>
                    <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                    生成中...
                  </>
                ) : (
                  <>
                    <SparkleIcon className="w-4 h-4" />
                    生成视频
                  </>
                )}
              </button>
              <button
                onClick={handleReset}
                disabled={isGenerating}
                className="px-6 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 text-white font-bold py-3.5 rounded-xl transition-all"
              >
                重置
              </button>
            </div>
          </div>
        </div>
        </div>
      </div>

      {/* 视频预览弹窗（原右侧面板改为弹窗，点击顶部"查看视频"或生成完成/失败自动弹出） */}
      {playerOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPlayerOpen(false);
          }}
        >
          <div className="relative w-full max-w-5xl max-h-[90vh] bg-[#0f111a] rounded-2xl border border-gray-800 shadow-2xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800 flex-shrink-0">
              <div className="text-sm text-gray-300 font-medium flex items-center gap-2">
                <FilmIcon className="w-4 h-4 text-purple-400" />
                {isGenerating
                  ? '正在生成视频…'
                  : videoUrl
                    ? '生成完成'
                    : generation.status === 'error'
                      ? '生成失败'
                      : '视频预览'}
              </div>
              <button
                onClick={() => setPlayerOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
                title="关闭 (Esc)"
              >
                <CloseIcon className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 flex flex-col overflow-y-auto min-h-[240px]">
              <VideoPlayer
                videoUrl={videoUrl}
                revisedPrompt={revisedPrompt}
                isLoading={isGenerating}
                error={generation.status === 'error' ? generation.error : undefined}
                progress={generation.progress}
              />
            </div>
          </div>
        </div>
      )}

      {/* 提示词编辑弹窗 — 左右双栏对比 */}
      {showPromptModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#1c1f2e] border border-gray-700 rounded-2xl w-full max-w-6xl max-h-[90vh] flex flex-col shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
              <h3 className="text-lg font-bold text-white">编辑提示词</h3>
              <div className="flex items-center gap-3">
                <button
                  onClick={async () => {
                    if (aiOptimizing) {
                      aiAbortRef.current?.abort();
                      setAiOptimizing(false);
                      return;
                    }
                    const inputPrompt = modalPrompt.trim();
                    if (!inputPrompt) return;
                    setAiOptimizing(true);
                    setAiOutput('');
                    const abortCtrl = new AbortController();
                    aiAbortRef.current = abortCtrl;
                    try {
                      const sessionId = getAuthSessionId();
                      const resp = await fetch('/api/ai/optimize-prompt', {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          ...(sessionId ? { 'X-Session-ID': sessionId } : {}),
                        },
                        body: JSON.stringify({ prompt: inputPrompt }),
                        signal: abortCtrl.signal,
                      });
                      if (!resp.ok) {
                        const err = await resp.json().catch(() => ({ error: 'Unknown error' }));
                        setAiOutput(`错误: ${err.error || resp.statusText}`);
                        setAiOptimizing(false);
                        return;
                      }
                      const reader = resp.body!.getReader();
                      const decoder = new TextDecoder();
                      let buf = '';
                      let accumulated = '';
                      while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buf += decoder.decode(value, { stream: true });
                        const lines = buf.split('\n');
                        buf = lines.pop() || '';
                        for (const line of lines) {
                          const trimmed = line.trim();
                          if (!trimmed.startsWith('data: ')) continue;
                          const data = trimmed.slice(6);
                          if (data === '[DONE]') continue;
                          try {
                            const parsed = JSON.parse(data);
                            if (parsed.content) {
                              accumulated += parsed.content;
                              setAiOutput(accumulated);
                            }
                            if (parsed.error) {
                              setAiOutput(prev => prev + `\n\n错误: ${parsed.error}`);
                            }
                          } catch {}
                        }
                      }
                    } catch (e: any) {
                      if (e.name !== 'AbortError') {
                        setAiOutput(prev => prev || `优化失败: ${e.message}`);
                      }
                    } finally {
                      setAiOptimizing(false);
                    }
                  }}
                  disabled={!modalPrompt.trim()}
                  className={`px-4 py-2 rounded-xl text-sm font-medium flex items-center gap-2 transition-all ${
                    aiOptimizing
                      ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                      : 'bg-gradient-to-r from-cyan-500/20 to-blue-500/20 text-cyan-400 hover:from-cyan-500/30 hover:to-blue-500/30 disabled:opacity-40'
                  }`}
                >
                  {aiOptimizing ? (
                    <>
                      <span className="animate-spin h-4 w-4 border-2 border-cyan-400 border-t-transparent rounded-full" />
                      停止
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      Kimi AI 优化
                    </>
                  )}
                </button>
                <button
                  onClick={() => {
                    aiAbortRef.current?.abort();
                    setShowPromptModal(false);
                  }}
                  className="p-2 hover:bg-gray-800 rounded-lg transition-colors"
                >
                  <CloseIcon className="w-5 h-5 text-gray-400" />
                </button>
              </div>
            </div>

            {/* Body — 左右双栏 */}
            <div className="flex-1 overflow-hidden flex flex-col md:flex-row p-6 gap-4 min-h-0">
              {/* 左栏: 原始提示词 */}
              <div className="flex-1 flex flex-col min-w-0">
                <label className="block text-sm font-medium text-gray-400 mb-2">原始提示词</label>

                <div className="flex-1 flex flex-row gap-3 min-h-0">
                  {/* 左侧竖向素材缩略图条：点击插入 / 拖入编辑器任意位置 */}
                  {modalAssets.length > 0 && (
                    <AssetStrip
                      assets={modalAssets}
                      orientation="vertical"
                      className="flex-shrink-0 w-16 h-full"
                      onInsert={(a) => promptEditorRef.current?.insertAsset(a)}
                    />
                  )}

                  <div className="flex-1 flex flex-col min-w-0">
                    <div className="flex-1 w-full bg-[#0f111a] border border-gray-700 rounded-xl px-4 py-3 overflow-y-auto focus-within:ring-2 focus-within:ring-purple-500 min-h-[340px] flex">
                      <PromptEditor
                        ref={promptEditorRef}
                        value={modalPrompt}
                        onChange={setModalPrompt}
                        assets={modalAssets}
                        autoFocus
                        minHeight={320}
                        className="flex-1 w-full"
                        placeholder={"【绘画风格】如：3D渲染风格 / 电影质感 / 动漫风格\n【人物】@图1（角色名）、@图2（角色名）\n【道具】@图3（道具名）\n【场景】场景描述、光影氛围\n\n【分镜】\n镜头：中景 / 特写 / 全景，运镜方式\n动作：@图1（角色名）做什么动作...\n音效：环境音 / 特效音\n对话：角色台词\n\n提示：从左侧素材条把素材拖/点入提示词，或直接输入 @ 触发候选"}
                      />
                    </div>
                    <div className="text-right text-xs text-gray-500 mt-1">{modalPrompt.length}/5000</div>
                  </div>
                </div>
              </div>

              {/* 右栏: AI 优化结果 */}
              <div className="flex-1 flex flex-col min-w-0">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-cyan-400">AI 优化结果</span>
                    {aiOptimizing && (
                      <span className="animate-spin h-3 w-3 border-2 border-cyan-400 border-t-transparent rounded-full" />
                    )}
                  </div>
                  {aiOutput && !aiOptimizing && (
                    <button
                      onClick={() => {
                        setModalPrompt(aiOutput);
                        setAiOutput('');
                      }}
                      className="px-3 py-1 bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 rounded-lg text-xs font-medium transition-all flex items-center gap-1"
                    >
                      ← 采用此结果
                    </button>
                  )}
                </div>
                <div className="flex-1 w-full bg-[#0f111a] border border-cyan-500/20 rounded-xl px-4 py-3 text-sm text-gray-200 leading-relaxed overflow-y-auto min-h-[360px]">
                  {aiOutput ? (
                    aiOptimizing ? (
                      // 流式生成中：用纯文本展示，保留实时刷新感
                      <div className="whitespace-pre-wrap">{aiOutput}</div>
                    ) : (
                      // 生成完成：用只读 PromptEditor，自动把 @图N/@视频N/@音频N 渲染成 chip
                      <PromptEditor
                        key={aiOutput}
                        value={aiOutput}
                        onChange={() => {}}
                        assets={modalAssets}
                        disabled
                        minHeight={0}
                        className="flex-1 w-full"
                      />
                    )
                  ) : aiOptimizing ? (
                    <span className="text-gray-600 animate-pulse">正在优化中...</span>
                  ) : (
                    <span className="text-gray-600">点击右上角「Kimi AI 优化」按钮，AI 将基于左侧提示词生成优化版本</span>
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex gap-3 px-6 py-4 border-t border-gray-800">
              <button
                onClick={() => {
                  aiAbortRef.current?.abort();
                  setShowPromptModal(false);
                }}
                className="flex-1 px-4 py-3 bg-[#0f111a] border border-gray-700 text-white hover:bg-gray-800 rounded-xl font-medium transition-all"
              >
                取消
              </button>
              <button
                onClick={() => {
                  setPrompt(modalPrompt);
                  aiAbortRef.current?.abort();
                  setShowPromptModal(false);
                }}
                className="flex-1 px-4 py-3 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white rounded-xl font-medium transition-all"
              >
                确认
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 配置预设 / 历史 面板 */}
      <PresetPanel
        open={showPresetPanel}
        onClose={() => setShowPresetPanel(false)}
        onLoad={applySnapshot}
        reloadToken={presetReloadToken}
      />
    </div>
  );
}
