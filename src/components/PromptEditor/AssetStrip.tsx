import { DATA_TRANSFER_KEY, type AssetItem, type AssetMentionAttrs } from './types';

interface AssetStripProps {
  assets: AssetItem[];
  onInsert?: (asset: AssetItem) => void;
  title?: string;
  className?: string;
  /** 布局方向：horizontal（默认）沿水平方向排列；vertical 竖直单列 */
  orientation?: 'horizontal' | 'vertical';
}

const KIND_BADGE: Record<AssetItem['kind'], string> = {
  image: 'bg-purple-600/80 text-white',
  video: 'bg-cyan-600/80 text-white',
  audio: 'bg-blue-600/80 text-white',
};

/**
 * 弹窗顶部的横向素材缩略图条。
 * - 点击缩略图：调用 onInsert 在光标处插入 mention
 * - 拖拽缩略图：通过 DATA_TRANSFER_KEY 把 attrs 写入 dataTransfer，编辑器在 handleDrop 里精准定位位置后插入
 */
export default function AssetStrip({
  assets,
  onInsert,
  title,
  className,
  orientation = 'horizontal',
}: AssetStripProps) {
  if (assets.length === 0) return null;

  const isVertical = orientation === 'vertical';

  return (
    <div className={className}>
      {title && (
        <div className="text-xs text-gray-500 mb-1.5">
          {title} <span className="text-gray-600">（点击或拖入提示词）</span>
        </div>
      )}
      <div
        className={
          isVertical
            ? 'flex flex-col gap-2 overflow-y-auto pr-1 h-full'
            : 'flex gap-2 overflow-x-auto pb-1'
        }
      >
        {assets.map((a) => {
          const attrs: AssetMentionAttrs = {
            kind: a.kind,
            assetId: a.id,
            label: a.label,
            thumb: a.thumb ?? null,
          };
          return (
            <button
              type="button"
              key={`${a.kind}-${a.id}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DATA_TRANSFER_KEY, JSON.stringify(attrs));
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => onInsert?.(a)}
              title={`点击插入 @${a.label}，或拖入光标位置`}
              className="relative w-14 h-14 flex-shrink-0 rounded-lg overflow-hidden border border-gray-700 bg-[#0f111a] hover:border-purple-500 transition-colors cursor-grab active:cursor-grabbing"
            >
              {a.kind === 'image' && a.thumb && (
                <img
                  src={a.thumb}
                  alt={a.label}
                  draggable={false}
                  className="w-full h-full object-cover"
                />
              )}
              {a.kind === 'video' && a.thumb && (
                <video
                  src={a.thumb}
                  muted
                  playsInline
                  preload="metadata"
                  className="w-full h-full object-cover bg-black"
                />
              )}
              {a.kind === 'audio' && (
                <div className="w-full h-full flex items-center justify-center text-blue-300">
                  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </svg>
                </div>
              )}
              <span
                className={`absolute bottom-0 left-0 right-0 text-[10px] text-center py-0.5 font-medium ${KIND_BADGE[a.kind]}`}
              >
                @{a.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
