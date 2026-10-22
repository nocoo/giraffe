ALTER TABLE catalog_repositories ADD COLUMN name_current INTEGER NOT NULL DEFAULT 1 CHECK(name_current IN (0,1));
DROP INDEX IF EXISTS catalog_current_name;
CREATE UNIQUE INDEX IF NOT EXISTS catalog_current_name ON catalog_repositories(account_id,repo) WHERE removed_at IS NULL AND name_current=1;

CREATE TABLE IF NOT EXISTS catalog_displaced_state (
 account_id TEXT NOT NULL,
 identity_key TEXT NOT NULL,
 table_name TEXT NOT NULL CHECK(table_name IN ('repo_stars','repo_statistics','factory_repo_state')),
 repo TEXT NOT NULL,
 version TEXT,
 payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=1500000),
 PRIMARY KEY(account_id,identity_key,table_name),
 FOREIGN KEY(account_id,identity_key) REFERENCES catalog_repositories(account_id,identity_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS catalog_unconfirmed (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL,
 repo TEXT NOT NULL,
 github_id TEXT,
 at TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('factory','legacy')),
 source_run_id TEXT,
 reason TEXT NOT NULL CHECK(reason IN ('private_unverifiable','scope_unverifiable','mass_removal_guard','identity_unavailable','budget_exhausted','permission_denied','github_unauthorized','github_rate_limited','github_error','lookup_unverifiable')),
 PRIMARY KEY(account_id,event_id)
);
CREATE INDEX IF NOT EXISTS catalog_unconfirmed_cursor ON catalog_unconfirmed(account_id,at,repo,event_id);
