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

CREATE TABLE IF NOT EXISTS refresh_schedule_times (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('daily','weekly','catalog')),
 times TEXT NOT NULL CHECK(json_valid(times) AND json_type(times)='array' AND json_array_length(times) BETWEEN 1 AND 6),
 PRIMARY KEY(account_id,kind)
);
INSERT INTO refresh_schedule_times(account_id,kind,times)
SELECT account_id,kind,json_array(time) FROM refresh_schedules WHERE 1
ON CONFLICT(account_id,kind) DO NOTHING;
INSERT INTO refresh_schedule_times(account_id,kind,times)
SELECT account_id,kind,json_array(time) FROM catalog_refresh_schedules WHERE 1
ON CONFLICT(account_id,kind) DO NOTHING;

CREATE TRIGGER IF NOT EXISTS refresh_times_insert AFTER INSERT ON refresh_schedules BEGIN
 INSERT INTO refresh_schedule_times(account_id,kind,times) VALUES(NEW.account_id,NEW.kind,json_array(NEW.time))
 ON CONFLICT(account_id,kind) DO UPDATE SET times=excluded.times;
END;
CREATE TRIGGER IF NOT EXISTS refresh_times_update AFTER UPDATE OF time ON refresh_schedules BEGIN
 UPDATE refresh_schedule_times SET times=json_array(NEW.time) WHERE account_id=NEW.account_id AND kind=NEW.kind;
END;
CREATE TRIGGER IF NOT EXISTS refresh_times_delete AFTER DELETE ON refresh_schedules BEGIN
 DELETE FROM refresh_schedule_times WHERE account_id=OLD.account_id AND kind=OLD.kind;
END;
CREATE TRIGGER IF NOT EXISTS catalog_times_insert AFTER INSERT ON catalog_refresh_schedules BEGIN
 INSERT INTO refresh_schedule_times(account_id,kind,times) VALUES(NEW.account_id,NEW.kind,json_array(NEW.time))
 ON CONFLICT(account_id,kind) DO UPDATE SET times=excluded.times;
END;
CREATE TRIGGER IF NOT EXISTS catalog_times_update AFTER UPDATE OF time ON catalog_refresh_schedules BEGIN
 UPDATE refresh_schedule_times SET times=json_array(NEW.time) WHERE account_id=NEW.account_id AND kind=NEW.kind;
END;
CREATE TRIGGER IF NOT EXISTS catalog_times_delete AFTER DELETE ON catalog_refresh_schedules BEGIN
 DELETE FROM refresh_schedule_times WHERE account_id=OLD.account_id AND kind=OLD.kind;
END;

ALTER TABLE snapshots ADD COLUMN content_meta TEXT;
ALTER TABLE factory_resources ADD COLUMN content_meta TEXT;
CREATE INDEX snapshots_content ON snapshots(account_id,kind,content_meta);
CREATE INDEX factory_resources_content ON factory_resources(run_id,repo,stream,content_meta);

