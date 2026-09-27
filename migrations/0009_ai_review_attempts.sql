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
