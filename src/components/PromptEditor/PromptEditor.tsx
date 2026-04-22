import { useEditor, EditorContent, type Editor, ReactRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Mention from '@tiptap/extension-mention';
import type { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
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
      /**
       * 纯文本粘贴解析：每个 `\n` 都起一个新段落（空行 → 空段落）。
       * 这样可以保持 "粘贴进来 → 序列化成 value → 再次粘出 / 重建" 三者的换行数量一致，
       * 避免 ProseMirror 默认按 `\n{2,}` 分段导致空行被吞、叠加 CSS 段间距又看起来多一行的问题。
       */
      clipboardTextParser(text, _context, _plain, view) {
        const schema = view.state.schema;
        const paragraphType = schema.nodes.paragraph;
        const paragraphs = text.split('\n').map((line) => {
          const content = line.length > 0 ? [schema.text(line)] : [];
          return paragraphType.create(null, content);
        });
        return new Slice(Fragment.fromArray(paragraphs), 1, 1);
      },
      /**
       * HTML 粘贴归一化：来自网页 / Word / Google Docs / VS Code 等的 HTML 常是
       *   `<p>A<br></p><p>B</p>` / `<p>A<br><br>B</p>` / `<p>A</p><p><br></p><p>B</p>` 等形态，
       * 如果保留段落内的 hardBreak，渲染出来会比源文本多一行空白（段末 <br> + 段落本身 min-height）。
       * 这里做两件事：
       *   1) 段内 hardBreak 展开为独立段落，同时 **丢弃段首/段尾 hardBreak**（多为 ProseMirror 空段落的 trailing break 占位符）
       *      —— 确保 "一段落 = value 里的一个 \n"，不会多一行也不会少一行。
       *   2) 文本节点中的 `@图N / @视频N / @音频N` 如果能命中当前 assets，直接替换成 assetMention chip。
       *      这样粘贴的文本和手打 + 触发 inputRule 得到的结果一致，不依赖 PasteRule 的时序/位置匹配。
       */
      transformPasted(slice, view) {
        const schema = view.state.schema;
        const paragraphType = schema.nodes.paragraph;
        const assetMentionType = schema.nodes.assetMention;
        if (!paragraphType) return slice;

        const currentAssets = assetsRef.current;
        const assetByLabel = new Map<string, AssetItem>();
        for (const a of currentAssets) {
          assetByLabel.set(`${a.kind}:${a.label}`, a);
        }

        /** 将一段字符串按 "@图N / @视频N / @音频N" 切成 [text, chip, text, ...] */
        const expandText = (text: string): PMNode[] => {
          if (!text) return [];
          if (!assetMentionType || !text.includes('@')) return [schema.text(text)];
          const regex = /@(图|视频|音频)(\d+)/g;
          const out: PMNode[] = [];
          let last = 0;
          let m: RegExpExecArray | null;
          while ((m = regex.exec(text)) !== null) {
            const [full, cn, numStr] = m;
            const kind = CN_TO_KIND[cn];
            const label = `${cn}${numStr}`;
            const asset = kind ? assetByLabel.get(`${kind}:${label}`) : undefined;
            if (!asset) continue;
            if (m.index > last) out.push(schema.text(text.slice(last, m.index)));
            out.push(
              assetMentionType.create({
                kind: asset.kind,
                assetId: asset.id,
                label: asset.label,
                thumb: asset.thumb ?? null,
              }),
            );
            last = m.index + full.length;
          }
          if (out.length === 0) return [schema.text(text)];
          if (last < text.length) out.push(schema.text(text.slice(last)));
          return out;
        };

        /** 合并 Fragment 中相邻 text（忽略 marks，StarterKit 已禁用 inline marks），
         *  并在合并后的整段字符串上做 mention 展开。 */
        const normalizeInlineFragment = (frag: Fragment): PMNode[] => {
          const merged: PMNode[] = [];
          let buf = '';
          const flush = () => {
            if (buf.length > 0) {
              merged.push(...expandText(buf));
              buf = '';
            }
          };
          frag.forEach((child) => {
            if (child.type.name === 'text' && child.text) {
              buf += child.text;
            } else {
              flush();
              merged.push(child);
            }
          });
          flush();
          return merged;
        };

        /** 对段落 children 展开 mention，再按 hardBreak 切分成多个段落 */
        const splitParagraph = (block: PMNode): PMNode[] => {
          const flattened = normalizeInlineFragment(block.content);
          // 去掉段首/段尾的 hardBreak（多为 ProseMirror 空段落的 trailing break 占位）
          while (flattened.length && flattened[0].type.name === 'hardBreak') flattened.shift();
          while (flattened.length && flattened[flattened.length - 1].type.name === 'hardBreak') flattened.pop();
          // 按 hardBreak 切分成子段落（内部真正的换行）
          const segments: PMNode[][] = [[]];
          for (const child of flattened) {
            if (child.type.name === 'hardBreak') {
              segments.push([]);
            } else {
              segments[segments.length - 1].push(child);
            }
          }
          return segments.map((seg) => paragraphType.create(block.attrs, Fragment.fromArray(seg)));
        };

        // slice.content 的两大形态：
        //   A) block-only：[paragraph, paragraph, ...]
        //   B) inline-only：[text, text, hardBreak, ...]
        // 两条路径都先走 normalizeInlineFragment/splitParagraph，保证 mention 转换一致。
        const firstChild = slice.content.firstChild;
        const isInlineSlice = !!firstChild && firstChild.isInline;

        if (isInlineSlice) {
          const inline = normalizeInlineFragment(slice.content);
          return new Slice(Fragment.fromArray(inline), slice.openStart, slice.openEnd);
        }

        const normalized: PMNode[] = [];
        slice.content.forEach((block) => {
          if (block.type === paragraphType) {
            normalized.push(...splitParagraph(block));
          } else if (block.isTextblock) {
            normalized.push(...splitParagraph(paragraphType.create(null, block.content)));
          } else {
            normalized.push(block);
          }
        });

        return new Slice(Fragment.fromArray(normalized), slice.openStart, slice.openEnd);
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
