import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { CloseIcon, PlusIcon } from './Icons';
import {
  deletePortrait,
  fetchPortraits,
  uploadPortrait,
  type ProjectPortrait,
  type PortraitStatus,
} from '../services/portraitService';
import {
  appendTosListThumbnailProcess,
  hasSigningQueryParams,
} from '../utils/tosImage';

const STATUS_LABEL: Record<PortraitStatus, string> = {
  uploading: '上传中',
  registering: '注册中',
  processing: '预处理',
  active: '可用',
  failed: '失败',
};

const STATUS_CLASS: Record<PortraitStatus, string> = {
  uploading: 'text-amber-300 bg-amber-500/15 border-amber-500/40',
  registering: 'text-amber-300 bg-amber-500/15 border-amber-500/40',
  processing: 'text-cyan-300 bg-cyan-500/15 border-cyan-500/40',
  active: 'text-green-300 bg-green-500/15 border-green-500/40',
  failed: 'text-red-300 bg-red-500/15 border-red-500/40',
};

export interface PortraitLibraryProps {
  mtProjectId: string | null;
  enabled: boolean;
  selectedIds: number[];
  onSelectionChange: (ids: number[]) => void;
  maxTotalImages: number;
  uploadedImageCount: number;
  onPortraitsChange?: (portraits: ProjectPortrait[]) => void;
  /** 为 true 时暂停轮询刷新（避免打断提示词编辑弹窗） */
  pauseRefresh?: boolean;
}

