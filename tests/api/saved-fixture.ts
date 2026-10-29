import { quote } from "./local-d1";

export function savedRepositorySql(account: string, id: string, repo: string, at: string) {
	return `INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at,active) VALUES(${quote(account)},${quote(id)},${quote(repo)},${quote(at.slice(0, 10))},'Asia/Shanghai',${quote(JSON.stringify({ id, name_with_owner: repo }))},${quote(at)},1) ON CONFLICT(account_id,repo_id) DO UPDATE SET repo=excluded.repo,payload=excluded.payload,fetched_at=excluded.fetched_at,active=1;`;
}

export function publicationSql(account: string) {
	return `INSERT INTO refresh_publications(account_id,payload,published_at) SELECT account_id,payload,fetched_at FROM refresh_snapshots WHERE account_id=${quote(account)} AND kind='factory' ON CONFLICT(account_id) DO UPDATE SET payload=excluded.payload,published_at=excluded.published_at;`;
}

export function savedSnapshotSql(
	account: string,
	kind: string,
	payload: Record<string, unknown>,
	at: string,
	metadata: string | null = null,
) {
	const logical = /^factory:v:[^:]+$/.test(kind) ? "factory" : kind;
	const statements = [
		`INSERT INTO refresh_snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES(${quote(account)},${quote(logical)},${quote(JSON.stringify(payload))},${quote(at)},${metadata === null ? "NULL" : quote(metadata)}) ON CONFLICT(account_id,kind) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at,content_meta=excluded.content_meta;`,
	];
	if (logical === "factory") {
		statements.push(publicationSql(account));
		for (const repo of (payload.repos ?? []) as Record<string, unknown>[]) {
			if (typeof repo.id !== "string" || typeof repo.name !== "string") continue;
			statements.push(
				`UPDATE refresh_catalog SET repo_id=${quote(repo.id)},payload=json_set(payload,'$.id',${quote(repo.id)}) WHERE account_id=${quote(account)} AND repo=${quote(repo.name)} COLLATE NOCASE AND active=1;`,
			);
		}
	}
	if (logical === "repos" && Array.isArray(payload.repos)) {
		statements.push(`UPDATE refresh_catalog SET active=0 WHERE account_id=${quote(account)};`);
		for (const repo of payload.repos as Record<string, unknown>[]) {
			const name = String(repo.name_with_owner);
			const id = `COALESCE((SELECT json_extract(value,'$.id') FROM refresh_publications,json_each(payload,'$.repos') WHERE account_id=${quote(account)} AND json_extract(value,'$.name')=${quote(name)} COLLATE NOCASE LIMIT 1),${quote(String(repo.id ?? name))})`;
			statements.push(
				`INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at,active) VALUES(${quote(account)},${id},${quote(name)},${quote(at.slice(0, 10))},'Asia/Shanghai',json_set(${quote(JSON.stringify(repo))},'$.id',${id}),${quote(at)},1) ON CONFLICT(account_id,repo_id) DO UPDATE SET repo=excluded.repo,payload=excluded.payload,fetched_at=excluded.fetched_at,active=1;`,
			);
		}
	}
	const stream = /^factory:(.+):([^:]+)$/.exec(logical);
	if (stream && !logical.startsWith("factory:v:"))
		statements.push(
			`INSERT INTO refresh_resources(account_id,repo_id,stream,payload,content_meta) SELECT account_id,repo_id,${quote(stream[2] as string)},${quote(JSON.stringify(payload))},${metadata === null ? "NULL" : quote(metadata)} FROM refresh_catalog WHERE account_id=${quote(account)} AND repo=${quote(stream[1] as string)} COLLATE NOCASE AND active=1 ON CONFLICT(account_id,repo_id,stream) DO UPDATE SET payload=excluded.payload,content_meta=excluded.content_meta;`,
		);
	return statements.join("\n");
}
