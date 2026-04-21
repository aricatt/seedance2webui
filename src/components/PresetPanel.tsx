/**
 * 配置预设 / 历史面板
 *
 * 两个 Tab：
 * - 我的预设：用户命名保存的配置，可加载/重命名/删除
 * - 最近历史：提交成功后自动记录，环形缓冲 20 条，可加载/删除/清空/另存为预设
 */
import { useEffect, useState, useCallback } from 'react';
import { CloseIcon, HistoryIcon, PackageIcon, PlusIcon } from './Icons';
import { useToast } from './Toast';
import type {
  ConfigSnapshot,
  PresetRecord,
  HistoryRecord,
  StorageStats,
} from '../services/configPresetService';
import {
  listPresets,
  listHistory,
  deletePreset,
  deleteHistoryItem,
  clearHistory,
  renamePreset,
  savePreset,
  summarizeSnapshot,
  getStorageStats,
  runGC,
  formatBytes,
  HISTORY_LIMIT,
  HISTORY_SIZE_SOFT_LIMIT,
  PRESET_SIZE_SOFT_LIMIT,
} from '../services/configPresetService';

export interface PresetPanelProps {
  open: boolean;
  onClose: () => void;
  /** 用户点击"加载"时回调；父组件负责回填 UI */
  onLoad: (snapshot: ConfigSnapshot) => void;
  /** 关闭后刷新的触发计数；当父组件 push 了新记录可用此让列表重拉 */
  reloadToken?: number;
}

type TabKind = 'presets' | 'history';

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { hour12: false });
}

function ThumbStrip({ snapshot }: { snapshot: ConfigSnapshot }) {
  const items: { key: string; thumb?: string; label: string; kind: string }[] = [];
  snapshot.images.forEach((a, i) => items.push({ key: `i${i}`, thumb: a.thumbDataUrl, label: a.label || `图${i + 1}`, kind: 'image' }));
  snapshot.videos.forEach((a, i) => items.push({ key: `v${i}`, thumb: a.thumbDataUrl, label: a.label || `视频${i + 1}`, kind: 'video' }));
  snapshot.audios.forEach((a, i) => items.push({ key: `a${i}`, thumb: undefined, label: a.label || `音频${i + 1}`, kind: 'audio' }));

  if (items.length === 0) {
    return <div className="text-[11px] text-gray-600">无素材</div>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {items.slice(0, 12).map((it) => (
        <div
          key={it.key}
          className="w-10 h-10 rounded-md border border-gray-700 bg-[#0f111a] overflow-hidden flex items-center justify-center relative"
          title={it.label}
        >
          {it.thumb ? (
            <img src={it.thumb} alt={it.label} className="w-full h-full object-cover" />
          ) : (
            <span className={`text-[10px] ${it.kind === 'audio' ? 'text-blue-300' : 'text-gray-500'}`}>
              {it.kind === 'audio' ? '♪' : '—'}
            </span>
          )}
          <span className="absolute bottom-0 right-0 text-[9px] bg-black/60 text-gray-200 px-1 rounded-tl-sm leading-tight">
            {it.label.replace(/^(图|视频|音频)/, '')}
          </span>
        </div>
      ))}
      {items.length > 12 && (
        <div className="w-10 h-10 rounded-md border border-gray-700 bg-[#0f111a] flex items-center justify-center text-[11px] text-gray-500">
          +{items.length - 12}
        </div>
      )}
    </div>
  );
}

function RecordCard({
  title,
  subtitle,
  snapshot,
  onLoad,
  onDelete,
  extraActions,
}: {
  title: string;
  subtitle: string;
  snapshot: ConfigSnapshot;
  onLoad: () => void;
  onDelete: () => void;
  extraActions?: React.ReactNode;
}) {
  return (
    <div className="bg-[#1c1f2e] border border-gray-800 rounded-xl p-4 hover:border-purple-500/40 transition-colors">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <div className="font-bold text-gray-100 truncate" title={title}>
            {title}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">{subtitle}</div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {extraActions}
          <button
            onClick={onLoad}
            className="px-3 py-1.5 bg-purple-600/20 text-purple-300 hover:bg-purple-600/30 rounded-md text-xs font-medium transition-colors"
          >
            加载
          </button>
          <button
            onClick={onDelete}
            className="px-2 py-1.5 bg-gray-800 text-gray-400 hover:bg-red-600/20 hover:text-red-400 rounded-md text-xs transition-colors"
            title="删除"
          >
            <CloseIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="text-[12px] text-gray-400 mb-2 line-clamp-2" title={snapshot.prompt}>
        {summarizeSnapshot(snapshot)}
      </div>
      <ThumbStrip snapshot={snapshot} />
      <div className="mt-2 flex gap-3 text-[11px] text-gray-500">
        <span>模型 {snapshot.model.replace(/^doubao-seedance-2-0-/, '').replace('-260128', '') || '-'}</span>
        <span>{snapshot.ratio}</span>
        <span>{snapshot.duration}s</span>
      </div>
    </div>
  );
}

