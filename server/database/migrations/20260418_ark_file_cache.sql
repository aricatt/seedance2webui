-- 方舟文件上传缓存表
-- 作用:
--   服务端将本地文件上传到方舟 /api/v3/files 后, 得到 file_id 与 expire_at.
--   相同文件 (按 SHA-256 去重) 在有效期内复用 file_id, 避免重复上传.

CREATE TABLE IF NOT EXISTS ark_file_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash TEXT NOT NULL UNIQUE,      -- 文件 SHA-256 (hex)
  file_id TEXT NOT NULL,                  -- 方舟返回的 file-xxx
  filename TEXT,                          -- 原始文件名 (仅作参考)
  mime_type TEXT,                         -- MIME, 如 image/jpeg / video/mp4 / audio/mpeg
  bytes INTEGER,                          -- 文件字节数
  purpose TEXT DEFAULT 'user_data',       -- Ark files purpose 字段
  uploaded_at INTEGER NOT NULL,           -- Unix 秒: 本地记录时间
  expires_at INTEGER NOT NULL             -- Unix 秒: Ark 返回的 expire_at
);

CREATE INDEX IF NOT EXISTS idx_ark_file_cache_hash ON ark_file_cache(content_hash);
CREATE INDEX IF NOT EXISTS idx_ark_file_cache_expires ON ark_file_cache(expires_at);
