CREATE TABLE IF NOT EXISTS catalog_refresh_schedules (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind='catalog'),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 time TEXT NOT NULL,
 weekday INTEGER NOT NULL CHECK(weekday=0),
 scope TEXT NOT NULL CHECK(scope='all'),
 next_at TEXT NOT NULL,
 last_run_id TEXT,
 last_error TEXT,
 PRIMARY KEY(account_id,kind)
);
CREATE INDEX IF NOT EXISTS catalog_refresh_schedules_due ON catalog_refresh_schedules(enabled,next_at);
