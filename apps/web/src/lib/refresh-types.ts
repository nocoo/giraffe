export const REFRESH_DIMENSIONS = [
	"commits",
	"issues",
	"prs",
	"actions",
	"releases",
	"alerts",
] as const;
export type RefreshDimension = (typeof REFRESH_DIMENSIONS)[number];
export type RefreshParams = {
	since: string;
	until: string;
	timezone: string;
	dimensions: RefreshDimension[];
	force: boolean;
	repo?: string;
};
export type RefreshDay = { date: string; since: string; until: string };
export type RefreshRun = {
	id: string;
	accountId: string;
	params: RefreshParams;
	trigger: "manual" | "scheduled";
	status: "queued" | "running" | "completed" | "partial" | "failed";
	phase: "account" | "repos" | "done";
	repos: string[];
	completedRepos: number;
	requests: number;
	partial: boolean;
	errorCode: string | null;
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
};
