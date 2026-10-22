UPDATE factory_runs
SET payload=json_set(payload,'$.publishedAt',NULL)
WHERE json_type(payload,'$.publishedAt') IS NULL;
