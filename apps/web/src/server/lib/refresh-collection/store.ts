import type { FactoryRepo, FactorySnapshot, FactoryStreamData } from "../../../lib/factory-types";
import { savedContentMeta } from "../content-version";
import { createDb, type Db } from "../db/d1";
import { ApiError } from "../errors";
import type { CollectionContext } from "../refresh-collection-contract";
import {
	assemblePages,
	latestSnapshotGroups,
	type SnapshotPage,
	splitPages,
} from "../snapshot-pages";
import { type Catalog, type DayObservation, type Node, windowOf } from "./model";

export const collectionDb = (context: CollectionContext) =>
	createDb(context.env.DB, undefined, 600);
export function catalog(db: Db, account: string) {
	return db
		.prepare(
			"SELECT * FROM refresh_catalog WHERE account_id=? AND active=1 ORDER BY repo COLLATE NOCASE",
		)
		.bind(account)
		.all<Catalog>();
}
export async function snapshots(
	db: Db,
	account: string,
	kind: string,
	payload: Node,
	fetchedAt: string,
) {
	const { pages } = splitPages(kind, { ...payload, fetched_at: fetchedAt });
	const metadata = await savedContentMeta(kind, assemblePages(kind, pages));
	return [
		db
			.prepare("DELETE FROM refresh_snapshots WHERE account_id=? AND kind IN (?,?)")
			.bind(account, kind, `${kind}#2`),
		...pages.map((page) =>
			db
				.prepare(
					"INSERT INTO refresh_snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES(?,?,?,?,?)",
				)
				.bind(account, page.kind, page.payload, fetchedAt, metadata),
		),
	];
}
export async function savedAccountPublication(
	db: Db,
	account: string,
): Promise<FactorySnapshot | null> {
	const row = await db
		.prepare("SELECT payload FROM refresh_accounts WHERE account_id=?")
		.bind(account)
		.first<{ payload: string }>();
	if (!row) return null;
	try {
		return JSON.parse(row.payload) as FactorySnapshot;
	} catch {
		return null;
	}
}
export async function catalogRepository(
	db: Db,
	account: string,
	name: string,
): Promise<Catalog | null> {
	return db
		.prepare(
			"SELECT * FROM refresh_catalog WHERE account_id=? AND repo=? COLLATE NOCASE AND active=1",
		)
		.bind(account, name)
		.first<Catalog>();
}
export function dayStatements(
	db: Db,
	context: CollectionContext,
	id: string,
	rows: DayObservation[],
) {
	return db
		.prepare(`INSERT INTO refresh_day_observations(account_id,repo_id,timezone,day,dimension,status,payload,fetched_at)
 SELECT ?,?,?,json_extract(value,'$.day'),json_extract(value,'$.dimension'),json_extract(value,'$.status'),json_extract(value,'$.payload'),json_extract(value,'$.fetched_at') FROM json_each(?) WHERE 1
 ON CONFLICT(account_id,repo_id,timezone,day,dimension) DO UPDATE SET status=excluded.status,payload=excluded.payload,fetched_at=excluded.fetched_at`)
		.bind(context.account.id, id, context.run.params.timezone, JSON.stringify(rows));
}
export async function resourceStatement(
	db: Db,
	context: CollectionContext,
	id: string,
	stream: string,
	payload: FactoryStreamData,
) {
	return db
		.prepare(
			"INSERT INTO refresh_resources(account_id,repo_id,stream,payload,content_meta) VALUES(?,?,?,?,?) ON CONFLICT(account_id,repo_id,stream) DO UPDATE SET payload=excluded.payload,content_meta=excluded.content_meta",
		)
		.bind(
			context.account.id,
			id,
			stream,
			JSON.stringify(payload),
			await savedContentMeta(`factory:${id}:${stream}`, payload as unknown as Node),
		);
}
export async function publish(db: Db, context: CollectionContext) {
	const [saved, repositories] = await Promise.all([
		db
			.prepare("SELECT payload FROM refresh_accounts WHERE account_id=?")
			.bind(context.account.id)
			.first<{ payload: string }>(),
		db
			.prepare(
				"SELECT p.payload FROM refresh_repository_publications p JOIN refresh_catalog c ON c.account_id=p.account_id AND c.repo_id=p.repo_id AND c.active=1 WHERE p.account_id=? ORDER BY c.repo COLLATE NOCASE",
			)
			.bind(context.account.id)
			.all<{ payload: string }>(),
	]);
	if (!saved) throw new ApiError(500, "db_error", "Account observation required");
	const account = JSON.parse(saved.payload) as FactorySnapshot;
	const repos = repositories.results.map((row) => JSON.parse(row.payload) as FactoryRepo);
	const snapshot: FactorySnapshot = {
		...account,
		window: windowOf(context),
		runId: context.run.id,
		repos,
		fetched_at: context.now,
		publication: {
			mixed: repos.some((repo) => repo.observation?.version !== context.run.id),
			runId: context.run.id,
			publishedAt: context.now,
		},
		status:
			account.inventory.complete &&
			account.contributionStatus === "complete" &&
			repos.every((repo) =>
				Object.entries(repo.coverage).every(
					([stream, coverage]) =>
						stream === "dependencies" ||
						(coverage.status === "complete" && coverage.inventoryComplete !== false),
				),
			)
				? "complete"
				: "partial",
	};
	const sources = (
		await db
			.prepare(
				"SELECT s.kind,s.payload,s.content_meta FROM refresh_snapshots s JOIN refresh_catalog c ON c.account_id=s.account_id AND c.repo_id=json_extract(s.payload,'$.repo_id') AND c.active=1 WHERE s.account_id=? AND s.kind LIKE 'repo:%'",
			)
			.bind(context.account.id)
			.all<SnapshotPage>()
	).results;
	const groups = latestSnapshotGroups(sources);
	const inventory = (await catalog(db, context.account.id)).results;
	const aggregates: D1PreparedStatement[] = [];
	for (const [logical, suffix, key] of [
		["issues", "issues", "issues"],
		["prs", "prs", "pull_requests"],
		["alerts", "security", "items"],
	] as const) {
		const items: unknown[] = [];
		const times: Record<string, string | null> = {};
		let truncated = false;
		for (const repo of inventory) {
			const source = groups.get(`repo:${repo.repo}:${suffix}`.toLowerCase())?.data;
			const at =
				typeof source?.fetched_at === "string" && source.unavailable !== true
					? source.fetched_at
					: null;
			times[repo.repo] = at;
			truncated ||= at === null || source?.truncated === true;
			if (Array.isArray(source?.[key])) items.push(...source[key]);
		}
		const fetchedAt =
			Object.values(times)
				.filter((value): value is string => value !== null)
				.sort()
				.at(-1) ?? (inventory.length ? "" : context.now);
		aggregates.push(
			...(await snapshots(
				db,
				context.account.id,
				logical,
				{
					[key]: items,
					repository_fetched_at: times,
					truncated,
					unavailable:
						inventory.length > 0 && Object.values(times).every((value) => value === null),
				},
				fetchedAt,
			)),
		);
	}
	await db.batch([
		...aggregates,
		...(await snapshots(
			db,
			context.account.id,
			"factory",
			snapshot as unknown as Node,
			context.now,
		)),
		db
			.prepare(
				"INSERT INTO refresh_publications(account_id,payload,published_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET payload=excluded.payload,published_at=excluded.published_at",
			)
			.bind(context.account.id, JSON.stringify(snapshot), context.now),
	]);
}
