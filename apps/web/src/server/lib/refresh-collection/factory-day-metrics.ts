import type { FactoryDay, FactoryEvent } from "../../../lib/factory-types";
import type { RefreshDay } from "../../../lib/refresh-types";
import { blankDay, type DayObservation } from "./model";

const inDay = (value: string | null | undefined, since: string, until: string) =>
	value !== null &&
	value !== undefined &&
	Date.parse(value) >= Date.parse(since) &&
	Date.parse(value) < Date.parse(until);

const failureConclusions = new Set(["failure", "timed_out", "cancelled", "action_required"]);

export function accumulateActionMetrics(
	metrics: FactoryDay,
	items: FactoryEvent[],
	defaultBranch: string | null,
	options: { repoTotals?: { ciOther: number; ciPending: number } } = {},
) {
	for (const item of items) {
		const branch = item.activityRun?.head_branch ?? null;
		const onDefault = Boolean(defaultBranch && branch && branch === defaultBranch);
		if (item.conclusion === "success") metrics.ciSuccess++;
		else if (failureConclusions.has(item.conclusion ?? "")) {
			if (onDefault) metrics.ciFailure++;
		} else if (item.state === "completed") {
			if (options.repoTotals) options.repoTotals.ciOther += 1;
		} else if (options.repoTotals) options.repoTotals.ciPending += 1;
	}
}

export function accumulateIssuePrMetrics(
	metrics: FactoryDay,
	dimension: "issues" | "prs",
	items: FactoryEvent[],
	lifecycle: FactoryEvent[],
	dayBounds: RefreshDay,
) {
	for (const item of lifecycle) {
		if (dimension === "issues" && inDay(item.closedAt, dayBounds.since, dayBounds.until))
			metrics.issueClosed++;
		if (dimension === "prs" && inDay(item.mergedAt, dayBounds.since, dayBounds.until))
			metrics.prMerged++;
	}
	if (lifecycle.length === 0) {
		for (const item of items) {
			if (dimension === "issues" && inDay(item.closedAt, dayBounds.since, dayBounds.until))
				metrics.issueClosed++;
			if (dimension === "prs" && inDay(item.mergedAt, dayBounds.since, dayBounds.until))
				metrics.prMerged++;
		}
	}
	for (const item of items) {
		if (dimension === "issues") {
			if (inDay(item.createdAt, dayBounds.since, dayBounds.until)) metrics.issueOpened++;
		}
		if (dimension === "prs") {
			if (inDay(item.createdAt, dayBounds.since, dayBounds.until)) metrics.prOpened++;
			else if (inDay(item.closedAt, dayBounds.since, dayBounds.until)) metrics.prClosed++;
		}
	}
}

export function metricsFromStoredDayObservations(
	day: RefreshDay,
	current: Map<string, DayObservation>,
	defaultBranch: string | null,
): FactoryDay {
	const metrics = blankDay();
	for (const dimension of ["commits", "issues", "prs", "actions", "releases"] as const) {
		const row = current.get(`${day.date}:${dimension}`);
		if (row?.status !== "complete") continue;
		const value = JSON.parse(row.payload) as {
			count: number | null;
			items?: FactoryEvent[];
		};
		if (dimension === "commits") {
			metrics.commits = Number(value.count) || 0;
			continue;
		}
		const items = Array.isArray(value.items) ? value.items : [];
		if (dimension === "actions") accumulateActionMetrics(metrics, items, defaultBranch);
		if (dimension === "issues") accumulateIssuePrMetrics(metrics, "issues", items, [], day);
		if (dimension === "prs") accumulateIssuePrMetrics(metrics, "prs", items, [], day);
		if (dimension === "releases") metrics.releases += items.length;
	}
	return metrics;
}

export function seedOutsideWindowMetrics(
	repoDays: Record<string, FactoryDay>,
	retainedDays: RefreshDay[],
	windowDayDates: Set<string>,
	current: Map<string, DayObservation>,
	priorDays: Record<string, FactoryDay> | undefined,
	defaultBranch: string | null,
) {
	const dimensions = ["commits", "issues", "prs", "actions", "releases"] as const;
	for (const day of retainedDays) {
		if (windowDayDates.has(day.date)) continue;
		const fromCache = metricsFromStoredDayObservations(day, current, defaultBranch);
		const observed = dimensions.map((dimension) => current.get(`${day.date}:${dimension}`));
		const hasComplete = observed.some((row) => row?.status === "complete");
		const hasAnyRow = observed.some((row) => row !== undefined);
		if (hasComplete) {
			repoDays[day.date] = fromCache;
			continue;
		}
		if (!hasAnyRow) {
			if (priorDays?.[day.date]) repoDays[day.date] = { ...blankDay(), ...priorDays[day.date] };
			else delete repoDays[day.date];
			continue;
		}
		delete repoDays[day.date];
	}
}
