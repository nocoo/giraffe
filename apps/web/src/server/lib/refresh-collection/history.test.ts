import { describe, expect, it } from "vitest";
import type { RefreshDay } from "../../../lib/refresh-types";
import type { CollectionContext } from "../refresh-collection-contract";
import { calendarDayBounds } from "../refresh-params";
import { canVerifyDefaultBranchCiFailures } from "./factory-day-metrics";
import {
	actionRepairDays,
	actionsDayMissingBranch,
	auditActionsObservations,
	dayBoundsFromObservation,
	dayNeedsRefresh,
	publicationDays,
	refreshDayBounds,
	reusableDayObservation,
} from "./history";
import { blankDay, type DayObservation } from "./model";

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
	it("refreshes in-window actions during lookback even when observations are complete", () => {
		const only = day("2026-10-31");
		const previous = [row("2026-10-31", "actions")];
		const ctx = {
			run: { params: { force: false, lookbackDays: 4 } },
			days: [only],
		} as CollectionContext;
		expect(dayNeedsRefresh(ctx, previous, only, "actions")).toBe(true);
	});
	it("requires refresh when no prior observation exists for the day", () => {
		const only = day("2026-10-31");
		const ctx = context([only]);
		expect(dayNeedsRefresh(ctx, [], only, "commits")).toBe(true);
		expect(dayNeedsRefresh(ctx, [], only, "actions")).toBe(true);
	});
	it("reuses complete issue observations for non-latest window days", () => {
		const days = [day("2026-10-30"), day("2026-10-31")];
		const previous = [row("2026-10-30", "issues"), row("2026-10-31", "issues")];
		expect(dayNeedsRefresh(context(days), previous, days[0] as RefreshDay, "issues")).toBe(false);
	});
	it("honors force refresh for every dimension", () => {
		const only = day("2026-10-31");
		expect(
			dayNeedsRefresh(context([only], true), [row("2026-10-31", "commits")], only, "commits"),
		).toBe(true);
	});
});

describe("reusableDayObservation", () => {
	it("requires complete issue inventories before reuse", () => {
		const incomplete = {
			...row("2026-10-31", "issues"),
			payload: JSON.stringify({
				inventoryComplete: false,
				items: [],
				since: day("2026-10-31").since,
				until: day("2026-10-31").until,
			}),
		};
		expect(reusableDayObservation(incomplete, "issues")).toBe(false);
		expect(reusableDayObservation(row("2026-10-31", "commits"), "commits")).toBe(true);
	});
});

describe("action repair and audit", () => {
	it("lists outside-window days missing observations when prior CI was nonzero", () => {
		const window = new Set(["2026-10-31"]);
		const retained = [day("2026-10-28"), day("2026-10-31")];
		const previous = [row("2026-10-31", "actions")];
		const repair = actionRepairDays(window, retained, previous, {
			"2026-10-28": { ...blankDay(), ciFailure: 2, ciSuccess: 0 },
		});
		expect(repair.map((entry) => entry.date)).toEqual(["2026-10-28"]);
		expect(
			actionRepairDays(
				window,
				retained,
				[
					{
						...row("2026-10-28", "actions"),
						payload: JSON.stringify({
							items: [{ id: "1", conclusion: "failure", activityRun: null }],
							since: day("2026-10-28").since,
							until: day("2026-10-28").until,
						}),
					},
				],
				undefined,
			).map((entry) => entry.date),
		).toEqual(["2026-10-28"]);
		expect(auditActionsObservations("owner/repo", window, retained, previous)).toMatchObject({
			repo: "owner/repo",
			outsideWindowDays: 1,
			missingObservationDays: 1,
			missingBranchDays: 0,
		});
	});
	it("skips outside-window repair when stored actions already include branches", () => {
		const window = new Set(["2026-10-31"]);
		const retained = [day("2026-10-28"), day("2026-10-31")];
		const previous = [
			{
				...row("2026-10-28", "actions"),
				payload: JSON.stringify({
					items: [{ id: "1", conclusion: "failure", activityRun: { head_branch: "main" } }],
					since: day("2026-10-28").since,
					until: day("2026-10-28").until,
				}),
			},
		];
		expect(
			actionRepairDays(window, retained, previous, {
				"2026-10-28": { ...blankDay(), ciSuccess: 2 },
			}),
		).toEqual([]);
	});
	it("derives day bounds from stored observation payloads", () => {
		const observation = row("2026-10-28", "actions");
		expect(dayBoundsFromObservation(observation)).toEqual({
			date: "2026-10-28",
			since: day("2026-10-28").since,
			until: day("2026-10-28").until,
		});
		expect(actionsDayMissingBranch(undefined)).toBe(false);
	});
	it("includes prior publication metric days in retained publication bounds", () => {
		const ctx = {
			run: { params: { timezone: "Asia/Shanghai" } },
			days: [{ date: "2026-10-31", since: "x", until: "y" }],
		} as CollectionContext;
		const rows: DayObservation[] = [];
		const days = publicationDays(ctx, rows, { "2026-08-03": blankDay() });
		expect(days.some((entry) => entry.date === "2026-08-03")).toBe(true);
		expect(days.some((entry) => entry.date === "2026-10-31")).toBe(true);
	});
	it("counts branchless and empty outside-window action days in the audit", () => {
		const window = new Set(["2026-10-31"]);
		const retained = [day("2026-10-27"), day("2026-10-28"), day("2026-10-31")];
		const previous = [
			{
				...row("2026-10-28", "actions"),
				payload: JSON.stringify({
					items: [{ id: "1", conclusion: "failure", activityRun: {} }],
					since: day("2026-10-28").since,
					until: day("2026-10-28").until,
				}),
			},
			{
				...row("2026-10-27", "actions"),
				payload: JSON.stringify({
					items: [],
					since: day("2026-10-27").since,
					until: day("2026-10-27").until,
				}),
			},
		];
		expect(auditActionsObservations("owner/repo", window, retained, previous)).toMatchObject({
			outsideWindowDays: 2,
			missingBranchDays: 1,
			missingObservationDays: 1,
		});
	});
	it("treats whitespace-only head_branch as missing for verification and audit", () => {
		const observationRow = {
			...row("2026-10-28", "actions"),
			payload: JSON.stringify({
				items: [{ id: "1", conclusion: "success", activityRun: { head_branch: "   " } }],
				since: day("2026-10-28").since,
				until: day("2026-10-28").until,
			}),
		};
		expect(canVerifyDefaultBranchCiFailures(observationRow)).toBe(false);
		expect(
			auditActionsObservations(
				"owner/repo",
				new Set(["2026-10-31"]),
				[day("2026-10-28")],
				[observationRow],
			),
		).toMatchObject({ missingBranchDays: 1 });
	});
	it("falls back to calendar bounds when no observation exists for a publication day", () => {
		expect(refreshDayBounds("2026-08-03", "Asia/Shanghai", new Map(), day("2026-08-04"))).toEqual(
			calendarDayBounds("2026-08-03", "Asia/Shanghai"),
		);
		const fallback = calendarDayBounds("2026-08-03", "Asia/Shanghai");
		expect(refreshDayBounds("2026-08-03", "Asia/Shanghai", new Map(), fallback)).toEqual(fallback);
	});
	it("prefers stored observation bounds when rebuilding outside-window metrics", () => {
		const observation = row("2026-10-28", "actions");
		const map = new Map([[`${observation.day}:actions`, observation]]);
		expect(refreshDayBounds("2026-10-28", "Asia/Shanghai", map, day("2026-10-28"))).toEqual(
			dayBoundsFromObservation(observation),
		);
	});
});
