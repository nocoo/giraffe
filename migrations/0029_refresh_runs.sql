CREATE TABLE IF NOT EXISTS refresh_runs (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('queued','running','completed','partial','failed')),
 trigger TEXT NOT NULL CHECK(trigger IN ('manual','scheduled')),
 schedule_day TEXT,
 payload TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS refresh_run_history ON refresh_runs(account_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS refresh_run_active ON refresh_runs(account_id) WHERE status='running';
CREATE UNIQUE INDEX IF NOT EXISTS refresh_run_schedule ON refresh_runs(account_id,schedule_day) WHERE trigger='scheduled';
