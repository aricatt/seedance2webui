-- 任务记录视频 API 平台，用于重启后恢复轮询
ALTER TABLE tasks ADD COLUMN video_provider TEXT;

-- 平台开关（管理员在设置页控制）
INSERT OR IGNORE INTO settings (key, value) VALUES ('provider_ark_enabled', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('provider_luminia_enabled', '1');
