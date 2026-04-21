/**
 * 单任务配置预设与历史缓存（纯前端 IndexedDB）
 *
 * 存储结构（DB v2）：
 * - `presets`  : 用户命名保存的预设（无数量上限；总大小软阈值 PRESET_SIZE_SOFT_LIMIT）
 * - `history`  : 提交成功后自动记录的环形缓冲（条数上限 HISTORY_LIMIT；总大小软阈值 HISTORY_SIZE_SOFT_LIMIT）
 * - `draft`    : 离开页面前的未提交配置快照（固定 key = 'current'）
 * - `blobs`    : 内容寻址的素材本体仓库（key = SHA-256 hex），实现跨预设/历史去重
 *
 * 关键设计：
 * - **内容寻址 (CAS)**：相同字节的文件 → 相同哈希 → 磁盘只存一份
 * - **标记清除 GC**：删除预设/历史后扫描所有剩余快照，清理无人引用的 Blob
 * - **配额自管理**：超过软阈值时从最老历史开始淘汰，直到达标；预设超硬阈值拒绝新存并提示
 * - **持久化申请**：初始化时静默请求 navigator.storage.persist() 避免整库被浏览器 LRU 回收
 */

// ============================================================
// 类型
// ============================================================

export type AssetKind = 'image' | 'video' | 'audio';

export interface AssetSnapshot {
  kind: AssetKind;
  /** 原始文件名 */
  name: string;
  /** 字节数 */
  size: number;
  /** MIME */
  type: string;
  /** 修改时间 */
  lastModified: number;
  /** 64px 缩略图 dataURL，音频可省 */
  thumbDataUrl?: string;
  /** 视频/音频时长（秒） */
  durationSeconds?: number;
  /** 图像 / 视频宽度（像素），用于恢复时无需再解码也能显示正确纵横比 */
  width?: number;
  /** 图像 / 视频高度（像素） */
  height?: number;
  /** 原始标签（如 "图1" / "视频1" / "音频1"） */
  label?: string;
  /** 内容哈希 (SHA-256 hex)；若缺失说明本体未缓存（draft 轻量模式） */
  blobHash?: string;
}

