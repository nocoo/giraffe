import { describe, expect, it } from "vitest";
import type { FactoryDay } from "../../../lib/factory-types";
import {
	FACTORY_DAY_METRICS_ZERO_GUARD_ENV,
	factoryDayMetricsZeroGuardEnabled,
	guardFactoryDayMetrics,
	resyncFactoryMetricsTotals,
} from "./factory-metrics-zero-guard";
import { blankDay } from "./model";

describe("factory day metrics zero guard", () => {
	it("passes proposed days through when no prior publication exists", () => {
		const next = { "2026-10-27": { ...blankDay(), commits: 3 } };
		expect(guardFactoryDayMetrics(undefined, next, "owner/repo")).toEqual({
			days: next,
			warnings: [],
		});
	});

	it("keeps prior nonzero values when a write would zero a field", () => {
		const prior: Record<string, FactoryDay> = {
			"2026-10-27": { ...blankDay(), prOpened: 2, ciFailure: 1 },
		};
		const next: Record<string, FactoryDay> = {
			"2026-10-27": { ...blankDay() },
		};
		const { days, warnings } = guardFactoryDayMetrics(prior, next, "owner/repo");
		expect(days["2026-10-27"]).toMatchObject({ prOpened: 2, ciFailure: 0 });
		expect(warnings).toEqual([
			{ code: "zero_guard_kept", repo: "owner/repo", day: "2026-10-27", field: "prOpened" },
		]);
	});

	it("restores a populated day when the write omits the day row", () => {
		const priorDay = { ...blankDay(), issueOpened: 3, commits: 5 };
		const prior = { "2026-08-03": priorDay };
		const { days, warnings } = guardFactoryDayMetrics(prior, {}, "owner/repo");
		expect(days["2026-08-03"]).toEqual(priorDay);
		expect(warnings.filter((w) => w.field === "issueOpened")).toHaveLength(1);
		expect(warnings.filter((w) => w.field === "ciFailure")).toHaveLength(0);
	});

	it("resyncs roll-up totals from guarded day rows", () => {
		const metrics = {
			...blankDay(),
			days: {
				"2026-10-27": { ...blankDay(), prOpened: 2 },
				"2026-10-28": { ...blankDay(), prOpened: 1 },
			},
		};
		metrics.prOpened = 99;
		resyncFactoryMetricsTotals(metrics);
		expect(metrics.prOpened).toBe(3);
	});

	it("defaults enabled unless env disables the guard", () => {
		expect(factoryDayMetricsZeroGuardEnabled({} as never)).toBe(true);
		expect(
			factoryDayMetricsZeroGuardEnabled({ [FACTORY_DAY_METRICS_ZERO_GUARD_ENV]: "" } as never),
		).toBe(true);
		expect(
			factoryDayMetricsZeroGuardEnabled({
				[FACTORY_DAY_METRICS_ZERO_GUARD_ENV]: "0",
			} as never),
		).toBe(false);
		expect(
			factoryDayMetricsZeroGuardEnabled({
				[FACTORY_DAY_METRICS_ZERO_GUARD_ENV]: "false",
			} as never),
		).toBe(false);
		expect(
			factoryDayMetricsZeroGuardEnabled({
				[FACTORY_DAY_METRICS_ZERO_GUARD_ENV]: "1",
			} as never),
		).toBe(true);
	});

	it("merges a kept field into an existing day row", () => {
		const prior = { "2026-10-27": { ...blankDay(), prOpened: 2, commits: 4 } };
		const next = { "2026-10-27": { ...blankDay(), commits: 4 } };
		const { days, warnings } = guardFactoryDayMetrics(prior, next, "owner/repo");
		expect(days["2026-10-27"]).toMatchObject({ prOpened: 2, commits: 4 });
		expect(warnings).toEqual([
			{ code: "zero_guard_kept", repo: "owner/repo", day: "2026-10-27", field: "prOpened" },
		]);
	});

	it("leaves matching day rows untouched", () => {
		const dayRow = { ...blankDay(), commits: 2 };
		const prior = { "2026-10-27": dayRow };
		const next = { "2026-10-27": { ...dayRow } };
		const { days, warnings } = guardFactoryDayMetrics(prior, next, "owner/repo");
		expect(days).toEqual(next);
		expect(warnings).toEqual([]);
	});

	it("does not zero-guard ciFailure decreases", () => {
		const prior = { "2026-10-29": { ...blankDay(), ciFailure: 4 } };
		const next = { "2026-10-29": { ...blankDay(), ciFailure: 2 } };
		const { days, warnings } = guardFactoryDayMetrics(prior, next, "owner/repo");
		expect(days["2026-10-29"]?.ciFailure).toBe(2);
		expect(warnings).toEqual([]);
	});

	it("still zero-guards accidental ciFailure zero for other fields only", () => {
		const prior = { "2026-10-29": { ...blankDay(), ciFailure: 4, prOpened: 2 } };
		const next = { "2026-10-29": { ...blankDay(), ciFailure: 0, prOpened: 0 } };
		const { days, warnings } = guardFactoryDayMetrics(prior, next, "owner/repo");
		expect(days["2026-10-29"]).toMatchObject({ ciFailure: 0, prOpened: 2 });
		expect(warnings).toEqual([
			{ code: "zero_guard_kept", repo: "owner/repo", day: "2026-10-29", field: "prOpened" },
		]);
	});
});
