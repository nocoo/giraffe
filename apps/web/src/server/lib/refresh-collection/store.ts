import {
	FACTORY_STREAMS,
	type FactoryRepo,
	type FactorySnapshot,
	type FactoryStreamData,
} from "../../../lib/factory-types";
import { envMode } from "../../env";
import { savedContentMeta } from "../content-version";
import { warmDashboardResponsesAfterPublishSafely } from "../dashboard-warm";
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
	const maxBytes = 1_500_000;
	const encoder = new TextEncoder();
	const batches: string[] = [];
	let current: string[] = [];
	let bytes = 2;
	for (const row of rows) {
		const encoded = JSON.stringify(row);
		const size = encoder.encode(encoded).length;
		if (size + 2 > maxBytes)
			throw new ApiError(500, "db_error", "day observation exceeds write capacity");
		if (bytes + size + (current.length ? 1 : 0) > maxBytes) {
			batches.push(`[${current.join(",")}]`);
			current = [];
			bytes = 2;
		}
		bytes += size + (current.length ? 1 : 0);
		current.push(encoded);
	}
	if (current.length) batches.push(`[${current.join(",")}]`);
	return batches.map((batch) =>
		db
			.prepare(`INSERT INTO refresh_day_observations(account_id,repo_id,timezone,day,dimension,status,payload,fetched_at)
 SELECT ?,?,?,json_extract(value,'$.day'),json_extract(value,'$.dimension'),json_extract(value,'$.status'),json_extract(value,'$.payload'),json_extract(value,'$.fetched_at') FROM json_each(?) WHERE 1
 ON CONFLICT(account_id,repo_id,timezone,day,dimension) DO UPDATE SET status=excluded.status,payload=excluded.payload,fetched_at=excluded.fetched_at`)
			.bind(context.account.id, id, context.run.params.timezone, batch),
	);
}
export async function resourceStatement(
	db: Db,
	context: CollectionContext,
	id: string,
	stream: string,
	payload: FactoryStreamData,
) {
	if (new TextEncoder().encode(JSON.stringify(payload)).length > 1_500_000) {
		const limited = {
			...payload,
			ranges: [],
			coverage: {
				...payload.coverage,
				status: "limited" as const,
				reason: "storage_limit",
				completeWindows: [],
				...(payload.coverage.availableWindows === undefined ? {} : { availableWindows: [] }),
				...(payload.coverage.inventoryComplete === undefined ? {} : { inventoryComplete: false }),
			},
		};
		const first = splitPages("resource", limited).pages[0];
		if (!first) throw new ApiError(500, "db_error", "resource page required");
		payload = {
			...limited,
			items: (JSON.parse(first.payload) as { items?: FactoryStreamData["items"] }).items ?? [],
		};
	}
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

export function shouldReplacePublishedFactorySnapshot(
	prior: FactorySnapshot | null,
	next: FactorySnapshot,
): boolean {
	if (!prior) return true;
	if (next.status === "complete") return true;
	if (prior.status === "partial") return true;
	const priorIds = new Set((prior.repos ?? []).map((repo) => repo.id));
	const nextIds = new Set((next.repos ?? []).map((repo) => repo.id));
	if (priorIds.size !== nextIds.size || [...nextIds].some((id) => !priorIds.has(id))) return true;
	return false;
}

export async function publish(
	db: Db,
	context: CollectionContext,
	pending: D1PreparedStatement[] = [],
	options: { updateFactorySnapshot?: boolean } = {},
) {
	const updateFactorySnapshot = options.updateFactorySnapshot !== false;
	const id = context.account.id;
	let priorFactory: FactorySnapshot | null = null;
	if (updateFactorySnapshot) {
		const priorFactoryRow = await db
			.prepare("SELECT payload FROM refresh_snapshots WHERE account_id=? AND kind='factory'")
			.bind(id)
			.first<{ payload: string }>();
		priorFactory = priorFactoryRow
			? (JSON.parse(priorFactoryRow.payload) as FactorySnapshot)
			: null;
	}
	const [saved, sourceRows, catalogRows] = (
		await db.batch([
			...pending,
			db.prepare("SELECT payload FROM refresh_accounts WHERE account_id=?").bind(id),
			db
				.prepare(
					"SELECT s.kind,s.payload,s.content_meta FROM refresh_snapshots s JOIN refresh_catalog c ON c.account_id=s.account_id AND c.repo_id=json_extract(s.payload,'$.repo_id') AND c.active=1 WHERE s.account_id=? AND s.kind LIKE 'repo:%'",
				)
				.bind(id),
			db
				.prepare(
					"SELECT c.repo,p.payload AS publication FROM refresh_catalog c LEFT JOIN refresh_repository_publications p ON p.account_id=c.account_id AND p.repo_id=c.repo_id WHERE c.account_id=? AND c.active=1 ORDER BY c.repo COLLATE NOCASE",
				)
				.bind(id),
		])
	).slice(-3) as [
		D1Result<{ payload: string }>,
		D1Result<SnapshotPage>,
		D1Result<{ repo: string; publication: string | null }>,
	];
	const row = saved.results[0];
	if (!row) throw new ApiError(500, "db_error", "Account observation required");
	if (!updateFactorySnapshot) return;
	const account = JSON.parse(row.payload) as FactorySnapshot;
	const retainedContribution =
		account.contribution ??
		(priorFactory?.contribution?.days?.length ? priorFactory.contribution : null);
	const retainedContributionObservation =
		account.contributionObservation ??
		(retainedContribution ? priorFactory?.contributionObservation : null);
	const retainedContributionStatus =
		account.contributionStatus === "complete"
			? "complete"
			: retainedContribution
				? (priorFactory?.contributionStatus ?? account.contributionStatus ?? "complete")
				: account.contributionStatus;
	const inventory = catalogRows.results;
	const repos = inventory.flatMap((entry) =>
		entry.publication === null ? [] : [JSON.parse(entry.publication) as FactoryRepo],
	);
	const snapshot: FactorySnapshot = {
		...account,
		contribution: retainedContribution,
		contributionStatus: retainedContributionStatus,
		...(retainedContributionObservation
			? { contributionObservation: retainedContributionObservation }
			: account.contributionObservation
				? { contributionObservation: account.contributionObservation }
				: {}),
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
			repos.length > 0 &&
			account.inventory.complete &&
			retainedContributionStatus === "complete" &&
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
	if (!shouldReplacePublishedFactorySnapshot(priorFactory, snapshot)) return;
	const groups = latestSnapshotGroups(sourceRows.results);
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
			.bind(
				context.account.id,
				JSON.stringify({
					rate: snapshot.rate,
					repos: repos.map((repo) => ({
						id: repo.id,
						name: repo.name,
						coverage: Object.fromEntries(
							FACTORY_STREAMS.map((stream) => [
								stream,
								{ retained: repo.coverage[stream].retained === true },
							]),
						),
					})),
				}),
				context.now,
			),
	]);
	if (envMode(context.env.ENVIRONMENT) !== "test") {
		await warmDashboardResponsesAfterPublishSafely(
			createDb(context.env.DB, undefined, 10_000),
			context.account.id,
		);
	}
}
