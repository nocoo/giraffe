CREATE TABLE IF NOT EXISTS repo_statistics (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 repo TEXT NOT NULL COLLATE NOCASE,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 PRIMARY KEY(account_id,repo)
);