export default function PortraitLibrary(props: PortraitLibraryProps) {
  const {
    mtProjectId,
    enabled,
    selectedIds,
    onSelectionChange,
    maxTotalImages,
    uploadedImageCount,
    onPortraitsChange,
    pauseRefresh = false,
  } = props;

  const [portraits, setPortraits] = useState<ProjectPortrait[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!mtProjectId || !enabled) {
      setPortraits([]);
      onPortraitsChange?.([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const list = await fetchPortraits(mtProjectId);
      setPortraits(list);
      onPortraitsChange?.(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [mtProjectId, enabled, onPortraitsChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled || !mtProjectId || pauseRefresh) return;
    const hasProcessing = portraits.some((p) =>
      ['uploading', 'registering', 'processing'].includes(p.status),
    );
    if (!hasProcessing && !showModal) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [enabled, mtProjectId, portraits, showModal, pauseRefresh, refresh]);

  useEffect(() => {
    if (!enabled) onSelectionChange([]);
  }, [enabled, onSelectionChange]);

  const slotsLeft = Math.max(0, maxTotalImages - uploadedImageCount - selectedIds.length);
  const activePortraits = portraits.filter((p) => p.status === 'active');

  const toggleSelect = (id: number) => {
    if (selectedIds.includes(id)) {
      onSelectionChange(selectedIds.filter((x) => x !== id));
      return;
    }
    if (uploadedImageCount + selectedIds.length >= maxTotalImages) return;
    onSelectionChange([...selectedIds, id]);
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length || !mtProjectId) return;
    const file = files[0];
    setUploading(true);
    setError('');
    try {
      await uploadPortrait(mtProjectId, file, uploadName || file.name);
      setUploadName('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (id: number) => {
    if (!mtProjectId) return;
    if (!window.confirm('确定从人像库删除该人像？')) return;
    try {
      await deletePortrait(mtProjectId, id);
      onSelectionChange(selectedIds.filter((x) => x !== id));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  if (!enabled) return null;

  return (
    <div className="mt-4 rounded-lg border border-violet-500/25 bg-[#141824] p-3">
      <PortraitLibraryHeader onOpenModal={() => setShowModal(true)} disabled={!mtProjectId} />
      {!mtProjectId && (
        <p className="text-[11px] text-amber-300/90">请先在左下角选择 ModelToo 项目后使用人像库。</p>
      )}
      {error && <PortraitError message={error} />}
      <PortraitPicker
        loading={loading}
        activePortraits={activePortraits}
        selectedIds={selectedIds}
        maxTotalImages={maxTotalImages}
        uploadedImageCount={uploadedImageCount}
        onToggle={toggleSelect}
      />
      {selectedIds.length > 0 && (
        <p className="text-[10px] text-violet-300/80 mt-2">
          已选 {selectedIds.length} 个库中人像
          {slotsLeft > 0 ? `，还可选 ${slotsLeft} 张（含本次上传）` : '，已达 9 张上限'}
        </p>
      )}
      {showModal && (
        <PortraitManageModal
          portraits={portraits}
          uploadName={uploadName}
          uploading={uploading}
          error={error}
          fileInputRef={fileInputRef}
          onClose={() => setShowModal(false)}
          onUploadNameChange={setUploadName}
          onPickFile={() => fileInputRef.current?.click()}
          onFileChange={(files) => void handleUpload(files)}
          onDelete={(id) => void handleDelete(id)}
        />
      )}
    </div>
  );
}

/** 悬停展示预览 URL，便于核对 TOS / 预签名是否正确 */
function PortraitPreviewHover({
  portrait,
  thumbPx,
  children,
  className = '',
}: {
  portrait: ProjectPortrait;
  thumbPx: number;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const original = portrait.previewUrl?.trim() || '';
  const scaled =
    original && !hasSigningQueryParams(original)
      ? appendTosListThumbnailProcess(original, 'download')
      : original;
  const scaledDiffers = Boolean(scaled && original && scaled !== original);

  return (
    <span
      className={`relative inline-block ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && original && (
        <div
          role="tooltip"
          className="absolute z-[90] left-0 top-full mt-1 w-[min(420px,calc(100vw-2rem))] p-2.5 rounded-lg border border-gray-600 bg-[#0a0c12] shadow-xl text-left pointer-events-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-[10px] text-gray-400 mb-1">
            {portrait.name || `人像 #${portrait.id}`} · 列表显示约 {thumbPx}×{thumbPx} px
          </div>
          <div className="text-[10px] text-amber-200/90 font-medium mb-0.5">原图 URL</div>
          <div className="text-[10px] text-gray-300 break-all font-mono leading-snug select-all max-h-24 overflow-y-auto custom-scrollbar">
            {original}
          </div>
          {scaledDiffers ? (
            <>
              <div className="text-[10px] text-cyan-200/90 font-medium mt-2 mb-0.5">
                缩略图 URL（TOS x-tos-process，边长 {thumbPx}px）
              </div>
              <div className="text-[10px] text-gray-300 break-all font-mono leading-snug select-all max-h-20 overflow-y-auto custom-scrollbar">
                {scaled}
              </div>
            </>
          ) : original.startsWith('/api/portraits/') ? (
            <p className="text-[10px] text-gray-500 mt-2 leading-snug">
              列表经本站同源代理加载（/api/portraits/…/preview），由服务端访问 TOS 并带缩放参数。
            </p>
          ) : (
            <p className="text-[10px] text-gray-500 mt-2 leading-snug">
              当前为预签名 URL，无法再拼缩放参数；上方即为列表 img 使用的地址。
            </p>
          )}
        </div>
      )}
      {open && !original && (
        <div className="absolute z-[90] left-0 top-full mt-1 px-2 py-1 rounded border border-gray-700 bg-[#0a0c12] text-[10px] text-gray-500">
          无 previewUrl
        </div>
      )}
    </span>
  );
}

function PortraitError({ message }: { message: string }) {
  return (
    <div className="text-[11px] text-red-300 bg-red-900/25 border border-red-800/50 rounded px-2 py-1.5 mb-2">
      {message}
    </div>
  );
}

function PortraitLibraryHeader({
  onOpenModal,
  disabled,
}: {
  onOpenModal: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
      <div>
        <div className="text-sm font-bold text-violet-200">虚拟人像库</div>
        <p className="text-[10px] text-gray-500 mt-0.5">
          入库后通过 asset:// 引用，与本次上传参考图合并编号（库图在前）。仅 Luminia 模型可用。
        </p>
      </div>
      <button
        type="button"
        onClick={onOpenModal}
        disabled={disabled}
        className="text-xs px-2.5 py-1.5 rounded-md border border-violet-500/50 text-violet-200 hover:bg-violet-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        title={disabled ? '请先在左下角选择 ModelToo 项目' : '管理人像库'}
      >
        管理人像库
      </button>
    </div>
  );
}

function PortraitPicker({
  loading,
  activePortraits,
  selectedIds,
  maxTotalImages,
  uploadedImageCount,
  onToggle,
}: {
  loading: boolean;
  activePortraits: ProjectPortrait[];
  selectedIds: number[];
  maxTotalImages: number;
  uploadedImageCount: number;
  onToggle: (id: number) => void;
}) {
  if (loading && activePortraits.length === 0) {
    return <p className="text-[11px] text-gray-500">加载人像库...</p>;
  }
  if (activePortraits.length === 0) {
    return (
      <p className="text-[11px] text-gray-500">
        暂无可用人像。点击「管理人像库」上传，预处理完成后可勾选。
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {activePortraits.map((p) => {
        const checked = selectedIds.includes(p.id);
        const disabled =
          !checked && uploadedImageCount + selectedIds.length >= maxTotalImages;
        return (
          <PortraitPreviewHover key={p.id} portrait={p} thumbPx={64}>
            <button
              type="button"
              onClick={() => onToggle(p.id)}
              disabled={disabled}
              title={p.name || `人像 #${p.id}`}
              className={`relative w-16 h-16 rounded-xl overflow-hidden border-2 transition-all ${
                checked
                  ? 'border-violet-400 ring-2 ring-violet-500/40'
                  : disabled
                    ? 'border-gray-800 opacity-40 cursor-not-allowed'
                    : 'border-gray-700 hover:border-violet-500/60'
              }`}
            >
              {p.previewUrl ? (
                <img src={p.previewUrl} alt={p.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-gray-800 flex items-center justify-center text-[10px] text-gray-500">
                  无预览
                </div>
              )}
              <span className="absolute top-0.5 left-0.5 text-[8px] font-bold px-1 rounded bg-amber-500/90 text-black">
                库
              </span>
              {checked && (
                <span className="absolute bottom-0.5 right-0.5 w-4 h-4 rounded-full bg-violet-500 flex items-center justify-center text-[10px] text-white">
                  ✓
                </span>
              )}
            </button>
          </PortraitPreviewHover>
        );
      })}
    </div>
  );
}

function PortraitManageModal({
  portraits,
  uploadName,
  uploading,
  error,
  fileInputRef,
  onClose,
  onUploadNameChange,
  onPickFile,
  onFileChange,
  onDelete,
}: {
  portraits: ProjectPortrait[];
  uploadName: string;
  uploading: boolean;
  error: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onUploadNameChange: (v: string) => void;
  onPickFile: () => void;
  onFileChange: (files: FileList | null) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl border border-gray-700 bg-[#12151f] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div>
            <h3 className="text-sm font-bold text-gray-100">虚拟人像库</h3>
            <p className="text-[10px] text-gray-500 mt-0.5">按当前 ModelToo 项目隔离</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-400">
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-gray-800/80 space-y-2">
          <div className="flex flex-wrap gap-2 items-end">
            <label className="flex-1 min-w-[140px]">
              <span className="text-[10px] text-gray-500 block mb-1">显示名称（可选）</span>
              <input
                value={uploadName}
                onChange={(e) => onUploadNameChange(e.target.value)}
                placeholder="例如：主角 A"
                className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-[#0f111a] border border-gray-700 text-gray-200"
              />
            </label>
            <button
              type="button"
              disabled={uploading}
              onClick={onPickFile}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:bg-gray-700 text-xs text-white font-medium transition-colors"
            >
              <PlusIcon className="w-3.5 h-3.5" />
              {uploading ? '上传中...' : '上传人像'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => onFileChange(e.target.files)}
            />
          </div>
          {error && <p className="text-[11px] text-red-300">{error}</p>}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {portraits.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-8">暂无人像，请上传</p>
          ) : (
            <ul className="space-y-2">
              {portraits.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-3 p-2 rounded-lg border border-gray-800 bg-[#0f111a]"
                >
                  <PortraitPreviewHover portrait={p} thumbPx={56}>
                    <div className="w-14 h-14 rounded-lg overflow-hidden flex-shrink-0 border border-gray-700">
                      {p.previewUrl ? (
                        <img src={p.previewUrl} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full bg-gray-800" />
                      )}
                    </div>
                  </PortraitPreviewHover>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-gray-200 truncate">
                      {p.name || `人像 #${p.id}`}
                    </div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_CLASS[p.status]}`}
                      >
                        {STATUS_LABEL[p.status]}
                      </span>
                      {p.status === 'failed' && p.errorMessage && (
                        <span className="text-[10px] text-red-400 truncate" title={p.errorMessage}>
                          {p.errorMessage}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onDelete(p.id)}
                    className="text-[10px] text-red-400 hover:text-red-300 px-2 py-1 rounded border border-red-900/50 hover:border-red-700 transition-colors flex-shrink-0"
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-4 py-2 border-t border-gray-800 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
