import { describe, expect, it } from "vitest";
import type { FactoryDay } from "../../../lib/factory-types";
import {
	accumulateActionMetrics,
	accumulateIssuePrMetrics,
	canVerifyDefaultBranchCiFailures,
	metricsFromStoredDayObservations,
	seedOutsideWindowMetrics,
} from "./factory-day-metrics";
import { blankDay, type DayObservation } from "./model";

const day = {
	date: "2026-10-27",
	since: "2026-10-26T16:00:00.000Z",
	until: "2026-10-27T16:00:00.000Z",
};

describe("factory day metrics from stored observations", () => {
	it("rebuilds opened and default-branch CI failures without live GitHub data", () => {
		const row = (
			dimension: string,
			items: unknown[],
			count: number | null = null,
		): DayObservation => ({
			day: day.date,
			dimension,
			status: "complete",
			payload: JSON.stringify({ count, items, since: day.since, until: day.until }),
			fetched_at: "2026-10-31T04:00:00.000Z",
		});
		const current = new Map<string, DayObservation>([
			[`${day.date}:issues`, row("issues", [{ id: "1", createdAt: "2026-10-27T02:00:00.000Z" }])],
			[`${day.date}:prs`, row("prs", [{ id: "2", createdAt: "2026-10-27T03:00:00.000Z" }])],
			[
				`${day.date}:actions`,
				row("actions", [
					{
						id: "9",
						conclusion: "failure",
						activityRun: { head_branch: "main" },
						createdAt: "2026-10-27T04:00:00.000Z",
					},
					{
						id: "10",
						conclusion: "failure",
						activityRun: { head_branch: "feature" },
						createdAt: "2026-10-27T05:00:00.000Z",
					},
				]),
			],
		]);
		expect(metricsFromStoredDayObservations(day, current, "main")).toMatchObject({
			issueOpened: 1,
			prOpened: 1,
			ciFailure: 1,
		});
	});

	it("keeps lookback windows from rewriting outside-window publication days", () => {
		const priorDay: FactoryDay = {
			...blankDay(),
			issueOpened: 70,
			prOpened: 14,
			ciFailure: 3,
			commits: 12,
		};
		const corrupted: FactoryDay = { ...blankDay() };
		const row: DayObservation = {
			day: day.date,
			dimension: "issues",
			status: "complete",
			payload: JSON.stringify({
				count: null,
				items: [{ id: "1", createdAt: "2026-10-27T02:00:00.000Z" }],
				since: day.since,
				until: day.until,
			}),
			fetched_at: "2026-10-31T04:00:00.000Z",
		};
		const current = new Map<string, DayObservation>([[`${day.date}:issues`, row]]);
		const days: Record<string, FactoryDay> = {};
		seedOutsideWindowMetrics(
			days,
			[day],
			new Set(["2026-10-28", "2026-10-29"]),
			current,
			{ [day.date]: corrupted, "2026-10-26": priorDay },
			"main",
		);
		expect(days[day.date]).toEqual({ ...blankDay(), issueOpened: 1 });
	});

	it("counts only default-branch failures in action metrics", () => {
		const metrics = blankDay();
		accumulateActionMetrics(
			metrics,
			[
				{ id: "1", conclusion: "failure", activityRun: { head_branch: "main" } } as never,
				{ id: "2", conclusion: "failure", activityRun: { head_branch: "dev" } } as never,
			],
			"main",
		);
		expect(metrics.ciFailure).toBe(1);
	});

	it("preserves ninety seeded outside-window days byte-for-byte from day cache", () => {
		const window = new Set(["2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"]);
		const current = new Map<string, DayObservation>();
		const expected: Record<string, FactoryDay> = {};
		for (let index = 0; index < 90; index += 1) {
			const date = new Date(Date.parse("2026-08-03T00:00:00.000Z") + index * 86_400_000)
				.toISOString()
				.slice(0, 10);
			if (window.has(date)) continue;
			const since = `${date}T00:00:00.000Z`;
			const until = `${date}T23:59:59.999Z`;
			const issueOpened = (index % 7) + 1;
			expected[date] = { ...blankDay(), issueOpened };
			const items = Array.from({ length: issueOpened }, (_, itemIndex) => ({
				id: `${index}:${itemIndex}`,
				createdAt: since,
			}));
			const payload = JSON.stringify({ count: null, items, since, until });
			current.set(`${date}:issues`, {
				day: date,
				dimension: "issues",
				status: "complete",
				payload,
				fetched_at: "2026-10-31T04:00:00.000Z",
			});
		}
		const days: Record<string, FactoryDay> = {};
		seedOutsideWindowMetrics(
			days,
			Object.keys(expected).map((date) => ({
				date,
				since: `${date}T00:00:00.000Z`,
				until: `${date}T23:59:59.999Z`,
			})),
			window,
			current,
			Object.fromEntries(Object.keys(expected).map((date) => [date, blankDay()])),
			"main",
		);
		for (const [date, metrics] of Object.entries(expected)) {
			expect(days[date]).toEqual(
				metricsFromStoredDayObservations(
					{ date, since: `${date}T00:00:00.000Z`, until: `${date}T23:59:59.999Z` },
					current,
					"main",
				),
			);
			expect(days[date]).toEqual(metrics);
		}
	});

	it("drops outside-window days when observations exist but are incomplete", () => {
		const days: Record<string, FactoryDay> = {
			"2026-10-27": { ...blankDay(), issueOpened: 9 },
		};
		const current = new Map<string, DayObservation>([
			[
				"2026-10-27:commits",
				{
					day: "2026-10-27",
					dimension: "commits",
					status: "partial",
					payload: JSON.stringify({ count: 0, items: [], since: day.since, until: day.until }),
					fetched_at: "2026-10-31T04:00:00.000Z",
				},
			],
		]);
		seedOutsideWindowMetrics(
			days,
			[day],
			new Set(["2026-10-28"]),
			current,
			{ "2026-10-27": { ...blankDay(), issueOpened: 9 } },
			"main",
		);
		expect(days["2026-10-27"]).toBeUndefined();
	});

	it("restores outside-window days from prior publication when observations are missing", () => {
		const priorDay = { ...blankDay(), commits: 8 };
		const days: Record<string, FactoryDay> = {};
		seedOutsideWindowMetrics(
			days,
			[day],
			new Set(["2026-10-28"]),
			new Map(),
			{ [day.date]: priorDay },
			"main",
		);
		expect(days[day.date]).toEqual(priorDay);
	});

	it("omits outside-window days when observations and prior publication are missing", () => {
		const days: Record<string, FactoryDay> = { "2026-10-27": { ...blankDay(), commits: 1 } };
		seedOutsideWindowMetrics(days, [day], new Set(["2026-10-28"]), new Map(), undefined, "main");
		expect(days[day.date]).toBeUndefined();
	});

	it("reports when stored actions can verify default-branch ciFailure", () => {
		expect(canVerifyDefaultBranchCiFailures(undefined)).toBe(false);
		const withBranch: DayObservation = {
			day: day.date,
			dimension: "actions",
			status: "complete",
			payload: JSON.stringify({
				items: [{ id: "1", conclusion: "failure", activityRun: { head_branch: "main" } }],
				since: day.since,
				until: day.until,
			}),
			fetched_at: "2026-10-31T04:00:00.000Z",
		};
		expect(canVerifyDefaultBranchCiFailures(withBranch)).toBe(true);
		const missingBranch: DayObservation = {
			...withBranch,
			payload: JSON.stringify({
				items: [{ id: "1", conclusion: "failure", activityRun: {} }],
				since: day.since,
				until: day.until,
			}),
		};
		expect(canVerifyDefaultBranchCiFailures(missingBranch)).toBe(false);
	});

	it("returns zero ciFailure from cache when action runs lack head_branch metadata", () => {
		const row: DayObservation = {
			day: day.date,
			dimension: "actions",
			status: "complete",
			payload: JSON.stringify({
				items: [{ id: "1", conclusion: "failure", activityRun: {} }],
				since: day.since,
				until: day.until,
			}),
			fetched_at: "2026-10-31T04:00:00.000Z",
		};
		expect(
			metricsFromStoredDayObservations(day, new Map([[`${day.date}:actions`, row]]), "main")
				.ciFailure,
		).toBe(0);
	});

	it("counts prOpened from lifecycle createdAt and prClosed only for non-merged closes", () => {
		const metrics = blankDay();
		const lifecycle = [
			{
				id: "m1",
				createdAt: "2026-10-31T10:00:00.000Z",
				closedAt: "2026-10-31T12:00:00.000Z",
				mergedAt: "2026-10-31T12:00:00.000Z",
			},
			{
				id: "c1",
				createdAt: "2026-10-30T10:00:00.000Z",
				closedAt: "2026-10-31T11:00:00.000Z",
				mergedAt: null,
			},
		] as never[];
		const bounds = {
			date: "2026-10-31",
			since: "2026-10-30T16:00:00.000Z",
			until: "2026-10-31T16:00:00.000Z",
		};
		accumulateIssuePrMetrics(metrics, "prs", [], lifecycle, bounds);
		expect(metrics).toMatchObject({ prOpened: 1, prMerged: 1, prClosed: 1 });
	});

	it("deduplicates workflow runs when accumulating action metrics", () => {
		const metrics = blankDay();
		const run = {
			id: "run-1",
			conclusion: "failure",
			activityRun: { head_branch: "main" },
		} as never;
		accumulateActionMetrics(metrics, [run, run], "main");
		expect(metrics.ciFailure).toBe(1);
	});
});