CREATE INDEX IF NOT EXISTS agent_analysis_recent ON agent_resources(
 account_id,
 json_array(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.scope'),repository,json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.domain')),
 CASE WHEN json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt') GLOB '????-??-??T*' AND (CASE WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-1)='Z' THEN 1 WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-6) GLOB '[+-][0-2][0-9]:[0-5][0-9]' AND CAST(substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-5,2) AS INTEGER)<=23 THEN 6 END) IS NOT NULL AND (length(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'))=19+(CASE WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-1)='Z' THEN 1 WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-6) GLOB '[+-][0-2][0-9]:[0-5][0-9]' AND CAST(substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-5,2) AS INTEGER)<=23 THEN 6 END) OR (substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),20,1)='.' AND length(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'))>20+(CASE WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-1)='Z' THEN 1 WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-6) GLOB '[+-][0-2][0-9]:[0-5][0-9]' AND CAST(substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-5,2) AS INTEGER)<=23 THEN 6 END) AND (CASE WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),20,1)='.' THEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),21,length(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'))-20-(CASE WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-1)='Z' THEN 1 WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-6) GLOB '[+-][0-2][0-9]:[0-5][0-9]' AND CAST(substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-5,2) AS INTEGER)<=23 THEN 6 END)) ELSE '' END) NOT GLOB '*[^0-9]*')) THEN unixepoch(substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),1,19)) - CASE WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-6,1) IN ('+','-') THEN (CAST(substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-5,2) AS INTEGER)*3600 + CAST(substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-2,2) AS INTEGER)*60) * CASE substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-6,1) WHEN '+' THEN 1 ELSE -1 END ELSE 0 END END DESC,
 CASE WHEN json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt') GLOB '????-??-??T*' AND (CASE WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-1)='Z' THEN 1 WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-6) GLOB '[+-][0-2][0-9]:[0-5][0-9]' AND CAST(substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-5,2) AS INTEGER)<=23 THEN 6 END) IS NOT NULL AND (length(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'))=19+(CASE WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-1)='Z' THEN 1 WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-6) GLOB '[+-][0-2][0-9]:[0-5][0-9]' AND CAST(substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-5,2) AS INTEGER)<=23 THEN 6 END) OR (substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),20,1)='.' AND length(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'))>20+(CASE WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-1)='Z' THEN 1 WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-6) GLOB '[+-][0-2][0-9]:[0-5][0-9]' AND CAST(substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-5,2) AS INTEGER)<=23 THEN 6 END) AND (CASE WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),20,1)='.' THEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),21,length(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'))-20-(CASE WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-1)='Z' THEN 1 WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-6) GLOB '[+-][0-2][0-9]:[0-5][0-9]' AND CAST(substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-5,2) AS INTEGER)<=23 THEN 6 END)) ELSE '' END) NOT GLOB '*[^0-9]*')) AND unixepoch(substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),1,19)) IS NOT NULL THEN rtrim((CASE WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),20,1)='.' THEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),21,length(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'))-20-(CASE WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-1)='Z' THEN 1 WHEN substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-6) GLOB '[+-][0-2][0-9]:[0-5][0-9]' AND CAST(substr(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt'),-5,2) AS INTEGER)<=23 THEN 6 END)) ELSE '' END),'0') END DESC,
 id DESC
) WHERE collection='reports' AND type='github-analysis';

DELETE FROM repo_stars
WHERE EXISTS (
    SELECT 1 FROM repo_statistics
    WHERE repo_statistics.account_id = repo_stars.account_id
      AND lower(repo_statistics.repo) = lower(repo_stars.repo)
      AND repo_statistics.enabled = 0
);

DELETE FROM repo_statistics;

ALTER TABLE repo_stars ADD COLUMN starred INTEGER NOT NULL DEFAULT 1 CHECK(starred IN (0,1));
ALTER TABLE repo_stars ADD COLUMN source TEXT NOT NULL DEFAULT 'owner' CHECK(source IN ('owner','agent'));
ALTER TABLE repo_stars ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE repo_stars ADD COLUMN reason TEXT CHECK(reason IS NULL OR length(reason)<=200);

UPDATE repo_stars
SET updated_at=COALESCE(
 strftime('%Y-%m-%dT%H:%M:%fZ',(SELECT updated_at FROM accounts WHERE accounts.id=repo_stars.account_id)),
 '1970-01-01T00:00:00.000Z'
);

CREATE TABLE IF NOT EXISTS activity_publications (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL REFERENCES factory_runs(id) ON DELETE CASCADE,
 previous_run_id TEXT,
 until_at TEXT NOT NULL,
 fetched_at TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=1500000),
 content_version TEXT NOT NULL,
 PRIMARY KEY(account_id,run_id)
);
CREATE INDEX IF NOT EXISTS activity_latest ON activity_publications(account_id,until_at DESC,run_id);
CREATE TABLE IF NOT EXISTS activity_pages (
 account_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 page INTEGER NOT NULL CHECK(page>=0 AND page<16),
 payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=1500000),
 PRIMARY KEY(account_id,run_id,page),
 FOREIGN KEY(account_id,run_id) REFERENCES activity_publications(account_id,run_id) ON DELETE CASCADE
);
CREATE TRIGGER IF NOT EXISTS activity_publications_ai AFTER INSERT ON activity_publications BEGIN
 INSERT INTO factory_budget(account_id,bytes) VALUES(NEW.account_id,length(CAST(NEW.payload AS BLOB))) ON CONFLICT(account_id) DO UPDATE SET bytes=bytes+excluded.bytes;
