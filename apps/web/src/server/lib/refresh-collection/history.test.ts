import { describe, expect, it } from "vitest";
import type { RefreshDay } from "../../../lib/refresh-types";
import type { CollectionContext } from "../refresh-collection-contract";
import { dayNeedsRefresh } from "./history";
import type { DayObservation } from "./model";

const day = (date: string): RefreshDay => ({
	date,
	since: `${date}T00:00:00.000Z`,
	until: `${date}T23:59:59.999Z`,
});
const row = (dayDate: string, dimension: string, inventoryComplete = true): DayObservation => ({
	day: dayDate,
	dimension,
	status: "complete",
	payload: JSON.stringify({
		count: 0,
		observed: 0,
		items: [],
		inventoryComplete,
		since: day(dayDate).since,
		until: day(dayDate).until,
	}),
	fetched_at: "2026-10-29T04:00:00.000Z",
});
const context = (days: RefreshDay[], force = false): CollectionContext =>
	({
		run: { params: { force } },
		days,
	}) as CollectionContext;

describe("dayNeedsRefresh", () => {
	it("always refreshes the latest calendar day for issues and pull requests", () => {
		const days = [day("2026-10-30"), day("2026-10-31")];
		const previous = [
			row("2026-10-30", "prs"),
			row("2026-10-31", "prs"),
			row("2026-10-31", "issues"),
		];
		const ctx = context(days);
		const older = days[0] as RefreshDay;
		const latest = days[1] as RefreshDay;
		expect(dayNeedsRefresh(ctx, previous, older, "prs")).toBe(false);
		expect(dayNeedsRefresh(ctx, previous, latest, "prs")).toBe(true);
		expect(dayNeedsRefresh(ctx, previous, latest, "issues")).toBe(true);
		expect(dayNeedsRefresh(ctx, previous, older, "commits")).toBe(true);
		previous.push(row("2026-10-30", "commits"));
		expect(dayNeedsRefresh(ctx, previous, older, "commits")).toBe(false);
	});
	it("recollects incomplete inventories and honors force", () => {
		const days = [day("2026-10-31")];
		const only = days[0] as RefreshDay;
		const previous = [row("2026-10-31", "prs", false)];
		const ctx = context(days);
		expect(dayNeedsRefresh(ctx, previous, only, "prs")).toBe(true);
		expect(dayNeedsRefresh(context(days, true), previous, only, "commits")).toBe(true);
	});
	it("refreshes actions days whose stored runs are missing head_branch", () => {
		const days = [day("2026-10-31")];
		const only = days[0] as RefreshDay;
		const previous: DayObservation[] = [
			{
				...row("2026-10-31", "actions"),
				payload: JSON.stringify({
					count: 1,
					observed: 1,
					items: [{ id: "1", activityRun: null, conclusion: "failure" }],
					since: only.since,
					until: only.until,
				}),
			},
		];
		expect(dayNeedsRefresh(context(days), previous, only, "actions")).toBe(true);
	});
	it("ignores malformed action day payloads when checking branch backfill", () => {
		const only = day("2026-10-31");
		expect(
			dayNeedsRefresh(
				context([only]),
				[{ ...row("2026-10-31", "actions"), payload: "{}" }],
				only,
				"actions",
			),
		).toBe(false);
	});
});
