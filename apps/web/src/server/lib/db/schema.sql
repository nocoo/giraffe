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

-- All factory payloads, including legacy snapshots, are measured without rewriting them.
CREATE TABLE IF NOT EXISTS factory_budget (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes >= 0)
);
INSERT INTO factory_budget(account_id,bytes)
SELECT a.id,
 COALESCE((SELECT SUM(length(CAST(payload AS BLOB))) FROM factory_runs WHERE account_id=a.id),0)+
 COALESCE((SELECT SUM(length(CAST(s.payload AS BLOB))) FROM factory_resources s JOIN factory_runs r ON r.id=s.run_id WHERE r.account_id=a.id),0)+
 COALESCE((SELECT SUM(length(CAST(payload AS BLOB))) FROM factory_repo_versions WHERE account_id=a.id),0)+
 COALESCE((SELECT SUM(length(CAST(payload AS BLOB))) FROM factory_repo_state WHERE account_id=a.id),0)+
 COALESCE((SELECT SUM(length(CAST(payload AS BLOB))) FROM snapshots WHERE account_id=a.id AND kind LIKE 'factory%'),0)+
 COALESCE((SELECT SUM(length(CAST(publication_id||repo||version||source AS BLOB))) FROM factory_version_refs WHERE account_id=a.id),0)
FROM accounts a WHERE 1 ON CONFLICT(account_id) DO UPDATE SET bytes=excluded.bytes;

CREATE TRIGGER IF NOT EXISTS budget_factory_runs_insert AFTER INSERT ON factory_runs BEGIN
 INSERT INTO factory_budget(account_id,bytes) VALUES(NEW.account_id,length(CAST(NEW.payload AS BLOB))) ON CONFLICT(account_id) DO UPDATE SET bytes=bytes+excluded.bytes;
END;

CREATE TRIGGER IF NOT EXISTS budget_factory_runs_update AFTER UPDATE ON factory_runs BEGIN
 UPDATE factory_budget SET bytes=bytes+length(CAST(NEW.payload AS BLOB))-length(CAST(OLD.payload AS BLOB)) WHERE account_id=NEW.account_id;
END;

CREATE TRIGGER IF NOT EXISTS budget_factory_runs_delete AFTER DELETE ON factory_runs BEGIN
 UPDATE factory_budget SET bytes=bytes-length(CAST(OLD.payload AS BLOB)) WHERE account_id=OLD.account_id;
END;

CREATE TRIGGER IF NOT EXISTS budget_factory_resources_insert AFTER INSERT ON factory_resources BEGIN
 INSERT INTO factory_budget(account_id,bytes) VALUES((SELECT account_id FROM factory_runs WHERE id=NEW.run_id),length(CAST(NEW.payload AS BLOB))) ON CONFLICT(account_id) DO UPDATE SET bytes=bytes+excluded.bytes;
END;

CREATE TRIGGER IF NOT EXISTS budget_factory_resources_update AFTER UPDATE ON factory_resources BEGIN
 UPDATE factory_budget SET bytes=bytes+length(CAST(NEW.payload AS BLOB))-length(CAST(OLD.payload AS BLOB)) WHERE account_id=(SELECT account_id FROM factory_runs WHERE id=NEW.run_id);
END;

CREATE TRIGGER IF NOT EXISTS budget_factory_resources_delete AFTER DELETE ON factory_resources BEGIN
 UPDATE factory_budget SET bytes=bytes-length(CAST(OLD.payload AS BLOB)) WHERE account_id=(SELECT account_id FROM factory_runs WHERE id=OLD.run_id);
END;

CREATE TRIGGER IF NOT EXISTS budget_factory_repo_versions_insert AFTER INSERT ON factory_repo_versions BEGIN
 INSERT INTO factory_budget(account_id,bytes) VALUES(NEW.account_id,length(CAST(NEW.payload AS BLOB))) ON CONFLICT(account_id) DO UPDATE SET bytes=bytes+excluded.bytes;
END;

CREATE TRIGGER IF NOT EXISTS budget_factory_repo_versions_update AFTER UPDATE ON factory_repo_versions BEGIN
 UPDATE factory_budget SET bytes=bytes+length(CAST(NEW.payload AS BLOB))-length(CAST(OLD.payload AS BLOB)) WHERE account_id=NEW.account_id;
END;

CREATE TRIGGER IF NOT EXISTS budget_factory_repo_versions_delete AFTER DELETE ON factory_repo_versions BEGIN
 UPDATE factory_budget SET bytes=bytes-length(CAST(OLD.payload AS BLOB)) WHERE account_id=OLD.account_id;
END;

CREATE TRIGGER IF NOT EXISTS budget_factory_repo_state_insert AFTER INSERT ON factory_repo_state BEGIN
 INSERT INTO factory_budget(account_id,bytes) VALUES(NEW.account_id,length(CAST(NEW.payload AS BLOB))) ON CONFLICT(account_id) DO UPDATE SET bytes=bytes+excluded.bytes;
END;

CREATE TRIGGER IF NOT EXISTS budget_factory_repo_state_update AFTER UPDATE ON factory_repo_state BEGIN
 UPDATE factory_budget SET bytes=bytes+length(CAST(NEW.payload AS BLOB))-length(CAST(OLD.payload AS BLOB)) WHERE account_id=NEW.account_id;
END;

CREATE TRIGGER IF NOT EXISTS budget_factory_repo_state_delete AFTER DELETE ON factory_repo_state BEGIN
 UPDATE factory_budget SET bytes=bytes-length(CAST(OLD.payload AS BLOB)) WHERE account_id=OLD.account_id;
END;

