DELETE FROM repo_stars
WHERE EXISTS (
    SELECT 1 FROM repo_statistics
    WHERE repo_statistics.account_id = repo_stars.account_id
      AND lower(repo_statistics.repo) = lower(repo_stars.repo)
      AND repo_statistics.enabled = 0
);

DELETE FROM repo_statistics;
