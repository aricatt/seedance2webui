/**
 * 方舟 Seedance 2.0 官方素材限制 & 前端校验工具
 *
 * 规则来源 (截图整理自官方文档):
 *   - 图片要求: 格式 / 宽高比 / 宽高像素 / 单张 <30MB / 数量 1~9
 *   - 视频要求: mp4 & mov / 480p-1080p / 时长[2,15]s / 最多 3 段 / 总时长 <=15s
 *                宽高比 [0.4,2.5] / 宽高 [300,6000] / 总像素 [409600, 2086876]
 *                单段 <=50MB / FPS [24,60]
 *   - 音频要求: wav / mp3 / 时长[2,15]s / 最多 3 段 / 总时长 <=15s / 单段 <=15MB
 *
 * 说明:
 *   - FPS 检测依赖浏览器的 `requestVideoFrameCallback`, 不稳. 本工具采取"软校验":
 *     能探测到且不在范围就 WARN, 不阻塞提交. 其它项全部硬校验 (拒绝).
 *   - 图片 "请求体总大小 64MB" 限制不在此处强校验, 服务端走 files API 不拼 base64,
 *     已经绕过该限制, 仅保留单张 30MB 这一条客户端硬限制.
 */

// ============================================================
// 规则常量 (export 出去便于 UI 文案引用)
// ============================================================

export const ARK_LIMITS = {
  image: {
    exts: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'heic', 'heif'] as const,
    mimes: [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/bmp',
      'image/tiff',
      'image/gif',
      'image/heic',
      'image/heif',
    ] as const,
    maxBytes: 30 * 1024 * 1024,
    // 开区间 (0.4, 2.5) — 严格大于/小于
    aspectOpen: { min: 0.4, max: 2.5 },
    // 开区间 (300, 6000) — 宽和高都必须严格位于此范围内
    sideOpen: { min: 300, max: 6000 },
    countMin: 1,
    countMax: 9,
  },
  video: {
    exts: ['mp4', 'mov'] as const,
    mimes: ['video/mp4', 'video/quicktime'] as const,
    maxBytes: 50 * 1024 * 1024,
    // 闭区间
    aspect: { min: 0.4, max: 2.5 },
    side: { min: 300, max: 6000 },
    pixels: { min: 409_600, max: 2_086_876 },
    duration: { min: 2, max: 15 },
    fps: { min: 24, max: 60 },
    countMax: 3,
    totalDurationMax: 15,
  },
  audio: {
    exts: ['wav', 'mp3'] as const,
    mimes: ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3'] as const,
    maxBytes: 15 * 1024 * 1024,
    duration: { min: 2, max: 15 },
    countMax: 3,
    totalDurationMax: 15,
  },
} as const;

// ============================================================
// 工具
// ============================================================

export interface ValidateOk<Meta> {
  ok: true;
  meta: Meta;
  warnings: string[];
}
export interface ValidateFail {
  ok: false;
  reason: string;
  warnings: string[];
}
export type ValidateResult<Meta> = ValidateOk<Meta> | ValidateFail;

function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function matchWhitelist(
  file: File,
  exts: readonly string[],
  mimes: readonly string[]
): boolean {
  const ext = fileExt(file.name);
  const mime = (file.type || '').toLowerCase();
  if (ext && exts.includes(ext as (typeof exts)[number])) return true;
  if (mime && mimes.includes(mime as (typeof mimes)[number])) return true;
  return false;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('无法解码图片 (可能文件损坏或格式不受浏览器支持)'));
    };
    img.src = url;
  });
}

function loadVideoMeta(file: File): Promise<{
  element: HTMLVideoElement;
  width: number;
  height: number;
  duration: number;
  cleanup: () => void;
}> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    const cleanup = () => URL.revokeObjectURL(url);
    video.onloadedmetadata = () => {
      resolve({
        element: video,
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
        cleanup,
      });
    };
    video.onerror = () => {
      cleanup();
      reject(new Error('无法读取视频元数据 (可能编码不受浏览器支持)'));
    };
    video.src = url;
  });
}

function loadAudioMeta(file: File): Promise<{ duration: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve({ duration: audio.duration });
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('无法读取音频元数据'));
    };
    audio.src = url;
  });
}

/**
 * 尝试估算 FPS (软校验, 失败或不支持则返回 null).
 * 原理: 用 requestVideoFrameCallback 在首 ~0.5s 内统计帧数 / 实际时间.
 * 浏览器兼容性不一 (Safari 16+ / Chrome/Edge 较稳).
 */
