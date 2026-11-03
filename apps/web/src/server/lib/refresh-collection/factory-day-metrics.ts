import type { FactoryDay, FactoryEvent } from "../../../lib/factory-types";
import type { RefreshDay } from "../../../lib/refresh-types";
import { actionsDayMissingBranch, refreshDayBounds } from "./history";
import { blankDay, type DayObservation } from "./model";

const inDay = (value: string | null | undefined, since: string, until: string) =>
	value !== null &&
	value !== undefined &&
	Date.parse(value) >= Date.parse(since) &&
	Date.parse(value) < Date.parse(until);

function dayActionItems(items: FactoryEvent[], since: string, until: string) {
	return items.filter((item) =>
		[item.at, item.createdAt, item.closedAt, item.mergedAt].some((at) => inDay(at, since, until)),
	);
}

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
		if (item.conclusion === "success") {
			if (onDefault) metrics.ciSuccess++;
		} else if (failureConclusions.has(item.conclusion ?? "")) {
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

export function canVerifyDefaultBranchCiActions(actionsRow: DayObservation | undefined): boolean {
	if (actionsRow?.status !== "complete" || actionsDayMissingBranch(actionsRow)) return false;
	const payload = JSON.parse(actionsRow.payload) as { items?: unknown };
	return Array.isArray(payload.items) && payload.items.length > 0;
}

/** @deprecated Use {@link canVerifyDefaultBranchCiActions}. */
export const canVerifyDefaultBranchCiFailures = canVerifyDefaultBranchCiActions;

export function recomputeDefaultBranchCiFromActionsRow(
	bounds: RefreshDay,
	actionsRow: DayObservation | undefined,
	defaultBranch: string | null,
): Pick<FactoryDay, "ciSuccess" | "ciFailure"> {
	const empty = { ciSuccess: 0, ciFailure: 0 };
	if (!actionsRow || !canVerifyDefaultBranchCiActions(actionsRow)) return empty;
	const payload = JSON.parse(actionsRow.payload) as { items?: FactoryEvent[] };
	const items = Array.isArray(payload.items) ? payload.items : [];
	const scoped = dayActionItems(items, bounds.since, bounds.until);
	const metrics = blankDay();
	accumulateActionMetrics(metrics, scoped, defaultBranch);
	return { ciSuccess: metrics.ciSuccess, ciFailure: metrics.ciFailure };
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
		if (dimension === "actions") {
			const ci = recomputeDefaultBranchCiFromActionsRow(day, row, defaultBranch);
			metrics.ciSuccess = ci.ciSuccess;
			metrics.ciFailure = ci.ciFailure;
			continue;
		}
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
		const bounds = refreshDayBounds(day.date, timezone, current, day);
		const actionsRow = current.get(`${day.date}:actions`);
		const observed = dimensions.map((dimension) => current.get(`${day.date}:${dimension}`));
		const hasAnyObservation = observed.some((row) => row !== undefined);
		const hasPartial = observed.some((row) => row && row.status !== "complete");
		if (!hasAnyObservation || hasPartial) {
			if (priorDays?.[day.date]) repoDays[day.date] = { ...blankDay(), ...priorDays[day.date] };
			else delete repoDays[day.date];
			continue;
		}
		const priorDay = priorDays?.[day.date];
		const fromCache = metricsFromStoredDayObservations(bounds, current, defaultBranch, timezone);
		const merged: FactoryDay = { ...fromCache };
		if (priorDay) {
			if (!current.get(`${day.date}:commits`)) merged.commits = priorDay.commits;
			if (!current.get(`${day.date}:issues`)) {
				merged.issueOpened = priorDay.issueOpened;
				merged.issueClosed = priorDay.issueClosed;
			}
			if (!current.get(`${day.date}:prs`)) {
				merged.prOpened = priorDay.prOpened;
				merged.prMerged = priorDay.prMerged;
				merged.prClosed = priorDay.prClosed;
			}
			if (!current.get(`${day.date}:releases`)) merged.releases = priorDay.releases;
		}
		if (actionsRow?.status === "complete") {
			if (canVerifyDefaultBranchCiActions(actionsRow)) {
				const ci = recomputeDefaultBranchCiFromActionsRow(bounds, actionsRow, defaultBranch);
				merged.ciSuccess = ci.ciSuccess;
				merged.ciFailure = ci.ciFailure;
			} else if (priorDay) {
				merged.ciSuccess = priorDay.ciSuccess;
				merged.ciFailure = priorDay.ciFailure;
			}
		} else if (priorDay) {
			merged.ciSuccess = priorDay.ciSuccess;
			merged.ciFailure = priorDay.ciFailure;
		}
		repoDays[day.date] = merged;
	}
}
