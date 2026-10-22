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