async function estimateFps(video: HTMLVideoElement): Promise<number | null> {
  const anyVideo = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, metadata: any) => void) => number;
  };
  if (typeof anyVideo.requestVideoFrameCallback !== 'function') return null;

  try {
    // 开始播放用于触发帧回调
    video.currentTime = 0;
    await video.play().catch(() => { });
    const sampleMs = 500;
    const start = performance.now();
    let frames = 0;

    return await new Promise<number | null>((resolve) => {
      const tick = () => {
        frames += 1;
        const elapsed = performance.now() - start;
        if (elapsed >= sampleMs) {
          video.pause();
          const fps = frames / (elapsed / 1000);
          resolve(Number.isFinite(fps) && fps > 0 ? fps : null);
          return;
        }
        anyVideo.requestVideoFrameCallback!(tick);
      };
      anyVideo.requestVideoFrameCallback!(tick);
      // 兜底, 1s 还没进 tick 就放弃
      setTimeout(() => resolve(frames > 0 ? frames / ((performance.now() - start) / 1000) : null), 1200);
    });
  } catch {
    return null;
  }
}

// ============================================================
// 单文件校验
// ============================================================

export interface ImageMeta {
  width: number;
  height: number;
  aspect: number;
  sizeBytes: number;
}

export async function validateImageFile(file: File): Promise<ValidateResult<ImageMeta>> {
  const warnings: string[] = [];
  const rule = ARK_LIMITS.image;

  if (!matchWhitelist(file, rule.exts, rule.mimes)) {
    return {
      ok: false,
      warnings,
      reason: `图片格式不支持: "${file.name}". 允许格式: ${rule.exts.join(', ')}`,
    };
  }
  if (file.size > rule.maxBytes) {
    return {
      ok: false,
      warnings,
      reason: `图片过大 (${formatBytes(file.size)}), 上限 ${formatBytes(rule.maxBytes)}`,
    };
  }

  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch (err) {
    // heic/heif 可能无法在浏览器解码, 放行 (服务端再校验), 但给出警告
    const ext = fileExt(file.name);
    if (ext === 'heic' || ext === 'heif') {
      warnings.push('浏览器不支持解码 HEIC/HEIF, 已跳过尺寸校验; 若上传后被服务端拒绝请转为 JPG/PNG');
      return {
        ok: true,
        warnings,
        meta: { width: 0, height: 0, aspect: 0, sizeBytes: file.size },
      };
    }
    return { ok: false, warnings, reason: (err as Error).message };
  }

  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const aspect = w / h;

  // 宽高像素 (开区间: 严格 > min && < max)
  const so = rule.sideOpen;
  if (!(w > so.min && w < so.max) || !(h > so.min && h < so.max)) {
    return {
      ok: false,
      warnings,
      reason: `图片尺寸 ${w}×${h} 超出允许范围 (${so.min}, ${so.max}) px`,
    };
  }

  // 宽高比 (开区间)
  const ao = rule.aspectOpen;
  if (!(aspect > ao.min && aspect < ao.max)) {
    return {
      ok: false,
      warnings,
      reason: `图片宽高比 ${aspect.toFixed(2)} 不在允许范围 (${ao.min}, ${ao.max})`,
    };
  }

  return { ok: true, warnings, meta: { width: w, height: h, aspect, sizeBytes: file.size } };
}

export interface VideoMeta {
  width: number;
  height: number;
  aspect: number;
  duration: number;
  pixels: number;
  fps: number | null;
  sizeBytes: number;
}

