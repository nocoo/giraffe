// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	alertsIncomplete,
	buildInsightsCharts,
	filterInsights,
	groupInsights,
	type InsightRow,
	loadInsights,
	loadInsightsBoard,
} from "./insights";
import type { IssueRow } from "./issues";
import type { PullRow } from "./pulls";
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

	it("stacks issue and pull dimensions for maintainer charts", () => {
		const issues: IssueRow[] = [
			{
				name_with_owner: "octocat/alpha",
				number: 1,
				title: "a",
				url: "u",
				created_at: "2026-08-01T00:00:00.000Z",
				updated_at: "2026-08-02T00:00:00.000Z",
				author_login: "octocat",
				labels: [],
				comments_count: 0,
			},
			{
				name_with_owner: "octocat/beta",
				number: 2,
				title: "b",
				url: "u",
				created_at: "2026-08-03T00:00:00.000Z",
				updated_at: "2026-08-04T00:00:00.000Z",
				author_login: null,
				labels: [],
				comments_count: 0,
			},
		];
		const pulls: PullRow[] = [
			{
				name_with_owner: "octocat/alpha",
				number: 3,
				title: "p",
				url: "u",
				created_at: "2026-08-01T00:00:00.000Z",
				updated_at: "2026-08-02T00:00:00.000Z",
				author_login: "octocat",
				is_draft: true,
				review_decision: null,
				additions: 1,
				deletions: 0,
				base_ref: "main",
				head_ref: "d",
			},
			{
				name_with_owner: "octocat/gamma",
				number: 4,
				title: "q",
				url: "u",
				created_at: "2026-08-03T00:00:00.000Z",
				updated_at: "2026-08-04T00:00:00.000Z",
				author_login: null,
				is_draft: false,
				review_decision: "REVIEW_REQUIRED",
				additions: 2,
				deletions: 1,
				base_ref: "main",
				head_ref: "r",
			},
			{
				name_with_owner: "octocat/gamma",
				number: 5,
				title: "s",
				url: "u",
				created_at: "2026-07-01T00:00:00.000Z",
				updated_at: "2026-07-02T00:00:00.000Z",
				author_login: "octocat",
				is_draft: false,
				review_decision: "APPROVED",
				additions: 1,
				deletions: 1,
				base_ref: "main",
				head_ref: "s",
			},
			{
				name_with_owner: "octocat/gamma",
				number: 6,
				title: "t",
				url: "u",
				created_at: "2026-08-10T00:00:00.000Z",
				updated_at: "2026-08-11T00:00:00.000Z",
				author_login: "octocat",
				is_draft: false,
				review_decision: "CHANGES_REQUESTED",
				additions: 1,
				deletions: 0,
				base_ref: "main",
				head_ref: "t",
			},
		];
		const charts = buildInsightsCharts(sample, issues, pulls, "2026-09-01T00:00:00.000Z");
		expect(charts.issueCount).toBe(2);
		expect(charts.prCount).toBe(4);
		expect(charts.reposWithIssues).toBe(1);
		expect(charts.reposWithPrs).toBe(1);
		expect(charts.reposWithBoth).toBe(1);
		expect(charts.reposQuiet).toBe(0);
		expect(charts.workloadByRepo).toEqual([
			{ x: "gamma", y: 0, y2: 3 },
			{ x: "alpha", y: 1, y2: 1 },
			{ x: "beta", y: 1, y2: 0 },
		]);
		expect(charts.coverage.map((row) => row.name)).toEqual(["仅 Issue", "仅 PR", "两者都有"]);
		expect(charts.health).toEqual([
			{ name: "健康", value: 1 },
			{ name: "观察", value: 1 },
			{ name: "风险", value: 1 },
		]);
		expect(charts.prStatus).toEqual([
			{ name: "草稿", value: 1 },
			{ name: "待审查", value: 1 },
			{ name: "需修改", value: 1 },
			{ name: "已批准", value: 1 },
		]);
		expect(charts.draftCount).toBe(1);
		expect(charts.staleCount).toBe(1);
		expect(charts.freshness).toEqual([
			{ x: "7 天内", y: 1 },
			{ x: "30 天内", y: 0 },
			{ x: "90 天内", y: 1 },
			{ x: "更久", y: 1 },
		]);
		expect(charts.activity.map((row) => row.x)).toEqual([
			"07-13",
			"07-20",
			"07-27",
			"08-03",
			"08-10",
			"08-17",
			"08-24",
			"08-31",
		]);
		expect(charts.activity.find((row) => row.x === "07-27")).toEqual({
			x: "07-27",
			y: 1,
			y2: 1,
		});
		expect(charts.activity.find((row) => row.x === "08-03")).toEqual({
			x: "08-03",
			y: 1,
			y2: 1,
		});
		expect(charts.activity.find((row) => row.x === "08-10")).toEqual({
			x: "08-10",
			y: 0,
			y2: 1,
		});
	});

	it("falls back to open issue counts and folds extra repos into 其他", () => {
		const rows: InsightRow[] = Array.from({ length: 9 }, (_, index) => ({
			name_with_owner: `octocat/r${index}`,
			open_issue_count: 9 - index,
			days_since_push: index === 0 ? 3 : 12,
			health: "strong",
			alerts: [],
			opportunities: [],
		}));
		rows.push({
			name_with_owner: "other/r0",
			open_issue_count: 0,
			days_since_push: 120,
			health: "risky",
			alerts: [],
			opportunities: [],
		});
		const charts = buildInsightsCharts(rows, null, null, "not-a-date");
		expect(charts.issueCount).toBe(45);
		expect(charts.prCount).toBe(0);
		expect(charts.reposQuiet).toBe(1);
		expect(charts.workloadByRepo[0]).toEqual({ x: "octocat/r0", y: 9, y2: 0 });
		expect(charts.workloadByRepo.at(-1)).toEqual({ x: "其他", y: 1, y2: 0 });
		expect(charts.activity).toEqual([]);
		expect(charts.coverage.some((row) => row.name === "暂无")).toBe(true);
	});

	it("skips invalid dates and counts unmarked reviews", () => {
		const issues: IssueRow[] = [
			{
				name_with_owner: "octocat/alpha",
				number: 1,
				title: "a",
				url: "u",
				created_at: "nope",
				updated_at: "2026-08-02T00:00:00.000Z",
				author_login: "octocat",
				labels: [],
				comments_count: 0,
			},
			{
				name_with_owner: "octocat/alpha",
				number: 2,
				title: "old",
				url: "u",
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-02T00:00:00.000Z",
				author_login: "octocat",
				labels: [],
				comments_count: 0,
			},
		];
		const pulls: PullRow[] = [
			{
				name_with_owner: "octocat/alpha",
				number: 3,
				title: "p",
				url: "u",
				created_at: "bad",
				updated_at: "2026-08-02T00:00:00.000Z",
				author_login: "octocat",
				is_draft: false,
				review_decision: null,
				additions: 1,
				deletions: 0,
				base_ref: "main",
				head_ref: "p",
			},
		];
		const charts = buildInsightsCharts(sample, issues, pulls, "2026-09-01T00:00:00.000Z");
		expect(charts.prStatus).toEqual([{ name: "未标记", value: 1 }]);
		expect(charts.activity.every((row) => row.y === 0 && row.y2 === 0)).toBe(true);
	});

	it("treats an empty issues snapshot as zero rather than falling back", () => {
		const charts = buildInsightsCharts(sample, [], [], "2026-09-01T00:00:00.000Z");
		expect(charts.issueCount).toBe(0);
		expect(charts.workloadByRepo).toEqual([]);
		expect(charts.reposQuiet).toBe(3);
	});

	it("loads the board from insights issues and pulls", async () => {
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
					alerts_incomplete: false,
					insights: sample,
				});
			}
			if (url === "/api/issues") {
				return Response.json({
					account_id: "acc1",
					fetched_at: "t",
					truncated: false,
					issues: [],
				});
			}
			if (url === "/api/prs") {
				return new Response(JSON.stringify({ error: { code: "snapshot_missing", message: "n" } }), {
					status: 409,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(url);
		});
		const board = await loadInsightsBoard();
		expect("missing" in board).toBe(false);
		if (!("missing" in board)) {
			expect(board.insights.insights).toHaveLength(3);
			expect(board.issues).toEqual([]);
			expect(board.pulls).toBeNull();
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
		expect(await loadInsightsBoard()).toEqual({ missing: true });
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
