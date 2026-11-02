import { describe, expect, it } from "vitest";
import type { FactorySnapshot } from "../../lib/factory-types";
import { contributionDates } from "./factory-contributions";
import {
	annualCalendarCoverage,
	contributionFailureCode,
	contributionWindow,
	materializeContributionDays,
	type RefreshCalendarWindow,
	savedAnnualCalendarCoverage,
} from "./refresh-calendar";

type Day = { date: unknown; count: unknown };
const anchor = "2026-10-29T04:00:00.000Z";
const daysOf = (window: RefreshCalendarWindow, count = 1): Day[] =>
	contributionDates(window.since.slice(0, 10), window.until.slice(0, 10)).map((date) => ({
		date,
		count,
	}));
const first = (days: Day[]) => days[0] as Day;
const reasonOf = (days: unknown, window = contributionWindow(anchor), total = 366) =>
	annualCalendarCoverage({ fetchedAt: window.until, window, days, total }).reason;

describe("refresh calendar window", () => {
	it("spans the preceding calendar year from the anchor", () => {
		expect(contributionWindow(anchor)).toEqual({
			since: "2025-10-29T04:00:00.000Z",
			until: anchor,
		});
		expect(contributionDates("2025-10-29", "2026-10-29")).toHaveLength(366);
	});
	it("derives leap-day windows with inclusive endpoints", () => {
		const leapAnchor = contributionWindow("2024-02-29T12:00:00.000Z");
		expect(leapAnchor).toEqual({
			since: "2023-03-01T12:00:00.000Z",
			until: "2024-02-29T12:00:00.000Z",
		});
		expect(daysOf(leapAnchor)).toHaveLength(366);
		const leapSpan = contributionWindow("2025-02-28T00:00:00.000Z");
		expect(leapSpan).toEqual({
			since: "2024-02-28T00:00:00.000Z",
			until: "2025-02-28T00:00:00.000Z",
		});
		expect(daysOf(leapSpan)).toHaveLength(367);
	});
	it("rejects an unparseable anchor", () => {
		expect(() => contributionWindow("2026-13-01T00:00:00.000Z")).toThrow(RangeError);
	});
});

