// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	alertsIncomplete,
	filterInsights,
	groupInsights,
	type InsightRow,
	loadInsights,
} from "./insights";
import { setActiveAccountId } from "./session";
import { clearSnapshots } from "./snapshot";

const sample: InsightRow[] = [
	{
		name_with_owner: "octocat/alpha",
		open_issue_count: 0,
		days_since_push: 1,
		health: "strong",
		alerts: [],
		opportunities: [],
	},
	{
		name_with_owner: "octocat/beta",
		open_issue_count: 20,
		days_since_push: 40,
		health: "watch",
		alerts: [],
		opportunities: ["many_issues"],
	},
	{
		name_with_owner: "octocat/gamma",
		open_issue_count: 1,
		days_since_push: 100,
		health: "risky",
		alerts: [
			{
				name_with_owner: "octocat/gamma",
				source: "dependabot",
				severity: "high",
				summary: "lodash",
				url: "https://github.com/octocat/gamma/security",
			},
		],
		opportunities: ["stale_push", "open_alerts"],
	},
];

describe("insights viewmodel", () => {
	afterEach(() => {
		setActiveAccountId(null);
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("groups and filters by health", () => {
		const groups = groupInsights(sample);
		expect(groups.strong.map((row) => row.name_with_owner)).toEqual(["octocat/alpha"]);
		expect(groups.watch).toHaveLength(1);
		expect(groups.risky).toHaveLength(1);
		expect(filterInsights(sample, "all")).toHaveLength(3);
		expect(filterInsights(sample, "risky")[0]?.name_with_owner).toBe("octocat/gamma");
		expect(
			alertsIncomplete({
				account_id: "a",
				fetched_at: "t",
				truncated: false,
				alerts_incomplete: true,
				insights: [],
			}),
		).toBe(true);
		expect(alertsIncomplete(null)).toBe(false);
		expect(
			alertsIncomplete({
				account_id: "a",
				fetched_at: "t",
				truncated: false,
				alerts_incomplete: false,
				insights: [],
			}),
		).toBe(false);
	});

	it("loads insights after session and maps snapshot_missing", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			if (url === "/api/insights") {
				return Response.json({
					account_id: "acc1",
					fetched_at: "2026-09-01T00:00:00.000Z",
					truncated: false,
					alerts_incomplete: true,
					insights: sample,
				});
			}
			throw new Error(url);
		});
		const snap = await loadInsights();
		expect("missing" in snap).toBe(false);
		if (!("missing" in snap)) {
			expect(alertsIncomplete(snap)).toBe(true);
			expect(snap.insights).toHaveLength(3);
		}
		clearSnapshots();
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input) === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			return new Response(JSON.stringify({ error: { code: "snapshot_missing", message: "n" } }), {
				status: 409,
				headers: { "content-type": "application/json" },
			});
		});
		expect(await loadInsights()).toEqual({ missing: true });
	});

	it("rethrows unexpected snapshot errors", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input) === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			return new Response(JSON.stringify({ error: { code: "github_error", message: "x" } }), {
				status: 502,
				headers: { "content-type": "application/json" },
			});
		});
		await expect(loadInsights()).rejects.toMatchObject({ code: "github_error" });
	});
});
