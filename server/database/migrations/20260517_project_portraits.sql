CREATE TABLE IF NOT EXISTS project_portraits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  mt_project_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  preview_url TEXT,
  luminia_asset_id TEXT,
  status TEXT NOT NULL DEFAULT 'uploading',
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_portraits_user_project
  ON project_portraits(user_id, mt_project_id);

CREATE INDEX IF NOT EXISTS idx_project_portraits_status
  ON project_portraits(status);
