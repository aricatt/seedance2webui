-- 持久化完成后落库的完整访问 URL（默认可配置较长预签名 TTL，供外部系统直接使用）
ALTER TABLE tasks ADD COLUMN persist_video_tos_url TEXT;
ALTER TABLE tasks ADD COLUMN persist_cover_tos_url TEXT;
