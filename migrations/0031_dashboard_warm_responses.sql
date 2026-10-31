CREATE TABLE IF NOT EXISTS dashboard_warm_responses (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 cache_key TEXT NOT NULL,
 data_version TEXT NOT NULL,
 etag TEXT NOT NULL,
 body TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY (account_id, cache_key)
);
CREATE INDEX IF NOT EXISTS dashboard_warm_responses_updated ON dashboard_warm_responses(account_id,updated_at DESC);
