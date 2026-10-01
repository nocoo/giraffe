import type { FactorySnapshot } from "../../lib/factory-types";
import { participates, type RepoStatistics } from "../../lib/repo-statistics";
import { snapshotFreshness } from "../../lib/snapshot-freshness";
import type { Db } from "./db/d1";
import { readSnapshot } from "./db/snapshots";
import { buildInsights, type InsightAlert } from "./insights";
import { assemblePages, type SnapshotPage, splitPages } from "./snapshot-pages";
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
	const settings = new Map(overrides.results.map((r) => [r.repo.toLowerCase(), r.enabled === 1]));
	const repos = (Array.isArray(snapshot?.repos) ? snapshot.repos : []).filter(
		(r): r is Repo => r !== null && typeof r === "object" && typeof r.name_with_owner === "string",
	);
	const defaults = new Map(
		repos.map((r) => [
			r.name_with_owner.toLowerCase(),
			participates({ is_fork: r.is_fork === true, is_archived: r.is_archived === true }),
		]),
	);
	return {
		...selection,
		catalog: snapshot,
		repos: repos.filter((repo) => selection.includes(repo.name_with_owner)),
		enabled(name: string, fallback: RepoStatistics = {}) {
			return (
				selection.includes(name) &&
				(settings.get(name.toLowerCase()) ??
					defaults.get(name.toLowerCase()) ??
					participates(fallback))
			);
		},
	};
}
type Policy = Awaited<ReturnType<typeof repoPolicy>>;

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
		snapshot.forbidden !== true
	);
}

async function repositoryPages(db: Db, account: string, suffix: string) {
	const rows = await db
		.prepare(
			"SELECT kind, payload FROM snapshots WHERE account_id=? AND (kind LIKE ? OR kind LIKE ?)",
		)
		.bind(account, `repo:%:${suffix}`, `repo:%:${suffix}#2`)
		.all<SnapshotPage>();
	const groups = new Map<string, SnapshotPage[]>();
	for (const row of rows.results) {
		const logical = row.kind.replace(/#2$/, "");
		groups.set(logical, [...(groups.get(logical) ?? []), row]);
	}
	const snapshots = new Map<string, Record<string, unknown>>();
	for (const [logical, pages] of groups) {
		const snapshot = assemblePages(logical, pages);
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
	const baselineAt = complete(snapshot) ? savedTime(snapshot?.fetched_at) : null;
	const catalogAt = complete(policy.catalog) ? savedTime(policy.catalog?.fetched_at) : null;
	const catalogProven =
		baselineAt !== null && catalogAt !== null && Date.parse(catalogAt) <= Date.parse(baselineAt);
	const suffix = ({ issues: "issues", prs: "prs", alerts: "security" } as Record<string, string>)[
		kind
	];
	const pages =
		suffix && names.size
			? await repositoryPages(db, account, suffix)
			: new Map<string, Record<string, unknown>>();
	const times = new Map<string, string | null>();
	const replacements = new Map<string, Record<string, unknown>[]>();
	for (const [lower, name] of names) {
		let at =
			recorded.get(lower) ??
			(kind === "repos" || kind === "notifications" || represented.has(lower) || catalogProven
				? baselineAt
				: null);
		const page = pages.get(lower);
		const pageAt = savedTime(page?.fetched_at);
		if (pageAt && Array.isArray(page?.[key]) && (!at || Date.parse(pageAt) > Date.parse(at))) {
			at = pageAt;
			replacements.set(
				lower,
				snapshotItems(page ?? null, key).map((row) => ({ ...row, name_with_owner: name })),
			);
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
	return { items, times, freshness: snapshotFreshness([...times.values()]) };
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
	if (kind === "repos") {
		const source = await projectList(db, account, kind, snap, policy, true);
		return {
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
					open_issue_count: issues.times.get(String(r.name_with_owner).toLowerCase())
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
				!complete(alerts) || security.freshness.missing > 0,
			),
			freshness,
			truncated: (scope === "all" && snap.truncated === true) || freshness.missing > 0,
		};
		const preview = splitPages(kind, derived);
		return { ...assemblePages(kind, preview.pages), truncated: preview.truncated };
	}
	const key = LIST_KEYS[kind];
	if (!key || !Array.isArray(snap[key])) return snap;
	const { items, freshness, times } = await projectList(db, account, kind, snap, policy);
	return {
		...snap,
		[key]: items,
		truncated:
			scope === "starred" && kind !== "notifications" ? freshness.missing > 0 : snap.truncated,
		fetched_at: kind === "notifications" ? snap.fetched_at : (freshness.latestAt ?? ""),
		freshness,
		...(snap.repository_fetched_at
			? {
					repository_fetched_at: Object.fromEntries([...times].filter(([, time]) => time !== null)),
				}
			: {}),
		...(kind === "alerts"
			? {
					dependabot_open: items.filter((r) => r.source === "dependabot").length,
					code_scanning_open: items.filter((r) => r.source === "code_scanning").length,
				}
			: {}),
	};
}

export function statisticsFactory(snap: FactorySnapshot, policy: Policy): FactorySnapshot {
	const { contributionObservation, ...base } = snap;
	void contributionObservation;
	const repos = snap.repos.filter((r) => policy.enabled(r.name, r));
	const excluded = snap.repos
		.filter((r) => policy.includes(r.name) && !policy.enabled(r.name, r))
		.map((r) => ({ name: r.name, reason: "statistics-disabled" }));
	// GitHub's account calendar has no repository breakdown, so it cannot honor this scope.
	return {
		...base,
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
		contribution: null,
		contributionExcluded: true,
		contributionStatus: "unavailable",
	};
}
