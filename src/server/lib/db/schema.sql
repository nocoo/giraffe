CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  token_ciphertext TEXT NOT NULL,
  token_last4 TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  scopes TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE UNIQUE INDEX accounts_login ON accounts (login);
CREATE UNIQUE INDEX accounts_one_active ON accounts (is_active) WHERE is_active = 1;

CREATE TABLE snapshots (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (account_id, kind)
);

CREATE TABLE snapshot_days (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (account_id, day)
);

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

-- Reference roots for immutable publications; original snapshots are never pruned.
CREATE TABLE IF NOT EXISTS factory_version_refs (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 publication_id TEXT NOT NULL,
 repo TEXT NOT NULL,
 version TEXT NOT NULL,
 source TEXT NOT NULL,
 PRIMARY KEY(account_id,publication_id,repo)
);
CREATE INDEX IF NOT EXISTS factory_ref_version ON factory_version_refs(account_id,repo,version);
CREATE TABLE IF NOT EXISTS factory_storage (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes >= 0)
);
INSERT INTO factory_storage(account_id,bytes)
SELECT r.account_id,SUM(length(CAST(s.payload AS BLOB))) FROM factory_resources s JOIN factory_runs r ON r.id=s.run_id GROUP BY r.account_id
ON CONFLICT(account_id) DO UPDATE SET bytes=excluded.bytes;
CREATE TRIGGER IF NOT EXISTS factory_resource_insert AFTER INSERT ON factory_resources BEGIN
 INSERT INTO factory_storage(account_id,bytes) VALUES((SELECT account_id FROM factory_runs WHERE id=NEW.run_id),length(CAST(NEW.payload AS BLOB)))
 ON CONFLICT(account_id) DO UPDATE SET bytes=bytes+excluded.bytes;
END;
CREATE TRIGGER IF NOT EXISTS factory_resource_update AFTER UPDATE OF payload ON factory_resources BEGIN
 UPDATE factory_storage SET bytes=bytes+length(CAST(NEW.payload AS BLOB))-length(CAST(OLD.payload AS BLOB)) WHERE account_id=(SELECT account_id FROM factory_runs WHERE id=NEW.run_id);
END;
CREATE TRIGGER IF NOT EXISTS factory_resource_delete AFTER DELETE ON factory_resources BEGIN
 UPDATE factory_storage SET bytes=bytes-length(CAST(OLD.payload AS BLOB)) WHERE account_id=(SELECT account_id FROM factory_runs WHERE id=OLD.run_id);
END;
