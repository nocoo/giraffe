-- Additive and repeatable. Legacy snapshots/accounts are never modified.
CREATE TABLE IF NOT EXISTS factory_runs (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 request_key TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','paused','completed','partial','cancelled','failed')),
 payload TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 lease_until TEXT,
 next_at TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(account_id, request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS factory_one_active ON factory_runs(account_id) WHERE status IN ('running','paused');
CREATE INDEX IF NOT EXISTS factory_due ON factory_runs(status,next_at,lease_until);
CREATE INDEX IF NOT EXISTS factory_history ON factory_runs(account_id,created_at DESC);
CREATE TABLE IF NOT EXISTS factory_state (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 published_id TEXT,
 catalog_id TEXT,
 next_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS factory_resources (
 run_id TEXT NOT NULL REFERENCES factory_runs(id) ON DELETE CASCADE,
 repo TEXT NOT NULL,
 stream TEXT NOT NULL,
 payload TEXT NOT NULL,
 PRIMARY KEY(run_id,repo,stream)
);
CREATE TABLE IF NOT EXISTS factory_repo_versions (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 repo TEXT NOT NULL,
 version TEXT NOT NULL,
 payload TEXT NOT NULL,
 refreshed_at TEXT NOT NULL,
 PRIMARY KEY(account_id,repo,version)
);
CREATE TABLE IF NOT EXISTS factory_repo_state (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 repo TEXT NOT NULL,
 version TEXT,
 payload TEXT NOT NULL,
 PRIMARY KEY(account_id,repo)
);
