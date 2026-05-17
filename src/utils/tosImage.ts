/** 与 NX `web/src/lib/tosImage.ts` 对齐：列表小图用 x-tos-process（预签名 URL 切勿再拼参数）。 */

export type TosListThumbVariant = 'result' | 'download';

const LIST_THUMB_MAX_SIDE: Record<TosListThumbVariant, number> = {
  result: 384,
  download: 96,
};

export function hasSigningQueryParams(url: string): boolean {
  const qMark = url.indexOf('?');
  if (qMark < 0) return false;
  const q = url.slice(qMark + 1).toLowerCase();
  return (
    q.includes('x-tos-signature') ||
    q.includes('x-tos-algorithm') ||
    q.includes('x-tos-credential') ||
    q.includes('x-amz-signature') ||
    q.includes('x-amz-credential') ||
    q.includes('signature=')
  );
}

function tosResizeProcessString(maxSide: number): string {
  return `image/resize,w_${maxSide},h_${maxSide},limit_0/format,webp`;
}

/** 非预签名 URL 时可拼 x-tos-process 缩小列表加载体积 */
export function appendTosListThumbnailProcess(
  url: string,
  variant: TosListThumbVariant = 'result',
): string {
  if (!url || url.startsWith('/') || url.startsWith('data:')) return url;
  if (hasSigningQueryParams(url)) return url;
  const lower = url.toLowerCase();
  if (lower.includes('x-tos-process=')) return url;
  const looksLikeOurTos =
    lower.includes('tos-cn') ||
    lower.includes('volces.com') ||
    lower.includes('yun-lib') ||
    lower.includes('seedance');
  if (!looksLikeOurTos) return url;
  const sep = url.includes('?') ? '&' : '?';
  const side = LIST_THUMB_MAX_SIDE[variant];
  return `${url}${sep}x-tos-process=${tosResizeProcessString(side)}`;
}

/** 外链/TOS 预签名 → 同源 `/api/video-proxy`（已同源则原样返回） */
export function wrapExternalMediaForBrowser(url: string): string {
  const u = String(url || '').trim();
  if (!u) return u;
  if (u.startsWith('/') || u.startsWith('data:')) return u;
  if (u.startsWith('/api/video-proxy?')) return u;
  return `/api/video-proxy?url=${encodeURIComponent(u)}`;
}

export function imageListNativeTitle(displaySrc: string, originalUrl?: string | null, hint?: string): string {
  const parts: string[] = [];
  if (displaySrc) parts.push(`列表加载：${displaySrc}`);
  const o = originalUrl?.trim();
  if (o && o !== displaySrc) parts.push(`原图/封面地址：${o}`);
  if (hint) parts.push(hint);
  return parts.length > 0 ? parts.join('\n') : displaySrc;
}
