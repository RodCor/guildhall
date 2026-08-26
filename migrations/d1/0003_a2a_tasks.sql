CREATE TABLE IF NOT EXISTS a2a_tasks (
  task_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  context_id TEXT NOT NULL,
  status TEXT NOT NULL,
  task_json TEXT NOT NULL CHECK (json_valid(task_json)),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS a2a_tasks_updated_at_idx
  ON a2a_tasks(updated_at DESC, task_id ASC);

CREATE INDEX IF NOT EXISTS a2a_tasks_context_status_idx
  ON a2a_tasks(context_id, status, updated_at DESC);
