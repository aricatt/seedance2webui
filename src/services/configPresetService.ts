/**
 * 单任务配置预设与历史缓存（纯前端，基于 IndexedDB）
 *
 * 设计要点：
 * - 只存元数据 (name/size/type/lastModified/duration) + 64px 缩略图 dataURL
 * - 不缓存资源本体（Blob），避免占满浏览器配额
 * - 下次加载配置时，根据 name + size 自动与用户重新选择/拖放的文件匹配
 * - 匹配不到则保留在"待补全素材"清单中，提示用户缺失
 *
 * 存储结构：
 * - store `presets`  : 用户命名保存的预设（无数量上限）
 * - store `history`  : 每次提交成功后自动记录的环形缓冲（上限 HISTORY_LIMIT 条）
 * - store `draft`    : 离开页面前的未提交配置快照（固定 key = 'current'）
 */

// ============================================================
// 类型
// ============================================================

export type AssetKind = 'image' | 'video' | 'audio';

/** 单个素材的"轻量快照"——不含文件本体 */
export interface AssetSnapshot {
  kind: AssetKind;
  /** 原始文件名（作为匹配键之一） */
  name: string;
  /** 字节数（作为匹配键之二，容错重名文件） */
  size: number;
  /** MIME 类型 */
  type: string;
  /** 文件修改时间（匹配参考，非强制） */
  lastModified: number;
  /** 64px 缩略图 dataURL，方便列表里视觉识别；音频可省略 */
  thumbDataUrl?: string;
  /** 视频/音频的时长（秒） */
  durationSeconds?: number;
  /** 原始显示标签（如 "图1" / "视频1" / "音频1"） */
  label?: string;
}

export interface ConfigSnapshot {
  prompt: string;
  model: string;
  ratio: string;
  duration: number;
  images: AssetSnapshot[];
  videos: AssetSnapshot[];
  audios: AssetSnapshot[];
}

export interface PresetRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  snapshot: ConfigSnapshot;
}

export interface HistoryRecord {
  id: string;
  createdAt: number;
  snapshot: ConfigSnapshot;
}

// ============================================================
// IndexedDB 基础设施
// ============================================================

const DB_NAME = 'seedance-config-presets';
const DB_VERSION = 1;
const STORE_PRESETS = 'presets';
const STORE_HISTORY = 'history';
const STORE_DRAFT = 'draft';
const DRAFT_KEY = 'current';

