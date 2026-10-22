import type {
	ActivityCoverage,
	ActivityPr,
	ActivityRepo,
	ActivityRun,
	ActivitySnapshot,
} from "../../apps/web/src/lib/activity-types";

export const activityAt = "2026-10-22T21:00:00.000Z";
export const activitySince = "2026-10-21T21:00:00.000Z";
export const completeActivity: ActivityCoverage = {
	status: "complete",
	truncated: false,
	reason: null,
};

export function activityPr(id = "81"): ActivityPr {
	return {
		id,
		title: "Keep current-run activity readable",
		url: `https://github.com/octocat/hello-world/pull/${id}`,
		at: activityAt,
		createdAt: activityAt,
		closedAt: activityAt,
		mergedAt: activityAt,
		author: "octocat",
		state: "merged",
		merged_at: activityAt,
		merged_by: "octocat",
		base_ref: "main",
		bot: false,
		dependency: false,
	};
}

export function activityRun(id = 101): ActivityRun {
	return {
		id,
		workflow_id: 10,
		workflow_name: "Deploy production",
		event: "push",
		head_branch: "main",
		head_sha: "abcdef",
		is_default_branch: true,
		status: "completed",
		conclusion: "failure",
		run_attempt: 1,
		created_at: activityAt,
		updated_at: activityAt,
		run_started_at: activityAt,
		duration_s: 23,
		html_url: `https://github.com/octocat/hello-world/actions/runs/${id}`,
		actor: "octocat",
		path: ".github/workflows/deploy.yml",
	};
}

export function activityRepo(): ActivityRepo {
	return {
		repo: "octocat/hello-world",
		ci_runs: [],
		prs: { opened: [], merged: [], closed: [] },
		issues: { opened: [], closed: [] },
		releases: [],
		commits: { default: 0, other: 0, items: [] },
		deploy: { last_success_at: "2026-10-20T22:00:00.000Z", runs: [] },
		snapshot: {
			open_prs: [],
			open_issues: { dependency: [], security: [], other: [] },
			dependabot: null,
			code_scanning: 0,
		},
		coverage: Object.fromEntries(
			[
				"prs",
				"prs.opened",
				"prs.merged",
				"prs.closed",
				"issues",
				"issues.opened",
				"issues.closed",
				"snapshot.open_prs",
				"snapshot.open_issues",
				"actions",
				"releases",
				"tags",
				"deploy",
				"commits",
				"other_commits",
				"code_scanning",
			].map((key) => [key, { ...completeActivity }]),
		),
	};
}

export function activityFixture(): ActivitySnapshot {
	return {
		account_id: "ui-account",
		window: { since: activitySince, until: activityAt, gap: false, first: false },
		runId: "activity-current",
		previousRunId: "activity-previous",
		fetchedAt: activityAt,
		repos: [activityRepo()],
		totals: {
			ci_runs: 0,
			merged_prs: 0,
			dependency_prs: 0,
			other_prs: 0,
			issues_opened: 0,
			issues_closed: 0,
			releases: 0,
			red_default_branch: [],
		},
		contributions: {
			timezone: "Asia/Shanghai",
			days: [
				{
					date: "2026-10-22",
					since: "2026-10-21T16:00:00.000Z",
					until: "2026-10-22T16:00:00.000Z",
					partial: false,
					count: 8,
					nativeCalendar: {
						timezone: "github",
						total: 8,
						days: [{ date: "2026-10-21", count: 8 }],
					},
					types: {
						commits: 4,
						issues: 1,
						pullRequests: 2,
						pullRequestReviews: 1,
						restricted: 0,
						repositories: 0,
					},
					coverage: completeActivity,
				},
				{
					date: "2026-10-23",
					since: "2026-10-22T16:00:00.000Z",
					until: activityAt,
					partial: true,
					count: null,
					nativeCalendar: { timezone: "github", total: null, days: [] },
					types: {
						commits: null,
						issues: null,
						pullRequests: null,
						pullRequestReviews: null,
						restricted: null,
						repositories: null,
					},
					coverage: { status: "unavailable", reason: "unknown", truncated: false },
				},
			],
		},
		coverage: { repos: { ...completeActivity }, contributions: { ...completeActivity } },
		truncated: false,
	};
}
