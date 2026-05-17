-- Add ModelToo project tracking columns to tasks table
ALTER TABLE tasks ADD COLUMN mt_project_id TEXT;
ALTER TABLE tasks ADD COLUMN mt_idempotency_key TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_mt_project_id ON tasks(mt_project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_mt_idempotency_key ON tasks(mt_idempotency_key);
