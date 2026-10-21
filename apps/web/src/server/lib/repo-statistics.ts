import { uniqueDependencySummaries } from "../../lib/factory-dependencies";
import type { FactorySnapshot } from "../../lib/factory-types";
import { participates, type RepoStatistics } from "../../lib/repo-statistics";
import { type SecurityFeatures, securityCount, securityIncomplete } from "../../lib/security";
import { snapshotFreshness } from "../../lib/snapshot-freshness";
import { composeContent, storedContent, withContent } from "./content-version";
import type { Db } from "./db/d1";
import { readSnapshot } from "./db/snapshots";
import { buildInsights, type InsightAlert } from "./insights";
import {
	assemblePages,
	assembleSnapshotGroups,
	type SnapshotGroups,
	type SnapshotPage,
	splitPages,
} from "./snapshot-pages";
import { type SnapshotScope, snapshotSelection } from "./snapshot-scope";

type Repo = Record<string, unknown> & RepoStatistics & { name_with_owner: string };
export async function repoPolicy(
	db: Db,
	account: string,
	source?: Record<string, unknown> | null,
	scope: SnapshotScope = "all",
) {
	const snapshot = source === undefined ? await readSnapshot(db, account, "repos") : source;
	const selection = await snapshotSelection(db, account, scope);
	const overrides = await db
		.prepare("SELECT repo,enabled FROM repo_statistics WHERE account_id=?")
		.bind(account)
		.all<{ repo: string; enabled: number }>();
	return policyFromSaved(snapshot, selection, overrides.results);
}

export function policyFromSaved(
	snapshot: Record<string, unknown> | null,
	selection: Awaited<ReturnType<typeof snapshotSelection>>,
	overrides: { repo: string; enabled: number }[],
) {
	const scope = selection.scope;
	const settings = new Map(overrides.map((r) => [r.repo.toLowerCase(), r.enabled === 1]));
	const repos = (Array.isArray(snapshot?.repos) ? snapshot.repos : []).filter(
		(r): r is Repo => r !== null && typeof r === "object" && typeof r.name_with_owner === "string",
	);
	const defaults = new Map(
		repos.map((r) => [
			r.name_with_owner.toLowerCase(),
			participates({ is_fork: r.is_fork === true, is_archived: r.is_archived === true }),
		]),
	);
	const includes = (name: string) => defaults.has(name.toLowerCase()) && selection.includes(name);
	const selected = repos.filter((repo) => includes(repo.name_with_owner));
	return {
		...selection,
		includes,
		empty: scope === "starred" && selected.length === 0,
		catalog: snapshot,
		repos: selected,
		enabled(name: string) {
			return (
				includes(name) &&
				(settings.get(name.toLowerCase()) ?? defaults.get(name.toLowerCase())) === true
			);
		},
	};
}
export type Policy = Awaited<ReturnType<typeof repoPolicy>>;

const LIST_KEYS: Record<string, string> = {
	repos: "repos",
	issues: "issues",
	prs: "pull_requests",
	alerts: "items",
	insights: "insights",
	notifications: "notifications",
};

function snapshotItems(snapshot: Record<string, unknown> | null, key: string) {
	const items = snapshot?.[key];
	return Array.isArray(items)
		? items.filter(
				(item): item is Record<string, unknown> => item !== null && typeof item === "object",
			)
		: [];
}

