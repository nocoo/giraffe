CREATE INDEX IF NOT EXISTS agent_analysis_recent ON agent_resources(
 account_id,
 json_array(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.scope'),repository,json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.domain')),
 CASE WHEN json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt') GLOB '????-??-??T*'
  THEN julianday(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt')) END DESC,
 id DESC
) WHERE collection='reports' AND type='github-analysis';
