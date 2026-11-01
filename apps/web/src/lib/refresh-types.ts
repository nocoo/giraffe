import type { FactoryDay } from "./factory-types";

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
	lookbackDays?: number;
};
export type RefreshDay = { date: string; since: string; until: string };
export type RefreshRequestBreakdown = {
	total: number;
	graphql: number;
	rest: number;
	a: { graphql: number; rest: number };
	b: { graphql: number; rest: number };
};
export type RefreshFailureDetail = {
	dimension: string | null;
	code: string;
	httpStatus: number | null;
	graphqlType: string | null;
	graphqlPath: string[] | null;
};
export type RefreshPartialReason = {
	repo: string | null;
	codes: string[];
	failures?: RefreshFailureDetail[];
};
export type RefreshMetricGuardEvent = {
	code: "zero_guard_kept";
	repo: string;
	day: string;
	field: keyof FactoryDay;
};
export type RefreshActionsObservationAudit = {
	repo: string;
	outsideWindowDays: number;
	missingObservationDays: number;
	missingBranchDays: number;
};
export type RefreshStepTiming = {
	startedAt: string;
	finishedAt: string | null;
	attempts: number;
};
export type RefreshRunTimings = {
	queuedAt: string;
	a: (RefreshStepTiming & { reused: boolean }) | null;
	repos: (RefreshStepTiming & { repo: string })[];
};
export type RefreshRun = {
	id: string;
	accountId: string;
	params: RefreshParams;
	trigger: "manual" | "scheduled";
	status: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
	phase: "account" | "repos" | "done";
	repos: string[];
	completedRepos: number;
	requests: number;
	requestBreakdown: RefreshRequestBreakdown;
	partialReasons: RefreshPartialReason[];
	metricGuardEvents?: RefreshMetricGuardEvent[];
	actionsObservationAudit?: RefreshActionsObservationAudit[];
	partial: boolean;
	aReused?: boolean;
	cancelRequested: boolean;
	errorCode: string | null;
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
	timings?: RefreshRunTimings;
};
