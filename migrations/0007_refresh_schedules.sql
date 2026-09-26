CREATE TABLE IF NOT EXISTS repo_stars (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 repo TEXT NOT NULL COLLATE NOCASE,
 PRIMARY KEY(account_id,repo)
);
CREATE TABLE IF NOT EXISTS refresh_schedules (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('daily','weekly')),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 time TEXT NOT NULL,
 weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
 scope TEXT NOT NULL CHECK(scope IN ('all','starred')),
 next_at TEXT NOT NULL,
 last_run_id TEXT,
 last_error TEXT,
 PRIMARY KEY(account_id,kind)
);
CREATE INDEX IF NOT EXISTS refresh_schedules_due ON refresh_schedules(enabled,next_at);
