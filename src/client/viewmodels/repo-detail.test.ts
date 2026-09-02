import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isValidRepoPart,
	loadRepoTab,
	REPO_TABS,
	repoKind,
	repoResource,
	securityUnavailable,
	sortedLanguages,
	trafficForbidden,
	trafficPoints,
} from "./repo-detail";
import { setActiveAccountId } from "./session";

describe("repo-detail viewmodel", () => {
	afterEach(() => {
		setActiveAccountId(null);
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("rejects illegal owner or name without fetching", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			urls.push(String(input));
			throw new Error("no");
		});
		expect(isValidRepoPart("octocat")).toBe(true);
		expect(isValidRepoPart(".")).toBe(false);
		expect(isValidRepoPart("..")).toBe(false);
		expect(isValidRepoPart("o!")).toBe(false);
		expect(await loadRepoTab("o!", "hello", "details")).toEqual({ invalid: true });
		expect(await loadRepoTab(".", "hello", "details")).toEqual({ invalid: true });
		expect(await loadRepoTab("octocat", "..", "details")).toEqual({ invalid: true });
		expect(urls).toEqual([]);
	});

	it("binds each tab to the correct GET path", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			urls.push(String(input));
			if (String(input) === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			return Response.json({ account_id: "acc1" });
		});
		for (const tab of REPO_TABS) {
			await loadRepoTab("octocat", "hello-world", tab);
		}
		expect(urls.filter((url) => url.startsWith("/api/repos/"))).toEqual([
			"/api/repos/octocat/hello-world",
			"/api/repos/octocat/hello-world/security",
			"/api/repos/octocat/hello-world/actions",
			"/api/repos/octocat/hello-world/prs",
			"/api/repos/octocat/hello-world/issues",
			"/api/repos/octocat/hello-world/releases",
			"/api/repos/octocat/hello-world/traffic",
			"/api/repos/octocat/hello-world/languages",
			"/api/repos/octocat/hello-world/contributors",
		]);
		expect(repoResource("o", "n", "details")).toBe("repos/o/n");
		expect(repoKind("o", "n", "security")).toBe("repo:o/n:security");
		expect(
			securityUnavailable({
				account_id: "a",
				fetched_at: "t",
				truncated: false,
				unavailable: true,
				dependabot_open: 0,
				code_scanning_open: 0,
			}),
		).toBe(true);
		expect(
			securityUnavailable({
				account_id: "a",
				fetched_at: "t",
				truncated: false,
				unavailable: false,
				dependabot_open: 1,
				code_scanning_open: 0,
			}),
		).toBe(false);
		expect(
			trafficForbidden({
				account_id: "a",
				fetched_at: "t",
				truncated: false,
				forbidden: true,
				views: { count: 0, uniques: 0, points: [] },
				clones: { count: 0, uniques: 0, points: [] },
			}),
		).toBe(true);
		expect(
			trafficForbidden({
				account_id: "a",
				fetched_at: "t",
				truncated: false,
				forbidden: false,
				views: { count: 1, uniques: 1, points: [{ timestamp: "t", count: 4, uniques: 2 }] },
				clones: { count: 0, uniques: 0, points: [] },
			}),
		).toBe(false);
		expect(trafficPoints([{ timestamp: "t", count: 4, uniques: 2 }])).toEqual([{ x: "t", y: 4 }]);
		expect(sortedLanguages({})).toEqual([]);
		expect(sortedLanguages({ TypeScript: 100, CSS: 100, Go: 50 })).toEqual([
			{ name: "CSS", value: 100 },
			{ name: "TypeScript", value: 100 },
			{ name: "Go", value: 50 },
		]);
	});

	it("maps snapshot_missing and rethrows other errors", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input) === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			return new Response(JSON.stringify({ error: { code: "snapshot_missing", message: "n" } }), {
				status: 409,
				headers: { "content-type": "application/json" },
			});
		});
		expect(await loadRepoTab("octocat", "hello-world", "details")).toEqual({ missing: true });
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input) === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			return new Response(JSON.stringify({ error: { code: "github_error", message: "x" } }), {
				status: 502,
				headers: { "content-type": "application/json" },
			});
		});
		await expect(loadRepoTab("octocat", "hello-world", "details")).rejects.toMatchObject({
			code: "github_error",
		});
	});
});
