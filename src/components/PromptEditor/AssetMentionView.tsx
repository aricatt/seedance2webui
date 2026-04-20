import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import type { AssetKind } from './types';

const KIND_STYLE: Record<AssetKind, string> = {
  image: 'border-purple-500/40 bg-purple-500/10 text-purple-200',
  video: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200',
  audio: 'border-blue-500/40 bg-blue-500/10 text-blue-200',
};

/**
 * @图N / @视频N / @音频N 的行内 chip 渲染。
 * 设为 contentEditable=false，使其作为一个不可拆分的原子节点参与光标移动/删除。
 */
export default function AssetMentionView({ node, selected }: NodeViewProps) {
  const kind = node.attrs.kind as AssetKind;
  const label = node.attrs.label as string;
  const thumb = node.attrs.thumb as string | undefined;

  return (
    <NodeViewWrapper
      as="span"
      data-asset-mention=""
      data-kind={kind}
      contentEditable={false}
      draggable
      className={`inline-flex items-center gap-1 align-baseline mx-[2px] px-1.5 py-[1px] rounded-md border text-[0.9em] leading-none select-none ${KIND_STYLE[kind]} ${selected ? 'ring-2 ring-purple-400/70' : ''}`}
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
