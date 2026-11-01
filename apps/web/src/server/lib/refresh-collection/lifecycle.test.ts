import { describe, expect, it } from "vitest";
import {
	closedIssueSearchQuery,
	dropStaleOpen,
	lifecycleCalendarRange,
	lifecycleEvents,
	lifecycleFromResponse,
	lifecycleSearchFields,
	lifecycleSearchRange,
	mergedPrSearchQuery,
	mergeLifecycleRaw,
} from "./lifecycle";
import { event } from "./model";

describe("lifecycle search helpers", () => {
	it("builds Shanghai instant search ranges and repo-scoped queries", () => {
		const days = [
			{
				date: "2026-10-29",
				since: "2026-10-28T16:00:00.000Z",
				until: "2026-10-29T16:00:00.000Z",
			},
			{
				date: "2026-10-31",
				since: "2026-10-30T16:00:00.000Z",
				until: "2026-10-31T16:00:00.000Z",
			},
		];
		expect(lifecycleSearchRange(days)).toBe("2026-10-28T16:00:00Z..2026-10-31T15:59:59Z");
		expect(lifecycleCalendarRange(days)).toBe(lifecycleSearchRange(days));
		expect(lifecycleSearchRange([days[0] ?? { date: "", since: "", until: "" }])).toBe(
			"2026-10-28T16:00:00Z..2026-10-29T15:59:59Z",
		);
		expect(lifecycleSearchRange([])).toBeNull();
		expect(mergedPrSearchQuery("owner/project", "2026-10-28T16:00:00Z..2026-10-31T15:59:59Z")).toBe(
			"repo:owner/project is:pr is:merged merged:2026-10-28T16:00:00Z..2026-10-31T15:59:59Z",
		);
		expect(closedIssueSearchQuery("owner/project", "2026-10-31")).toBe(
			"repo:owner/project is:issue is:closed closed:2026-10-31",
		);
	});
	it("embeds lifecycle search fields only for requested streams", () => {
		expect(lifecycleSearchFields(["prs"]).vars).toContain("mergedQuery");
		expect(lifecycleSearchFields(["prs"]).fields).toContain("mergedLifecycle");
		expect(lifecycleSearchFields(["issues"]).vars).toContain("closedQuery");
		expect(lifecycleSearchFields(["commits"]).fields.trim()).toBe("");
	});
	it("parses merged and closed search nodes with real timestamps", () => {
		const mergedAt = "2026-10-31T02:00:00.000Z";
		const closedAt = "2026-10-31T01:03:00.000Z";
		const raw = lifecycleFromResponse(
			{
				mergedLifecycle: {
					nodes: [
						{ id: "PR_1", state: "MERGED", mergedAt, createdAt: mergedAt, title: "x" },
						{ id: "", state: "MERGED" },
					],
					pageInfo: { hasNextPage: true },
				},
				closedLifecycle: {
					nodes: [{ id: "I_1", state: "CLOSED", closedAt, createdAt: "2026-10-20T00:00:00.000Z" }],
					pageInfo: { hasNextPage: false },
				},
			},
			["issues", "prs"],
		);
		expect(raw.truncated).toBe(true);
		expect(lifecycleEvents(raw, "prs")).toHaveLength(1);
		expect(lifecycleEvents(raw, "prs")[0]?.mergedAt).toBe(mergedAt);
		expect(lifecycleEvents(raw, "issues")[0]?.closedAt).toBe(closedAt);
		expect(event({ id: "PR_1", mergedAt, state: "MERGED" }).state).toBe("merged");
	});
	it("ignores closed lifecycle payloads when only pull requests are needed", () => {
		const raw = lifecycleFromResponse(
			{
				closedLifecycle: {
					nodes: [{ id: "I_1", state: "CLOSED", closedAt: "2026-10-31T01:03:00.000Z" }],
					pageInfo: { hasNextPage: false },
				},
			},
			["prs"],
		);
		expect(raw.closed).toHaveLength(0);
	});
	it("merges lifecycle rows into inventory and drops stale OPEN without inferring close times", () => {
		const inventory = new Map<string, Record<string, unknown>>([
			["OPEN_1", { id: "OPEN_1", state: "OPEN" }],
			[
				"PRIOR",
				{
					id: "PRIOR",
					state: "OPEN",
					title: "keep",
					closedAt: "2026-10-28T22:30:36.000Z",
				},
			],
		]);
		mergeLifecycleRaw(inventory, [{ id: "PRIOR", closedAt: "2026-10-31T01:03:27.000Z" }], "issues");
		expect(inventory.get("PRIOR")).toMatchObject({
			title: "keep",
			state: "CLOSED",
			closedAt: "2026-10-31T01:03:27.000Z",
		});
		dropStaleOpen(inventory, new Set());
		expect(inventory.has("OPEN_1")).toBe(false);
	});
	it("writes mergedAt from lifecycle rows for pull requests", () => {
		const inventory = new Map<string, Record<string, unknown>>();
		mergeLifecycleRaw(
			inventory,
			[{ id: "PR_1", mergedAt: "2026-10-31T02:00:00.000Z", closedAt: "2026-10-31T02:00:00.000Z" }],
			"prs",
		);
		expect(inventory.get("PR_1")).toMatchObject({
			state: "MERGED",
			mergedAt: "2026-10-31T02:00:00.000Z",
		});
	});
	it("ignores lifecycle rows without ids", () => {
		const inventory = new Map<string, Record<string, unknown>>();
		mergeLifecycleRaw(inventory, [{ title: "missing id" }], "issues");
		expect(inventory.size).toBe(0);
	});
	it("keeps fetched OPEN inventory rows when reconciling stale items", () => {
		const inventory = new Map<string, Record<string, unknown>>([
			["OPEN_1", { id: "OPEN_1", state: "OPEN" }],
		]);
		dropStaleOpen(inventory, new Set(["OPEN_1"]));
		expect(inventory.has("OPEN_1")).toBe(true);
	});
});
