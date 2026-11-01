import type { FactoryDay, FactoryEvent } from "../../../lib/factory-types";
import type { RefreshDay } from "../../../lib/refresh-types";
import { actionsDayMissingBranch } from "./history";
import { blankDay, type DayObservation } from "./model";

const inDay = (value: string | null | undefined, since: string, until: string) =>
	value !== null &&
	value !== undefined &&
	Date.parse(value) >= Date.parse(since) &&
	Date.parse(value) < Date.parse(until);

const failureConclusions = new Set(["failure", "timed_out", "cancelled", "action_required"]);

const calendarDate = (value: string, timezone: string) =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(value));

export function accumulateActionMetrics(
	metrics: FactoryDay,
	items: FactoryEvent[],
	defaultBranch: string | null,
	options: { repoTotals?: { ciOther: number; ciPending: number } } = {},
) {
	const seen = new Set<string>();
	for (const item of items) {
		if (seen.has(item.id)) continue;
		seen.add(item.id);
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
	timezone: string,
) {
	const opened = new Set<string>();
	const openedOnDay = (item: FactoryEvent) => {
		if (!item.createdAt) return false;
		return calendarDate(item.createdAt, timezone) === dayBounds.date;
	};
	const countOpened = (item: FactoryEvent) => {
		if (opened.has(item.id)) return;
		if (dimension === "issues" && openedOnDay(item)) {
			opened.add(item.id);
			metrics.issueOpened++;
		}
		if (dimension === "prs" && openedOnDay(item)) {
			opened.add(item.id);
			metrics.prOpened++;
		}
	};
	for (const item of lifecycle) {
		if (dimension === "issues" && inDay(item.closedAt, dayBounds.since, dayBounds.until))
			metrics.issueClosed++;
		if (dimension === "prs" && inDay(item.mergedAt, dayBounds.since, dayBounds.until))
			metrics.prMerged++;
		countOpened(item);
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
		countOpened(item);
		if (dimension === "prs") {
			if (
				inDay(item.closedAt, dayBounds.since, dayBounds.until) &&
				!inDay(item.mergedAt, dayBounds.since, dayBounds.until)
			)
				metrics.prClosed++;
		}
	}
	for (const item of lifecycle) {
		if (
			dimension === "prs" &&
			inDay(item.closedAt, dayBounds.since, dayBounds.until) &&
			!inDay(item.mergedAt, dayBounds.since, dayBounds.until)
		)
			metrics.prClosed++;
	}
}

export function canVerifyDefaultBranchCiFailures(actionsRow: DayObservation | undefined): boolean {
	return actionsRow?.status === "complete" && !actionsDayMissingBranch(actionsRow);
}

export function metricsFromStoredDayObservations(
	day: RefreshDay,
	current: Map<string, DayObservation>,
	defaultBranch: string | null,
	timezone: string,
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
		if (dimension === "issues")
			accumulateIssuePrMetrics(metrics, "issues", items, [], day, timezone);
		if (dimension === "prs") accumulateIssuePrMetrics(metrics, "prs", items, [], day, timezone);
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
	timezone: string,
) {
	const dimensions = ["commits", "issues", "prs", "actions", "releases"] as const;
	for (const day of retainedDays) {
		if (windowDayDates.has(day.date)) continue;
		const actionsRow = current.get(`${day.date}:actions`);
		const fromCache = metricsFromStoredDayObservations(day, current, defaultBranch, timezone);
		const observed = dimensions.map((dimension) => current.get(`${day.date}:${dimension}`));
		const hasComplete = observed.some((row) => row?.status === "complete");
		const hasAnyRow = observed.some((row) => row !== undefined);
		if (hasComplete) {
			const merged = { ...fromCache };
			const priorDay = priorDays?.[day.date];
			if (!canVerifyDefaultBranchCiFailures(actionsRow) && priorDay) {
				merged.ciSuccess = priorDay.ciSuccess;
				merged.ciFailure = priorDay.ciFailure;
			}
			repoDays[day.date] = merged;
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
