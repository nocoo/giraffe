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
