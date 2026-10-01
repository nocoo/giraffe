import type { FactoryRunStep } from "../../lib/factory-run";
import { type Collected, collectKind } from "./collect";
import type { Db } from "./db/d1";
import { fenced, type RunLease } from "./db/factory-runs";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { ApiError } from "./errors";
import { boundedJson } from "./factory-publish";
import { resourceDelta } from "./factory-retention";
import type { GithubClient } from "./github-client";
import { buildInsights, type InsightAlert } from "./insights";
import { assertKind, prepareRefresh } from "./refresh";
import { repoPolicy } from "./repo-statistics";

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

function assertComplete(payload: Collected | null | undefined): asserts payload is Collected {
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
	const scoped = run.selection?.scope !== "all";
	if (resource === "insights" && scoped) {
		const names = run.siteRepos ?? run.repos;
		if (
			names.some((repo) =>
				["details", "issues"].some(
					(tab) =>
						!run.steps.some((s) => s.resource === `repo:${repo}:${tab}` && s.status === "success"),
				),
			)
		)
			throw new ApiError(409, "snapshot_sources_incomplete", "Insights sources were not updated");
		const policy = await repoPolicy(db, run.account_id);
		const catalog = await siteCatalog(db, run.account_id);
		if (!catalog || names.some((name) => !catalog.includes(name)))
			throw new ApiError(409, "snapshot_sources_incomplete", "selected catalogue sources missing");
		const alerts = await readSnapshot(db, run.account_id, "alerts");
		const issues = await readSnapshot(db, run.account_id, "issues");
		if (!Array.isArray(issues?.issues))
			throw new ApiError(409, "snapshot_sources_incomplete", "selected Issues sources missing");
		const counts = new Map<string, number>();
		for (const row of issues.issues as { name_with_owner: string }[])
			counts.set(row.name_with_owner, (counts.get(row.name_with_owner) ?? 0) + 1);
		const previous = await readSnapshot(db, run.account_id, "insights");
		const selected = new Set(names);
		const fresh = buildInsights(
			policy.repos
				.filter(
					(repo) => selected.has(repo.name_with_owner) && policy.enabled(repo.name_with_owner),
				)
				.map((repo) => ({
					name_with_owner: repo.name_with_owner,
					open_issue_count: counts.get(repo.name_with_owner) ?? 0,
					pushed_at: typeof repo.pushed_at === "string" ? repo.pushed_at : null,
				})),
			Array.isArray(alerts?.items) ? (alerts.items as InsightAlert[]) : [],
			now,
			!alerts || alerts.truncated === true || alerts.unavailable === true,
		);
		const old = Array.isArray(previous?.insights)
			? (previous.insights as { name_with_owner: string }[])
			: [];
		const payload = {
			...fresh,
			fetched_at: String(previous?.fetched_at ?? now),
			insights: [...old.filter((repo) => !selected.has(repo.name_with_owner)), ...fresh.insights],
			truncated: previous?.truncated ?? true,
			repository_fetched_at: {
				...(previous?.repository_fetched_at as Record<string, string>),
				...Object.fromEntries(names.map((repo) => [repo, now])),
			},
		};
		const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
		if (bytes > 1_500_000)
			throw new ApiError(422, "snapshot_incomplete", "Insights exceed bounded storage");
		lease.extraBytes =
			(lease.extraBytes ?? 0) +
			bytes -
			(previous ? new TextEncoder().encode(JSON.stringify(previous)).length : 0);
		return {
			writes: replaceSnapshotStmts(
				db,
				run.account_id,
				"insights",
				payload,
				String(previous?.fetched_at ?? now),
			),
			done: true,
		};
	}
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
	const suffix = step.repo ? resource.split(":").at(-1) : null;
	const global =
		suffix === "issues"
			? "issues"
			: suffix === "prs"
				? "prs"
				: suffix === "security"
					? "alerts"
					: suffix === "details"
						? "repos"
						: null;
	const key =
		global === "issues"
			? "issues"
			: global === "prs"
				? "pull_requests"
				: global === "alerts"
					? "items"
					: "repos";
	if (
		step.repo &&
		global &&
		global !== "repos" &&
		run.steps.some((s) => s.resource === global && s.status === "success")
	) {
		const source = (await readSnapshot(db, run.account_id, global)) as Collected | null;
		assertComplete(source);
		const items = (source[key] as Record<string, unknown>[]).filter(
			(item) => item.name_with_owner === step.repo,
		);
		written[resource] = {
			truncated: false,
			[key]: items,
			...(global === "alerts" ? alertCounts(items) : {}),
		};
		step.strategy = "reused";
	}
	if (suffix === "security" && !written[resource])
		written[resource] = await collectKind(gh, token, "alerts", [String(step.repo)], 1_500_000);
	const metadata = run.steps.find(
		(s) => s.kind === "metadata" && s.repo === step.repo && s.status === "success",
	);
	if (["languages", "contributors"].includes(suffix ?? "") && metadata?.sourceHead !== undefined) {
		const source = (await readSnapshot(db, run.account_id, resource)) as Collected | null;
		if (
			run.depth === "quick" &&
			source &&
			!source.truncated &&
			!source.unavailable &&
			source.source_head === metadata.sourceHead
		) {
			written[resource] = {
				...source,
				source_fetched_at: source.source_fetched_at ?? source.fetched_at,
			};
			step.strategy = "reused";
		} else written[resource] = await collectKind(gh, token, resource, [], 1_500_000);
		written[resource].source_head = metadata.sourceHead;
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
			!scoped &&
			names.some((name) => !(run.siteRepos ?? run.repos).includes(name))
		)
			throw new ApiError(409, "catalog_changed", "sync catalog before refreshing new repositories");
	}
	if (step.repo && global && run.selection?.scope !== "all") {
		const previous = (await readSnapshot(db, run.account_id, global)) as Collected | null;
		if ((previous && Array.isArray(previous[key])) || global !== "repos") {
			const payload = prepared.written[resource] as Collected;
			const oldItems = (previous?.[key] ?? []) as Record<string, unknown>[];
			const fresh =
				global === "repos"
					? oldItems
							.filter((item) => item.name_with_owner === step.repo)
							.map((item) => ({
								...item,
								...Object.fromEntries(
									Object.entries(payload).filter(
										([field]) => !["fetched_at", "truncated", "account_id"].includes(field),
									),
								),
							}))
					: (payload[key] as Record<string, unknown>[]);
			const items = [...oldItems.filter((item) => item.name_with_owner !== step.repo), ...fresh];
			const merged = {
				...previous,
				fetched_at: String(previous?.fetched_at ?? now),
				truncated: previous?.truncated ?? true,
				[key]: items,
				repository_fetched_at: {
					...(previous?.repository_fetched_at as Record<string, string>),
					[step.repo]: now,
				},
				...(global === "alerts" ? alertCounts(items) : {}),
			};
			if (new TextEncoder().encode(JSON.stringify(merged)).length > 1_500_000)
				throw new ApiError(422, "snapshot_incomplete", "global list exceeds bounded storage");
			prepared.stmts.push(
				...replaceSnapshotStmts(
					db,
					run.account_id,
					global,
					merged,
					String(previous?.fetched_at ?? now),
				),
			);
			prepared.bytes +=
				new TextEncoder().encode(JSON.stringify(merged)).length -
				(previous ? new TextEncoder().encode(JSON.stringify(previous)).length : 0);
		}
	}
	lease.extraBytes = (lease.extraBytes ?? 0) + prepared.bytes;
	return { writes: prepared.stmts, done: true };
}

function alertCounts(items: Record<string, unknown>[]) {
	return {
		dependabot_open: items.filter((item) => item.source === "dependabot").length,
		code_scanning_open: items.filter((item) => item.source === "code_scanning").length,
	};
}
