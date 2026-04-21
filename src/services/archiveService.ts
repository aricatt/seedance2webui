/**
 * 任务归档客户端服务
 *
 * 在任务提交成功（拿到 dbTaskId）后立即调用，把提示词 + 输入素材压缩后
 * 打包成单文件 HTML 上传到服务端，用于事后数据备案。
 *
 * 关键约束：
 * - 只在浏览器内处理（File 对象一旦页面离开就没了）
 * - 图片/视频首帧压缩为 320px 边长的 JPEG（quality 0.75）
 * - 音频只记录文件名，不内嵌
 * - 提示词里的 @图N / @视频N / @音频N 渲染成和素材条一致的 chip
 * - 单文件 HTML 自包含，离线可看，无网络依赖
 */
import { getAuthHeaders } from './authService';

// ===== 类型 =====

export interface ArchiveImageInput {
  file: File;
  label: string; // e.g. "图1"
  originalName: string;
}

export interface ArchiveVideoInput {
  file: File;
  label: string; // e.g. "视频1"
  originalName: string;
  durationSeconds?: number | null;
}

export interface ArchiveAudioInput {
  label: string; // e.g. "音频1"
  originalName: string;
  bytes?: number;
}

export interface ArchiveMeta {
  taskId: number;
  submittedAt: string;
  model: string;
  ratio: string;
  duration: number;
}

export interface BuildArchiveInput {
  prompt: string;
  images: ArchiveImageInput[];
  videos: ArchiveVideoInput[];
  audios: ArchiveAudioInput[];
  meta: ArchiveMeta;
}

// ===== 压缩工具 =====

const MAX_EDGE = 320;
const JPEG_QUALITY = 0.75;

/** 计算保持宽高比下的目标尺寸 */
function fitSize(w: number, h: number, max: number): { w: number; h: number } {
  if (w <= max && h <= max) return { w, h };
  if (w >= h) return { w: max, h: Math.round((h / w) * max) };
  return { w: Math.round((w / h) * max), h: max };
}

