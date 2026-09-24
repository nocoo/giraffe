import type { FactorySnapshot } from "../../lib/factory-types";
import { participates, type RepoStatistics } from "../../lib/repo-statistics";
import type { Db } from "./db/d1";
import { readSnapshot } from "./db/snapshots";
import { buildInsights, type InsightAlert } from "./insights";
import { assemblePages, splitPages } from "./snapshot-pages";

type Repo = Record<string, unknown> & RepoStatistics & { name_with_owner: string };
export async function repoPolicy(db: Db, account: string, source?: Record<string, unknown> | null) {
	const snapshot = source === undefined ? await readSnapshot(db, account, "repos") : source;
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
		repos,
		enabled(name: string, fallback: RepoStatistics = {}) {
			return (
				settings.get(name.toLowerCase()) ??
				defaults.get(name.toLowerCase()) ??
				participates(fallback)
			);
		},
	};
}
type Policy = Awaited<ReturnType<typeof repoPolicy>>;

/** Project immutable/raw snapshots at read time so settings apply immediately, even to old data. */
export async function statisticsSnapshot(
	db: Db,
	account: string,
	kind: string,
	snap: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	if (kind.startsWith("repo:")) return snap;
	const policy = await repoPolicy(db, account, kind === "repos" ? snap : undefined);
	if (kind === "repos")
		return {
			...snap,
			repos: policy.repos.map((r) => ({
				...r,
				statistics_enabled: policy.enabled(r.name_with_owner),
			})),
		};
	if (kind === "insights" && policy.repos.length) {
		const alerts = await readSnapshot(db, account, "alerts");
		const derived = {
			...buildInsights(
				policy.repos
					.filter((r) => policy.enabled(r.name_with_owner))
					.map((r) => ({
						name_with_owner: r.name_with_owner,
						open_issue_count: Number(r.open_issue_count ?? 0),
						pushed_at: typeof r.pushed_at === "string" ? r.pushed_at : null,
					})),
				Array.isArray(alerts?.items) ? (alerts.items as InsightAlert[]) : [],
				String(snap.fetched_at),
				!alerts || alerts.truncated === true || alerts.unavailable === true,
			),
			truncated: snap.truncated,
		};
		const preview = splitPages(kind, derived);
		return { ...assemblePages(kind, preview.pages), truncated: preview.truncated };
	}
	const key = (
		{
			issues: "issues",
			prs: "pull_requests",
			alerts: "items",
			insights: "insights",
			notifications: "notifications",
		} as Record<string, string>
	)[kind];
	if (!key || !Array.isArray(snap[key])) return snap;
	const items = (snap[key] as Array<Record<string, unknown>>).filter((r) =>
		policy.enabled(String(r.name_with_owner ?? "")),
	);
	return {
		...snap,
		[key]: items,
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
		.filter((r) => !policy.enabled(r.name, r))
		.map((r) => ({ name: r.name, reason: "statistics-disabled" }));
	// GitHub's account calendar has no repository breakdown, so it cannot honor this scope.
	return {
		...base,
		repos,
		inventory: {
			...snap.inventory,
			excluded: [
				...snap.inventory.excluded.filter((r) => !excluded.some((e) => e.name === r.name)),
				...excluded,
			],
		},
		contribution: null,
		contributionExcluded: true,
		contributionStatus: "unavailable",
	};
}
