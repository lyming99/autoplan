-- Provider-neutral token accounting. Nullable token columns preserve fields
-- that a provider did not report; callers must not estimate missing usage.

CREATE TABLE IF NOT EXISTS model_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  invocation_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('plan_generation', 'task_execution', 'chat')),
  operation_id TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cached_tokens INTEGER CHECK (cached_tokens IS NULL OR cached_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  collected_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_id) REFERENCES operations(operation_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_usage_invocation_key
ON model_usage (invocation_key);

CREATE INDEX IF NOT EXISTS idx_model_usage_project_collected_at
ON model_usage (project_id, collected_at, id);

CREATE INDEX IF NOT EXISTS idx_model_usage_project_provider
ON model_usage (project_id, provider, collected_at, id);
