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
