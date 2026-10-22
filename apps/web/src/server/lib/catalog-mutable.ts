import type { CatalogPlan } from "./catalog-history";
import type { Db } from "./db/d1";

const TABLES = {
	repo_stars: ["starred", "source", "updated_at", "reason"],
	repo_statistics: ["enabled"],
	factory_repo_state: ["version", "payload"],
};

export function catalogMutableWrites(db: Db, account: string, plan: CatalogPlan) {
	const writes: D1PreparedStatement[] = [];
	const displaced = JSON.stringify(plan.displaced);
	const restored = JSON.stringify(plan.restored);
	const nonce = crypto.randomUUID();
	const renames = JSON.stringify(
		plan.renames.map((rename, index) => ({ ...rename, staged: `@catalog:${nonce}:${index}` })),
	);
	for (const [table, columns] of Object.entries(TABLES)) {
		const object = ["repo", ...columns].map((column) => `'${column}',s.${column}`).join(",");
		const payload = table === "factory_repo_state" ? "s.payload" : `json_object(${object})`;
		const version = table === "factory_repo_state" ? "s.version" : "NULL";
		if (plan.displaced.length)
			writes.push(
				db
					.prepare(`INSERT INTO catalog_displaced_state(account_id,identity_key,table_name,repo,version,payload)
 SELECT ?,json_extract(value,'$.identity_key'),?,s.repo,${version},${payload} FROM json_each(?) JOIN ${table} s ON s.account_id=? AND s.repo=json_extract(value,'$.repo') COLLATE NOCASE
 ON CONFLICT(account_id,identity_key,table_name) DO UPDATE SET repo=excluded.repo,version=excluded.version,payload=excluded.payload`)
					.bind(account, table, displaced, account),
				db
					.prepare(
						`DELETE FROM ${table} WHERE account_id=? AND repo COLLATE NOCASE IN (SELECT json_extract(value,'$.repo') FROM json_each(?))`,
					)
					.bind(account, displaced),
			);
		if (plan.removed.length)
			writes.push(
				db
					.prepare(
						`DELETE FROM ${table} WHERE account_id=? AND repo COLLATE NOCASE IN (SELECT value FROM json_each(?))`,
					)
					.bind(account, JSON.stringify(plan.removed)),
			);
		const mapping =
			"(SELECT json_extract(value,'$.to') FROM json_each(?) WHERE lower(json_extract(value,'$.from'))=lower(repo))";
		const staged =
			"(SELECT json_extract(value,'$.staged') FROM json_each(?) WHERE lower(json_extract(value,'$.from'))=lower(repo))";
		if (plan.renames.length)
			writes.push(
				db
					.prepare(
						`UPDATE ${table} SET ${table === "factory_repo_state" ? `payload=CASE WHEN json_type(payload,'$.observation')='object' THEN json_set(payload,'$.repo',${mapping},'$.observation.repo',COALESCE(json_extract(payload,'$.observation.repo'),repo)) ELSE json_set(payload,'$.repo',${mapping}) END,` : ""}repo=${staged} WHERE account_id=? AND repo COLLATE NOCASE IN (SELECT json_extract(value,'$.from') FROM json_each(?))`,
					)
					.bind(
						...(table === "factory_repo_state" ? [renames, renames] : []),
						renames,
						account,
						renames,
					),
				db
					.prepare(
						`UPDATE ${table} SET repo=(SELECT json_extract(value,'$.to') FROM json_each(?) WHERE json_extract(value,'$.staged')=repo) WHERE account_id=? AND repo IN (SELECT json_extract(value,'$.staged') FROM json_each(?))`,
					)
					.bind(renames, account, renames),
			);
		const values = columns
			.map((column) => {
				if (table !== "factory_repo_state") return `json_extract(d.payload,'$.${column}')`;
				if (column === "version") return "d.version";
				return `CASE WHEN d.repo=json_extract(value,'$.repo') THEN d.payload WHEN json_type(d.payload,'$.observation')='object' THEN json_set(d.payload,'$.repo',json_extract(value,'$.repo'),'$.observation.repo',COALESCE(json_extract(d.payload,'$.observation.repo'),d.repo)) ELSE json_set(d.payload,'$.repo',json_extract(value,'$.repo')) END`;
			})
			.join(",");
		if (plan.restored.length)
			writes.push(
				db
					.prepare(`INSERT INTO ${table}(account_id,repo,${columns.join(",")})
 SELECT ?,json_extract(value,'$.repo'),${values} FROM json_each(?) JOIN catalog_displaced_state d ON d.account_id=? AND d.identity_key=json_extract(value,'$.identity_key') AND d.table_name=? WHERE 1
 ON CONFLICT(account_id,repo) DO UPDATE SET ${columns.map((column) => `${column}=excluded.${column}`).join(",")}`)
					.bind(account, restored, account, table),
			);
	}
	if (plan.removedIdentities.length || plan.restored.length)
		writes.push(
			db
				.prepare(
					"DELETE FROM catalog_displaced_state WHERE account_id=? AND (identity_key IN (SELECT value FROM json_each(?)) OR identity_key IN (SELECT json_extract(value,'$.identity_key') FROM json_each(?)))",
				)
				.bind(account, JSON.stringify(plan.removedIdentities), restored),
		);
	return writes;
}
