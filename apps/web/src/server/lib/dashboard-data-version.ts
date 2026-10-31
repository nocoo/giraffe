import { APP_VERSION } from "../../lib/version";
import { activityPublicationSql } from "./activity-store";
import type { Db } from "./db/d1";
import { factoryRateStatement } from "./factory-rate";
import {
	type AccountObservationResource,
	ciPagesStatement,
	logicalSnapshotStatement,
	observationStarsStatement,
	publicationSnapshotStatement,
	repositoryPagesStatement,
	type SavedAccount,
} from "./saved-observation-statements";
import type { SnapshotScope } from "./snapshot-scope";

function accountId(account: SavedAccount): string {
	if (account !== null) return account;
	throw new Error("dashboard version requires a concrete account id");
}

function starsRevision(rows: { repo: string; starred: number; updated_at: string }[]): string {
	return rows.map((star) => `${star.repo}:${star.starred}:${star.updated_at}`).join("|");
}

function snapshotMetaSignature(
	rows: { kind: string; content_meta: string | null; fetched_at?: string | null }[],
): string {
	return rows
		.map(
			(row) => `${row.kind}:${row.content_meta ?? ""}${row.fetched_at ? `:${row.fetched_at}` : ""}`,
		)
		.sort()
		.join("|");
}

function publicationIdentityFromPayload(payload: string | undefined): string {
	if (!payload) return "missing";
	try {
		const parsed = JSON.parse(payload) as {
			runId?: string;
			publication?: { runId?: string; publishedAt?: string };
		};
		return `${parsed.publication?.runId ?? parsed.runId ?? ""}:${parsed.publication?.publishedAt ?? ""}`;
	} catch {
		return "malformed";
	}
}

export type DashboardVersionInput = {
	app: string;
	resource: string;
	scope: SnapshotScope;
	includeRemoved: boolean;
	account: string;
	stars: string;
	catalog: string;
	publication: string;
	publicationRow: string;
	agent: string;
	meta: string;
	rate: string;
	snapshots: string;
	repositoryPages?: string;
	ciPages?: string;
	activityQuery?: string;
};

export async function accountObservationVersionInput(
	db: Db,
	account: SavedAccount,
	resource: AccountObservationResource,
	scope: SnapshotScope,
	includeRemoved = false,
): Promise<DashboardVersionInput> {
	const id = accountId(account);
	const statements: D1PreparedStatement[] = [
		observationStarsStatement(db, id),
		db
			.prepare(
				"SELECT COUNT(*) AS count, IFNULL(MAX(fetched_at),'') AS fetched FROM refresh_catalog WHERE account_id=? AND active=1",
			)
			.bind(id),
		publicationSnapshotStatement(db, id),
		db
			.prepare(
				"SELECT IFNULL(published_at,'') AS published, payload FROM refresh_publications WHERE account_id=?",
			)
			.bind(id),
		db
			.prepare(
				"SELECT IFNULL(MAX(revision),0) AS revision, IFNULL(MAX(updated_at),'') AS updated FROM repo_agent_state WHERE account_id=?",
			)
			.bind(id),
		db
			.prepare("SELECT IFNULL(MAX(updated_at),'') AS updated FROM repo_meta WHERE account_id=?")
			.bind(id),
		factoryRateStatement(db, id),
	];
	const snapshotKinds: string[] = [];
	if (resource === "factory") snapshotKinds.push("factory");
	else if (resource === "ci") snapshotKinds.push("repos");
	else snapshotKinds.push(resource);
	if (resource === "issues" || resource === "prs") snapshotKinds.push("repos");
	for (const kind of snapshotKinds) statements.push(logicalSnapshotStatement(db, id, kind));
	let repositoryPagesIndex = -1;
	if (resource === "issues" || resource === "prs") {
		repositoryPagesIndex = statements.length;
		statements.push(repositoryPagesStatement(db, id, resource));
	}
	let ciPagesIndex = -1;
	if (resource === "ci") {
		ciPagesIndex = statements.length;
		statements.push(ciPagesStatement(db, id));
	}
	const results = await db.batch(statements);
	const row = <T>(index: number) => results[index]?.results as T[];
	const catalog = row<{ count: number; fetched: string }>(1)[0];
	const publicationPayload = row<{ payload: string }>(2)[0]?.payload;
	const publicationRow = row<{ published: string; payload: string | null }>(3)[0];
	const agent = row<{ revision: number; updated: string }>(4)[0];
	const meta = row<{ updated: string }>(5)[0]?.updated ?? "";
	const rate = row<{ rate: string | null }>(6)[0]?.rate ?? "";
	const snapshotStart = 7;
	const snapshotParts = snapshotKinds.map((_, offset) =>
		snapshotMetaSignature(row(snapshotStart + offset)),
	);
	const input: DashboardVersionInput = {
		app: APP_VERSION,
		resource,
		scope,
		includeRemoved,
		account: id,
		stars: starsRevision(row(0)),
		catalog: `${catalog?.count ?? 0}:${catalog?.fetched ?? ""}`,
		publication: publicationIdentityFromPayload(publicationPayload),
		publicationRow: `${publicationRow?.published ?? ""}:${publicationRow?.payload ?? ""}`,
		agent: `${agent?.revision ?? 0}:${agent?.updated ?? ""}`,
		meta,
		rate,
		snapshots: snapshotParts.join("|"),
	};
	if (repositoryPagesIndex >= 0)
		input.repositoryPages = snapshotMetaSignature(row(repositoryPagesIndex));
	if (ciPagesIndex >= 0) input.ciPages = snapshotMetaSignature(row(ciPagesIndex));
	return input;
}

