CREATE TABLE IF NOT EXISTS activity_commit_heads (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 repo_id TEXT NOT NULL,
 head TEXT,
 pending TEXT,
 PRIMARY KEY(account_id,repo_id)
);

CREATE TABLE IF NOT EXISTS activity_commit_ledger (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 repo_id TEXT NOT NULL,
 sha TEXT NOT NULL,
 first_run_id TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 window_since TEXT NOT NULL,
 window_until TEXT NOT NULL,
 payload TEXT,
 published_run_id TEXT,
 reconciliation TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(account_id,repo_id,sha)
);
CREATE INDEX IF NOT EXISTS activity_commit_pending ON activity_commit_ledger(account_id,repo_id,published_run_id);
