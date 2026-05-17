/**
 * Seedance 2.0 多模态 content 构造（方舟 / Luminia 共用规则）
 */

function normalizeUrlList(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  return arr
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean);
}

/**
 * 构造媒体 content 条目（不含 text；Luminia 的 prompt 在顶层）
 */
export function buildSeedanceMediaContent({
  imageUrls = [],
  videoUrl = '',
  videoUrls = [],
  audioUrl = '',
  audioUrls = [],
}) {
  const content = [];

  const videos = [...normalizeUrlList(videoUrl), ...normalizeUrlList(videoUrls)];
  const audios = [...normalizeUrlList(audioUrl), ...normalizeUrlList(audioUrls)];
  const hasReferenceMedia = videos.length > 0 || audios.length > 0;

  const items = imageUrls
    .map((item) => (typeof item === 'string' ? { url: item } : item))
    .filter((item) => item && item.url);

  const hasExplicitRoles = items.some((item) => item.role);
  const defaultRole =
    items.length <= 1 && !hasReferenceMedia ? 'first_frame' : 'reference_image';

  items.forEach((item) => {
    const role = hasReferenceMedia
      ? 'reference_image'
      : item.role || (hasExplicitRoles ? 'reference_image' : defaultRole);
    content.push({
      type: 'image_url',
      image_url: { url: item.url },
      role,
    });
  });

  videos.forEach((url) => {
    content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
  });

  audios.forEach((url) => {
    content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' });
  });

  return content;
}

/**
 * 方舟 API：含 text 的完整 content
 */
export function buildArkContent(opts) {
  const content = [];
  const prompt = opts.prompt;
  if (prompt && String(prompt).trim()) {
    content.push({ type: 'text', text: String(prompt) });
  }
  content.push(...buildSeedanceMediaContent(opts));
  return content;
}
