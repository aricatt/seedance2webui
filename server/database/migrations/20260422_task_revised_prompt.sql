-- 任务文本结果：方舟生成成功后会在 content.revised_prompt 返回模型改写后的提示词，
-- 之前只在内存的任务对象里保留，未持久化；本次新增字段，便于在下载管理页和归档中查看。
-- 同时复用 error_message 字段记录失败原因，无需额外列。

ALTER TABLE tasks ADD COLUMN revised_prompt TEXT;
