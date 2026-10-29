CREATE TABLE IF NOT EXISTS refresh_runs_cancelled (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('queued','running','completed','partial','failed','cancelled')),
 trigger TEXT NOT NULL CHECK(trigger IN ('manual','scheduled')),
 schedule_day TEXT,
 payload TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO refresh_runs_cancelled(id,account_id,status,trigger,schedule_day,payload,created_at,updated_at)
 SELECT id,account_id,status,trigger,schedule_day,payload,created_at,updated_at FROM refresh_runs;
DROP TABLE IF EXISTS refresh_runs;
ALTER TABLE refresh_runs_cancelled RENAME TO refresh_runs;
CREATE INDEX IF NOT EXISTS refresh_run_history ON refresh_runs(account_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS refresh_run_active ON refresh_runs(account_id) WHERE status='running';
CREATE UNIQUE INDEX IF NOT EXISTS refresh_run_schedule ON refresh_runs(account_id,schedule_day) WHERE trigger='scheduled';

UPDATE refresh_runs
SET status='failed',
 payload=json_set(payload,'$.status','failed','$.phase','done','$.errorCode','refresh_schema_cutover','$.finishedAt',json_extract(payload,'$.updatedAt'))
WHERE status IN ('queued','running')
 AND (
  json_type(payload,'$.requestBreakdown') IS NULL
  OR json_type(payload,'$.partialReasons') IS NULL
  OR json_type(payload,'$.cancelRequested') IS NULL
 );
