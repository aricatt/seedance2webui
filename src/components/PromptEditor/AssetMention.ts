import { Node, mergeAttributes, InputRule, PasteRule } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import AssetMentionView from './AssetMentionView';
import { CN_TO_KIND, type AssetItem, type AssetMentionAttrs } from './types';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    assetMention: {
      /** 在当前光标（或指定位置）插入一个素材 mention */
      insertAssetMention: (attrs: AssetMentionAttrs, pos?: number) => ReturnType;
    };
  }
}

export interface AssetMentionOptions {
  /**
   * 返回当前最新的素材列表，供 InputRule / PasteRule 将 "@图N" 文本自动转为 chip。
   * 通过函数访问保证总能拿到最新值（而不是扩展注册时的闭包快照）。
   */
  getAssets: () => AssetItem[];
}

/**
 * 行内原子节点：@图N / @视频N / @音频N
 * - atom + inline：作为整体被光标/删除操作处理
 * - renderText：editor.getText() 时还原成纯文本 "@<label>"，兼容现有后端
 */
export const AssetMention = Node.create<AssetMentionOptions>({
  name: 'assetMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return {
      getAssets: () => [],
    };
  },

  addAttributes() {
    return {
      kind: { default: 'image' },
      assetId: { default: '' },
      label: { default: '' },
      thumb: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-asset-mention]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-asset-mention': '',
        'data-kind': node.attrs.kind,
        'data-asset-id': node.attrs.assetId,
      }),
      `@${node.attrs.label}`,
    ];
  },

  renderText({ node }) {
    return `@${node.attrs.label}`;
  },

  addCommands() {
    return {
      insertAssetMention:
        (attrs, pos) =>
        ({ chain }) => {
          const base = chain().focus();
          if (typeof pos === 'number') {
            return base
              .insertContentAt(pos, { type: this.name, attrs })
              .run();
          }
          return base.insertContent({ type: this.name, attrs }).run();
        },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(AssetMentionView);
  },

  /**
   * 打字时：用户输入 "@图2" + 分隔符（空格 / 换行 / 中英标点）时，
   * 如果能在当前素材中匹配到，自动把 "@图2" 替换为 chip，保留分隔符。
   */
  addInputRules() {
    return [
      new InputRule({
        find: /@(图|视频|音频)(\d+)([\s，。,.!?！？、；;:：])$/,
        handler: ({ state, range, match }) => {
          const [, cn, numStr, tail] = match;
          const kind = CN_TO_KIND[cn];
          const label = `${cn}${numStr}`;
          const assets = this.options.getAssets?.() ?? [];
          const asset = assets.find((a) => a.kind === kind && a.label === label);
          if (!asset) return null;
          const nodeType = state.schema.nodes.assetMention;
          const node = nodeType.create({
            kind: asset.kind,
            assetId: asset.id,
            label: asset.label,
            thumb: asset.thumb ?? null,
          });
          // range 覆盖了 "@图2<tail>"；我们只替换 "@图2"，保留 tail
          state.tr.replaceWith(range.from, range.to - tail.length, node);
        },
      }),
    ];
  },

  /**
   * 粘贴时：扫描文本里所有 "@图N / @视频N / @音频N"，能匹配到素材的一律转 chip。
   */
  addPasteRules() {
    return [
      new PasteRule({
        find: /@(图|视频|音频)(\d+)/g,
        handler: ({ state, range, match }) => {
          const [, cn, numStr] = match;
          const kind = CN_TO_KIND[cn];
          const label = `${cn}${numStr}`;
          const assets = this.options.getAssets?.() ?? [];
          const asset = assets.find((a) => a.kind === kind && a.label === label);
          if (!asset) return null;
          const nodeType = state.schema.nodes.assetMention;
          const node = nodeType.create({
            kind: asset.kind,
            assetId: asset.id,
            label: asset.label,
            thumb: asset.thumb ?? null,
          });
          state.tr.replaceWith(range.from, range.to, node);
        },
      }),
    ];
  },
});
