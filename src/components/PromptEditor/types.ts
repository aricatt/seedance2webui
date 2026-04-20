/**
 * 统一的素材项类型（图片/视频/音频），供 PromptEditor 系列组件使用。
 * label 是用户在提示词中看到的可读标识，例如 "图2" / "视频1" / "音频1"。
 */
export type AssetKind = 'image' | 'video' | 'audio';

export interface AssetItem {
  kind: AssetKind;
  /** 稳定的资源 id，chip 里记录它，避免删图之后编号漂移 */
  id: string;
  /** 当前的展示编号文本，例如 "图2"。PromptEditor 会在序列化时使用它。 */
  label: string;
  /** 缩略图地址（图片/视频原 URL；音频可不传） */
  thumb?: string;
}

export interface AssetMentionAttrs {
  kind: AssetKind;
  assetId: string;
  label: string;
  thumb?: string | null;
}

export const DATA_TRANSFER_KEY = 'application/x-asset-mention';

export const KIND_TO_CN: Record<AssetKind, string> = {
  image: '图',
  video: '视频',
  audio: '音频',
};

export const CN_TO_KIND: Record<string, AssetKind> = {
  图: 'image',
  视频: 'video',
  音频: 'audio',
};