END;
CREATE TRIGGER IF NOT EXISTS activity_publications_au AFTER UPDATE ON activity_publications BEGIN
 UPDATE factory_budget SET bytes=bytes+length(CAST(NEW.payload AS BLOB))-length(CAST(OLD.payload AS BLOB)) WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER IF NOT EXISTS activity_publications_ad AFTER DELETE ON activity_publications BEGIN
 UPDATE factory_budget SET bytes=bytes-length(CAST(OLD.payload AS BLOB)) WHERE account_id=OLD.account_id;
END;
CREATE TRIGGER IF NOT EXISTS activity_pages_ai AFTER INSERT ON activity_pages BEGIN
 INSERT INTO factory_budget(account_id,bytes) VALUES(NEW.account_id,length(CAST(NEW.payload AS BLOB))) ON CONFLICT(account_id) DO UPDATE SET bytes=bytes+excluded.bytes;
END;
CREATE TRIGGER IF NOT EXISTS activity_pages_au AFTER UPDATE ON activity_pages BEGIN
 UPDATE factory_budget SET bytes=bytes+length(CAST(NEW.payload AS BLOB))-length(CAST(OLD.payload AS BLOB)) WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER IF NOT EXISTS activity_pages_ad AFTER DELETE ON activity_pages BEGIN
 UPDATE factory_budget SET bytes=bytes-length(CAST(OLD.payload AS BLOB)) WHERE account_id=OLD.account_id;
END;

CREATE TABLE IF NOT EXISTS catalog_repositories (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 identity_key TEXT NOT NULL,
 github_id TEXT,
 repo TEXT NOT NULL COLLATE NOCASE,
 row_payload TEXT NOT NULL CHECK(length(CAST(row_payload AS BLOB))<=16000),
 first_seen_at TEXT,
 last_seen_at TEXT,
 removed_at TEXT,
 archived_changed_at TEXT,
 is_archived INTEGER NOT NULL CHECK(is_archived IN (0,1)),
 visibility TEXT NOT NULL,
 is_fork INTEGER NOT NULL CHECK(is_fork IN (0,1)),
 first_seen_source TEXT NOT NULL CHECK(first_seen_source IN ('saved_catalog','github_catalog')),
 last_source_run_id TEXT,
 PRIMARY KEY(account_id,identity_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_github_id ON catalog_repositories(account_id,github_id) WHERE github_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS catalog_current_name ON catalog_repositories(account_id,repo) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS catalog_removed ON catalog_repositories(account_id,removed_at);

CREATE TABLE IF NOT EXISTS catalog_changes (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('added','removed','archived','unarchived','visibility_changed','fork_changed','renamed')),
 repo TEXT NOT NULL,
 github_id TEXT,
 at TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('factory','legacy')),
 source_run_id TEXT,
 details TEXT NOT NULL CHECK(length(CAST(details AS BLOB))<=1024),
 PRIMARY KEY(account_id,event_id)
);
CREATE INDEX IF NOT EXISTS catalog_changes_cursor ON catalog_changes(account_id,at,repo,event_id);

CREATE TABLE IF NOT EXISTS catalog_state (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 history_since TEXT NOT NULL,
 checked_at TEXT,
 revision INTEGER NOT NULL DEFAULT 0,
 source_run_id TEXT,
 warning_code TEXT
);

INSERT INTO catalog_state(account_id,history_since)
SELECT account_id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM snapshots WHERE kind IN ('repos','repos#2') GROUP BY account_id
ON CONFLICT(account_id) DO NOTHING;
INSERT INTO catalog_repositories(account_id,identity_key,repo,row_payload,first_seen_at,last_seen_at,is_archived,visibility,is_fork,first_seen_source)
SELECT s.account_id,'legacy:'||lower(json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.name_with_owner')),json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.name_with_owner'),j.value,
 strftime('%Y-%m-%dT%H:%M:%fZ',s.fetched_at),strftime('%Y-%m-%dT%H:%M:%fZ',s.fetched_at),
 json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.is_archived') IS 1,COALESCE(json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.visibility'),CASE WHEN json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.is_private') IS 1 THEN 'PRIVATE' ELSE 'PUBLIC' END),
 json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.is_fork') IS 1,'saved_catalog'
