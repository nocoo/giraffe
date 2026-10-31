import type {
	ActivityCoverage,
	ActivityRepo,
	ActivityRun,
	ActivitySnapshot,
} from "../../lib/activity-types";
import type { FactoryEvent } from "../../lib/factory-types";
import { loadKind } from "./snapshot";

export function loadActivity(repository?: string) {
	return loadKind<ActivitySnapshot>(
		`activity?run=latest${repository ? `&repository=${encodeURIComponent(repository)}` : ""}`,
	);
}

export function activitySectionState(count: number | null, incomplete: boolean) {
	if (count === null) return "unknown";
	if (incomplete) return "partial";
	return count === 0 ? "empty" : "ready";
}

export function isActivityFailure(conclusion: string | null): boolean {
	return ["failure", "timed_out", "action_required", "startup_failure"].includes(conclusion ?? "");
}

export type ActivityRow = {
	id: string;
	repo: string;
	title: string;
	kind: string;
	at: string | null;
	author: string | null;
};
type ActivitySource = {
	coverage: string[];
	read: (repo: ActivityRepo) => ActivityRow[] | null;
};

function events(
	repo: ActivityRepo,
	items: FactoryEvent[] | null,
	kind: string,
	field: "createdAt" | "mergedAt" | "closedAt" | "at",
): ActivityRow[] | null {
	return (
		items?.map((event) => ({
			id: `${repo.repo}:${kind}:${event.id}`,
			repo: repo.repo,
			title: event.title,
			kind,
			at: event[field],
			author: event.author ?? event.merged_by ?? event.closed_by ?? null,
		})) ?? null
	);
}

function runs(repo: ActivityRepo, items: ActivityRun[] | null, defaultBranch: boolean) {
	return (
		items
			?.filter(
				(run) =>
					isActivityFailure(run.conclusion) && (!defaultBranch || run.is_default_branch === true),
			)
			.map((run) => ({
				id: `${repo.repo}:run:${run.id}`,
				repo: repo.repo,
				title: run.workflow_name,
				kind: `${run.head_branch ?? "未知分支"} · ${run.conclusion}`,
				at: run.created_at,
				author: run.actor,
			})) ?? null
	);
}

const ACTIVITY_SECTIONS: { key: string; title: string; sources: ActivitySource[] }[] = [
	{
		key: "merged",
		title: "已合并",
		sources: [
			{ coverage: ["prs.merged"], read: (repo) => events(repo, repo.prs.merged, "PR", "mergedAt") },
		],
	},
	{
		key: "opened",
		title: "新开",
		sources: [
			{
				coverage: ["prs.opened"],
				read: (repo) => events(repo, repo.prs.opened, "PR", "createdAt"),
			},
			{
				coverage: ["issues.opened"],
				read: (repo) => events(repo, repo.issues.opened, "Issue", "createdAt"),
			},
		],
	},
	{
		key: "closed",
		title: "已关闭",
		sources: [
			{ coverage: ["prs.closed"], read: (repo) => events(repo, repo.prs.closed, "PR", "closedAt") },
			{
				coverage: ["issues.closed"],
				read: (repo) => events(repo, repo.issues.closed, "Issue", "closedAt"),
			},
		],
	},
	{
		key: "releases",
		title: "发布与标签",
		sources: [
			{
				coverage: ["releases", "tags"],
				read: (repo) => events(repo, repo.releases, "Release / Tag", "at"),
			},
		],
	},
	{
		key: "ci",
		title: "默认分支红 CI",
		sources: [{ coverage: ["actions"], read: (repo) => runs(repo, repo.ci_runs, true) }],
	},
	{
		key: "deploy",
		title: "部署失败",
		sources: [{ coverage: ["actions"], read: (repo) => runs(repo, repo.deploy.runs, false) }],
	},
];

export function activitySections(snapshot: ActivitySnapshot) {
	const account = snapshot.coverage.repos;
	return ACTIVITY_SECTIONS.map(({ key, title, sources }) => {
		const rows: ActivityRow[] = [];
		const missing = new Set<string>();
		let incomplete =
			snapshot.truncated || account?.status === "partial" || account?.truncated === true;
		for (const repo of snapshot.repos) {
			if (
				key === "ci" &&
				repo.ci_runs?.some(
					(run) => run.is_default_branch === null && isActivityFailure(run.conclusion),
				)
			)
				missing.add(repo.repo);
			for (const source of sources) {
				const items = source.read(repo);
				if (items === null) missing.add(repo.repo);
				else rows.push(...items);
				for (const name of source.coverage) {
					const coverage = repo.coverage[name];
					if (!coverage || coverage.status === "unavailable") missing.add(repo.repo);
					if (coverage?.truncated || coverage?.status === "partial") incomplete = true;
				}
			}
		}
		return {
			key,
			title,
			rows,
			missingRepos: [...missing],
			state: activitySectionState(
				missing.size || !account || account.status === "unavailable" ? null : rows.length,
				incomplete,
			),
		};
	});
}

export function activityCount(value: number | null): string {
	return value === null ? "未知" : value.toLocaleString("zh-CN");
}

export function activityObservedCount(
	value: number | null,
	coverage: ActivityCoverage | undefined,
	truncated = false,
): string {
	if (value === null || !coverage || coverage.status === "unavailable") return "未知";
	return `${truncated || coverage.truncated || coverage.status === "partial" ? "≥ " : ""}${activityCount(value)}`;
}

export function activitySummary(snapshot: ActivitySnapshot) {
	const count = (value: number | null, keys: string[]) => {
		const coverage = [
			snapshot.coverage.repos,
			...snapshot.repos.flatMap((repo) => keys.map((key) => repo.coverage[key])),
		];
		if (coverage.some((source) => !source || source.status === "unavailable")) return "未知";
		return activityObservedCount(
			value,
			{
				status: "complete",
				reason: null,
				truncated: coverage.some((source) => source?.truncated || source?.status === "partial"),
			},
			snapshot.truncated,
		);
	};
	return {
		merged: count(snapshot.totals.merged_prs, ["prs.merged"]),
		dependency: count(snapshot.totals.dependency_prs, ["prs.merged"]),
		other: count(snapshot.totals.other_prs, ["prs.merged"]),
		opened: count(snapshot.totals.issues_opened, ["issues.opened"]),
		closed: count(snapshot.totals.issues_closed, ["issues.closed"]),
		releases: count(snapshot.totals.releases, ["releases", "tags"]),
	};
}
