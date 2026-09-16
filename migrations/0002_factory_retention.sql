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
