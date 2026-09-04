// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	alertsIncomplete,
	cachedRepoRows,
	filterRepos,
	healthMap,
	type InsightsSnapshot,
	loadInsightsOptional,
	loadRepos,
	type RepoRow,
	repoMetrics,
	sortRepos,
	visibleRepos,
} from "./repos";
import { setActiveAccountId } from "./session";
import { clearSnapshots, putSnapshot } from "./snapshot";

const sample: RepoRow[] = [
	{
		name_with_owner: "octocat/hello-world",
		name: "hello-world",
		owner_login: "octocat",
		description: "demo",
		stargazer_count: 2,
		fork_count: 0,
		open_issue_count: 1,
		primary_language: "TypeScript",
		pushed_at: "2026-08-01T00:00:00.000Z",
		visibility: "PUBLIC",
		is_private: false,
		is_archived: false,
		is_fork: false,
		url: "https://github.com/octocat/hello-world",
	},
	{
		name_with_owner: "octocat/alpha",
		name: "alpha",
		owner_login: "octocat",
		description: null,
		stargazer_count: 10,
		fork_count: 1,
		open_issue_count: 0,
		primary_language: null,
		pushed_at: "2026-09-01T00:00:00.000Z",
		visibility: "PUBLIC",
		is_private: false,
		is_archived: false,
		is_fork: false,
		url: "https://github.com/octocat/alpha",
	},
];

describe("repos viewmodel", () => {
	afterEach(() => {
		setActiveAccountId(null);
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("filters, sorts, and maps health", () => {
		expect(filterRepos(sample, "hello").map((row) => row.name)).toEqual(["hello-world"]);
		expect(sortRepos(sample, "stars")[0]?.name).toBe("alpha");
		expect(sortRepos(sample, "name")[0]?.name).toBe("alpha");
		expect(sortRepos(sample, "pushed")[0]?.name).toBe("alpha");
		expect(visibleRepos(sample, "", "name").map((row) => row.name)).toEqual([
			"alpha",
			"hello-world",
		]);
		const health = healthMap({
			account_id: "acc1",
			alerts_incomplete: true,
			insights: [{ name_with_owner: "octocat/alpha", health: "strong" }],
		});
		expect(health.get("octocat/alpha")).toBe("strong");
		expect(alertsIncomplete({ account_id: "acc1", alerts_incomplete: true, insights: [] })).toBe(
			true,
		);
		expect(alertsIncomplete(null)).toBe(false);
		expect(healthMap(null).size).toBe(0);
		expect(repoMetrics([])).toEqual({ count: 0, stars: 0, forks: 0, issues: 0 });
		expect(repoMetrics(sample)).toEqual({ count: 2, stars: 12, forks: 1, issues: 1 });
	});

	it("loads repos after session and maps snapshot_missing", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			if (url === "/api/repos") {
				return Response.json({
					account_id: "acc1",
					fetched_at: "2026-09-01T00:00:00.000Z",
					truncated: false,
					repos: sample,
				});
			}
			throw new Error(url);
		});
		const snap = await loadRepos();
		expect("missing" in snap).toBe(false);
		if (!("missing" in snap)) {
			expect(snap.repos).toHaveLength(2);
			expect(cachedRepoRows()).toHaveLength(2);
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
		expect(await loadRepos()).toEqual({ missing: true });
		expect(cachedRepoRows()).toEqual([]);
		setActiveAccountId("acc1");
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			if (url === "/api/repos") {
				return Response.json({
					account_id: "acc1",
					fetched_at: "t",
					truncated: false,
					repos: sample,
				});
			}
			throw new Error(url);
		});
		await loadRepos();
		setActiveAccountId("acc2");
		expect(cachedRepoRows()).toEqual([]);
	});

	it("loads optional insights or null when missing", async () => {
		setActiveAccountId("acc1");
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input) === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			throw new Error(String(input));
		});
		const cached: InsightsSnapshot = {
			account_id: "acc1",
			alerts_incomplete: false,
			insights: [],
		};
		putSnapshot("insights", cached);
		expect((await loadInsightsOptional())?.insights).toEqual([]);
		clearSnapshots();
		expect(await loadInsightsOptional()).toBeNull();
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
		await expect(loadRepos()).rejects.toMatchObject({ code: "github_error" });
	});
});
