import type { FactoryEvent } from "./factory-types";

export type ActivityWindow = { since: string; until: string; gap: boolean; first: boolean };
export type ActivityCoverage = {
	status: "complete" | "partial" | "unavailable";
	truncated: boolean;
	reason: string | null;
};
export type ActivityRun = {
	id: number;
	workflow_id: number | null;
	workflow_name: string;
	event: string | null;
	head_branch: string | null;
	head_sha: string | null;
	is_default_branch: boolean | null;
	status: string;
	conclusion: string | null;
	run_attempt: number | null;
	created_at: string | null;
	updated_at: string | null;
	run_started_at: string | null;
	duration_s: number | null;
	html_url: string;
	actor: string | null;
	path: string | null;
};
export type ActivityPr = FactoryEvent & {
	merged_at: string | null;
	merged_by: string | null;
	base_ref: string | null;
	bot: boolean;
	dependency: boolean;
};
export type ActivityIssue = FactoryEvent & {
	closed_by: string | null;
	state_reason: string | null;
	labels: string[];
};
export type ActivityCommit = {
	sha: string;
	author: string | null;
	message: string;
	at: string | null;
	url: string;
	branch: string | null;
	is_default_branch: boolean;
	observation?: { runId: string; window: ActivityWindow; at: string; bootstrap: boolean };
};
export type DeferredActivityCommits = {
	runId: string;
	window: ActivityWindow;
	items: ActivityCommit[];
};
export type ActivityRepo = {
	repo: string;
	ci_runs: ActivityRun[] | null;
	prs: { opened: ActivityPr[] | null; merged: ActivityPr[] | null; closed: ActivityPr[] | null };
	issues: { opened: ActivityIssue[] | null; closed: ActivityIssue[] | null };
	releases: FactoryEvent[] | null;
	commits: {
		default: number | null;
		other: number | null;
		items: ActivityCommit[] | null;
		deferred?: DeferredActivityCommits[];
	};
	deploy: { last_success_at: string | null; runs: ActivityRun[] | null };
	snapshot: {
		open_prs: ActivityPr[] | null;
		open_issues: {
			dependency: ActivityIssue[];
			security: ActivityIssue[];
			other: ActivityIssue[];
		} | null;
		dependabot: number | null;
		code_scanning: number | null;
	};
	coverage: Record<string, ActivityCoverage>;
};
export type ActivityContributions = {
	timezone: "Asia/Shanghai";
	days: {
		date: string;
		since: string;
		until: string;
		partial: boolean;
		count: number | null;
		nativeCalendar?: {
			timezone: "github";
			total: number | null;
			days: { date: string; count: number }[];
		};
		types: {
			commits: number | null;
			issues: number | null;
			pullRequests: number | null;
			pullRequestReviews: number | null;
			restricted: number | null;
			repositories: number | null;
		};
		coverage: ActivityCoverage;
	}[];
};
export type ActivitySnapshot = {
	membership?: string[];
	account_id: string;
	window: ActivityWindow;
	runId: string;
	previousRunId: string | null;
	fetchedAt: string;
	repos: ActivityRepo[];
	totals: {
		ci_runs: number | null;
		merged_prs: number | null;
		dependency_prs: number | null;
		other_prs: number | null;
		issues_opened: number | null;
		issues_closed: number | null;
		releases: number | null;
		red_default_branch: (ActivityRun & { repo: string })[] | null;
	};
	contributions: ActivityContributions | null;
	coverage: Record<string, ActivityCoverage>;
	truncated: boolean;
};
