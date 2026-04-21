import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useEffect, useRef } from 'react';
import tippy, { type Instance as TippyInstance } from 'tippy.js';
import type { AssetKind } from './types';

const KIND_STYLE: Record<AssetKind, string> = {
  image: 'border-purple-500/40 bg-purple-500/10 text-purple-200',
  video: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200',
  audio: 'border-blue-500/40 bg-blue-500/10 text-blue-200',
};

const KIND_BADGE: Record<AssetKind, string> = {
  image: 'bg-purple-600/80',
  video: 'bg-cyan-600/80',
  audio: 'bg-blue-600/80',
};

/** 构造 tippy content：一张与素材条同尺寸（w-14 h-14）的缩略图 + 标签 */
function buildPreviewElement(kind: AssetKind, label: string, thumb?: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'asset-preview-card';

  const thumbBox = document.createElement('div');
  thumbBox.className = 'asset-preview-thumb';
  if (kind === 'image' && thumb) {
    const img = document.createElement('img');
    img.src = thumb;
    img.alt = label;
    img.draggable = false;
    thumbBox.appendChild(img);
  } else if (kind === 'video' && thumb) {
    const v = document.createElement('video');
    v.src = thumb;
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    thumbBox.appendChild(v);
  } else {
    const icon = document.createElement('div');
    icon.className = 'asset-preview-icon';
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="28" height="28"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>';
    thumbBox.appendChild(icon);
  }
  wrap.appendChild(thumbBox);

  const badge = document.createElement('div');
  badge.className = `asset-preview-badge ${KIND_BADGE[kind]}`;
  badge.textContent = `@${label}`;
  wrap.appendChild(badge);

  return wrap;
}

/**
 * @图N / @视频N / @音频N 的行内 chip 渲染。
 * 设为 contentEditable=false，使其作为一个不可拆分的原子节点参与光标移动/删除。
 */
export default function AssetMentionView({ node, selected }: NodeViewProps) {
  const kind = node.attrs.kind as AssetKind;
  const label = node.attrs.label as string;
  const thumb = node.attrs.thumb as string | undefined;

  const rootRef = useRef<HTMLSpanElement>(null);

  // 悬浮缩略图：复用已引入的 tippy.js，每个 chip 挂一个实例，节点卸载时销毁
  useEffect(() => {
    const anchor = rootRef.current;
    if (!anchor) return;
    const content = buildPreviewElement(kind, label, thumb);
    const instance: TippyInstance = tippy(anchor, {
      content,
      allowHTML: true,
      theme: 'asset-preview',
      placement: 'top',
      arrow: false,
      offset: [0, 8],
      delay: [200, 0],
      hideOnClick: true,
      appendTo: () => document.body,
    });
    return () => {
      instance.destroy();
    };
  }, [kind, label, thumb]);

  return (
    <NodeViewWrapper
      ref={rootRef}
      as="span"
      data-asset-mention=""
      data-kind={kind}
      contentEditable={false}
      draggable
      className={`inline-flex items-center gap-1 align-baseline mx-[2px] px-1.5 py-[1px] rounded-md border text-[0.9em] leading-none select-none cursor-help ${KIND_STYLE[kind]} ${selected ? 'ring-2 ring-purple-400/70' : ''}`}
    >
      <span className="font-medium">@{label}</span>
      {kind === 'image' && thumb && (
        <img
          src={thumb}
          alt={label}
          draggable={false}
          className="h-[1.25em] w-[1.25em] rounded-sm object-cover"
        />
      )}
      {kind === 'video' && thumb && (
        <video
          src={thumb}
          muted
          playsInline
          preload="metadata"
          className="h-[1.25em] w-[1.6em] rounded-sm object-cover bg-black"
        />
      )}
      {kind === 'audio' && (
        <svg
          className="h-[1em] w-[1em]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      )}
    </NodeViewWrapper>
  );
}