describe("annual contribution calendar coverage", () => {
	it("treats a missing snapshot as incomplete coverage", () => {
		expect(savedAnnualCalendarCoverage(null)).toMatchObject({
			complete: false,
			reason: "missing",
		});
	});
	it.each([
		[anchor, 366],
		["2024-02-29T12:00:00.000Z", 366],
		["2025-02-28T00:00:00.000Z", 367],
	])("accepts a complete contiguous year from %s", (at, length) => {
		const window = contributionWindow(at);
		const days = daysOf(window, 0);
		expect(days).toHaveLength(length);
		expect(annualCalendarCoverage({ fetchedAt: window.until, window, days, total: 0 })).toEqual({
			complete: true,
			reason: "complete",
			window,
		});
	});
	it("accepts contiguous GitHub week padding outside the window", () => {
		const window = contributionWindow(anchor);
		expect(
			reasonOf([
				{ date: "2025-10-28", count: 1 },
				...daysOf(window),
				{ date: "2026-10-30", count: 3 },
			]),
		).toBe("complete");
	});
	it("rejects the pre-0.27.2 two-day calendar even when saved as complete", () => {
		const saved = {
			status: "complete",
			contributionStatus: "complete",
			fetched_at: "2026-10-28T16:51:11.000Z",
			contribution: {
				days: [
					{ date: "2026-10-27", count: 5 },
					{ date: "2026-10-28", count: 7 },
				],
				total: 12,
				fetchedAt: "2026-10-28T16:51:11.000Z",
			},
			contributionObservation: {
				version: "run-old",
				window: {
					since: "2026-10-27T16:00:00.000Z",
					until: "2026-10-28T16:00:00.000Z",
				},
				fetchedAt: "2026-10-28T16:51:11.000Z",
			},
		} as unknown as FactorySnapshot;
		expect(savedAnnualCalendarCoverage(saved)).toMatchObject({
			complete: false,
			reason: "window_invalid",
		});
	});
	it("rejects a one-year window that is not derived from the saved fetched_at", () => {
		const window = contributionWindow(anchor);
		expect(reasonOf(daysOf(window), { since: "2025-10-28T04:00:00.000Z", until: anchor })).toBe(
			"window_invalid",
		);
	});
	it("rejects malformed stored windows and fetched_at values", () => {
		const window = contributionWindow(anchor);
		expect(reasonOf(daysOf(window), { since: "not-a-date", until: anchor })).toBe("window_invalid");
		expect(reasonOf(daysOf(window), { since: 1, until: anchor } as never)).toBe("window_invalid");
		expect(
			annualCalendarCoverage({
				fetchedAt: "not-a-date",
				window,
				days: daysOf(window),
				total: 0,
			}).reason,
		).toBe("window_invalid");
	});
	it("rejects missing evidence and invalid totals", () => {
		const window = contributionWindow(anchor);
		expect(
			annualCalendarCoverage({
				fetchedAt: null,
				window,
				days: daysOf(window),
				total: 0,
			}).reason,
		).toBe("missing");
		expect(
			annualCalendarCoverage({
				fetchedAt: window.until,
				window,
				days: daysOf(window),
				total: -1,
			}).reason,
		).toBe("total_invalid");
	});
	it.each<[string, (days: Day[]) => Day[]]>([
		["a missing endpoint", (days) => days.slice(0, -1)],
		["an interior hole", (days) => days.filter((_, index) => index !== 180)],
		["a duplicate date", (days) => [...days, days[10] as Day]],
		["out-of-order dates", (days) => [days[1] as Day, first(days), ...days.slice(2)]],
	])("rejects %s", (name, mutate) => {
		const window = contributionWindow(anchor);
		expect(reasonOf(mutate(daysOf(window)))).toBe(
			name === "a missing endpoint" ? "dates_incomplete" : "dates_invalid",
		);
	});
	it.each<[string, (days: Day[]) => Day[]]>([
		["an impossible date", (days) => [{ ...first(days), date: "2026-02-30" }, ...days.slice(1)]],
		["a non-canonical date", (days) => [{ ...first(days), date: "2026-1-05" }, ...days.slice(1)]],
		["a non-string date", (days) => [{ ...first(days), date: 20261029 }, ...days.slice(1)]],
		["a missing count", (days) => [{ date: first(days).date, count: undefined }, ...days.slice(1)]],
		["a negative count", (days) => [{ ...first(days), count: -1 }, ...days.slice(1)]],
		[
			"a non-finite count",
			(days) => [{ ...first(days), count: Number.POSITIVE_INFINITY }, ...days.slice(1)],
		],
	])("rejects %s", (_name, mutate) => {
		const window = contributionWindow(anchor);
		expect(reasonOf(mutate(daysOf(window)))).toBe("dates_invalid");
	});
	it("rejects a null calendar day and a non-array payload", () => {
		expect(reasonOf([null])).toBe("dates_invalid");
		expect(reasonOf("days")).toBe("dates_invalid");
	});
	it("rejects an empty calendar as incomplete", () => {
		expect(reasonOf([])).toBe("dates_incomplete");
	});
	it.each<[unknown]>([[-1], [Number.NaN], ["367"]])("rejects a malformed total: %j", (total) => {
		const window = contributionWindow(anchor);
		expect(reasonOf(daysOf(window), window, total as number)).toBe("total_invalid");
	});
	it("reports missing evidence instead of inventing a calendar", () => {
		expect(savedAnnualCalendarCoverage(null)).toEqual({
			complete: false,
			reason: "missing",
			window: null,
		});
		expect(
			savedAnnualCalendarCoverage({ contribution: null } as unknown as FactorySnapshot),
		).toEqual({ complete: false, reason: "missing", window: null });
		const window = contributionWindow(anchor);
		for (const total of [undefined, null])
			expect(
				annualCalendarCoverage({ fetchedAt: window.until, window, days: daysOf(window), total })
					.reason,
			).toBe("missing");
		expect(
			annualCalendarCoverage({ fetchedAt: window.until, window, days: null, total: 0 }).reason,
		).toBe("missing");
	});
});

describe("materializeContributionDays", () => {
	it("returns null when GitHub returned no contribution days", () => {
		const window = contributionWindow(anchor);
		expect(materializeContributionDays(window.until, window, [])).toBeNull();
	});
	it("fills interior holes and out-of-order GitHub weeks", () => {
		const window = contributionWindow(anchor);
		const days = daysOf(window, 2);
		const shuffled = [...days.slice(100), ...days.slice(0, 100)].map((day) => ({
			date: String(day.date),
			count: Number(day.count),
		}));
		const materialized = materializeContributionDays(window.until, window, shuffled);
		expect(materialized?.length).toBe(366);
		expect(
			annualCalendarCoverage({
				fetchedAt: window.until,
				window,
				days: materialized ?? [],
				total: materialized?.reduce((sum, day) => sum + day.count, 0) ?? 0,
			}).complete,
		).toBe(true);
	});
});

describe("contributionFailureCode", () => {
	it.each([
		["missing"],
		["window_invalid"],
		["dates_invalid"],
		["dates_incomplete"],
		["total_invalid"],
	] as const)("maps %s", (reason) => {
		expect(contributionFailureCode({ complete: false, reason, window: null })).toBe(
			`contributions:coverage_${reason}`,
		);
	});
	it("falls back when coverage is complete", () => {
		expect(contributionFailureCode({ complete: true, reason: "complete", window: null })).toBe(
			"contributions:unavailable",
		);
	});
});
