-- 任务归档：每个生成任务在提交成功后由客户端生成单文件 HTML 上传到
-- data/archives/{task_id}.html，路径记录在 tasks.archive_path 中。
-- 归档只包含提示词 + 输入素材预览（图片/视频首帧压缩 JPEG、音频文件名），
-- 不含成品视频（成品视频在下载页单独下载）。

ALTER TABLE tasks ADD COLUMN archive_path TEXT;
