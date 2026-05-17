-- 任务生成所用输出分辨率（如 480p / 720p / 1080p），供下载页等展示
ALTER TABLE tasks ADD COLUMN resolution TEXT;

-- 与「全局设置」页一致：批量任务默认分辨率
INSERT OR IGNORE INTO settings (key, value) VALUES ('resolution', '720p');
