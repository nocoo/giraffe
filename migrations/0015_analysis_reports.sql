CREATE INDEX IF NOT EXISTS agent_analysis_recent ON agent_resources(
 account_id,
 json_array(json_extract(payload,'$.scope'),repository,json_extract(payload,'$.domain')),
 CASE WHEN json_extract(payload,'$.generatedAt') GLOB '????-??-??T*'
  THEN julianday(json_extract(payload,'$.generatedAt')) END DESC,
 id DESC
) WHERE collection='reports' AND type='github-analysis';
