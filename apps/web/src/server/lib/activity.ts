import type { ActivityCoverage, ActivityRepo, ActivitySnapshot } from "../../lib/activity-types";

export const unknownActivity = (reason: string, truncated = false): ActivityCoverage => ({
	status: "unavailable",
	truncated,
	reason,
});

export function activityTotals(repos: ActivityRepo[]): ActivitySnapshot["totals"] {
	const sum = (stream: string, list: (repo: ActivityRepo) => unknown[] | null) =>
		repos.some((repo) => repo.coverage[stream]?.status !== "complete" || list(repo) === null)
			? null
			: repos.reduce((total, repo) => total + (list(repo)?.length ?? 0), 0);
	const merged = repos.flatMap((repo) => repo.prs.merged ?? []);
	const mergedTotal = sum("prs", (repo) => repo.prs.merged);
	const classified = repos.every(
		(repo) =>
			!repo.coverage.pr_classification || repo.coverage.pr_classification.status === "complete",
	);
	return {
		ci_runs: sum("actions", (repo) => repo.ci_runs),
		merged_prs: mergedTotal,
		dependency_prs:
			mergedTotal === null || !classified ? null : merged.filter((pr) => pr.dependency).length,
		other_prs:
			mergedTotal === null || !classified ? null : merged.filter((pr) => !pr.dependency).length,
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
