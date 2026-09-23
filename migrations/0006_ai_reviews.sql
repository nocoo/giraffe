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