export interface ConfigSnapshot {
  prompt: string;
  model: string;
  ratio: string;
  duration: number;
  /** 分辨率：'480p' | '720p'（Seedance 2.0 系列支持）；旧快照可能无此字段 */
  resolution?: string;
  /** 种子整数；未设置或 null 表示随机 */
  seed?: number | null;
  /** 是否固定摄像头 */
  cameraFixed?: boolean;
  /** 是否包含水印 */
  watermark?: boolean;
  /** 是否生成音频（有声视频） */
  generateAudio?: boolean;
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

interface BlobRecord {
  hash: string;
  blob: Blob;
  size: number;
  type: string;
  createdAt: number;
}

interface DraftEntry {
  createdAt: number;
  snapshot: ConfigSnapshot;
}

export interface StorageStats {
  /** blobs 仓库中素材本体总字节数 */
  blobBytes: number;
  /** blobs 条目数（去重后） */
  blobCount: number;
  /** 被历史引用的 blob 字节数（同哈希只计一次，包含其它记录也引用的） */
  historyReferencedBytes: number;
  /** 被预设引用的 blob 字节数（同哈希只计一次） */
  presetReferencedBytes: number;
  /** 浏览器报告的总已用（含本应用全部 IndexedDB） */
  browserUsage?: number;
  /** 浏览器报告的配额上限 */
  browserQuota?: number;
  /** 是否已获得持久化存储许可 */
  persisted?: boolean;
}

// ============================================================
// 配置
// ============================================================

const DB_NAME = 'seedance-config-presets';
const DB_VERSION = 2;
const STORE_PRESETS = 'presets';
const STORE_HISTORY = 'history';
const STORE_DRAFT = 'draft';
const STORE_BLOBS = 'blobs';
const DRAFT_KEY = 'current';

/** 最近历史保留条数 */
export const HISTORY_LIMIT = 20;
/** 历史引用的 Blob 总字节软阈值（超出按旧到新淘汰历史条目） */
export const HISTORY_SIZE_SOFT_LIMIT = 2 * 1024 * 1024 * 1024; // 2 GB
/** 预设引用的 Blob 总字节软阈值（超出拒绝新存入并提示用户手动删除） */
export const PRESET_SIZE_SOFT_LIMIT = 5 * 1024 * 1024 * 1024; // 5 GB

// ============================================================
// IndexedDB 基础设施
// ============================================================

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
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: 'hash' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () =>
      console.warn('[preset-db] 另一个标签页锁住了旧版本，请刷新其他标签页');
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
  storeNames: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDB();
  return await new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result: T;
    Promise.resolve(fn(tx))
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
// 哈希：SHA-256，基于 SubtleCrypto；同一 File 的结果用 WeakMap 缓存
// ============================================================

const fileHashCache = new WeakMap<Blob, Promise<string>>();

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export async function hashBlob(blob: Blob): Promise<string> {
  const cached = fileHashCache.get(blob);
  if (cached) return cached;
  const p = blob.arrayBuffer().then(sha256Hex);
  fileHashCache.set(blob, p);
  return p;
}

// ============================================================
// Blob 仓库（内容寻址）
// ============================================================

/** 把一个 File/Blob 存入仓库；返回它的内容哈希。相同内容只会存一份。 */
export async function putBlobIfAbsent(blob: Blob): Promise<string> {
  const hash = await hashBlob(blob);
  await withStore(STORE_BLOBS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_BLOBS);
    const existing = await idbRequest(
      store.get(hash) as IDBRequest<BlobRecord | undefined>,
    );
    if (!existing) {
      const record: BlobRecord = {
        hash,
        blob,
        size: blob.size,
        type: blob.type || 'application/octet-stream',
        createdAt: Date.now(),
      };
      await idbRequest(store.put(record));
    }
  });
  return hash;
}

/** 预热：当用户把文件添加到 UI 时，后台 fire-and-forget 存入 blob 仓库 */
export function prewarmBlob(blob: Blob): void {
  putBlobIfAbsent(blob).catch((e) =>
    console.warn('[preset] 预热 Blob 失败，忽略', e),
  );
}

export async function getBlobByHash(hash: string): Promise<Blob | null> {
  const record = await withStore(STORE_BLOBS, 'readonly', (tx) =>
    idbRequest(
      tx.objectStore(STORE_BLOBS).get(hash) as IDBRequest<BlobRecord | undefined>,
    ),
  );
  return record?.blob ?? null;
}

/**
 * 基于快照重建一个 File 对象；本体已被 GC 或未缓存时返回 null
 */
export async function reconstructFile(snap: AssetSnapshot): Promise<File | null> {
  if (!snap.blobHash) return null;
  const blob = await getBlobByHash(snap.blobHash);
  if (!blob) return null;
  return new File([blob], snap.name, {
    type: snap.type || blob.type || 'application/octet-stream',
    lastModified: snap.lastModified || Date.now(),
  });
}

// ============================================================
// 缩略图生成（保留）
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
 * - image / video 生成缩略图
 * - 同时把本体通过 CAS 写入 blobs 仓库，填入 blobHash
 */
export async function fileToAssetSnapshot(
  file: File,
  kind: AssetKind,
  opts?: {
    label?: string;
    durationSeconds?: number;
    width?: number;
    height?: number;
  },
): Promise<AssetSnapshot> {
  let thumbDataUrl: string | undefined;
  if (kind === 'image') {
    thumbDataUrl = await imageFileToThumb(file);
  } else if (kind === 'video') {
    thumbDataUrl = await videoFileToThumb(file);
  }
  const blobHash = await putBlobIfAbsent(file);
  return {
    kind,
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    thumbDataUrl,
    durationSeconds: opts?.durationSeconds,
    width: opts?.width,
    height: opts?.height,
    label: opts?.label,
    blobHash,
  };
}