function savedTime(value: unknown): string | null {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function complete(snapshot: Record<string, unknown> | null) {
	return (
		snapshot !== null &&
		snapshot.truncated !== true &&
		snapshot.unavailable !== true &&
		snapshot.forbidden !== true &&
		(snapshot.features === undefined || !securityIncomplete(snapshot))
	);
}

function contentInput(snapshot: Record<string, unknown> | null) {
	return snapshot ? (storedContent(snapshot)?.hash ?? null) : "missing";
}

async function repositoryPages(db: Db, account: string, suffix: string) {
	const rows = await db
		.prepare(
			"SELECT kind, payload, content_meta FROM snapshots WHERE account_id=? AND (kind LIKE ? OR kind LIKE ?)",
		)
		.bind(account, `repo:%:${suffix}`, `repo:%:${suffix}#2`)
		.all<SnapshotPage>();
	return completeRepositoryPages(assembleSnapshotGroups(rows.results), suffix);
}

function completeRepositoryPages(groups: SnapshotGroups, suffix: string) {
	const snapshots = new Map<string, Record<string, unknown>>();
	for (const [logical, snapshot] of groups) {
		const lower = logical.toLowerCase();
		if (!lower.startsWith("repo:") || !lower.endsWith(`:${suffix}`)) continue;
		if (!complete(snapshot)) continue;
		const name = logical.slice(5, -suffix.length - 1).toLowerCase();
		const previous = snapshots.get(name);
		if (
			!savedTime(previous?.fetched_at) ||
			Date.parse(String(snapshot.fetched_at)) > Date.parse(String(previous?.fetched_at))
		)
			snapshots.set(name, snapshot);
	}
	return snapshots;
}

async function projectList(
	db: Db,
	account: string,
	kind: string,
	snapshot: Record<string, unknown> | null,
	policy: Policy,
	includeDisabled = false,
	savedPages?: SnapshotGroups,
) {
	const key = LIST_KEYS[kind] as string;
	const allowed = includeDisabled ? policy.includes : policy.enabled;
	const selectedItems = (kind === "repos" ? policy.repos : snapshotItems(snapshot, key)).filter(
		(item) => allowed(String(item.name_with_owner ?? "")),
	);
	const represented = new Set<string>();
	const names = new Map(
		policy.repos
			.filter((repo) => allowed(repo.name_with_owner))
			.map((repo) => [repo.name_with_owner.toLowerCase(), repo.name_with_owner]),
	);
	for (const item of selectedItems) {
		const name = String(item.name_with_owner ?? "");
		const lower = name.toLowerCase();
		if (!names.has(lower)) names.set(lower, name);
		represented.add(lower);
	}
	const recorded = new Map(
		Object.entries((snapshot?.repository_fetched_at ?? {}) as Record<string, unknown>).map(
			([name, time]) => [name.toLowerCase(), savedTime(time)],
		),
	);
	const baselineAt = savedTime(snapshot?.fetched_at);
	const catalogAt = complete(policy.catalog) ? savedTime(policy.catalog?.fetched_at) : null;
	const catalogProven =
		(complete(snapshot) || (kind === "alerts" && snapshot?.features !== undefined)) &&
		baselineAt !== null &&
		catalogAt !== null &&
		Date.parse(catalogAt) <= Date.parse(baselineAt);
	const suffix = ({ issues: "issues", prs: "prs", alerts: "security" } as Record<string, string>)[
		kind
	];
	const pages =
		suffix && names.size
			? savedPages
				? completeRepositoryPages(savedPages, suffix)
				: await repositoryPages(db, account, suffix)
			: new Map<string, Record<string, unknown>>();
	const times = new Map<string, string | null>();
	const replacements = new Map<string, Record<string, unknown>[]>();
	const completeRepos = new Set<string>();
	const securitySources: (SecurityFeatures | undefined)[] = [];
	const contentInputs: Record<string, string | null> = {
		catalog: contentInput(policy.catalog),
		[kind]: contentInput(snapshot),
	};
	for (const [lower, name] of names) {
		let source = snapshot;
		let at =
			recorded.get(lower) ??
			(kind === "repos" ||
			(kind === "notifications" && complete(snapshot)) ||
			represented.has(lower) ||
			catalogProven
				? baselineAt
				: null);
		let covered = at !== null && complete(snapshot);
		const page = pages.get(lower);
		const pageAt = savedTime(page?.fetched_at);
		if (
			pageAt &&
			Array.isArray(page?.[key]) &&
			(!at ||
				Date.parse(pageAt) > Date.parse(at) ||
				(!covered && Date.parse(pageAt) === Date.parse(at)))
		) {
			at = pageAt;
			covered = true;
			source = page ?? null;
			contentInputs[`repo:${lower}:${suffix}`] = contentInput(page ?? null);
			replacements.set(
				lower,
				snapshotItems(page ?? null, key).map((row) => ({ ...row, name_with_owner: name })),
			);
		}
		if (covered) completeRepos.add(lower);
		if (kind === "alerts") {
			const features = at === null ? undefined : (source?.features as SecurityFeatures | undefined);
			securitySources.push(features);
		}
		times.set(lower, at);
	}
	const emitted = new Set<string>();
	const items = selectedItems.flatMap((item) => {
		const name = String(item.name_with_owner ?? "").toLowerCase();
		const replacement = replacements.get(name);
		if (!replacement) return [item];
		if (emitted.has(name)) return [];
		emitted.add(name);
		return replacement;
	});
	for (const [name, replacement] of replacements)
		if (!emitted.has(name)) items.push(...replacement);
	const features = securitySources.some(Boolean)
		? (Object.fromEntries(
				(["dependabot", "code_scanning"] as const).map((feature) => {
					const inputs = securitySources.map((source) => source?.[feature]);
					const denied = inputs.find((input) => input?.reason_code);
					return [
						feature,
						{
							status: inputs.every((input) => input?.status === "available")
								? "available"
								: inputs.every((input) => input?.status === "unavailable")
									? "unavailable"
									: "partial",
							reason_code: denied?.reason_code ?? null,
							reason: denied?.reason ?? null,
						},
					];
				}),
			) as SecurityFeatures)
		: undefined;
	return {
		features,
		items,
		times,
		freshness: snapshotFreshness([...times.values()]),
		completeRepos,
		incomplete: completeRepos.size < names.size,
		contentInputs,
		repositories: [...names.values()],
	};
}

/** Project immutable/raw snapshots at read time so settings apply immediately, even to old data. */
export async function statisticsSnapshot(
	db: Db,
	account: string,
	kind: string,
	snap: Record<string, unknown>,
	scope: SnapshotScope = "all",
): Promise<Record<string, unknown>> {
	if (kind.startsWith("repo:")) return snap;
	const policy = await repoPolicy(db, account, kind === "repos" ? snap : undefined, scope);
	return projectSnapshot(db, account, kind, snap, policy);
}

export async function projectSnapshot(
	db: Db,
	account: string,
	kind: string,
	snap: Record<string, unknown>,
	policy: Policy,
	statisticsFilter = true,
	savedPages?: SnapshotGroups,
): Promise<Record<string, unknown>> {
	if (kind.startsWith("repo:")) return snap;
	const scope = policy.scope;
	if (kind === "repos") {
		const source = await projectList(db, account, kind, snap, policy, true);
		const data = {
			...snap,
			fetched_at: source.freshness.latestAt ?? "",
			freshness: source.freshness,
			...(snap.repository_fetched_at
				? {
						repository_fetched_at: Object.fromEntries(
							[...source.times].filter(([, time]) => time !== null),
						),
					}
				: {}),
			repos: policy.repos.map((r) => ({
				...r,
				statistics_enabled: policy.enabled(r.name_with_owner),
				starred: policy.starred(r.name_with_owner),
			})),
		};
		const hash = await composeContent(source.contentInputs, {
			repositories: policy.repos.map((repo) => ({
				name: repo.name_with_owner,
				statistics_enabled: policy.enabled(repo.name_with_owner),
				starred: policy.starred(repo.name_with_owner),
			})),
			total: source.freshness.total,
			missing: source.freshness.missing,
			complete: [...source.completeRepos],
		});
		return withContent(data, hash ? { hash } : null);
	}
	if (kind === "insights") {
		const repos = await projectList(db, account, "repos", policy.catalog, policy);
		const issues = await projectList(
			db,
			account,
			"issues",
			await readSnapshot(db, account, "issues"),
			policy,
		);
		const alerts = await readSnapshot(db, account, "alerts");
		const security = await projectList(db, account, "alerts", alerts, policy);
		const names = new Map(
			repos.items.map((repo) => [
				String(repo.name_with_owner).toLowerCase(),
				String(repo.name_with_owner),
			]),
		);
		const freshness = snapshotFreshness(
			[...names.keys()].flatMap((name) => [repos.times.get(name), issues.times.get(name)]),
		);
		const issueCounts = new Map<string, number>();
		for (const issue of issues.items) {
			if (issue.state && String(issue.state).toLowerCase() !== "open") continue;
			const name = String(issue.name_with_owner).toLowerCase();
			issueCounts.set(name, (issueCounts.get(name) ?? 0) + 1);
		}
		const derived = {
			...buildInsights(
				repos.items.map((r) => ({
					name_with_owner: String(r.name_with_owner),
					open_issue_count: issues.completeRepos.has(String(r.name_with_owner).toLowerCase())
						? (issueCounts.get(String(r.name_with_owner).toLowerCase()) ?? 0)
						: Number(r.open_issue_count ?? 0),
					pushed_at: typeof r.pushed_at === "string" ? r.pushed_at : null,
				})),
				security.items.map((alert) => ({
					...alert,
					name_with_owner:
						names.get(String(alert.name_with_owner).toLowerCase()) ?? String(alert.name_with_owner),
				})) as InsightAlert[],
				freshness.latestAt ?? "",
				security.incomplete || security.freshness.missing > 0,
			),
			freshness,
			truncated:
				(scope === "all" && snap.truncated === true) || repos.incomplete || issues.incomplete,
		};
		const preview = splitPages(kind, derived);
		return { ...assemblePages(kind, preview.pages), truncated: preview.truncated };
	}
	const key = LIST_KEYS[kind];
	if (!key || !Array.isArray(snap[key])) return snap;
	const {
		items,
		freshness,
		times,
		incomplete,
		contentInputs,
		repositories,
		completeRepos,
		features,
	} = await projectList(db, account, kind, snap, policy, !statisticsFilter, savedPages);
	const alertsUnavailable = features
		? Object.values(features).every((feature) => feature.status === "unavailable")
		: incomplete && snap.unavailable === true;
	const data = {
		...snap,
		[key]: items,
		truncated: scope === "starred" && kind !== "notifications" ? incomplete : snap.truncated,
		fetched_at: kind === "notifications" ? snap.fetched_at : (freshness.latestAt ?? ""),
		freshness,
		...(snap.repository_fetched_at
			? {
					repository_fetched_at: Object.fromEntries([...times].filter(([, time]) => time !== null)),
				}
			: {}),
		...(kind === "alerts"
			? {
					features,
					unavailable: alertsUnavailable,
					reason_code: alertsUnavailable ? snap.reason_code : undefined,
					reason: alertsUnavailable ? snap.reason : undefined,
					...Object.fromEntries(
						(["dependabot", "code_scanning"] as const).map((feature) => [
							`${feature}_open`,
							securityCount(
								{
									...(features ? { features } : {}),
									unavailable: alertsUnavailable,
									truncated: incomplete || snap.truncated === true,
									dependabot_open: items.filter((item) => item.source === "dependabot").length,
									code_scanning_open: items.filter((item) => item.source === "code_scanning")
										.length,
								},
								feature,
							),
						]),
					),
				}
			: {}),
	};
	const hash = await composeContent(contentInputs, {
		repositories,
		total: freshness.total,
		missing: freshness.missing,
		complete: [...completeRepos],
		truncated: data.truncated,
	});
	return withContent(data, hash ? { hash } : null);
}

export function statisticsFactory(
	snap: FactorySnapshot,
	policy: Policy,
	statisticsFilter = true,
): FactorySnapshot {
	const repos = snap.repos
		.filter((r) => (statisticsFilter ? policy.enabled(r.name) : policy.includes(r.name)))
		.map((repo) => ({ ...repo, dependencies: uniqueDependencySummaries(repo.dependencies) }));
	const excluded = snap.repos
		.filter((r) => statisticsFilter && policy.includes(r.name) && !policy.enabled(r.name))
		.map((r) => ({ name: r.name, reason: "statistics-disabled" }));
	const projected = {
		...snap,
		repos,
		inventory: {
			...snap.inventory,
			excluded: [
				...snap.inventory.excluded.filter(
					(r) => policy.includes(r.name) && !excluded.some((e) => e.name === r.name),
				),
				...excluded,
			],
		},
	};
	if (policy.scope === "all") return projected;
	const { contributionObservation, ...base } = projected;
	void contributionObservation;
	return {
		...base,
		contribution: null,
		contributionExcluded: true,
		contributionStatus: "unavailable",
	};
}

export function factoryObserved(publication: FactorySnapshot, policy: Policy) {
	return publication.repos.filter((repo) => policy.enabled(repo.name));
}

export function factoryFreshness(snap: FactorySnapshot, policy: Policy) {
	return snapshotFreshness(
		factoryObserved(snap, policy).map((repo) => repo.observation?.refreshedAt),
	);
}
