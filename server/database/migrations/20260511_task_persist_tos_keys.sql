-- 方舟生成视频完成后写入 TOS_PERSIST_BUCKET 的对象 key（预签名 URL 按需生成）
ALTER TABLE tasks ADD COLUMN persist_video_key TEXT;
ALTER TABLE tasks ADD COLUMN persist_cover_key TEXT;
