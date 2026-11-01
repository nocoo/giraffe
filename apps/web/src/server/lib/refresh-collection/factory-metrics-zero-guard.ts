import type { FactoryDay } from "../../../lib/factory-types";
import type { RefreshMetricGuardEvent } from "../../../lib/refresh-types";
import type { Env } from "../../env";
import { blankDay } from "./model";

/** Temporary safety net; set FACTORY_DAY_METRICS_ZERO_GUARD=0 to disable. */
export const FACTORY_DAY_METRICS_ZERO_GUARD_ENV = "FACTORY_DAY_METRICS_ZERO_GUARD";

export function factoryDayMetricsZeroGuardEnabled(env: Env): boolean {
	const raw = (env as unknown as Record<string, unknown>)[FACTORY_DAY_METRICS_ZERO_GUARD_ENV];
	if (raw === undefined || raw === "") return true;
	return raw !== "0" && raw !== "false";
}

export const FACTORY_DAY_METRIC_FIELDS = [
	"commits",
	"issueOpened",
	"issueClosed",
	"prOpened",
	"prMerged",
	"prClosed",
	"ciSuccess",
	"ciFailure",
	"releases",
] as const satisfies readonly (keyof FactoryDay)[];

/** Metrics protected when a refresh would accidentally zero a field (semantic narrowing exempt). */
export const FACTORY_DAY_METRICS_ZERO_GUARD_FIELDS = [
	"commits",
	"issueOpened",
	"issueClosed",
	"prOpened",
	"prMerged",
	"releases",
] as const satisfies readonly (keyof FactoryDay)[];

const populated = (day: FactoryDay) =>
	FACTORY_DAY_METRICS_ZERO_GUARD_FIELDS.some((field) => day[field] !== 0);

export function guardFactoryDayMetrics(
	priorDays: Record<string, FactoryDay> | undefined,
	nextDays: Record<string, FactoryDay>,
	repo: string,
	actionsVerified: (day: string) => boolean = () => true,
): { days: Record<string, FactoryDay>; warnings: RefreshMetricGuardEvent[] } {
	const warnings: RefreshMetricGuardEvent[] = [];
	if (!priorDays) return { days: nextDays, warnings };
	const days: Record<string, FactoryDay> = { ...nextDays };
	for (const [date, priorDay] of Object.entries(priorDays)) {
		if (!(date in nextDays) && populated(priorDay)) {
			days[date] = { ...priorDay };
			for (const field of FACTORY_DAY_METRICS_ZERO_GUARD_FIELDS) {
				if (priorDay[field] !== 0)
					warnings.push({ code: "zero_guard_kept", repo, day: date, field });
			}
			continue;
		}
		const proposed = days[date] ?? blankDay();
		const merged: FactoryDay = { ...proposed };
		let kept = false;
		for (const field of FACTORY_DAY_METRICS_ZERO_GUARD_FIELDS) {
			if (priorDay[field] !== 0 && proposed[field] === 0) {
				merged[field] = priorDay[field];
				warnings.push({ code: "zero_guard_kept", repo, day: date, field });
				kept = true;
			}
		}
		if (!actionsVerified(date)) {
			merged.ciSuccess = priorDay.ciSuccess;
			merged.ciFailure = priorDay.ciFailure;
		}
		if (kept || !actionsVerified(date)) days[date] = merged;
	}
	return { days, warnings };
}

export function resyncFactoryMetricsTotals(
	metrics: { days: Record<string, FactoryDay> } & FactoryDay,
) {
	for (const field of FACTORY_DAY_METRIC_FIELDS) metrics[field] = 0;
	for (const day of Object.values(metrics.days))
		for (const field of FACTORY_DAY_METRIC_FIELDS) metrics[field] += day[field];
}