export function serializeDashboardVersion(input: DashboardVersionInput): string {
	return JSON.stringify(input);
}

export async function accountObservationDataVersion(
	db: Db,
	account: SavedAccount,
	resource: AccountObservationResource,
	scope: SnapshotScope,
	includeRemoved = false,
): Promise<string> {
	return serializeDashboardVersion(
		await accountObservationVersionInput(db, account, resource, scope, includeRemoved),
	);
}

export async function activityDataVersion(
	db: Db,
	account: string,
	queryKey: string,
): Promise<string> {
	const results = await db.batch([
		db.prepare(activityPublicationSql).bind(account),
		db
			.prepare(
				"SELECT COUNT(*) AS count, IFNULL(MAX(fetched_at),'') AS fetched FROM refresh_catalog WHERE account_id=? AND active=1",
			)
			.bind(account),
		db.prepare("SELECT COUNT(*) AS count FROM refresh_resources WHERE account_id=?").bind(account),
		db
			.prepare(
				"SELECT kind, IFNULL(content_meta,'') AS content_meta FROM refresh_snapshots WHERE account_id=? AND kind LIKE '%:actions' ORDER BY kind",
			)
			.bind(account),
		db.prepare("SELECT COUNT(*) AS count FROM refresh_items WHERE account_id=?").bind(account),
		observationStarsStatement(db, account),
	]);
	const publicationPayload = (results[0]?.results[0] as { payload?: string } | undefined)?.payload;
	const catalog = results[1]?.results[0] as { count: number; fetched: string } | undefined;
	const resources = results[2]?.results[0] as { count: number } | undefined;
	const pages = (results[3]?.results ?? []) as { kind: string; content_meta: string }[];
	const items = results[4]?.results[0] as { count: number } | undefined;
	return JSON.stringify({
		app: APP_VERSION,
		kind: "activity",
		account,
		query: queryKey,
		publication: publicationIdentityFromPayload(publicationPayload),
		catalog: `${catalog?.count ?? 0}:${catalog?.fetched ?? ""}`,
		resources: resources?.count ?? 0,
		items: items?.count ?? 0,
		pages: pages.map((row) => `${row.kind}:${row.content_meta}`).join("|"),
		stars: starsRevision(
			results[5]?.results as { repo: string; starred: number; updated_at: string }[],
		),
	});
}
