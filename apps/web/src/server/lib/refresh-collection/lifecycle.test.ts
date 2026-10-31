import { describe, expect, it } from "vitest";
import {
	closedIssueSearchQuery,
	dropStaleOpen,
	lifecycleCalendarRange,
	lifecycleEvents,
	lifecycleFromResponse,
	lifecycleSearchFields,
	mergedPrSearchQuery,
	mergeLifecycleRaw,
} from "./lifecycle";
import { event } from "./model";

describe("lifecycle search helpers", () => {
	it("builds Shanghai calendar search ranges and repo-scoped queries", () => {
		const days = [
			{ date: "2026-10-29", since: "x", until: "y" },
			{ date: "2026-10-31", since: "a", until: "b" },
		];
		expect(lifecycleCalendarRange(days)).toBe("2026-10-29..2026-10-31");
		expect(lifecycleCalendarRange([days[0] ?? { date: "", since: "", until: "" }])).toBe(
			"2026-10-29",
		);
		expect(lifecycleCalendarRange([])).toBeNull();
		expect(mergedPrSearchQuery("owner/project", "2026-10-31")).toBe(
			"repo:owner/project is:pr is:merged merged:2026-10-31",
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
	it("merges lifecycle rows into inventory and marks stale OPEN without timestamps", () => {
		const inventory = new Map<string, Record<string, unknown>>([
			["OPEN_1", { id: "OPEN_1", state: "OPEN" }],
			["PRIOR", { id: "PRIOR", state: "OPEN", title: "keep" }],
		]);
		mergeLifecycleRaw(inventory, [{ id: "PRIOR", closedAt: "2026-10-31T01:00:00.000Z" }], "issues");
		expect(inventory.get("PRIOR")).toMatchObject({
			title: "keep",
			state: "CLOSED",
			closedAt: "2026-10-31T01:00:00.000Z",
		});
		dropStaleOpen(inventory, new Set());
		expect(inventory.get("OPEN_1")).toMatchObject({ state: "CLOSED", closedAt: null });
		inventory.set("OPEN_2", { id: "OPEN_2", state: "OPEN", mergedAt: "2026-10-31T02:00:00.000Z" });
		dropStaleOpen(inventory, new Set());
		expect(inventory.get("OPEN_2")).toMatchObject({ state: "MERGED" });
	});
});