// ============================================================
// 文件 ↔ 快照 匹配（name + size，快速不用哈希）
// ============================================================

export function matchesSnapshot(file: File, snap: AssetSnapshot): boolean {
  return file.name === snap.name && file.size === snap.size;
}

// ============================================================
// 预设（手动命名保存）
// ============================================================

export async function listPresets(): Promise<PresetRecord[]> {
  const records = await withStore(STORE_PRESETS, 'readonly', (tx) =>
    idbRequest(tx.objectStore(STORE_PRESETS).getAll() as IDBRequest<PresetRecord[]>),
  );
  return records.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function savePreset(name: string, snapshot: ConfigSnapshot): Promise<PresetRecord> {
  // 硬阈值检查：预设引用的本体总大小若超限，拒绝新存入
  const stats = await getStorageStats();
  const incomingSize = sumSnapshotBlobSize(snapshot);
  if (stats.presetReferencedBytes + incomingSize > PRESET_SIZE_SOFT_LIMIT) {
    throw new Error(
      `预设总体积已超 ${formatBytes(PRESET_SIZE_SOFT_LIMIT)}（当前 ${formatBytes(stats.presetReferencedBytes)}），请先删除部分预设再保存`,
    );
  }
  const now = Date.now();
  const record: PresetRecord = {
    id: genId('preset'),
    name: name.trim() || `未命名预设 ${new Date(now).toLocaleString('zh-CN')}`,
    createdAt: now,
    updatedAt: now,
    snapshot,
  };
  await withStore(STORE_PRESETS, 'readwrite', (tx) =>
    idbRequest(tx.objectStore(STORE_PRESETS).put(record)),
  );
  return record;
}

export async function renamePreset(id: string, name: string): Promise<void> {
  await withStore(STORE_PRESETS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_PRESETS);
    const record =
      (await idbRequest(store.get(id) as IDBRequest<PresetRecord | undefined>)) ?? null;
    if (!record) return;
    record.name = name.trim() || record.name;
    record.updatedAt = Date.now();
    await idbRequest(store.put(record));
  });
}

export async function deletePreset(id: string): Promise<void> {
  await withStore(STORE_PRESETS, 'readwrite', (tx) =>
    idbRequest(tx.objectStore(STORE_PRESETS).delete(id)),
  );
  await runGC();
}

// ============================================================
// 历史（自动环形缓冲 + 大小软阈值）
// ============================================================

export async function listHistory(): Promise<HistoryRecord[]> {
  const records = await withStore(STORE_HISTORY, 'readonly', (tx) =>
    idbRequest(tx.objectStore(STORE_HISTORY).getAll() as IDBRequest<HistoryRecord[]>),
  );
  return records.sort((a, b) => b.createdAt - a.createdAt);
}

export async function pushHistory(snapshot: ConfigSnapshot): Promise<HistoryRecord> {
  const record: HistoryRecord = {
    id: genId('hist'),
    createdAt: Date.now(),
    snapshot,
  };
  await withStore(STORE_HISTORY, 'readwrite', (tx) =>
    idbRequest(tx.objectStore(STORE_HISTORY).put(record)),
  );
  // 先按条数淘汰，再按大小淘汰
  await evictHistoryByCount();
  await evictHistoryBySize();
  await runGC();
  return record;
}

export async function deleteHistoryItem(id: string): Promise<void> {
  await withStore(STORE_HISTORY, 'readwrite', (tx) =>
    idbRequest(tx.objectStore(STORE_HISTORY).delete(id)),
  );
  await runGC();
}

export async function clearHistory(): Promise<void> {
  await withStore(STORE_HISTORY, 'readwrite', (tx) =>
    idbRequest(tx.objectStore(STORE_HISTORY).clear()),
  );
  await runGC();
}