FROM snapshots s,json_each(CASE WHEN json_valid(s.payload) THEN s.payload ELSE '{}' END,'$.repos') j
WHERE s.kind IN ('repos','repos#2') AND json_type(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.name_with_owner')='text' AND length(CAST(j.value AS BLOB))<=16000
AND NOT EXISTS(SELECT 1 FROM catalog_repositories known WHERE known.account_id=s.account_id AND known.repo=json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.name_with_owner') COLLATE NOCASE)
ON CONFLICT(account_id,identity_key) DO NOTHING;

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

UPDATE repo_stars
SET source = 'agent'
WHERE account_id IN (SELECT id FROM accounts WHERE lower(login) = 'nocoo')
  AND lower(repo) IN (
    'nocoo/base-ci', 'nocoo/base-cli', 'nocoo/base-mcp',
    'nocoo/diorama-journey', 'nocoo/eagle', 'nocoo/falcon',
    'nocoo/gaga', 'nocoo/hexly.ai', 'nocoo/his.fm',
    'nocoo/kite', 'nocoo/lizheng.dev', 'nocoo/next-ai',
    'nocoo/octo', 'nocoo/rhino', 'nocoo/rio',
    'nocoo/sleepy', 'nocoo/zeppelin', 'nocoo/zoo'
  )
  AND source = 'owner'
  AND starred = 1
  AND reason IS NULL
  AND updated_at = '2026-10-18T12:03:11.294Z';

UPDATE factory_runs
SET payload=json_set(payload,'$.publishedAt',NULL)
WHERE json_type(payload,'$.publishedAt') IS NULL;

CREATE TABLE IF NOT EXISTS repo_agent_state (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 identity_key TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload)='object' AND length(CAST(payload AS BLOB))<=16384),
 revision INTEGER NOT NULL CHECK(revision>0 AND revision<=9007199254740991),
 updated_at TEXT NOT NULL,
 updated_by TEXT NOT NULL,
 PRIMARY KEY(account_id,identity_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS repo_agent_state_revision ON repo_agent_state(account_id,revision);

CREATE TABLE IF NOT EXISTS repo_meta (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 identity_key TEXT NOT NULL,
 created_at TEXT,
 created_at_source TEXT CHECK(created_at_source IN ('agent','catalog')),
 archived_at TEXT,
 archived_at_source TEXT CHECK(archived_at_source IN ('agent','catalog')),
 category TEXT CHECK(category IN ('app','docs-vault','profile','repro','derivative')),
 category_source TEXT CHECK(category_source IN ('agent','catalog')),
 exclusion_reason TEXT CHECK(length(exclusion_reason)<=200),
 exclusion_reason_source TEXT CHECK(exclusion_reason_source IN ('agent','catalog')),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(account_id,identity_key),
 CHECK((created_at IS NULL)=(created_at_source IS NULL)),
 CHECK((archived_at IS NULL)=(archived_at_source IS NULL)),
 CHECK((category IS NULL)=(category_source IS NULL)),
 CHECK((exclusion_reason IS NULL)=(exclusion_reason_source IS NULL))
);

CREATE TABLE IF NOT EXISTS factory_run_journal (
 run_id TEXT PRIMARY KEY REFERENCES factory_runs(id) ON DELETE CASCADE,
 invocations INTEGER NOT NULL DEFAULT 0,
 journal TEXT NOT NULL DEFAULT '{}'
);

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

DELETE FROM activity_publications
WHERE (account_id, run_id) IN (
 SELECT a.account_id, a.run_id
 FROM activity_publications a
 WHERE NOT EXISTS (
  SELECT 1 FROM factory_resources f
  WHERE f.run_id = a.run_id AND f.stream = 'activity-snapshot'
 )
);

UPDATE activity_commit_ledger
SET published_run_id = NULL
WHERE published_run_id IS NOT NULL
 AND NOT EXISTS (
  SELECT 1 FROM activity_publications ap
  WHERE ap.account_id = activity_commit_ledger.account_id
   AND ap.run_id = activity_commit_ledger.published_run_id
 );
