-- 任务归档 HTML 持久化到 TOS_PERSIST_BUCKET
ALTER TABLE tasks ADD COLUMN persist_archive_key TEXT;
ALTER TABLE tasks ADD COLUMN persist_archive_tos_url TEXT;
