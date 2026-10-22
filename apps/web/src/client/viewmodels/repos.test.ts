// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cachedRepoRows,
	filterRepos,
	healthMap,
	loadInsightsOptional,
	loadRepos,
	type RepoRow,
	repoMetrics,
	saveRepoStar,
	sortRepos,
	visibleRepos,
} from "./repos";
import { setActiveAccountId } from "./session";

const sample: RepoRow[] = [
	{
		starred: true,
		star_source: "agent",
		star_updated_at: "2026-10-21T00:00:00Z",
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
		star_source: null,
		star_updated_at: null,
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
	it("counts every scoped repository including unstarred forks and archives", () => {
		const first = sample[0];
		if (!first) throw new Error("fixture");
		const rows = [
			{ ...first, starred: false, is_fork: true },
			{ ...first, starred: false, is_archived: true },
			{ ...first, starred: true, statistics_enabled: false },
		];
		expect(repoMetrics(rows)).toEqual({
			count: 3,
			stars: 6,
			forks: 0,
			issues: 3,
		});
	});
	it("saves local stars, updates cached rows and rejects account changes or failed writes", async () => {
		const first = sample[0];
		if (!first) throw new Error("fixture");
		setActiveAccountId("acc1");
		let responseAccount = "acc1";
		let switchAccount = false;
		let fail = false;
		const updatedAt = "2026-10-22T00:00:00Z";
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input) === "/api/accounts")
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			if (String(input) === "/api/repos?scope=starred")
				return Response.json({
					account_id: "acc1",
					fetched_at: "t",
					truncated: false,
					repos: sample,
				});
			expect(String(input)).toBe("/api/repos/octocat/hello-world/star");
			expect(init?.method).toBe("POST");
			if (fail)
				return Response.json({ error: { code: "db_error", message: "failed" } }, { status: 500 });
			if (switchAccount) setActiveAccountId("acc2");
			return Response.json({
				account_id: responseAccount,
				name_with_owner: first.name_with_owner,
				starred: false,
				star_source: "owner",
				star_updated_at: updatedAt,
			});
		});
		await loadRepos();
		expect(await saveRepoStar("acc1", first, false)).toEqual({
			starred: false,
			star_source: "owner",
			star_updated_at: updatedAt,
		});
		expect(cachedRepoRows()[0]).toMatchObject({
			starred: false,
			star_source: "owner",
			star_updated_at: updatedAt,
		});
		expect(cachedRepoRows()[1]?.starred).toBeUndefined();
		expect(cachedRepoRows()[1]?.star_source).toBeNull();
		fail = true;
		await expect(saveRepoStar("acc1", first, true)).rejects.toMatchObject({
			code: "db_error",
		});
		expect(cachedRepoRows()[0]).toMatchObject({
			starred: false,
			star_source: "owner",
			star_updated_at: updatedAt,
		});
		fail = false;
		responseAccount = "other";
		await expect(saveRepoStar("acc1", first, true)).rejects.toMatchObject({
			code: "account_conflict",
		});
		responseAccount = "acc1";
		switchAccount = true;
		await expect(saveRepoStar("acc1", first, true)).rejects.toMatchObject({
			code: "account_conflict",
		});
		await expect(saveRepoStar("acc1", first, true)).rejects.toMatchObject({
			code: "account_conflict",
		});
	});
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
			if (url === "/api/repos?scope=starred") {
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
			if (url === "/api/repos?scope=starred") {
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
		let missing = false;
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input) === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			if (String(input) === "/api/insights?scope=starred")
				return missing
					? Response.json(
							{ error: { code: "snapshot_missing", message: "missing" } },
							{ status: 409 },
						)
					: Response.json({ account_id: "acc1", insights: [] });
			throw new Error(String(input));
		});
		expect((await loadInsightsOptional())?.insights).toEqual([]);
		missing = true;
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
