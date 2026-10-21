import type { AgentResource } from "../../lib/agent-resource";
import type { Db } from "./db/d1";

const key = `json_array(json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.scope'),repository,json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.domain'))`;
const generatedAt = `json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.generatedAt')`;
const zoneLength = `CASE WHEN substr(${generatedAt},-1)='Z' THEN 1 WHEN substr(${generatedAt},-6) GLOB '[+-][0-2][0-9]:[0-5][0-9]' AND CAST(substr(${generatedAt},-5,2) AS INTEGER)<=23 THEN 6 END`;
const digits = `CASE WHEN substr(${generatedAt},20,1)='.' THEN substr(${generatedAt},21,length(${generatedAt})-20-(${zoneLength})) ELSE '' END`;
const validTime = `${generatedAt} GLOB '????-??-??T*' AND (${zoneLength}) IS NOT NULL AND (length(${generatedAt})=19+(${zoneLength}) OR (substr(${generatedAt},20,1)='.' AND length(${generatedAt})>20+(${zoneLength}) AND (${digits}) NOT GLOB '*[^0-9]*'))`;
// Removing the fraction before epoch conversion prevents SQLite's .9999 rounding carry.
const second = `CASE WHEN ${validTime} THEN unixepoch(substr(${generatedAt},1,19)) - CASE WHEN substr(${generatedAt},-6,1) IN ('+','-') THEN (CAST(substr(${generatedAt},-5,2) AS INTEGER)*3600 + CAST(substr(${generatedAt},-2,2) AS INTEGER)*60) * CASE substr(${generatedAt},-6,1) WHEN '+' THEN 1 ELSE -1 END ELSE 0 END END`;
const fraction = `CASE WHEN ${validTime} AND unixepoch(substr(${generatedAt},1,19)) IS NOT NULL THEN rtrim((${digits}),'0') END`;

export async function readAnalysisReports(db: Db, account: string) {
	// Seek the next indexed key rather than scanning every historical report.
	const result = await db
		.prepare(`WITH RECURSIVE report_keys(key) AS (
			SELECT (
				SELECT ${key}
				FROM agent_resources
				WHERE account_id=? AND collection='reports' AND type='github-analysis'
				ORDER BY ${key} LIMIT 1
			)
			UNION ALL
			SELECT (
				SELECT ${key}
				FROM agent_resources
				WHERE account_id=? AND collection='reports' AND type='github-analysis'
				AND ${key}>report_keys.key
				ORDER BY ${key} LIMIT 1
			) FROM report_keys WHERE key IS NOT NULL
		)
		SELECT r.id,r.account_id,r.repository,r.type,r.status,r.source_version,r.payload,r.revision,r.created_at,r.updated_at
		FROM report_keys CROSS JOIN agent_resources r
		WHERE report_keys.key IS NOT NULL AND r.rowid IN (
			SELECT rowid FROM agent_resources
			WHERE account_id=? AND collection='reports' AND type='github-analysis'
			AND ${key}=report_keys.key
			ORDER BY ${second} DESC,${fraction} DESC,id DESC LIMIT 3
		)
		ORDER BY report_keys.key,${second.replaceAll("payload", "r.payload")} DESC,
			${fraction.replaceAll("payload", "r.payload")} DESC,r.id DESC`)
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
