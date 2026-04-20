import {
  forwardRef,
  useImperativeHandle,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { AssetItem, AssetKind } from './types';

export interface MentionListHandle {
  /** 被 Tiptap Suggestion 调用来传递键盘事件（↑↓ Enter Esc） */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export interface MentionListProps {
  items: AssetItem[];
  command: (item: AssetItem) => void;
}

const GROUP_ORDER: AssetKind[] = ['image', 'video', 'audio'];
const GROUP_TITLE: Record<AssetKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
};
const GROUP_DOT: Record<AssetKind, string> = {
  image: 'bg-purple-400',
  video: 'bg-cyan-400',
  audio: 'bg-blue-400',
};

const MentionList = forwardRef<MentionListHandle, MentionListProps>(function MentionList(
  { items, command },
  ref,
) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // 展平序列，用于 ↑↓ 导航；分组仅用于渲染
  const flat = useMemo(() => {
    const result: AssetItem[] = [];
    for (const kind of GROUP_ORDER) {
      for (const it of items) if (it.kind === kind) result.push(it);
    }
    return result;
  }, [items]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  const select = (idx: number) => {
    const item = flat[idx];
    if (item) command(item);
  };

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: (event) => {
        if (event.key === 'ArrowDown') {
          setSelectedIndex((i) => (i + 1) % Math.max(flat.length, 1));
          return true;
        }
        if (event.key === 'ArrowUp') {
          setSelectedIndex((i) => (i - 1 + flat.length) % Math.max(flat.length, 1));
          return true;
        }
        if (event.key === 'Enter') {
          select(selectedIndex);
          return true;
        }
        return false;
      },
    }),
    [flat, selectedIndex],
  );

  if (flat.length === 0) {
    return (
      <div className="min-w-[220px] rounded-xl border border-gray-700 bg-[#1c1f2e] shadow-2xl p-3 text-xs text-gray-500">
        无匹配素材
      </div>
    );
  }

  // 分组渲染
  let runningIndex = 0;
  return (
    <div className="min-w-[260px] max-h-[320px] overflow-y-auto rounded-xl border border-gray-700 bg-[#1c1f2e] shadow-2xl py-1 text-sm">
      {GROUP_ORDER.map((kind) => {
        const group = flat.filter((it) => it.kind === kind);
        if (group.length === 0) return null;
        return (
          <div key={kind} className="py-1">
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${GROUP_DOT[kind]}`} />
              {GROUP_TITLE[kind]}
              <span className="text-gray-600">· {group.length}</span>
            </div>
            {group.map((item) => {
              const idx = runningIndex++;
              const isActive = idx === selectedIndex;
              return (
                <button
                  type="button"
                  key={`${item.kind}-${item.id}`}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onClick={() => select(idx)}
                  className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
                    isActive ? 'bg-purple-500/15 text-white' : 'text-gray-300 hover:bg-gray-700/40'
                  }`}
                >
                  <div className="w-8 h-8 flex-shrink-0 rounded-md overflow-hidden bg-[#0f111a] border border-gray-700">
                    {item.kind === 'image' && item.thumb && (
                      <img
                        src={item.thumb}
                        alt={item.label}
                        className="w-full h-full object-cover"
                        draggable={false}
                      />
                    )}
                    {item.kind === 'video' && item.thumb && (
                      <video
                        src={item.thumb}
                        muted
                        playsInline
                        preload="metadata"
                        className="w-full h-full object-cover bg-black"
                      />
                    )}
                    {item.kind === 'audio' && (
                      <div className="w-full h-full flex items-center justify-center text-blue-300">
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M9 18V5l12-2v13" />
                          <circle cx="6" cy="18" r="3" />
                          <circle cx="18" cy="16" r="3" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <span className="font-medium text-purple-300">@{item.label}</span>
                </button>
              );
            })}
          </div>
        );
      })}
      <div className="px-3 py-1 text-[10px] text-gray-600 border-t border-gray-800 mt-1">
        ↑↓ 选择 · Enter 插入 · Esc 取消
      </div>
    </div>
  );
});

export default MentionList;
