/**
 * 持久桶图片/视频同源代理：服务端读取 TOS，浏览器不直连 volces.com
 */

import sharp from 'sharp';
import { getPersistObjectV2, guessMimeType } from './tosUploader.js';

const LIST_THUMB_MAX_SIDE = 96;

async function readPersistObjectBuffer(objectKey) {
  const result = await getPersistObjectV2(objectKey);
  const content = result?.data?.content;
  if (!content) {
    throw new Error('无法读取持久桶对象');
  }

  const chunks = [];
  if (typeof content[Symbol.asyncIterator] === 'function') {
    for await (const chunk of content) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } else if (Buffer.isBuffer(content)) {
    chunks.push(content);
  } else {
    chunks.push(Buffer.from(await content));
  }
  return Buffer.concat(chunks);
}

async function resizeListWebp(raw, maxSide = LIST_THUMB_MAX_SIDE) {
  return sharp(raw)
    .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

function contentTypeFromKey(key) {
  return guessMimeType(key) || 'application/octet-stream';
}

/**
 * @param {'full'|'list'|'download'|'cover'} variant
 */
export async function servePersistImageBuffer(objectKey, variant) {
  const raw = await readPersistObjectBuffer(objectKey);
  if (variant === 'cover' || variant === 'download' || variant === 'list') {
    const buf = await resizeListWebp(raw);
    return { buffer: buf, contentType: 'image/webp' };
  }
  return { buffer: raw, contentType: contentTypeFromKey(objectKey) };
}

/** 视频等大对象：流式转发，避免整文件进内存 */
export async function streamPersistObjectToResponse(res, objectKey) {
  const result = await getPersistObjectV2(objectKey);
  const content = result?.data?.content;
  if (!content) {
    throw new Error('无法读取持久桶对象');
  }

  const contentType =
    result?.data?.contentType || contentTypeFromKey(objectKey);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');

  const writeChunk = async (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!res.write(buf)) {
      await new Promise((resolve) => res.once('drain', resolve));
    }
  };

  if (typeof content[Symbol.asyncIterator] === 'function') {
    for await (const chunk of content) {
      await writeChunk(chunk);
    }
    res.end();
    return;
  }
  if (Buffer.isBuffer(content)) {
    res.send(content);
    return;
  }
  res.send(Buffer.from(await content));
}
