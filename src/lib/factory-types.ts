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
export type FactoryCoverage = {
	status: CoverageStatus;
	pages: number;
	fetchedAt: string | null;
	source: string;
	reason: string | null;
	observed: number;
};
export type FactoryEvent = {
	id: string;
	title: string;
	url: string;
	at: string;
	createdAt: string;
	closedAt: string | null;
	mergedAt: string | null;
	author: string;
	state: string;
	conclusion?: string | null;
	draft?: boolean;
	review?: string | null;
	version?: string;
	path?: string;
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
export type FactoryRepo = {
	metadataAt?: string;
	observation?: {
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
	dependencies: { name: string; version: string; path: string; url: string }[];
};
export type FactoryStreamData = {
	runId: string;
	items: FactoryEvent[];
	next: string | null;
	ranges: FactoryWindow[];
	coverage: FactoryCoverage;
};
export type FactorySnapshot = {
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
	status: "collecting" | "complete";
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
	rate: { remaining: number; resetAt: string | null; resource: string } | null;
	contribution: {
		days: { date: string; count: number }[];
		total: number;
		restricted: number;
		fetchedAt: string;
	} | null;
	contributionStatus: "pending" | "complete" | "unavailable";
};
