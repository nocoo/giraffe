CREATE TABLE IF NOT EXISTS refresh_catalog (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 repo_id TEXT NOT NULL,
 repo TEXT NOT NULL COLLATE NOCASE,
 discovered_day TEXT NOT NULL,
 timezone TEXT NOT NULL,
 payload TEXT NOT NULL,
 fetched_at TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 PRIMARY KEY(account_id,repo_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS refresh_catalog_name ON refresh_catalog(account_id,repo) WHERE active=1;
CREATE TABLE IF NOT EXISTS refresh_accounts (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 payload TEXT NOT NULL,
 fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS refresh_day_observations (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 repo_id TEXT NOT NULL,
 timezone TEXT NOT NULL,
 day TEXT NOT NULL,
 dimension TEXT NOT NULL CHECK(dimension IN ('commits','issues','prs','actions','releases','alerts')),
 status TEXT NOT NULL CHECK(status IN ('complete','partial','unavailable')),
 payload TEXT NOT NULL,
 fetched_at TEXT NOT NULL,
 PRIMARY KEY(account_id,repo_id,timezone,day,dimension)
);
CREATE TABLE IF NOT EXISTS refresh_items (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 repo_id TEXT NOT NULL,
 stream TEXT NOT NULL CHECK(stream IN ('issues','prs')),
 item_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 PRIMARY KEY(account_id,repo_id,stream,item_id)
);
CREATE TABLE IF NOT EXISTS refresh_repository_publications (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 repo_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 fetched_at TEXT NOT NULL,
 PRIMARY KEY(account_id,repo_id)
);
CREATE TABLE IF NOT EXISTS refresh_snapshots (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,
 payload TEXT NOT NULL,
 fetched_at TEXT NOT NULL,
 content_meta TEXT,
 PRIMARY KEY(account_id,kind)
);
CREATE TABLE IF NOT EXISTS refresh_publications (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 payload TEXT NOT NULL,
 published_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS refresh_resources (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 repo_id TEXT NOT NULL,
 stream TEXT NOT NULL,
 payload TEXT NOT NULL,
 content_meta TEXT,
 PRIMARY KEY(account_id,repo_id,stream)
);
