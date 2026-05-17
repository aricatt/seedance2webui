-- 人像库预览改用 TOS_PERSIST_BUCKET，存对象 key 便于按需刷新预签名 URL
ALTER TABLE project_portraits ADD COLUMN tos_persist_key TEXT;
