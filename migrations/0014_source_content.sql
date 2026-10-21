ALTER TABLE snapshots ADD COLUMN content_meta TEXT;
ALTER TABLE factory_resources ADD COLUMN content_meta TEXT;
CREATE INDEX snapshots_content ON snapshots(account_id,kind,content_meta);
CREATE INDEX factory_resources_content ON factory_resources(run_id,repo,stream,content_meta);
