import type { FactoryRunStep } from "../../lib/factory-run";
import { retainSecurity, type SecurityFeatures, securityIncomplete } from "../../lib/security";
import { type Collected, collectKind } from "./collect";
import type { Db } from "./db/d1";
import { fenced, type RunLease } from "./db/factory-runs";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { ApiError } from "./errors";
import { boundedJson } from "./factory-publish";
import type { GithubClient } from "./github-client";
import { githubUnavailability } from "./github-unavailable";
import { buildInsights, type InsightAlert } from "./insights";
import { assertKind, prepareRefresh } from "./refresh";
import { splitPages } from "./snapshot-pages";
import { type Policy, repoPolicy } from "./snapshot-projection";

export async function siteCatalog(db: Db, account: string): Promise<string[] | null> {
	const policy = await repoPolicy(db, account);
	return siteCatalogFromPolicy(policy);
}
export function siteCatalogFromPolicy(policy: Pick<Policy, "catalog" | "includes">) {
	const names = catalogNames(policy.catalog);
	return names?.filter(policy.includes) ?? null;
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
	if (!payload || payload.truncated)
		throw new ApiError(422, "snapshot_incomplete", "page source incomplete");
	if (payload.forbidden || payload.unavailable)
		throw new ApiError(403, "snapshot_unavailable", "page source unavailable");
}

function assertSources(steps: FactoryRunStep[], resources: string[]): void {
	const missing = resources
		.map((resource) => steps.find((step) => step.resource === resource))
		.filter((step) => step?.status !== "success");
	if (!missing.length) return;
	const unavailable = missing.every((step) => step?.status === "unavailable");
	throw new ApiError(
		unavailable ? 403 : 409,
		unavailable ? "snapshot_unavailable" : "snapshot_sources_incomplete",
		"Insights sources were not updated",
	);
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
		assertSources(
			run.steps,
			names.flatMap((repo) => ["details", "issues"].map((tab) => `repo:${repo}:${tab}`)),
		);
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
					(repo) => selected.has(repo.name_with_owner) && policy.includes(repo.name_with_owner),
				)
				.map((repo) => ({
					name_with_owner: repo.name_with_owner,
					open_issue_count: counts.get(repo.name_with_owner) ?? 0,
					pushed_at: typeof repo.pushed_at === "string" ? repo.pushed_at : null,
				})),
			Array.isArray(alerts?.items) ? (alerts.items as InsightAlert[]) : [],
			now,
			securityIncomplete(alerts),
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
		return {
			writes: await replaceSnapshotStmts(
				db,
				run.account_id,
				"insights",
				payload,
				String(previous?.fetched_at ?? now),
			),
			done: true,
		};
	}
	if (resource === "insights") assertSources(run.steps, ["repos", "issues"]);
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
			? await collectKind(gh, token, resource, names.slice(cursor, cursor + 10), 1_500_000).catch(
					(error: unknown) => {
						if (cursor > 0 && githubUnavailability(error))
							throw new ApiError(422, "snapshot_incomplete", "page collection interrupted");
						throw error;
					},
				)
			: {
					truncated: false,
					unavailable: false,
					issues: [],
					pull_requests: [],
					items: [],
					dependabot_open: 0,
					code_scanning_open: 0,
				};
		if (resource === "alerts" && page.unavailable && !page.truncated)
			return {
				writes: [],
				done: true,
				unavailable: true,
				reasonCode: String(page.reason_code ?? "unknown"),
			};
		assertComplete(page);
		const features = page.features as SecurityFeatures | undefined;
		const previousFeatures = previous.features as SecurityFeatures | undefined;
		if (features && previousFeatures) {
			for (const feature of ["dependabot", "code_scanning"] as const) {
				const old = previousFeatures[feature];
				const current = features[feature];
				if (old.status !== current.status) current.status = "partial";
				current.reason_code = old.reason_code ?? current.reason_code;
				current.reason = old.reason ?? current.reason;
			}
		}
		const alertCount = (feature: "dependabot" | "code_scanning") => {
			const count = Number(previous[`${feature}_open`] ?? 0) + Number(page[`${feature}_open`] ?? 0);
			return features?.[feature].status === "available" || count > 0 ? count : null;
		};
		const key = resource === "issues" ? "issues" : resource === "prs" ? "pull_requests" : "items";
		const payload: Collected = {
			...page,
			fetched_at: now,
			[key]: [...(Array.isArray(previous[key]) ? previous[key] : []), ...(page[key] as unknown[])],
			...(resource === "alerts"
				? {
						dependabot_open: alertCount("dependabot"),
						code_scanning_open: alertCount("code_scanning"),
					}
				: {}),
		};
		// Fail explicitly rather than truncating a global list or exceeding a D1 row.
		const encoded = JSON.stringify(payload);
		if (new TextEncoder().encode(encoded).length > 1_500_000)
			throw new ApiError(422, "snapshot_incomplete", "page list exceeds bounded storage");
		step.snapshotCursor = Math.min(names.length, cursor + 10);
		if (step.snapshotCursor < names.length) {
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
		global !== "alerts" &&
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
		};
		step.strategy = "reused";
	}
	if (suffix === "security" && !written[resource])
		written[resource] = await collectKind(gh, token, resource, [], 1_500_000);
	const security = suffix === "security" ? written[resource] : null;
	const features = security?.features as SecurityFeatures | undefined;
	const unavailableFeature =
		features && Object.values(features).find((feature) => feature.status === "unavailable");
	if (security && features && unavailableFeature && !security.truncated) {
		const previous = await readSnapshot(db, run.account_id, resource);
		const payload = {
			...security,
			retained: retainSecurity(previous, features),
			fetched_at: now,
		};
		if (splitPages(resource, payload).truncated)
			throw new ApiError(422, "snapshot_incomplete", "retained security exceeds page capacity");
		return {
			writes: await replaceSnapshotStmts(db, run.account_id, resource, payload, now),
			done: true,
			unavailable: true,
			reasonCode: unavailableFeature.reason_code ?? "unknown",
		};
	}
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
		deriveInsights: resource === "insights" || !run.steps.some((s) => s.resource === "insights"),
	});
	assertComplete(prepared.written[resource]);
	if (resource === "repos") {
		const names = catalogNames(prepared.written.repos ?? null)?.filter(
			(name) => name.split("/")[0]?.toLowerCase() === run.owner.toLowerCase(),
		);
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
				...(await replaceSnapshotStmts(
					db,
					run.account_id,
					global,
					merged,
					String(previous?.fetched_at ?? now),
				)),
			);
		}
	}
	const unavailableAlert =
		resource === "alerts" && (written.alerts?.features as SecurityFeatures | undefined);
	const alertReason =
		unavailableAlert &&
		Object.values(unavailableAlert).find((feature) => feature.status !== "available");
	return {
		writes: prepared.stmts,
		done: true,
		...(alertReason ? { unavailable: true, reasonCode: alertReason.reason_code ?? "unknown" } : {}),
	};
}

function alertCounts(items: Record<string, unknown>[]) {
	return {
		dependabot_open: items.filter((item) => item.source === "dependabot").length,
		code_scanning_open: items.filter((item) => item.source === "code_scanning").length,
	};
}