/** 用 canvas 压缩图片到 dataURL (JPEG) */
export async function compressImageToDataUrl(
  file: File,
  maxEdge = MAX_EDGE,
  quality = JPEG_QUALITY,
): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const { w, h } = fitSize(img.naturalWidth, img.naturalHeight, maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 上下文不可用');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 抽取视频首帧作为压缩 JPEG dataURL */
export async function extractVideoFirstFrameToDataUrl(
  file: File,
  maxEdge = MAX_EDGE,
  quality = JPEG_QUALITY,
): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('视频加载超时')), 20_000);
      video.onloadeddata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error('视频加载失败'));
      };
    });

    // 跳到 0.1s，避免部分编码第一帧是黑帧
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
      try {
        video.currentTime = Math.min(0.1, (video.duration || 1) / 10);
      } catch {
        // 有些浏览器 seek 会抛，忽略直接取当前帧
        resolve();
      }
    });

    const { w, h } = fitSize(video.videoWidth, video.videoHeight, maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 上下文不可用');
    ctx.drawImage(video, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

// ===== HTML 生成 =====

/** HTML 转义，防止提示词里的 < > & 破坏结构 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text);
}

function formatBytes(n?: number): string {
  if (!n || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 构建压缩后的素材预览 Map，label → 归档内用的 { thumbDataUrl, meta } */
interface CompressedEntry {
  kind: 'image' | 'video' | 'audio';
  label: string;
  originalName: string;
  thumbDataUrl?: string; // audio 没有
  extra?: string; // 音频字节数等
}

/**
 * 把提示词中的 @图N / @视频N / @音频N 替换成渲染 chip 的 HTML。
 * 未命中素材的部分保留为纯文本。
 */
function renderPromptWithChips(prompt: string, byLabel: Map<string, CompressedEntry>): string {
  // 按行处理以保留换行
  const lines = prompt.split('\n');
  const regex = /@(图|视频|音频)(\d+)/g;
  const rendered = lines.map((line) => {
    let out = '';
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    regex.lastIndex = 0;
    while ((match = regex.exec(line)) !== null) {
      const [full, cn, numStr] = match;
      const label = `${cn}${numStr}`;
      if (match.index > lastIndex) {
        out += escapeHtml(line.slice(lastIndex, match.index));
      }
      const entry = byLabel.get(label);
      if (entry) {
        out += renderChip(entry);
      } else {
        out += escapeHtml(full);
      }
      lastIndex = match.index + full.length;
    }
    if (lastIndex < line.length) {
      out += escapeHtml(line.slice(lastIndex));
    }
    return out;
  });
  return rendered.join('<br />');
}

function renderChip(entry: CompressedEntry): string {
  const kindClass = `chip-${entry.kind}`;
  const thumbHtml = entry.thumbDataUrl
    ? `<img class="chip-thumb" src="${escapeAttr(entry.thumbDataUrl)}" alt="${escapeAttr(entry.label)}" />`
    : '<span class="chip-icon">♪</span>';
  return `<span class="chip ${kindClass}" data-kind="${escapeAttr(entry.kind)}" data-label="${escapeAttr(entry.label)}"><span class="chip-label">@${escapeHtml(entry.label)}</span>${thumbHtml}</span>`;
}

function renderAssetCard(entry: CompressedEntry): string {
  const kindClass = `card-${entry.kind}`;
  const thumb = entry.thumbDataUrl
    ? `<img class="card-thumb" src="${escapeAttr(entry.thumbDataUrl)}" alt="${escapeAttr(entry.label)}" />`
    : '<div class="card-thumb card-audio-placeholder">♪</div>';
  const extra = entry.extra ? `<div class="card-extra">${escapeHtml(entry.extra)}</div>` : '';
  return `<div class="asset-card ${kindClass}">
      ${thumb}
      <div class="card-label">@${escapeHtml(entry.label)}</div>
      <div class="card-name">${escapeHtml(entry.originalName)}</div>
      ${extra}
    </div>`;
}

/** 把 ISO 时间转成本地可读字符串（带 Z 的 UTC ISO 字符串，本地时区呈现） */
function toLocalReadable(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN');
}

function renderMeta(meta: ArchiveMeta): string {
  const row = (k: string, v: string) =>
    `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`;
  return `
    <table class="meta-table">
      ${row('任务 ID', String(meta.taskId))}
      ${row('提交时间', toLocalReadable(meta.submittedAt))}
      ${row('模型', meta.model)}
      ${row('画幅比例', meta.ratio)}
      ${row('时长（秒）', String(meta.duration))}
    </table>`;
}

/**
 * 构建归档 HTML。使用内联 CSS，无外部依赖。
 */
export function buildArchiveHTML(
  input: BuildArchiveInput,
  compressed: CompressedEntry[],
): string {
  const byLabel = new Map<string, CompressedEntry>();
  for (const c of compressed) byLabel.set(c.label, c);

  const groups: Record<'image' | 'video' | 'audio', CompressedEntry[]> = {
    image: compressed.filter((c) => c.kind === 'image'),
    video: compressed.filter((c) => c.kind === 'video'),
    audio: compressed.filter((c) => c.kind === 'audio'),
  };

  const groupBlock = (title: string, items: CompressedEntry[]) => {
    if (items.length === 0) return '';
    return `<div class="asset-group">
        <h3>${escapeHtml(title)}（${items.length}）</h3>
        <div class="asset-grid">${items.map(renderAssetCard).join('')}</div>
      </div>`;
  };

  // 视频 + 音频合并为一排（两者合计不超过 6 个），保留原顺序（视频在前、音频在后）
  const mediaItems = [...groups.video, ...groups.audio];
  const mediaBlock =
    mediaItems.length === 0
      ? ''
      : `<div class="asset-group">
          <h3>参考视频与音频（${mediaItems.length}）</h3>
          <div class="asset-grid">${mediaItems.map(renderAssetCard).join('')}</div>
        </div>`;

  const promptHtml = renderPromptWithChips(input.prompt || '(无提示词)', byLabel);
  const plainPrompt = input.prompt || '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>任务归档 #${input.meta.taskId}</title>
<style>
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px 32px;
  background: #0f111a; color: #e5e7eb;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
  line-height: 1.7;
}
.container { max-width: 960px; margin: 0 auto; }
header h1 { margin: 0 0 4px; font-size: 18px; font-weight: 700; color: #fff; }
header .sub { color: #9ca3af; font-size: 12px; }
section { margin-top: 28px; }
h2 { font-size: 14px; color: #c4b5fd; font-weight: 600; margin: 0 0 10px; letter-spacing: 0.5px; }
h3 { font-size: 12px; color: #9ca3af; font-weight: 500; margin: 14px 0 8px; text-transform: uppercase; letter-spacing: 1px; }
.prompt-box {
  background: #1c1f2e; border: 1px solid #374151; border-radius: 12px;
  padding: 16px 20px; font-size: 14px; white-space: normal;
}
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 6px; margin: 0 2px; border-radius: 6px;
  border: 1px solid; font-size: 0.9em; line-height: 1;
  vertical-align: baseline;
}
.chip-label { font-weight: 500; }
.chip-thumb {
  width: 1.25em; height: 1.25em; border-radius: 3px; object-fit: cover;
}
.chip-icon { font-size: 0.95em; }
.chip-image { border-color: rgba(168,85,247,0.4); background: rgba(168,85,247,0.1); color: #ddd6fe; }
.chip-video { border-color: rgba(34,211,238,0.4); background: rgba(34,211,238,0.1); color: #a5f3fc; }
.chip-audio { border-color: rgba(59,130,246,0.4); background: rgba(59,130,246,0.1); color: #bfdbfe; }
.asset-group { margin-top: 18px; }
.asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
.asset-card {
  background: #1c1f2e; border: 1px solid #374151; border-radius: 10px;
  padding: 10px; display: flex; flex-direction: column; align-items: center; gap: 6px;
}
.card-thumb {
  width: 100%; aspect-ratio: 1/1; object-fit: cover; border-radius: 6px;
  background: #0f111a;
}
.card-audio-placeholder {
  display: flex; align-items: center; justify-content: center;
  color: #93c5fd; font-size: 32px;
}
.card-label { font-size: 12px; font-weight: 500; color: #ddd6fe; }
.card-name { font-size: 11px; color: #9ca3af; word-break: break-all; text-align: center; }
.card-extra { font-size: 10px; color: #6b7280; }
.meta-table {
  width: 100%; border-collapse: collapse; font-size: 13px;
  background: #1c1f2e; border: 1px solid #374151; border-radius: 10px; overflow: hidden;
}
.meta-table th, .meta-table td { padding: 8px 14px; text-align: left; border-bottom: 1px solid #2a2f3e; }
.meta-table tr:last-child th, .meta-table tr:last-child td { border-bottom: none; }
.meta-table th { color: #9ca3af; font-weight: 500; width: 110px; }
.meta-table td { color: #e5e7eb; font-family: "SF Mono", Menlo, Consolas, monospace; }
.plain-prompt {
  margin-top: 10px; background: #0f111a; border: 1px dashed #374151; border-radius: 8px;
  padding: 10px 14px; font-size: 12px; color: #9ca3af; white-space: pre-wrap; font-family: "SF Mono", Menlo, Consolas, monospace;
}
footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #2a2f3e; font-size: 11px; color: #6b7280; text-align: center; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>任务归档 #${input.meta.taskId}</h1>
    <div class="sub">提交于 ${escapeHtml(toLocalReadable(input.meta.submittedAt))} · 离线可读 · 此文件由浏览器端生成</div>
  </header>

  <section>
    <h2>元数据</h2>
    ${renderMeta(input.meta)}
  </section>

  <section>
    <h2>输入素材</h2>
    ${groupBlock('参考图片', groups.image)}
    ${mediaBlock}
    ${compressed.length === 0 ? '<div style="color:#6b7280;font-size:12px;">（本次任务没有附带任何素材）</div>' : ''}
  </section>

  <section>
    <h2>提示词（含素材引用）</h2>
    <div class="prompt-box">${promptHtml}</div>
    <h3>原始纯文本</h3>
    <div class="plain-prompt">${escapeHtml(plainPrompt)}</div>
  </section>

  <footer>
    Seedance 任务归档 · 生成于 ${escapeHtml(new Date().toISOString())}
  </footer>
</div>
</body>
</html>`;
}

// ===== 主入口 =====

/**
 * 为一个已提交的任务生成归档 HTML 并上传到服务端。
 * 失败不抛异常，仅 console.warn，保证不干扰主流程。
 */
export async function archiveTask(input: BuildArchiveInput): Promise<void> {
  try {
    // 1) 并行压缩所有图片、视频首帧
    const imagePromises = input.images.map(async (it) => {
      const thumb = await compressImageToDataUrl(it.file).catch((e) => {
        console.warn('[archive] 图片压缩失败', it.originalName, e);
        return undefined;
      });
      return {
        kind: 'image' as const,
        label: it.label,
        originalName: it.originalName,
        thumbDataUrl: thumb,
      };
    });
    const videoPromises = input.videos.map(async (it) => {
      const thumb = await extractVideoFirstFrameToDataUrl(it.file).catch((e) => {
        console.warn('[archive] 视频首帧提取失败', it.originalName, e);
        return undefined;
      });
      const extra = it.durationSeconds ? `时长 ${it.durationSeconds.toFixed(1)}s` : '';
      return {
        kind: 'video' as const,
        label: it.label,
        originalName: it.originalName,
        thumbDataUrl: thumb,
        extra,
      };
    });
    const audioEntries: CompressedEntry[] = input.audios.map((it) => ({
      kind: 'audio' as const,
      label: it.label,
      originalName: it.originalName,
      extra: formatBytes(it.bytes),
    }));

    const [images, videos] = await Promise.all([
      Promise.all(imagePromises),
      Promise.all(videoPromises),
    ]);
    const compressed: CompressedEntry[] = [...images, ...videos, ...audioEntries];

    // 2) 组装 HTML
    const html = buildArchiveHTML(input, compressed);

    // 3) 上传到服务端
    const res = await fetch(`/api/tasks/${input.meta.taskId}/archive`, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'text/html; charset=utf-8',
      },
      body: html,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    console.info(`[archive] task ${input.meta.taskId} 归档已上传 (${(html.length / 1024).toFixed(1)} KB)`);
  } catch (e) {
    console.warn('[archive] 归档失败（不影响主流程）：', e);
  }
}

// CompressedEntry 类型也导出给测试
export type { CompressedEntry };
