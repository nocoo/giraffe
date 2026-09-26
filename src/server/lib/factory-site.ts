import type { FactoryRunStep } from "../../lib/factory-run";
import { type Collected, collectKind } from "./collect";
import type { Db } from "./db/d1";
import { fenced, type RunLease } from "./db/factory-runs";
import { readSnapshot } from "./db/snapshots";
import { ApiError } from "./errors";
import { boundedJson } from "./factory-publish";
import { resourceDelta } from "./factory-retention";
import type { GithubClient } from "./github-client";
import { assertKind, prepareRefresh } from "./refresh";

export async function siteCatalog(db: Db, account: string): Promise<string[] | null> {
	return catalogNames(await readSnapshot(db, account, "repos"));
}

function catalogNames(snapshot: Record<string, unknown> | null): string[] | null {
	if (!snapshot || snapshot.truncated || !Array.isArray(snapshot.repos)) return null;
	const names = snapshot.repos.map(
		(repo: { name_with_owner?: unknown } | null) => repo?.name_with_owner,
	);
	if (!names.every((name): name is string => typeof name === "string")) return null;
	try {
		for (const name of names) assertKind(`repo:${name}:details`);
	} catch {
		return null;
	}
	return new Set(names).size === names.length ? names : null;
}

function assertComplete(payload: Collected | undefined) {
	if (payload?.forbidden || payload?.unavailable)
		throw new ApiError(403, "snapshot_unavailable", "page source unavailable");
	if (!payload || payload.truncated)
		throw new ApiError(422, "snapshot_incomplete", "page source incomplete");
}

/** One bounded page of site work. All writes commit with the run's lease and cursor. */
export async function collectSitePage(
	db: Db,
	lease: RunLease,
	step: FactoryRunStep,
	gh: GithubClient,
	token: string,
	now: string,
) {
	const resource = step.resource ?? "";
	assertKind(resource);
	const run = lease.run;
	if (
		resource === "insights" &&
		["repos", "issues"].some(
			(source) => !run.steps.some((s) => s.resource === source && s.status === "success"),
		)
	)
		throw new ApiError(409, "snapshot_sources_incomplete", "Insights sources were not updated");
	const written: Record<string, Collected> = {};
	const writes: D1PreparedStatement[] = [];
	if (["issues", "prs", "alerts"].includes(resource)) {
		const names = run.siteRepos ?? run.repos;
		const cursor = step.snapshotCursor ?? 0;
		const stream = `snapshot:${resource}`;
		const old = await db
			.prepare("SELECT payload FROM factory_resources WHERE run_id=? AND repo='' AND stream=?")
			.bind(run.id, stream)
			.first<{ payload: string }>();
		const previous: Collected = old ? JSON.parse(old.payload) : { truncated: false };
		const page = names.length
			? await collectKind(gh, token, resource, names.slice(cursor, cursor + 10), 1_500_000)
			: {
					truncated: false,
					unavailable: false,
					issues: [],
					pull_requests: [],
					items: [],
					dependabot_open: 0,
					code_scanning_open: 0,
				};
		assertComplete(page);
		const key = resource === "issues" ? "issues" : resource === "prs" ? "pull_requests" : "items";
		const payload: Collected = {
			...page,
			fetched_at: now,
			[key]: [...(Array.isArray(previous[key]) ? previous[key] : []), ...(page[key] as unknown[])],
			...(resource === "alerts"
				? {
						dependabot_open: Number(previous.dependabot_open ?? 0) + Number(page.dependabot_open),
						code_scanning_open:
							Number(previous.code_scanning_open ?? 0) + Number(page.code_scanning_open),
					}
				: {}),
		};
		// Fail explicitly rather than truncating a global list or exceeding a D1 row.
		const encoded = JSON.stringify(payload);
		if (new TextEncoder().encode(encoded).length > 1_500_000)
			throw new ApiError(422, "snapshot_incomplete", "page list exceeds bounded storage");
		step.snapshotCursor = Math.min(names.length, cursor + 10);
		if (step.snapshotCursor < names.length) {
			lease.extraBytes =
				(lease.extraBytes ?? 0) + (await resourceDelta(db, run.id, "", stream, encoded));
			writes.push(
				fenced(
					db,
					lease,
					now,
					"INSERT INTO factory_resources(run_id,repo,stream,payload) SELECT ?,?,?,? WHERE $guard ON CONFLICT(run_id,repo,stream) DO UPDATE SET payload=excluded.payload",
					[run.id, "", stream, boundedJson(payload)],
				),
			);
			return { writes, done: false };
		}
		written[resource] = payload;
	}
	const prepared = await prepareRefresh(db, run.account_id, gh, token, [resource], now, written, {
		measureBytes: true,
		deriveInsights: resource === "insights" || !run.steps.some((s) => s.resource === "insights"),
	});
	assertComplete(prepared.written[resource]);
	if (resource === "repos") {
		const names = catalogNames(prepared.written.repos ?? null);
		if (!names) throw new ApiError(422, "snapshot_incomplete", "repository names unavailable");
		if (names.length > 500)
			throw new ApiError(422, "factory_capacity", "site catalog exceeds 500 repositories");
		if (
			run.mode === "refresh" &&
			names.some((name) => !(run.siteRepos ?? run.repos).includes(name))
		)
			throw new ApiError(409, "catalog_changed", "sync catalog before refreshing new repositories");
	}
	lease.extraBytes = (lease.extraBytes ?? 0) + prepared.bytes;
	return { writes: prepared.stmts, done: true };
}
