/**
 * 服务端任务归档（供 Studio / 小云雀 Bearer 集成路径）
 * 浏览器端仍用 archiveService.ts；集成请求无浏览器，在此生成等价 HTML 备案。
 */
import sharp from 'sharp';
import * as taskService from './taskService.js';
import { saveTaskArchiveHtml } from './archivePersistService.js';
import { getPortraitArchiveThumbBuffer } from './projectPortraitService.js';

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(n) {
  if (!n || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * @param {number} dbTaskId
 * @param {object} opts
 */
export async function writeIntegrationGenerateVideoArchive(dbTaskId, opts) {
  const {
    prompt,
    model,
    ratio,
    duration,
    resolution,
    seed,
    watermark,
    generateAudio,
    creatorLabel,
    portraitIds = [],
    mtProjectId = '',
    imageFiles = [],
    videoFiles = [],
    audioFiles = [],
  } = opts;

  const submittedAt = new Date().toISOString();

  const thumbBlocks = [];
  let figIndex = 0;

  if (mtProjectId && Array.isArray(portraitIds)) {
    for (const pid of portraitIds) {
      figIndex += 1;
      const label = `图${figIndex}`;
      try {
        const buf = await getPortraitArchiveThumbBuffer({ id: Number(pid), mtProjectId });
        const src = `data:image/jpeg;base64,${buf.toString('base64')}`;
        thumbBlocks.push(
          `<figure style="display:inline-block;margin:8px;vertical-align:top;text-align:center"><div style="font-size:12px;color:#666">${escapeHtml(label)} · 人像库</div><img alt="${escapeHtml(label)}" src="${src}" style="max-width:320px;border:1px solid #ccc;border-radius:4px"/><figcaption style="font-size:11px;color:#888;max-width:320px;word-break:break-all">人像库 #${escapeHtml(String(pid))}</figcaption></figure>`,
        );
      } catch (e) {
        thumbBlocks.push(
          `<p style="color:#b00">${escapeHtml(label)}（人像库 #${escapeHtml(String(pid))}）— 缩略图失败: ${escapeHtml(e.message || String(e))}</p>`,
        );
      }
    }
  }

  for (let i = 0; i < imageFiles.length; i++) {
    const f = imageFiles[i];
    figIndex += 1;
    const label = `图${figIndex}`;
    try {
      const buf = await sharp(f.buffer)
        .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer();
      const src = `data:image/jpeg;base64,${buf.toString('base64')}`;
      thumbBlocks.push(
        `<figure style="display:inline-block;margin:8px;vertical-align:top;text-align:center"><div style="font-size:12px;color:#666">${escapeHtml(label)}</div><img alt="${escapeHtml(label)}" src="${src}" style="max-width:320px;border:1px solid #ccc;border-radius:4px"/><figcaption style="font-size:11px;color:#888;max-width:320px;word-break:break-all">${escapeHtml(f.originalname || '')}</figcaption></figure>`,
      );
    } catch (e) {
      thumbBlocks.push(
        `<p style="color:#b00">${escapeHtml(label)} — 缩略图失败: ${escapeHtml(e.message || String(e))} (${escapeHtml(f.originalname || '')})</p>`,
      );
    }
  }

  const videoList = videoFiles.map((f, i) => `<li>${escapeHtml(`视频${i + 1}`)} — ${escapeHtml(f.originalname || '')}</li>`).join('');
  const audioList = audioFiles.map((f, i) => `<li>${escapeHtml(`音频${i + 1}`)} — ${escapeHtml(f.originalname || '')} ${formatBytes(f.size)}</li>`).join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>任务归档 #${dbTaskId}（Studio 集成）</title>
<style>
body{font-family:system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#222}
pre{white-space:pre-wrap;background:#f6f8fa;padding:12px;border-radius:8px;border:1px solid #e1e4e8}
.meta{font-size:14px;color:#444;line-height:1.6}
h1{font-size:20px}
</style>
</head>
<body>
<h1>任务归档 #${dbTaskId}</h1>
<p class="meta">
提交时间 ${escapeHtml(submittedAt)} · 来源 <strong>Studio 集成</strong>
${creatorLabel ? ` · 操作账号 ${escapeHtml(creatorLabel)}` : ''}
</p>
<p class="meta">
模型 ${escapeHtml(model)} · 比例 ${escapeHtml(String(ratio))} · 时长 ${escapeHtml(String(duration))}s
${resolution ? ` · 分辨率 ${escapeHtml(String(resolution))}` : ''}
 · seed ${seed !== undefined && seed !== null ? escapeHtml(String(seed)) : '随机'}
 · watermark ${watermark ? 'true' : 'false'} · generate_audio ${generateAudio ? 'true' : 'false'}
</p>
<h2>提示词</h2>
<pre>${escapeHtml(prompt || '')}</pre>
<h2>参考图片 (${figIndex})</h2>
${thumbBlocks.length ? `<div>${thumbBlocks.join('\n')}</div>` : '<p>（无）</p>'}
<h2>参考视频 (${videoFiles.length})</h2>
${videoFiles.length ? `<ul>${videoList}</ul>` : '<p>（无）</p>'}
<h2>参考音频 (${audioFiles.length})</h2>
${audioFiles.length ? `<ul>${audioList}</ul>` : '<p>（无）</p>'}
<hr/>
<p style="font-size:12px;color:#888">Seedance 任务归档 · 服务端生成（集成路径）</p>
</body>
</html>`;

  const saved = await saveTaskArchiveHtml(dbTaskId, html);
  taskService.updateTask(dbTaskId, saved);
}