CREATE TRIGGER IF NOT EXISTS budget_snapshots_insert AFTER INSERT ON snapshots WHEN NEW.kind LIKE 'factory%' BEGIN
 INSERT INTO factory_budget(account_id,bytes) VALUES(NEW.account_id,length(CAST(NEW.payload AS BLOB))) ON CONFLICT(account_id) DO UPDATE SET bytes=bytes+excluded.bytes;
END;

CREATE TRIGGER IF NOT EXISTS budget_snapshots_update AFTER UPDATE ON snapshots WHEN NEW.kind LIKE 'factory%' BEGIN
 UPDATE factory_budget SET bytes=bytes+length(CAST(NEW.payload AS BLOB))-length(CAST(OLD.payload AS BLOB)) WHERE account_id=NEW.account_id;
END;

CREATE TRIGGER IF NOT EXISTS budget_snapshots_delete AFTER DELETE ON snapshots WHEN OLD.kind LIKE 'factory%' BEGIN
 UPDATE factory_budget SET bytes=bytes-length(CAST(OLD.payload AS BLOB)) WHERE account_id=OLD.account_id;
END;

CREATE TRIGGER IF NOT EXISTS budget_factory_version_refs_insert AFTER INSERT ON factory_version_refs BEGIN
 INSERT INTO factory_budget(account_id,bytes) VALUES(NEW.account_id,length(CAST(NEW.publication_id||NEW.repo||NEW.version||NEW.source AS BLOB))) ON CONFLICT(account_id) DO UPDATE SET bytes=bytes+excluded.bytes;
END;

CREATE TRIGGER IF NOT EXISTS budget_factory_version_refs_update AFTER UPDATE ON factory_version_refs BEGIN
 UPDATE factory_budget SET bytes=bytes+length(CAST(NEW.publication_id||NEW.repo||NEW.version||NEW.source AS BLOB))-length(CAST(OLD.publication_id||OLD.repo||OLD.version||OLD.source AS BLOB)) WHERE account_id=NEW.account_id;
END;

CREATE TRIGGER IF NOT EXISTS budget_factory_version_refs_delete AFTER DELETE ON factory_version_refs BEGIN
 UPDATE factory_budget SET bytes=bytes-length(CAST(OLD.publication_id||OLD.repo||OLD.version||OLD.source AS BLOB)) WHERE account_id=OLD.account_id;
END;

CREATE TABLE IF NOT EXISTS repo_statistics (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 repo TEXT NOT NULL COLLATE NOCASE,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 PRIMARY KEY(account_id,repo)
);

CREATE TABLE IF NOT EXISTS ai_settings (
  kind TEXT PRIMARY KEY CHECK(kind IN ('summary', 'judgment')),
  api_key_ciphertext TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK(key_version > 0),
  model TEXT NOT NULL,
  base_url TEXT NOT NULL,
  sdk_type TEXT NOT NULL CHECK(sdk_type IN ('openai', 'anthropic')),
  auth_type TEXT NOT NULL CHECK(auth_type IN ('apiKey', 'bearer')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_reviews (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 repo TEXT NOT NULL,
 job_id TEXT NOT NULL UNIQUE,
 source_version TEXT NOT NULL,
 source_at TEXT NOT NULL,
 stage TEXT NOT NULL CHECK(stage IN ('judgment','summary','complete','failed')),
 input TEXT,
 judgment TEXT,
 report TEXT,
 report_version TEXT,
 report_at TEXT,
 error TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_at TEXT NOT NULL,
 lease_token TEXT,
 lease_until TEXT,
 PRIMARY KEY(account_id,repo)
);
CREATE INDEX IF NOT EXISTS ai_reviews_due ON ai_reviews(stage,next_at,lease_until);

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

CREATE TABLE IF NOT EXISTS ai_provider_options (
 kind TEXT PRIMARY KEY REFERENCES ai_settings(kind) ON DELETE CASCADE,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);

CREATE TABLE IF NOT EXISTS ai_review_attempts (
 job_id TEXT NOT NULL REFERENCES ai_reviews(job_id) ON DELETE CASCADE ON UPDATE CASCADE,
 stage TEXT NOT NULL CHECK(stage IN ('judgment','summary')),
 attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 2),
 source_version TEXT NOT NULL,
 error TEXT NOT NULL,
 diagnostic TEXT NOT NULL,
 recorded_at TEXT NOT NULL,
 PRIMARY KEY(job_id,stage,attempt)
);

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

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
  label TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK(json_valid(scopes) AND json_type(scopes) = 'array'),
  creator TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(expires_at > created_at),
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS api_tokens_account_created ON api_tokens(account_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS api_authorization_codes (
  code_hash TEXT PRIMARY KEY CHECK(length(code_hash) = 64),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK(json_valid(scopes) AND json_type(scopes) = 'array'),
  creator TEXT NOT NULL,
  expires_in_days INTEGER NOT NULL CHECK(expires_in_days BETWEEN 1 AND 90),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL CHECK(length(code_challenge) = 43),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(expires_at > created_at),
  consumed_at TEXT,
  token_id TEXT UNIQUE,
  CHECK((consumed_at IS NULL) = (token_id IS NULL))
);
CREATE INDEX IF NOT EXISTS api_authorization_codes_account ON api_authorization_codes(account_id);
CREATE INDEX IF NOT EXISTS api_authorization_codes_expiry ON api_authorization_codes(expires_at);

CREATE TABLE IF NOT EXISTS agent_resources (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 collection TEXT NOT NULL CHECK(collection IN ('records','reports','jobs')),
 id TEXT NOT NULL,
 repository TEXT,
 type TEXT NOT NULL,
 status TEXT NOT NULL,
 source_version TEXT,
 payload TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(account_id,collection,id)
);
CREATE INDEX IF NOT EXISTS agent_resource_filters ON agent_resources(account_id,collection,type,status,repository,id);