export default function PresetPanel({ open, onClose, onLoad, reloadToken }: PresetPanelProps) {
  const [tab, setTab] = useState<TabKind>('history');
  const [presets, setPresets] = useState<PresetRecord[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const toastCtx = useToast();
  const { toast, confirm } = toastCtx;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [p, h, s] = await Promise.all([listPresets(), listHistory(), getStorageStats()]);
      setPresets(p);
      setHistory(h);
      setStats(s);
    } catch (e) {
      console.error('[preset-panel] 加载失败', e);
      toast.error('加载配置列表失败');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh, reloadToken]);

  if (!open) return null;

  const handleLoad = (snap: ConfigSnapshot) => {
    onLoad(snap);
    onClose();
  };

  const handleDeletePreset = async (id: string, name: string) => {
    const ok = await confirm({
      title: '删除预设',
      message: `确定要删除预设"${name}"吗？`,
      danger: true,
      confirmText: '删除',
    });
    if (!ok) return;
    await deletePreset(id);
    toast.success('已删除');
    void refresh();
  };

  const handleDeleteHistory = async (id: string) => {
    await deleteHistoryItem(id);
    void refresh();
  };

  const handleRename = async (id: string, current: string) => {
    const next = window.prompt('新名称', current);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === current) return;
    await renamePreset(id, trimmed);
    toast.success('已重命名');
    void refresh();
  };

  const handleClearHistory = async () => {
    const ok = await confirm({
      title: '清空历史',
      message: `将清空最近 ${history.length} 条提交历史，此操作不可撤销。`,
      danger: true,
      confirmText: '清空',
    });
    if (!ok) return;
    await clearHistory();
    toast.success('历史已清空');
    void refresh();
  };

  const handlePromoteToPreset = async (snap: ConfigSnapshot) => {
    const name = window.prompt('保存为预设，请输入名称：', `预设 ${new Date().toLocaleString('zh-CN')}`);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await savePreset(trimmed, snap);
      toast.success('已保存为预设');
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    }
  };

  const handleRunGC = async () => {
    try {
      const r = await runGC();
      if (r.deletedCount === 0) {
        toast.info('当前没有可回收的孤儿数据');
      } else {
        toast.success(`已释放 ${formatBytes(r.deletedBytes)}（${r.deletedCount} 个孤儿 Blob）`);
      }
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '释放失败');
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-[#0f111a] border border-gray-700 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-bold text-white">配置管理</h3>
            <span className="text-xs text-gray-500">
              预设无上限 · 历史最多保留 {HISTORY_LIMIT} 条
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-800 rounded-lg transition-colors"
          >
            <CloseIcon className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-6 pt-3 border-b border-gray-800">
          <button
            onClick={() => setTab('history')}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              tab === 'history'
                ? 'text-purple-300 bg-purple-500/10 border border-b-0 border-purple-500/30'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <HistoryIcon className="w-4 h-4" />
            最近历史 ({history.length})
          </button>
          <button
            onClick={() => setTab('presets')}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              tab === 'presets'
                ? 'text-purple-300 bg-purple-500/10 border border-b-0 border-purple-500/30'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <PackageIcon className="w-4 h-4" />
            我的预设 ({presets.length})
          </button>

          <div className="ml-auto pb-2">
            {tab === 'history' && history.length > 0 && (
              <button
                onClick={handleClearHistory}
                className="text-xs text-red-400 hover:text-red-300 transition-colors px-2 py-1"
              >
                清空历史
              </button>
            )}
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading ? (
            <div className="text-center text-gray-500 py-12 text-sm">加载中...</div>
          ) : tab === 'history' ? (
            history.length === 0 ? (
              <div className="text-center text-gray-500 py-12 text-sm">
                暂无历史记录
                <div className="text-xs text-gray-600 mt-1">
                  成功提交任务后，会自动把当时的配置记录到这里
                </div>
              </div>
            ) : (
              history.map((h) => (
                <RecordCard
                  key={h.id}
                  title={`提交于 ${formatTimestamp(h.createdAt)}`}
                  subtitle={`自动记录 · ${formatTimestamp(h.createdAt)}`}
                  snapshot={h.snapshot}
                  onLoad={() => handleLoad(h.snapshot)}
                  onDelete={() => handleDeleteHistory(h.id)}
                  extraActions={
                    <button
                      onClick={() => handlePromoteToPreset(h.snapshot)}
                      className="px-2 py-1.5 bg-gray-800 text-gray-300 hover:bg-indigo-600/20 hover:text-indigo-300 rounded-md text-xs transition-colors"
                      title="另存为预设"
                    >
                      <PlusIcon className="w-3.5 h-3.5" />
                    </button>
                  }
                />
              ))
            )
          ) : presets.length === 0 ? (
            <div className="text-center text-gray-500 py-12 text-sm">
              暂无预设
              <div className="text-xs text-gray-600 mt-1">
                在主界面点击"保存为预设"按钮，或在最近历史中把任意记录另存为预设
              </div>
            </div>
          ) : (
            presets.map((p) => (
              <RecordCard
                key={p.id}
                title={p.name}
                subtitle={`更新于 ${formatTimestamp(p.updatedAt)}`}
                snapshot={p.snapshot}
                onLoad={() => handleLoad(p.snapshot)}
                onDelete={() => handleDeletePreset(p.id, p.name)}
                extraActions={
                  <button
                    onClick={() => handleRename(p.id, p.name)}
                    className="px-2 py-1.5 bg-gray-800 text-gray-300 hover:bg-gray-700 rounded-md text-xs transition-colors"
                    title="重命名"
                  >
                    重命名
                  </button>
                }
              />
            ))
          )}
        </div>

        {/* Footer · 存储统计 */}
        {stats && (
          <div className="px-6 py-3 border-t border-gray-800 bg-[#0a0c13] text-[11px] text-gray-400 space-y-1.5">
            <div className="flex items-center flex-wrap gap-x-4 gap-y-1">
              <span>
                素材缓存 <span className="text-gray-200">{formatBytes(stats.blobBytes)}</span>
                <span className="text-gray-600"> / {stats.blobCount} 条（已去重）</span>
              </span>
              <span>
                历史占用{' '}
                <span
                  className={
                    stats.historyReferencedBytes > HISTORY_SIZE_SOFT_LIMIT * 0.9
                      ? 'text-amber-400'
                      : 'text-gray-200'
                  }
                >
                  {formatBytes(stats.historyReferencedBytes)}
                </span>
                <span className="text-gray-600"> / {formatBytes(HISTORY_SIZE_SOFT_LIMIT)}</span>
              </span>
              <span>
                预设占用{' '}
                <span
                  className={
                    stats.presetReferencedBytes > PRESET_SIZE_SOFT_LIMIT * 0.9
                      ? 'text-amber-400'
                      : 'text-gray-200'
                  }
                >
                  {formatBytes(stats.presetReferencedBytes)}
                </span>
                <span className="text-gray-600"> / {formatBytes(PRESET_SIZE_SOFT_LIMIT)}</span>
              </span>
              {stats.browserQuota ? (
                <span className="text-gray-500">
                  浏览器配额 {formatBytes(stats.browserUsage)} / {formatBytes(stats.browserQuota)}
                </span>
              ) : null}
              {stats.persisted === true && (
                <span className="text-green-500 text-[10px]">● 已持久化</span>
              )}
              {stats.persisted === false && (
                <span className="text-yellow-500 text-[10px]" title="浏览器在存储压力下可能整库回收">
                  ○ 未持久化
                </span>
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="text-gray-600 truncate">
                相同内容的素材会自动共享存储（SHA-256 内容寻址）；删除记录后自动清理孤儿
              </div>
              <button
                onClick={handleRunGC}
                className="px-2.5 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-md text-xs transition-colors flex-shrink-0"
                title="立即扫描并删除无人引用的素材 Blob"
              >
                立即释放空间
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
