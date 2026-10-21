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
