import type {
	ActivityCommit,
	ActivityCoverage,
	ActivityIssue,
	ActivityPr,
	ActivityRepo,
	ActivityRun,
	ActivitySnapshot,
	ActivityWindow,
} from "../../lib/activity-types";
import type { FactoryRun } from "../../lib/factory-run";
import type { FactoryEvent, FactoryRepo, FactoryStreamData } from "../../lib/factory-types";
import type { ActivitySupplement } from "./activity-collect";
import type { LandedActivity } from "./activity-landed";
import { ApiError } from "./errors";

export const completeActivity = (): ActivityCoverage => ({
	status: "complete",
	truncated: false,
	reason: null,
});
export const unknownActivity = (reason: string, truncated = false): ActivityCoverage => ({
	status: "unavailable",
	truncated,
	reason,
});
export const activityBeijingDate = (at: string) =>
	new Date(Date.parse(at) + 8 * 3600_000).toISOString().slice(0, 10);
const beijingDate = activityBeijingDate;
export function requireActivityWindow(run: FactoryRun): ActivityWindow {
	if (!run.activityWindow) throw new ApiError(500, "checkpoint_invalid", "Activity window missing");
	return run.activityWindow;
}
export function isActivityRun(run: FactoryRun): boolean {
	return (
		run.mode === "refresh" &&
		run.depth === "quick" &&
		run.trigger !== "weekly" &&
		!run.selection?.repo &&
		(run.trigger === "daily" || run.selection?.scope === "all")
	);
}
export function activityWindow(
	run: FactoryRun,
	previous: FactoryRun | null,
	interrupted: boolean,
): ActivityWindow {
	const until = run.window.until;
	const since = previous?.window.until ?? new Date(Date.parse(until) - 86400_000).toISOString();
	return {
		since,
		until,
		gap:
			!previous ||
			interrupted ||
			Date.parse(beijingDate(until)) - Date.parse(beijingDate(since)) > 86400_000,
		first: !previous,
	};
}
export const isDeployWorkflow = (name: string) =>
	/(?:^|[^a-z])(?:deploy(?:ment)?|release|publish|pages)(?:[^a-z]|$)/i.test(name);
