/**
 * 方舟生成完成后：下载视频 → 上传 TOS_PERSIST_BUCKET → 首帧封面 → 上传封面。
 * 仅由生成完成路径触发，不扫描历史任务；临时文件落在 temp_ffmpeg 供 Docker FFmpeg 读写。
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import * as taskService from './taskService.js';
import {
  isTosPersistConfigured,
  uploadFileToPersistBucket,
  buildCanonicalPersistObjectUrl,
} from './tosUploader.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TEMP_FFMPEG = path.join(PROJECT_ROOT, 'temp_ffmpeg');

export function isVideoResultHostingEnabled() {
  const v = (process.env.VIDEO_RESULT_HOSTING_ENABLED || '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no') return false;
  return isTosPersistConfigured();
}

function defaultMaxBytes() {
  const n = parseInt(process.env.VIDEO_PERSIST_MAX_BYTES || `${600 * 1024 * 1024}`, 10);
  return Number.isFinite(n) && n > 0 ? n : 600 * 1024 * 1024;
}

function hostPathToContainerPath(hostAbsPath, tempFfmpegRoot) {
  const rel = path.relative(tempFfmpegRoot, hostAbsPath);
  const posixRel = rel.split(path.sep).join('/');
  if (posixRel.startsWith('..') || path.isAbsolute(posixRel)) {
    throw new Error('工作路径必须在 temp_ffmpeg 目录下');
  }
  return `/temp/${posixRel}`;
}

class MaxBytesTransform extends Transform {
  constructor(max) {
    super();
    this.max = max;
    this.seen = 0;
  }

  _transform(chunk, enc, cb) {
    this.seen += chunk.length;
    if (this.seen > this.max) {
      cb(new Error(`视频超过大小限制 (${this.max} bytes)`));
      return;
    }
    cb(null, chunk);
  }
}

async function downloadVideoToFile(url, destPath, maxBytes) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });
  if (!res.ok) {
    throw new Error(`下载视频失败 HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error('下载响应无 body');
  }
  await pipeline(
    Readable.fromWeb(res.body),
    new MaxBytesTransform(maxBytes),
    fs.createWriteStream(destPath),
  );
}

async function extractFirstFrameDocker(hostVideoPath, hostCoverPath) {
  const container = process.env.MODELTOOSD_FFMPEG_CONTAINER || 'modeltoosd-ffmpeg-tools';
  const inC = hostPathToContainerPath(hostVideoPath, TEMP_FFMPEG);
  const outC = hostPathToContainerPath(hostCoverPath, TEMP_FFMPEG);
  await execFileAsync(
    'docker',
    [
      'exec',
      container,
      'ffmpeg',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      '0',
      '-i',
      inC,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      outC,
    ],
    { timeout: 180000 },
  );
}

async function extractFirstFrameHost(hostVideoPath, hostCoverPath) {
  await execFileAsync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      '0',
      '-i',
      hostVideoPath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      hostCoverPath,
    ],
    { timeout: 180000 },
  );
}

async function extractFirstFrame(hostVideoPath, hostCoverPath) {
  const skipDocker = process.env.MODELTOOSD_SKIP_DOCKER_FFMPEG === '1';
  if (!skipDocker) {
    try {
      await extractFirstFrameDocker(hostVideoPath, hostCoverPath);
      return;
    } catch (err) {
      console.warn('[persist] Docker FFmpeg 抽帧失败，尝试宿主机 ffmpeg:', err.message);
    }
  }
  await extractFirstFrameHost(hostVideoPath, hostCoverPath);
}

async function runPersistGeneratedVideo(taskId, sourceVideoUrl) {
  let workDir = null;
  try {
    const row = taskService.getTaskById(taskId);
    if (!row || row.persist_video_key) return;

    fs.mkdirSync(TEMP_FFMPEG, { recursive: true });
    workDir = path.join(TEMP_FFMPEG, `persist-${taskId}-${Date.now()}`);
    fs.mkdirSync(workDir, { recursive: true });

    const videoLocal = path.join(workDir, 'source.mp4');
    await downloadVideoToFile(sourceVideoUrl, videoLocal, defaultMaxBytes());

    const { key: videoKey } = await uploadFileToPersistBucket(videoLocal, {
      filename: `task-${taskId}.mp4`,
    });

    let coverKey = null;
    const coverLocal = path.join(workDir, 'cover.jpg');
    try {
      await extractFirstFrame(videoLocal, coverLocal);
      if (fs.existsSync(coverLocal) && fs.statSync(coverLocal).size > 0) {
        const up = await uploadFileToPersistBucket(coverLocal, {
          filename: `task-${taskId}-cover.jpg`,
        });
        coverKey = up.key;
      }
    } catch (coverErr) {
      console.warn(`[persist] task ${taskId} 封面失败（已上传视频）:`, coverErr.message);
    }

    const again = taskService.getTaskById(taskId);
    if (again?.persist_video_key) return;

    const videoTosUrl = buildCanonicalPersistObjectUrl(videoKey);
    const coverTosUrl = coverKey ? buildCanonicalPersistObjectUrl(coverKey) : null;

    taskService.updateTask(taskId, {
      persist_video_key: videoKey,
      persist_cover_key: coverKey,
      persist_video_tos_url: videoTosUrl,
      persist_cover_tos_url: coverTosUrl,
    });
    console.log(`[persist] task ${taskId} 完成 video_key=${videoKey} cover=${coverKey || '(none)'} canonical=${videoTosUrl || '(no)'}`);
  } finally {
    if (workDir && fs.existsSync(workDir)) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }
}

/**
 * 异步触发持久化（不阻塞生成接口）；失败仅打日志，不影响任务 done / video_url。
 */
export function schedulePersistGeneratedVideo(taskId, sourceVideoUrl) {
  if (!isVideoResultHostingEnabled()) return;
  const url = (sourceVideoUrl || '').trim();
  if (!url.startsWith('http')) return;

  setImmediate(() => {
    runPersistGeneratedVideo(taskId, url).catch((err) => {
      console.error(`[persist] task ${taskId} 管线异常:`, err.message);
    });
  });
}
