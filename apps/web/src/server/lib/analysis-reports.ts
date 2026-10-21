import type { AgentResource } from "../../lib/agent-resource";
import type { Db } from "./db/d1";

export async function readAnalysisReports(db: Db, account: string) {
	// Seek the next indexed key rather than scanning every historical report.
	const result = await db
		.prepare(`WITH RECURSIVE report_keys(key) AS (
			SELECT (
				SELECT json_array(json_extract(payload,'$.scope'),repository,json_extract(payload,'$.domain'))
				FROM agent_resources
				WHERE account_id=? AND collection='reports' AND type='github-analysis'
				ORDER BY json_array(json_extract(payload,'$.scope'),repository,json_extract(payload,'$.domain')) LIMIT 1
			)
			UNION ALL
			SELECT (
				SELECT json_array(json_extract(payload,'$.scope'),repository,json_extract(payload,'$.domain'))
				FROM agent_resources
				WHERE account_id=? AND collection='reports' AND type='github-analysis'
				AND json_array(json_extract(payload,'$.scope'),repository,json_extract(payload,'$.domain'))>report_keys.key
				ORDER BY json_array(json_extract(payload,'$.scope'),repository,json_extract(payload,'$.domain')) LIMIT 1
			) FROM report_keys WHERE key IS NOT NULL
		)
		SELECT r.id,r.account_id,r.repository,r.type,r.status,r.source_version,r.payload,r.revision,r.created_at,r.updated_at
		FROM report_keys CROSS JOIN agent_resources r
		WHERE report_keys.key IS NOT NULL AND r.rowid IN (
			SELECT rowid FROM agent_resources
			WHERE account_id=? AND collection='reports' AND type='github-analysis'
			AND json_array(json_extract(payload,'$.scope'),repository,json_extract(payload,'$.domain'))=report_keys.key
			ORDER BY CASE WHEN json_extract(payload,'$.generatedAt') GLOB '????-??-??T*'
				THEN julianday(json_extract(payload,'$.generatedAt')) END DESC,id DESC LIMIT 3
		)
		ORDER BY report_keys.key,CASE WHEN json_extract(r.payload,'$.generatedAt') GLOB '????-??-??T*'
			THEN julianday(json_extract(r.payload,'$.generatedAt')) END DESC,r.id DESC`)
		.bind(account, account, account)
		.all<Omit<AgentResource, "payload"> & { payload: string }>();
	return {
		account_id: account,
		items: result.results.map((row) => ({
			...row,
			payload: JSON.parse(row.payload) as AgentResource["payload"],
		})),
	};
}
