import { useEditor, EditorContent, type Editor, ReactRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Mention from '@tiptap/extension-mention';
import type { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion';
import tippy, { type Instance as TippyInstance } from 'tippy.js';
import { useEffect, useImperativeHandle, useRef, forwardRef, useCallback } from 'react';
import { AssetMention } from './AssetMention';
import MentionList, { type MentionListHandle } from './MentionList';
import {
  CN_TO_KIND,
  DATA_TRANSFER_KEY,
  type AssetItem,
  type AssetMentionAttrs,
} from './types';

export interface PromptEditorHandle {
  /** 在当前光标处插入一个素材 mention */
  insertAsset: (asset: AssetItem) => void;
  /** 聚焦到编辑器 */
  focus: () => void;
  /** 获取底层 editor 实例（高级用法） */
  getEditor: () => Editor | null;
}

export interface PromptEditorProps {
  value: string;
  onChange: (value: string) => void;
  assets: AssetItem[];
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  /** 编辑区最小高度（px） */
  minHeight?: number;
  /** 禁用（只读）状态 */
  disabled?: boolean;
}

type JSONNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: JSONNode[];
};

/** 把 "文本 @图2 文本" 的纯文本解析成 Tiptap JSON，用于初始化和外部赋值。 */
function buildDocJSON(value: string, assets: AssetItem[]): JSONNode {
  const byLabel = new Map<string, AssetItem>();
  for (const a of assets) {
    byLabel.set(`${a.kind}:${a.label}`, a);
  }

  const lines = value.split('\n');
  const regex = /@(图|视频|音频)(\d+)/g;

  const paragraphs: JSONNode[] = lines.map((line) => {
    const nodes: JSONNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    regex.lastIndex = 0;
    while ((match = regex.exec(line)) !== null) {
      const [full, cn, numStr] = match;
      const kind = CN_TO_KIND[cn];
      const label = `${cn}${numStr}`;
      const asset = kind ? byLabel.get(`${kind}:${label}`) : undefined;

      if (match.index > lastIndex) {
        nodes.push({ type: 'text', text: line.slice(lastIndex, match.index) });
      }

      if (asset) {
        nodes.push({
          type: 'assetMention',
          attrs: {
            kind: asset.kind,
            assetId: asset.id,
            label: asset.label,
            thumb: asset.thumb ?? null,
          },
        });
      } else {
        // 无法匹配到当前素材，保留为纯文本
        nodes.push({ type: 'text', text: full });
      }

      lastIndex = match.index + full.length;
    }
    if (lastIndex < line.length) {
      nodes.push({ type: 'text', text: line.slice(lastIndex) });
    }
    return nodes.length > 0
      ? { type: 'paragraph', content: nodes }
      : { type: 'paragraph' };
  });

  return { type: 'doc', content: paragraphs };
}

const PromptEditor = forwardRef<PromptEditorHandle, PromptEditorProps>(function PromptEditor(
  { value, onChange, assets, placeholder, autoFocus, className, minHeight = 320, disabled },
  ref,
) {
  const lastEmittedRef = useRef<string>(value);
  const assetsRef = useRef<AssetItem[]>(assets);
  assetsRef.current = assets;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bold: false,
        italic: false,
        strike: false,
        code: false,
      }),
      Placeholder.configure({
        placeholder: placeholder ?? '',
        showOnlyWhenEditable: true,
      }),
      AssetMention.configure({
        getAssets: () => assetsRef.current,
      }),
      // @ 触发候选面板：用 Mention 的 suggestion 基建，但插入我们自己的 assetMention 节点
      Mention.configure({
        suggestion: {
          char: '@',
          // 过滤：按 label 模糊匹配，允许用 "图" / "图2" / "视频" / "音频1" 等搜索
          items: ({ query }) => {
            const q = query.trim();
            const all = assetsRef.current;
            if (!q) return all;
            return all.filter((a) => a.label.includes(q));
          },
          // 用自定义节点替代默认 mention 节点，保持与拖放/点击一致的 chip
          command: ({ editor: ed, range, props }) => {
            const item = props as AssetItem;
            ed.chain()
              .focus()
              .deleteRange(range)
              .insertAssetMention({
                kind: item.kind,
                assetId: item.id,
                label: item.label,
                thumb: item.thumb ?? null,
              })
              .insertContent(' ')
              .run();
          },
          // 用 ReactRenderer + tippy 渲染候选面板
          render: () => {
            let component: ReactRenderer<MentionListHandle, {
              items: AssetItem[];
              command: (item: AssetItem) => void;
            }> | null = null;
            let popup: TippyInstance[] | null = null;

            return {
              onStart: (props: SuggestionProps) => {
                component = new ReactRenderer(MentionList, {
                  props: {
                    items: props.items as AssetItem[],
                    command: (item: AssetItem) => props.command(item as unknown as Record<string, unknown>),
                  },
                  editor: props.editor,
                });
                if (!props.clientRect) return;
                popup = tippy('body', {
                  getReferenceClientRect: () => {
                    const rect = props.clientRect?.();
                    return rect ?? new DOMRect(0, 0, 0, 0);
                  },
                  appendTo: () => document.body,
                  content: component.element,
                  showOnCreate: true,
                  interactive: true,
                  trigger: 'manual',
                  placement: 'bottom-start',
                  theme: 'asset-mention',
                  arrow: false,
                  offset: [0, 6],
                });
              },
              onUpdate: (props: SuggestionProps) => {
                component?.updateProps({
                  items: props.items as AssetItem[],
                  command: (item: AssetItem) => props.command(item as unknown as Record<string, unknown>),
                });
                if (!props.clientRect) return;
                popup?.[0]?.setProps({
                  getReferenceClientRect: () => {
                    const rect = props.clientRect?.();
                    return rect ?? new DOMRect(0, 0, 0, 0);
                  },
                });
              },
              onKeyDown: (props: SuggestionKeyDownProps) => {
                if (props.event.key === 'Escape') {
                  popup?.[0]?.hide();
                  return true;
                }
                return component?.ref?.onKeyDown(props.event) ?? false;
              },
              onExit: () => {
                popup?.[0]?.destroy();
                component?.destroy();
                popup = null;
                component = null;
              },
            };
          },
        },
      }),
    ],
    content: buildDocJSON(value, assets),
    editable: !disabled,
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: {
        class:
          'prompt-editor-content w-full h-full whitespace-pre-wrap text-sm text-gray-200 leading-relaxed focus:outline-none',
      },
      handleDrop(view, event, _slice, moved) {
        if (moved) return false;
        const raw = event.dataTransfer?.getData(DATA_TRANSFER_KEY);
        if (!raw) return false;
        let attrs: AssetMentionAttrs;
        try {
          attrs = JSON.parse(raw) as AssetMentionAttrs;
        } catch {
          return false;
        }
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (!coords) return false;
        const nodeType = view.state.schema.nodes.assetMention;
        if (!nodeType) return false;
        const node = nodeType.create({
          kind: attrs.kind,
          assetId: attrs.assetId,
          label: attrs.label,
          thumb: attrs.thumb ?? null,
        });
        const tr = view.state.tr.insert(coords.pos, node);
        view.dispatch(tr);
        event.preventDefault();
        return true;
      },
    },
    onUpdate({ editor: ed }) {
      const text = ed.getText({ blockSeparator: '\n' });
      lastEmittedRef.current = text;
      onChange(text);
    },
  });

  // 外部 value 变化（例如 "采用 AI 结果"）时，用最新 assets 重建内容
  useEffect(() => {
    if (!editor) return;
    if (value === lastEmittedRef.current) return;
    const doc = buildDocJSON(value, assetsRef.current);
    editor.commands.setContent(doc, { emitUpdate: false });
    lastEmittedRef.current = value;
  }, [value, editor]);

  // 素材列表变化（新增/删除/重排导致 label 漂移）时，同步已插入 chip 的 label/thumb
  useEffect(() => {
    if (!editor) return;
    const byId = new Map(assets.map((a) => [a.id, a]));
    const { state } = editor;
    let tr = state.tr;
    let changed = false;
    state.doc.descendants((node, pos) => {
      if (node.type.name !== 'assetMention') return;
      const asset = byId.get(node.attrs.assetId);
      if (!asset) return; // 素材被删：保留旧 chip，避免破坏上下文
      const nextLabel = asset.label;
      const nextThumb = asset.thumb ?? null;
      if (node.attrs.label !== nextLabel || (node.attrs.thumb ?? null) !== nextThumb) {
        tr = tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          label: nextLabel,
          thumb: nextThumb,
        });
        changed = true;
      }
    });
    if (changed) {
      // 标记这次变更不应触发 onChange 外发（label 只影响展示+序列化文本）
      editor.view.dispatch(tr);
      lastEmittedRef.current = editor.getText({ blockSeparator: '\n' });
      onChange(lastEmittedRef.current);
    }
  }, [assets, editor, onChange]);

  // 禁用状态同步
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  const insertAsset = useCallback(
    (asset: AssetItem) => {
      if (!editor) return;
      editor
        .chain()
        .focus()
        .insertAssetMention({
          kind: asset.kind,
          assetId: asset.id,
          label: asset.label,
          thumb: asset.thumb ?? null,
        })
        .run();
    },
    [editor],
  );

  useImperativeHandle(
    ref,
    () => ({
      insertAsset,
      focus: () => editor?.commands.focus(),
      getEditor: () => editor,
    }),
    [editor, insertAsset],
  );

  return (
    <div className={className} style={{ minHeight }}>
      <EditorContent editor={editor} className="h-full" />
    </div>
  );
});

export default PromptEditor;