/** 最近历史保留条数 */
export const HISTORY_LIMIT = 20;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PRESETS)) {
        db.createObjectStore(STORE_PRESETS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        db.createObjectStore(STORE_HISTORY, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_DRAFT)) {
        db.createObjectStore(STORE_DRAFT);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDB();
  return await new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result: T;
    Promise.resolve(fn(store))
      .then((r) => {
        result = r;
      })
      .catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================
// 缩略图生成
// ============================================================

const THUMB_MAX_EDGE = 96;
const THUMB_JPEG_QUALITY = 0.7;

function fitSize(w: number, h: number, max: number): { w: number; h: number } {
  if (w <= max && h <= max) return { w, h };
  if (w >= h) return { w: max, h: Math.round((h / w) * max) };
  return { w: Math.round((w / h) * max), h: max };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

async function imageFileToThumb(file: File): Promise<string | undefined> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const { w, h } = fitSize(img.naturalWidth, img.naturalHeight, THUMB_MAX_EDGE);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', THUMB_JPEG_QUALITY);
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function videoFileToThumb(file: File): Promise<string | undefined> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  try {
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('视频加载超时')), 10_000);
      video.onloadeddata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error('视频加载失败'));
      };
    });
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
      try {
        video.currentTime = Math.min(0.1, (video.duration || 1) / 10);
      } catch {
        resolve();
      }
    });
    const { w, h } = fitSize(video.videoWidth, video.videoHeight, THUMB_MAX_EDGE);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(video, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', THUMB_JPEG_QUALITY);
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 把一个 File 转成 AssetSnapshot。
 * image / video 会生成缩略图；audio 不生成。
 */
export async function fileToAssetSnapshot(
  file: File,
  kind: AssetKind,
  opts?: { label?: string; durationSeconds?: number },
): Promise<AssetSnapshot> {
  let thumbDataUrl: string | undefined;
  if (kind === 'image') {
    thumbDataUrl = await imageFileToThumb(file);
  } else if (kind === 'video') {
    thumbDataUrl = await videoFileToThumb(file);
  }
  return {
    kind,
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    thumbDataUrl,
    durationSeconds: opts?.durationSeconds,
    label: opts?.label,
  };
}

// ============================================================
// 文件 ↔ 快照 匹配
// ============================================================

/** 判断一个 File 是否对应某个 AssetSnapshot（按 name + size 严格匹配） */
export function matchesSnapshot(file: File, snap: AssetSnapshot): boolean {
  return file.name === snap.name && file.size === snap.size;
}

// ============================================================
// 预设（手动命名保存）
// ============================================================

export async function listPresets(): Promise<PresetRecord[]> {
  const records = await withStore(STORE_PRESETS, 'readonly', (store) =>
    idbRequest(store.getAll() as IDBRequest<PresetRecord[]>),
  );
  return records.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function savePreset(name: string, snapshot: ConfigSnapshot): Promise<PresetRecord> {
  const now = Date.now();
  const record: PresetRecord = {
    id: genId('preset'),
    name: name.trim() || `未命名预设 ${new Date(now).toLocaleString('zh-CN')}`,
    createdAt: now,
    updatedAt: now,
    snapshot,
  };
  await withStore(STORE_PRESETS, 'readwrite', (store) => idbRequest(store.put(record)));
  return record;
}

export async function renamePreset(id: string, name: string): Promise<void> {
  await withStore(STORE_PRESETS, 'readwrite', async (store) => {
    const record = (await idbRequest(store.get(id) as IDBRequest<PresetRecord | undefined>)) ?? null;
    if (!record) return;
    record.name = name.trim() || record.name;
    record.updatedAt = Date.now();
    await idbRequest(store.put(record));
  });
}

export async function deletePreset(id: string): Promise<void> {
  await withStore(STORE_PRESETS, 'readwrite', (store) => idbRequest(store.delete(id)));
}

// ============================================================
// 历史（自动环形缓冲）
// ============================================================

export async function listHistory(): Promise<HistoryRecord[]> {
  const records = await withStore(STORE_HISTORY, 'readonly', (store) =>
    idbRequest(store.getAll() as IDBRequest<HistoryRecord[]>),
  );
  return records.sort((a, b) => b.createdAt - a.createdAt);
}

export async function pushHistory(snapshot: ConfigSnapshot): Promise<HistoryRecord> {
  const record: HistoryRecord = {
    id: genId('hist'),
    createdAt: Date.now(),
    snapshot,
  };
  await withStore(STORE_HISTORY, 'readwrite', async (store) => {
    await idbRequest(store.put(record));
    // 超出上限则淘汰最旧记录
    const all = (await idbRequest(store.getAll() as IDBRequest<HistoryRecord[]>)) as HistoryRecord[];
    if (all.length > HISTORY_LIMIT) {
      const sorted = all.sort((a, b) => a.createdAt - b.createdAt);
      const overflow = sorted.slice(0, all.length - HISTORY_LIMIT);
      await Promise.all(overflow.map((r) => idbRequest(store.delete(r.id))));
    }
  });
  return record;
}

export async function deleteHistoryItem(id: string): Promise<void> {
  await withStore(STORE_HISTORY, 'readwrite', (store) => idbRequest(store.delete(id)));
}

export async function clearHistory(): Promise<void> {
  await withStore(STORE_HISTORY, 'readwrite', (store) => idbRequest(store.clear()));
}

// ============================================================
// 草稿（离开页面前自动备份，只保留最新一份）
// ============================================================

interface DraftEntry {
  createdAt: number;
  snapshot: ConfigSnapshot;
}

export async function saveDraft(snapshot: ConfigSnapshot): Promise<void> {
  const entry: DraftEntry = { createdAt: Date.now(), snapshot };
  await withStore(STORE_DRAFT, 'readwrite', (store) => idbRequest(store.put(entry, DRAFT_KEY)));
}

export async function loadDraft(): Promise<DraftEntry | null> {
  const entry = await withStore(STORE_DRAFT, 'readonly', (store) =>
    idbRequest(store.get(DRAFT_KEY) as IDBRequest<DraftEntry | undefined>),
  );
  return entry ?? null;
}

export async function clearDraft(): Promise<void> {
  await withStore(STORE_DRAFT, 'readwrite', (store) => idbRequest(store.delete(DRAFT_KEY)));
}

// ============================================================
// 工具：判断快照是否为"空"（不值得保存）
// ============================================================

export function isSnapshotEmpty(s: ConfigSnapshot): boolean {
  return (
    !s.prompt.trim() &&
    s.images.length === 0 &&
    s.videos.length === 0 &&
    s.audios.length === 0
  );
}

/** 给快照生成一个用于列表展示的简短摘要 */
export function summarizeSnapshot(s: ConfigSnapshot): string {
  const parts: string[] = [];
  if (s.images.length) parts.push(`图 ${s.images.length}`);
  if (s.videos.length) parts.push(`视频 ${s.videos.length}`);
  if (s.audios.length) parts.push(`音频 ${s.audios.length}`);
  const assetStr = parts.length ? parts.join(' · ') : '无素材';
  const promptPreview = s.prompt.trim().slice(0, 40) || '(无提示词)';
  return `${assetStr} · ${promptPreview}`;
}
