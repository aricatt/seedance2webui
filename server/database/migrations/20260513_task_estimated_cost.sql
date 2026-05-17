-- 添加 estimated_cost 字段用于保存预扣费用
ALTER TABLE tasks ADD COLUMN estimated_cost REAL DEFAULT NULL;
