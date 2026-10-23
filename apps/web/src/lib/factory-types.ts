/** GitHub measurements. Null/unavailable is never an observed zero. */
export type FactoryWindow = { since: string; until: string };
export const FACTORY_STREAMS = [
	"commits",
	"issues",
	"prs",
	"actions",
	"releases",
	"alerts",
	"dependencies",
] as const;
export type FactoryStreamName = (typeof FACTORY_STREAMS)[number];
export type CoverageStatus = "pending" | "partial" | "complete" | "unavailable" | "limited";
export type UnavailableReasonCode =
	| "alerts_disabled"
	| "code_scanning_disabled"
	| "permission_denied"
	| "not_found"
	| "unknown";
export type FactoryCoverage = {
	observation?: NonNullable<FactoryRepo["observation"]> & { head: string | null };
	reason_code?: UnavailableReasonCode | "dependency_parse_unsupported";
	retained?: true;
	strategy?: "full" | "incremental" | "reused";
	sourceFetchedAt?: string | null;
	status: CoverageStatus;
	pages: number;
	fetchedAt: string | null;
	source: string;
	reason: string | null;
	observed: number;
};
export type FactoryEvent = {
	updatedAt?: string | null;
	activityRun?: Omit<import("./activity-types").ActivityRun, "is_default_branch">;
	merged_by?: string | null;
	base_ref?: string | null;
	bot?: boolean;
	dependency?: boolean;
	closed_by?: string | null;
	state_reason?: string | null;
	labels?: string[];
	tag_name?: string | null;
	body?: string;
	severity?: string | null;
	id: string;
	title: string;
	url: string;
	at: string | null;
	createdAt: string | null;
	closedAt: string | null;
	mergedAt: string | null;
	author: string | null;
	state: string;
	conclusion?: string | null;
	draft?: boolean;
	mergeable?: boolean | null;
	mergeStateStatus?: string | null;
	checks?: import("./pull-request").PrState["checks"];
	review?: string | null;
	version?: string;
	path?: string;
	job?: string;
};
export type FactoryDay = {
	commits: number;
	issueOpened: number;
	issueClosed: number;
	prOpened: number;
	prMerged: number;
	prClosed: number;
	ciSuccess: number;
	ciFailure: number;
	releases: number;
};
export type FactoryMetrics = FactoryDay & {
	ciOther: number;
	ciPending: number;
	agedPrs: number;
	agedIssues: number;
	botOpen: number;
	botMerged: number;
	alerts: number;
	cycleHours: number[];
	days: Record<string, FactoryDay>;
	authors: Record<string, number>;
};
export type FactoryDependency = { name: string; version: string; path: string; url: string };
export type FactoryRepo = {
	is_fork?: boolean;
	is_archived?: boolean;
	metadataAt?: string;
	observation?: {
		publishedAt?: string;
		metadataAt?: string;
		repo?: string;
		version: string;
		window: FactoryWindow;
		refreshedAt: string;
		source: "run" | "legacy";
	};
	id: string;
	name: string;
	url: string;
	description: string | null;
	private: boolean;
	diskKiB: number;
	pushedAt: string | null;
	language: string;
	languages: { name: string; bytes: number }[];
	languageBytes: number;
	languagesComplete: boolean;
	topics: string[];
	branch: string | null;
	head: string | null;
	totalCommits: number;
	openIssues: number;
	closedIssues: number;
	openPrs: number;
	closedPrs: number;
	mergedPrs: number;
	totalReleases: number;
	coverage: Record<FactoryStreamName, FactoryCoverage>;
	metrics: FactoryMetrics;
	dependencies: FactoryDependency[];
	manifests?: FactoryDependency[];
};
export type FactoryStreamData = {
	incremental?: {
		since: string;
		phase: "collect" | "pr_state";
		pendingPrIds: string[];
		observedIds: string[];
	};
	runId: string;
	items: FactoryEvent[];
	manifests?: FactoryDependency[];
	next: string | null;
	ranges: FactoryWindow[];
	coverage: FactoryCoverage;
};
export type FactoryRate = {
	remaining: number;
	resetAt: string | null;
	resource: string;
	observedAt?: string;
};
export type FactorySnapshot = {
	activityWindow?: import("./activity-types").ActivityWindow;
	truncated?: boolean;
	freshness?: import("./snapshot-freshness").SnapshotFreshness;
	contributionExcluded?: boolean;
	contributionObservation?: { version: string; window: FactoryWindow; fetchedAt: string };
	publication?: { mixed: boolean; runId: string; publishedAt: string };
	schema: 1;
	account_id: string;
	owner: string;
	runId: string;
	revision: number;
	leaseUntil: string | null;
	startedAt: string;
	fetched_at: string;
	window: FactoryWindow;
	status: "collecting" | "complete" | "partial";
	inventory: {
		total: number;
		scanned: number;
		complete: boolean;
		after: string | null;
		pages: number;
		excluded: { name: string; reason: string }[];
	};
	repos: FactoryRepo[];
	cursor: { repo: number; stream: number };
	requests: number;
	rate: FactoryRate | null;
	rateLimits?: Partial<Record<"core" | "graphql", FactoryRate>>;
	contribution: {
		days: {
			date: string;
			count: number;
			partial?: boolean;
			observedAt?: string;
			types?: {
				commits: number | null;
				issues: number | null;
				pullRequests: number | null;
				pullRequestReviews: number | null;
				restricted: number | null;
				repositories: number | null;
			};
			breakdown?: "complete" | "unavailable" | "mismatch";
		}[];
		total: number;
		restricted: number;
		fetchedAt: string;
		observedAt?: string;
		partial?: boolean;
		timezone?: "github";
		typeWindowTimezone?: "UTC";
		typesStatus?: "pending" | "complete" | "partial";
	} | null;
	contributionStatus: "pending" | "complete" | "unavailable";
};

export type FactorySelectedRepo = {
	name: string;
	description: string | null;
	language: string | null;
	topics: string[] | null;
};
export type FactoryViewSnapshot = FactorySnapshot & { selectedRepos: FactorySelectedRepo[] };
