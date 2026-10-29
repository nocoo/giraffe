import type { FactorySnapshot } from "../../apps/web/src/lib/factory-types";
import { savedContentMeta } from "../../apps/web/src/server/lib/content-version";
import type { Db } from "../../apps/web/src/server/lib/db/d1";
import { readSnapshot, replaceSnapshotStmts } from "../../apps/web/src/server/lib/db/snapshots";
import { assemblePages, splitPages } from "../../apps/web/src/server/lib/snapshot-pages";

export async function savedObservationStmts(
	db: Db,
	account: string,
	kind: string,
	payload: Record<string, unknown>,
	at: string,
) {
	const statements = await replaceSnapshotStmts(db, account, kind, payload, at);
	if (kind === "factory") {
		const snapshot = assemblePages(
			kind,
			splitPages(kind, { ...payload, fetched_at: at, truncated: payload.truncated === true }).pages,
		);
		statements.push(
			db
				.prepare(
					"INSERT INTO refresh_publications(account_id,payload,published_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET payload=excluded.payload,published_at=excluded.published_at",
				)
				.bind(account, JSON.stringify(snapshot), at),
		);
		const catalog = await readSnapshot(db, account, "repos");
		for (const repo of (payload as FactorySnapshot).repos) {
			const member = (catalog?.repos as Record<string, unknown>[] | undefined)?.find(
				(member) => String(member.name_with_owner).toLowerCase() === repo.name.toLowerCase(),
			);
			if (member && !member.id)
				statements.push(
					db
						.prepare(
							"INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at,active) VALUES(?,?,?,?,'Asia/Shanghai',?,?,1) ON CONFLICT(account_id,repo_id) DO UPDATE SET repo=excluded.repo,payload=excluded.payload,fetched_at=excluded.fetched_at,active=1",
						)
						.bind(
							account,
							repo.id,
							member.name_with_owner,
							at.slice(0, 10),
							JSON.stringify({ ...member, id: repo.id }),
							at,
						),
				);
		}
	}
	const stream = /^factory:(.+):([^:]+)$/.exec(kind);
	if (stream && !kind.startsWith("factory:v:")) {
		const publication = await readSnapshot(db, account, "factory");
		const repo = publication
			? (publication as FactorySnapshot).repos.find(
					(repo) =>
						repo.name.toLowerCase() === stream[1]?.toLowerCase() ||
						repo.observation?.repo?.toLowerCase() === stream[1]?.toLowerCase(),
				)
			: undefined;
		if (repo)
			statements.push(
				db
					.prepare(
						"INSERT INTO refresh_resources(account_id,repo_id,stream,payload,content_meta) VALUES(?,?,?,?,?) ON CONFLICT(account_id,repo_id,stream) DO UPDATE SET payload=excluded.payload,content_meta=excluded.content_meta",
					)
					.bind(
						account,
						repo.id,
						stream[2],
						JSON.stringify(payload),
						await savedContentMeta(kind, payload),
					),
			);
	}
	if (kind === "repos" && Array.isArray(payload.repos)) {
		statements.push(
			db.prepare("UPDATE refresh_catalog SET active=0 WHERE account_id=?").bind(account),
		);
		for (const repo of payload.repos) {
			if (typeof repo?.id !== "string" || typeof repo.name_with_owner !== "string") continue;
			statements.push(
				db
					.prepare(
						"INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at,active) VALUES(?,?,?,?,'Asia/Shanghai',?,?,1) ON CONFLICT(account_id,repo_id) DO UPDATE SET repo=excluded.repo,payload=excluded.payload,fetched_at=excluded.fetched_at,active=1",
					)
					.bind(account, repo.id, repo.name_with_owner, at.slice(0, 10), JSON.stringify(repo), at),
			);
		}
	}
	return statements;
}

export async function syncSavedObservation(db: Db, account: string, kind: string, at: string) {
	const logical = kind.replace(/#2$/, "");
	if (logical !== "repos" && logical !== "factory" && !logical.startsWith("factory:")) return;
	const root = await db
		.prepare("SELECT kind FROM refresh_snapshots WHERE account_id=? AND kind=?")
		.bind(account, logical)
		.first();
	if (!root) return;
	const snapshot = await readSnapshot(db, account, logical);
	if (snapshot)
		await db.batch((await savedObservationStmts(db, account, logical, snapshot, at)).slice(2));
}
