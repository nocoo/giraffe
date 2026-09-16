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
