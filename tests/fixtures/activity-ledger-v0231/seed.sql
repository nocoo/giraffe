CREATE TABLE _test_marker(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO _test_marker VALUES('env','test');
INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at)
VALUES('legacy','fixture-owner','fake-envelope','fake',1,'2026-10-22','2026-10-22'),
      ('other','fixture-other','fake-envelope','fake',0,'2026-10-22','2026-10-22');
INSERT INTO snapshots(account_id,kind,payload,fetched_at,content_meta)
VALUES('legacy','repos','{"repos":[],"fetched_at":"2026-10-22","truncated":false}','2026-10-22','{"legacy":true}'),
      ('legacy','notifications','{"notifications":[],"fetched_at":"2026-10-22","truncated":false}','2026-10-22',NULL);
INSERT INTO snapshot_days(account_id,day,payload) VALUES('legacy','2026-10-22','{"saved":true}');
INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at)
VALUES('legacy-run','legacy','fixture-key','completed','{"id":"legacy-run","publishedAt":null}','2026-10-22','2026-10-22','2026-10-22');
INSERT INTO factory_run_journal(run_id,invocations,journal) VALUES('legacy-run',3,'{"saved":true}');
INSERT INTO factory_resources(run_id,repo,stream,payload,content_meta)
VALUES('legacy-run','fixture-owner/repo','commits','{"items":[]}','{"legacy":true}');
INSERT INTO factory_repo_versions(account_id,repo,version,payload,refreshed_at)
VALUES('legacy','fixture-owner/repo','legacy-run','{"saved":true}','2026-10-22');
INSERT INTO factory_repo_state(account_id,repo,version,payload)
VALUES('legacy','fixture-owner/repo','legacy-run','{"saved":true}');
INSERT INTO factory_state(account_id,published_id,catalog_id,next_at)
VALUES('legacy','legacy-run','legacy-run','2026-10-23');
INSERT INTO factory_version_refs(account_id,publication_id,repo,version,source)
VALUES('legacy','legacy-run','fixture-owner/repo','legacy-run','run');
INSERT INTO activity_publications(account_id,run_id,until_at,fetched_at,payload,content_version)
VALUES('legacy','legacy-run','2026-10-22','2026-10-22','{"saved":true}','fixture-version');
INSERT INTO activity_pages(account_id,run_id,page,payload)
VALUES('legacy','legacy-run',0,'{"repos":[]}');
