-- 添加任务消耗的tokens和费用字段
-- 用于记录视频生成任务的实际消耗和费用

-- 添加 tokens 消耗字段（单位：token）
ALTER TABLE tasks ADD COLUMN total_tokens INTEGER DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN completion_tokens INTEGER DEFAULT NULL;

-- 添加费用字段（单位：元）
ALTER TABLE tasks ADD COLUMN cost REAL DEFAULT NULL;

-- 添加单价字段（单位：元/百万token，用于记录计费单价）
ALTER TABLE tasks ADD COLUMN unit_price REAL DEFAULT NULL;