async function evictHistoryByCount(): Promise<void> {
  const all = await listHistory(); // 新→旧
  if (all.length <= HISTORY_LIMIT) return;
  const toDrop = all.slice(HISTORY_LIMIT);
  await withStore(STORE_HISTORY, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_HISTORY);
    for (const r of toDrop) await idbRequest(store.delete(r.id));
  });
}

async function evictHistoryBySize(): Promise<void> {
  // 需要根据 blob 仓库实际大小计算，按旧→新逐条淘汰
  while (true) {
    const all = await listHistory(); // 新→旧
    if (all.length === 0) return;
    const hashSizes = await getBlobHashToSize();
    // 聚合出历史引用的独立哈希集的总字节
    const referenced = new Set<string>();
    for (const r of all) collectHashes(r.snapshot, referenced);
    let total = 0;
    for (const h of referenced) total += hashSizes.get(h) || 0;
    if (total <= HISTORY_SIZE_SOFT_LIMIT) return;
    // 删最旧的一条
    const oldest = all[all.length - 1];
    await withStore(STORE_HISTORY, 'readwrite', (tx) =>
      idbRequest(tx.objectStore(STORE_HISTORY).delete(oldest.id)),
    );
  }
}

// ============================================================
// 草稿
// ============================================================

export async function saveDraft(snapshot: ConfigSnapshot): Promise<void> {
  const entry: DraftEntry = { createdAt: Date.now(), snapshot };
  await withStore(STORE_DRAFT, 'readwrite', (tx) =>
    idbRequest(tx.objectStore(STORE_DRAFT).put(entry, DRAFT_KEY)),
  );
}

export async function loadDraft(): Promise<DraftEntry | null> {
  const entry = await withStore(STORE_DRAFT, 'readonly', (tx) =>
    idbRequest(
      tx.objectStore(STORE_DRAFT).get(DRAFT_KEY) as IDBRequest<DraftEntry | undefined>,
    ),
  );
  return entry ?? null;
}

export async function clearDraft(): Promise<void> {
  await withStore(STORE_DRAFT, 'readwrite', (tx) =>
    idbRequest(tx.objectStore(STORE_DRAFT).delete(DRAFT_KEY)),
  );
  await runGC();
}

// ============================================================
// GC：扫描所有快照引用的哈希，删除孤儿 Blob
// ============================================================

function collectHashes(snap: ConfigSnapshot, out: Set<string>): void {
  for (const list of [snap.images, snap.videos, snap.audios]) {
    for (const a of list) if (a.blobHash) out.add(a.blobHash);
  }
}

async function getBlobHashToSize(): Promise<Map<string, number>> {
  const records = await withStore(STORE_BLOBS, 'readonly', (tx) =>
    idbRequest(tx.objectStore(STORE_BLOBS).getAll() as IDBRequest<BlobRecord[]>),
  );
  const map = new Map<string, number>();
  for (const r of records) map.set(r.hash, r.size);
  return map;
}

/**
 * 扫描所有剩余 preset/history/draft 的引用，删除 blobs store 中无人引用的条目。
 * 返回删除统计。
 */
export async function runGC(): Promise<{ deletedCount: number; deletedBytes: number }> {
  const [presets, history, draftEntry, allHashes] = await Promise.all([
    listPresets(),
    listHistory(),
    loadDraft(),
    withStore(STORE_BLOBS, 'readonly', (tx) =>
      idbRequest(
        tx.objectStore(STORE_BLOBS).getAll() as IDBRequest<BlobRecord[]>,
      ),
    ),
  ]);
  const referenced = new Set<string>();
  for (const p of presets) collectHashes(p.snapshot, referenced);
  for (const h of history) collectHashes(h.snapshot, referenced);
  if (draftEntry) collectHashes(draftEntry.snapshot, referenced);
  const orphans = allHashes.filter((r) => !referenced.has(r.hash));
  if (orphans.length === 0) return { deletedCount: 0, deletedBytes: 0 };
  let bytes = 0;
  await withStore(STORE_BLOBS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_BLOBS);
    for (const r of orphans) {
      bytes += r.size;
      await idbRequest(store.delete(r.hash));
    }
  });
  return { deletedCount: orphans.length, deletedBytes: bytes };
}

