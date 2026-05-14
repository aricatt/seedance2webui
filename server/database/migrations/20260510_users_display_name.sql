-- 用户展示名（与 ModelToo display_name / username 同步；本地登录可为空）
ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