export const duringActivity = (at: string | null | undefined, window: ActivityWindow) => {
	const value = Date.parse(at ?? "");
	return value > Date.parse(window.since) && value <= Date.parse(window.until);
};
export function activityPr(event: FactoryEvent): ActivityPr {
	return {
		...event,
		merged_at: event.mergedAt,
		merged_by: event.merged_by ?? null,
		base_ref: event.base_ref ?? null,
		bot: event.bot ?? /\[bot\]$/i.test(event.author ?? ""),
		dependency:
			event.dependency ?? /^(?:dependabot|renovate)(?:\[bot\])?$/i.test(event.author ?? ""),
	};
}
function issue(event: FactoryEvent): ActivityIssue {
	return {
		...event,
		closed_by: event.closed_by ?? null,
		state_reason: event.state_reason ?? null,
		labels: event.labels ?? [],
	};
}
export function workflowRun(event: FactoryEvent, branch: string | null): ActivityRun | null {
	if (!event.activityRun) return null;
	const run = event.activityRun;
	return {
		...run,
		is_default_branch:
			!branch || !run.head_branch
				? null
				: run.head_branch === branch &&
					!["pull_request", "pull_request_target"].includes(run.event ?? ""),
	};
}
export function activityBranch(run: FactoryRun, repo: FactoryRepo): string | null {
	const expectedRepoId = run.repoIds[repo.name];
	if (expectedRepoId !== undefined && expectedRepoId !== repo.id) return null;
	return (
		run.steps.find(
			(step) => step.kind === "metadata" && step.repo === repo.name && step.status === "success",
		)?.sourceBranch ?? null
	);
}
export function activityRepo(
	repo: FactoryRepo,
	streams: Map<string, FactoryStreamData>,
	window: ActivityWindow,
	supplement: ActivitySupplement | null,
	security: Record<string, unknown> | null,
	landed?: LandedActivity,
): ActivityRepo {
	const coverage: ActivityRepo["coverage"] = {};
	const read = (stream: string): FactoryEvent[] | null => {
		const data = streams.get(stream);
		const source = data?.coverage;
		coverage[stream] =
			source?.status === "complete"
				? completeActivity()
				: {
						status:
							source?.status === "limited" || source?.status === "partial"
								? "partial"
								: "unavailable",
						truncated: source?.status === "limited" || source?.status === "partial",
						reason: source?.reason ?? "Current-run source unavailable",
					};
		if (!data || source?.status === "unavailable" || source?.status === "pending") return null;
		return data.items;
	};
	const prs = read("prs")?.map(activityPr) ?? null;
	const issues = read("issues")?.map(issue) ?? null;
	const actions = read("actions");
	const runs =
		actions?.flatMap((event) => {
			const run = workflowRun(event, repo.branch);
			return run && duringActivity(run.created_at, window) ? [run] : [];
		}) ?? null;
	if (actions?.some((event) => !event.activityRun))
		coverage.actions = unknownActivity("Workflow fields absent in source", true);
	coverage.actions_fields = runs?.some(
		(run) =>
			run.workflow_id === null ||
			run.event === null ||
			run.head_sha === null ||
			run.run_attempt === null ||
			run.actor === null,
	)
		? { status: "partial", truncated: false, reason: "Workflow field evidence unavailable" }
		: runs === null
			? unknownActivity("Workflow fields unavailable")
			: completeActivity();
	coverage.issue_fields = issues?.some(
		(issue) => issue.closedAt && (!issue.closed_by || !issue.state_reason),
	)
		? { status: "partial", truncated: false, reason: "Issue closure actor or reason unavailable" }
		: issues === null
			? unknownActivity("Issue fields unavailable")
			: completeActivity();
	coverage.default_branch =
		!repo.branch || runs === null
			? unknownActivity("Current-run workflow branch context unavailable")
			: runs.some(
						(run) =>
							run.is_default_branch === null &&
							["failure", "timed_out", "action_required", "startup_failure"].includes(
								run.conclusion ?? "",
							),
					)
				? {
						status: "partial",
						truncated: false,
						reason: "Failed workflow branch context unavailable",
					}
				: completeActivity();
	const releases =
		read("releases")?.filter(
			(event) => duringActivity(event.at, window) && event.state !== "draft",
		) ?? null;
	coverage.commits =
		landed?.coverage ?? unknownActivity("Default-branch observation ledger unavailable");
	const commits: ActivityCommit[] | null = landed?.items ?? null;
	coverage.other_commits =
		supplement?.coverage.other_commits ?? unknownActivity("Other branches not observed");
	coverage.tags =
		supplement?.coverage.tags ?? unknownActivity("Tag publication timestamps not observed");
	coverage.deploy =
		supplement?.coverage.deploy ?? unknownActivity("Last successful deployment not observed");
	const other = supplement?.commits ?? null;
	const seen = new Set(commits?.map((event) => event.sha));
	const uniqueOther = other?.filter((event) => !seen.has(event.sha)) ?? null;
	const openIssues =
		issues === null || coverage.issues?.status !== "complete"
			? null
			: {
					dependency: [] as ActivityIssue[],
					security: [] as ActivityIssue[],
					other: [] as ActivityIssue[],
				};
	for (const event of issues ?? [])
		if (event.state === "open") {
			const category = event.labels.some((label) => /security|vulnerability/i.test(label))
				? "security"
				: event.labels.some((label) => /dependenc|dependabot|renovate/i.test(label))
					? "dependency"
					: "other";
			openIssues?.[category].push(event);
		}
	const features = security?.features as Record<string, { status?: string }> | undefined;
	const alert = (feature: "dependabot" | "code_scanning") => {
		const value = security?.[`${feature}_open`];
		const known = features?.[feature]?.status === "available" && typeof value === "number";
		coverage[feature] = known
			? completeActivity()
			: unknownActivity("Security feature unavailable or incomplete");
		return known ? value : null;
	};
	for (const key of ["opened", "merged", "closed"])
		coverage[`prs.${key}`] = { ...(coverage.prs ?? unknownActivity("PR coverage unavailable")) };
	for (const key of ["opened", "closed"])
		coverage[`issues.${key}`] = {
			...(coverage.issues ?? unknownActivity("Issue coverage unavailable")),
		};
	coverage["snapshot.open_prs"] = {
		...(coverage.prs ?? unknownActivity("PR coverage unavailable")),
	};
	coverage["snapshot.open_issues"] = {
		...(coverage.issues ?? unknownActivity("Issue coverage unavailable")),
	};
	coverage.prs_fields = prs?.some(
		(pr) =>
			(pr.mergedAt && !pr.merged_by) ||
			!pr.base_ref ||
			(pr.state === "open" && (!pr.checks?.state || !pr.review)),
	)
		? {
				status: "partial",
				truncated: false,
				reason: "Nullable PR enrichment fields are unavailable or pending",
			}
		: prs === null
			? unknownActivity("PR field evidence unavailable")
			: completeActivity();
	const filtered = <T extends FactoryEvent>(
		items: T[] | null,
		field: "createdAt" | "closedAt" | "mergedAt",
	) => items?.filter((event) => duringActivity(event[field], window)) ?? null;
	const candidates = (actions ?? [])
		.map((event) => workflowRun(event, repo.branch))
		.filter((value): value is ActivityRun => value !== null);
	const last =
		[
			...candidates
				.filter(
					(value) =>
						value.conclusion === "success" &&
						isDeployWorkflow(`${value.workflow_name} ${value.path ?? ""}`),
				)
				.map((value) => value.updated_at ?? value.created_at ?? ""),
			supplement?.last_success_at ?? "",
		]
			.filter((at) => Number.isFinite(Date.parse(at)))
			.sort()
			.at(-1) ?? null;
	return {
		repo: repo.name,
		ci_runs: runs,
		prs: {
			opened: filtered(prs, "createdAt"),
			merged: filtered(prs, "mergedAt"),
			closed: filtered(prs, "closedAt"),
		},
		issues: { opened: filtered(issues, "createdAt"), closed: filtered(issues, "closedAt") },
		releases:
			releases === null
				? null
				: [
						...releases,
						...(supplement?.tags ?? []).filter(
							(tag) => !releases.some((release) => release.tag_name === tag.tag_name),
						),
					],
		commits: {
			default: coverage.commits?.status === "complete" ? (commits?.length ?? null) : null,
			other:
				coverage.other_commits?.status === "complete" && coverage.commits?.status === "complete"
					? (uniqueOther?.length ?? null)
					: null,
			items: commits === null ? null : [...commits, ...(uniqueOther ?? [])],
			deferred: landed?.deferred ?? [],
		},
		deploy: {
			last_success_at: last,
			runs:
				runs?.filter((value) => isDeployWorkflow(`${value.workflow_name} ${value.path ?? ""}`)) ??
				null,
		},
		snapshot: {
			open_prs:
				coverage.prs?.status === "complete"
					? (prs?.filter((event) => event.state === "open") ?? null)
					: null,
			open_issues: openIssues,
			dependabot: alert("dependabot"),
			code_scanning: alert("code_scanning"),
		},
		coverage,
	};
}
export function activityTotals(repos: ActivityRepo[]): ActivitySnapshot["totals"] {
	const sum = (stream: string, list: (repo: ActivityRepo) => unknown[] | null) =>
		repos.some((repo) => repo.coverage[stream]?.status !== "complete" || list(repo) === null)
			? null
			: repos.reduce((total, repo) => total + (list(repo)?.length ?? 0), 0);
	const merged = repos.flatMap((repo) => repo.prs.merged ?? []);
	const mergedTotal = sum("prs", (repo) => repo.prs.merged);
	return {
		ci_runs: sum("actions", (repo) => repo.ci_runs),
		merged_prs: mergedTotal,
		dependency_prs: mergedTotal === null ? null : merged.filter((pr) => pr.dependency).length,
		other_prs: mergedTotal === null ? null : merged.filter((pr) => !pr.dependency).length,
		issues_opened: sum("issues", (repo) => repo.issues.opened),
		issues_closed: sum("issues", (repo) => repo.issues.closed),
		releases: sum(
			"releases",
			(repo) => repo.releases?.filter((event) => event.state !== "tag") ?? null,
		),
		red_default_branch: repos.some(
			(repo) =>
				repo.ci_runs === null ||
				repo.coverage.actions?.status !== "complete" ||
				repo.coverage.default_branch?.status !== "complete" ||
				repo.ci_runs.some(
					(run) =>
						run.is_default_branch === null &&
						["failure", "timed_out", "action_required", "startup_failure"].includes(
							run.conclusion ?? "",
						),
				),
		)
			? null
			: repos.flatMap((repo) =>
					(repo.ci_runs ?? [])
						.filter(
							(run) =>
								run.is_default_branch &&
								["failure", "timed_out", "action_required", "startup_failure"].includes(
									run.conclusion ?? "",
								),
						)
						.map((run) => ({ ...run, repo: repo.repo })),
				),
	};
}
