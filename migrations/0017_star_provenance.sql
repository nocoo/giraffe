ALTER TABLE repo_stars ADD COLUMN starred INTEGER NOT NULL DEFAULT 1 CHECK(starred IN (0,1));
ALTER TABLE repo_stars ADD COLUMN source TEXT NOT NULL DEFAULT 'owner' CHECK(source IN ('owner','agent'));
ALTER TABLE repo_stars ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE repo_stars ADD COLUMN reason TEXT CHECK(reason IS NULL OR length(reason)<=200);

UPDATE repo_stars
SET updated_at=COALESCE(
 strftime('%Y-%m-%dT%H:%M:%fZ',(SELECT updated_at FROM accounts WHERE accounts.id=repo_stars.account_id)),
 '1970-01-01T00:00:00.000Z'
);
