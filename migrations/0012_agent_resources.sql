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
