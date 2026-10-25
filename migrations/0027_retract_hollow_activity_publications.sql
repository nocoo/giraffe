DELETE FROM activity_publications
WHERE (account_id, run_id) IN (
 SELECT a.account_id, a.run_id
 FROM activity_publications a
 WHERE NOT EXISTS (
  SELECT 1 FROM factory_resources f
  WHERE f.run_id = a.run_id AND f.stream = 'activity-snapshot'
 )
);

UPDATE activity_commit_ledger
SET published_run_id = NULL
WHERE published_run_id IS NOT NULL
 AND NOT EXISTS (
  SELECT 1 FROM activity_publications ap
  WHERE ap.account_id = activity_commit_ledger.account_id
   AND ap.run_id = activity_commit_ledger.published_run_id
 );