// ============================================================
// 存储统计 & 初始化
// ============================================================

function sumSnapshotBlobSize(snap: ConfigSnapshot): number {
  let total = 0;
  for (const list of [snap.images, snap.videos, snap.audios]) {
    for (const a of list) total += a.size || 0;
  }
  return total;
}

export async function getStorageStats(): Promise<StorageStats> {
  const [presets, history, allBlobs] = await Promise.all([
    listPresets(),
    listHistory(),
    withStore(STORE_BLOBS, 'readonly', (tx) =>
      idbRequest(tx.objectStore(STORE_BLOBS).getAll() as IDBRequest<BlobRecord[]>),
    ),
  ]);
  const sizeOf = new Map<string, number>();
  for (const r of allBlobs) sizeOf.set(r.hash, r.size);

  const histRefs = new Set<string>();
  for (const h of history) collectHashes(h.snapshot, histRefs);
  let historyReferencedBytes = 0;
  for (const h of histRefs) historyReferencedBytes += sizeOf.get(h) || 0;

  const presetRefs = new Set<string>();
  for (const p of presets) collectHashes(p.snapshot, presetRefs);
  let presetReferencedBytes = 0;
  for (const h of presetRefs) presetReferencedBytes += sizeOf.get(h) || 0;

  const blobBytes = allBlobs.reduce((s, r) => s + (r.size || 0), 0);

  let browserUsage: number | undefined;
  let browserQuota: number | undefined;
  let persisted: boolean | undefined;
  try {
    if (typeof navigator !== 'undefined' && navigator.storage) {
      if (navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        browserUsage = est.usage;
        browserQuota = est.quota;
      }
      if (navigator.storage.persisted) {
        persisted = await navigator.storage.persisted();
      }
    }
  } catch {
    /* ignore */
  }

  return {
    blobBytes,
    blobCount: allBlobs.length,
    historyReferencedBytes,
    presetReferencedBytes,
    browserUsage,
    browserQuota,
    persisted,
  };
}

/**
 * 初始化：
 * 1. 静默申请持久化存储许可，阻止浏览器 LRU 回收
 * 2. 启动时跑一次 GC，清理历史异常退出遗留的孤儿 Blob
 */
let initPromise: Promise<void> | null = null;
export async function initStorage(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
        const persisted = await navigator.storage.persisted?.();
        if (!persisted) {
          const granted = await navigator.storage.persist();
          console.info(`[preset] 持久化存储 ${granted ? '已申请成功' : '未获得'}`);
        }
      }
    } catch (e) {
      console.warn('[preset] 持久化申请失败', e);
    }
    try {
      const r = await runGC();
      if (r.deletedCount > 0) {
        console.info(
          `[preset] 启动 GC 清理 ${r.deletedCount} 个孤儿 Blob (${formatBytes(r.deletedBytes)})`,
        );
      }
    } catch (e) {
      console.warn('[preset] 启动 GC 失败', e);
    }
  })();
  return initPromise;
}

// ============================================================
// 工具
// ============================================================

export function isSnapshotEmpty(s: ConfigSnapshot): boolean {
  return (
    !s.prompt.trim() &&
    s.images.length === 0 &&
    s.videos.length === 0 &&
    s.audios.length === 0
  );
}

export function summarizeSnapshot(s: ConfigSnapshot): string {
  const parts: string[] = [];
  if (s.images.length) parts.push(`图 ${s.images.length}`);
  if (s.videos.length) parts.push(`视频 ${s.videos.length}`);
  if (s.audios.length) parts.push(`音频 ${s.audios.length}`);
  const assetStr = parts.length ? parts.join(' · ') : '无素材';
  const promptPreview = s.prompt.trim().slice(0, 40) || '(无提示词)';
  return `${assetStr} · ${promptPreview}`;
}

export function formatBytes(n?: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