export async function validateVideoFile(file: File): Promise<ValidateResult<VideoMeta>> {
  const warnings: string[] = [];
  const rule = ARK_LIMITS.video;

  if (!matchWhitelist(file, rule.exts, rule.mimes)) {
    return {
      ok: false,
      warnings,
      reason: `视频格式不支持: "${file.name}". 仅支持 ${rule.exts.join(', ')} (容器)`,
    };
  }
  if (file.size > rule.maxBytes) {
    return {
      ok: false,
      warnings,
      reason: `视频过大 (${formatBytes(file.size)}), 上限 ${formatBytes(rule.maxBytes)}`,
    };
  }

  let meta: { element: HTMLVideoElement; width: number; height: number; duration: number; cleanup: () => void };
  try {
    meta = await loadVideoMeta(file);
  } catch (err) {
    return { ok: false, warnings, reason: (err as Error).message };
  }

  const { width: w, height: h, duration, element } = meta;
  const aspect = h > 0 ? w / h : 0;
  const pixels = w * h;

  try {
    if (!(w >= rule.side.min && w <= rule.side.max) || !(h >= rule.side.min && h <= rule.side.max)) {
      return {
        ok: false,
        warnings,
        reason: `视频分辨率 ${w}×${h} 超出允许范围 [${rule.side.min}, ${rule.side.max}] px`,
      };
    }
    if (!(aspect >= rule.aspect.min && aspect <= rule.aspect.max)) {
      return {
        ok: false,
        warnings,
        reason: `视频宽高比 ${aspect.toFixed(2)} 不在 [${rule.aspect.min}, ${rule.aspect.max}] 内`,
      };
    }
    if (!(pixels >= rule.pixels.min && pixels <= rule.pixels.max)) {
      return {
        ok: false,
        warnings,
        reason: `视频总像素 ${pixels.toLocaleString()} 不在 [${rule.pixels.min.toLocaleString()}, ${rule.pixels.max.toLocaleString()}] 内 (约 640×640 ~ 2206×946)`,
      };
    }
    if (!(duration >= rule.duration.min && duration <= rule.duration.max)) {
      return {
        ok: false,
        warnings,
        reason: `视频时长 ${duration.toFixed(1)}s 不在 [${rule.duration.min}, ${rule.duration.max}] s 内`,
      };
    }

    // 软校验 FPS
    let fps: number | null = null;
    try {
      fps = await estimateFps(element);
    } catch {
      /* ignore */
    }
    if (fps != null) {
      if (fps < rule.fps.min || fps > rule.fps.max) {
        warnings.push(
          `估算帧率 ${fps.toFixed(1)} FPS 不在推荐范围 [${rule.fps.min}, ${rule.fps.max}], 服务端仍可能拒绝`
        );
      }
    } else {
      warnings.push('浏览器未能测得视频帧率, 已跳过 FPS 校验 (服务端仍会复核)');
    }

    return {
      ok: true,
      warnings,
      meta: { width: w, height: h, aspect, duration, pixels, fps, sizeBytes: file.size },
    };
  } finally {
    meta.cleanup();
  }
}

export interface AudioMeta {
  duration: number;
  sizeBytes: number;
}

export async function validateAudioFile(file: File): Promise<ValidateResult<AudioMeta>> {
  const warnings: string[] = [];
  const rule = ARK_LIMITS.audio;

  if (!matchWhitelist(file, rule.exts, rule.mimes)) {
    return {
      ok: false,
      warnings,
      reason: `音频格式不支持: "${file.name}". 仅支持 ${rule.exts.join(', ')}`,
    };
  }
  if (file.size > rule.maxBytes) {
    return {
      ok: false,
      warnings,
      reason: `音频过大 (${formatBytes(file.size)}), 上限 ${formatBytes(rule.maxBytes)}`,
    };
  }

  let info: { duration: number };
  try {
    info = await loadAudioMeta(file);
  } catch (err) {
    return { ok: false, warnings, reason: (err as Error).message };
  }
  const { duration } = info;

  if (!(duration >= rule.duration.min && duration <= rule.duration.max)) {
    return {
      ok: false,
      warnings,
      reason: `音频时长 ${duration.toFixed(1)}s 不在 [${rule.duration.min}, ${rule.duration.max}] s 内`,
    };
  }
  return { ok: true, warnings, meta: { duration, sizeBytes: file.size } };
}

// ============================================================
// 批量聚合校验 (数量 / 总时长)
// ============================================================

export function validateImageCount(existing: number, incoming: number): string | null {
  const total = existing + incoming;
  const { countMin, countMax } = ARK_LIMITS.image;
  if (total > countMax) {
    return `图片最多 ${countMax} 张 (当前 ${existing}, 还可添加 ${Math.max(0, countMax - existing)})`;
  }
  if (total < countMin && total > 0) {
    return `图片至少 ${countMin} 张`;
  }
  return null;
}

export function validateMediaGroup(
  kind: 'video' | 'audio',
  existingMetas: Array<{ duration: number }>,
  incomingMeta: { duration: number }
): string | null {
  const rule = kind === 'video' ? ARK_LIMITS.video : ARK_LIMITS.audio;
  if (existingMetas.length + 1 > rule.countMax) {
    return `${kind === 'video' ? '视频' : '音频'}最多 ${rule.countMax} 段`;
  }
  const total =
    existingMetas.reduce((s, m) => s + (m.duration || 0), 0) + (incomingMeta.duration || 0);
  if (total > rule.totalDurationMax) {
    return `${kind === 'video' ? '视频' : '音频'}累计时长 ${total.toFixed(1)}s 超过 ${rule.totalDurationMax}s 上限`;
  }
  return null;
}
