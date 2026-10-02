import { afterEach, describe, expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { loadAlerts } from "./alerts";
import { loadCi } from "./ci";
import { factoryFreshness, loadFactory, loadFactoryDetail, reloadFactory } from "./factory";
import { loadFocusSources } from "./focus";
import { loadInbox, markRead, markReadAll } from "./inbox";
import { loadInsightsBoard } from "./insights";
import { loadIssues } from "./issues";
import { loadPulls } from "./pulls";
import { loadRepoTab } from "./repo-detail";
import { loadInsightsOptional, loadRepos } from "./repos";
import {
	getRepositoryScope,
	scopedResource,
	setRepositoryScope,
	subscribeRepositoryScope,
} from "./scope";
import { setActiveAccountId } from "./session";

afterEach(() => {
	setRepositoryScope("starred");
	setActiveAccountId(null);
	vi.stubGlobal("fetch", () => {
		throw new Error("network denied in L1");
	});
});

describe("repository scope", () => {
	it("uses only selected repository observations for factory subview timestamps", () => {
		const snapshot = factoryFixture();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("missing repository fixture");
		const oldestAt = "2026-08-01T00:00:00Z";
		const latestAt = "2026-08-03T00:00:00Z";
		const observed = {
			...repo,
			observation: {
				version: "old",
				window: snapshot.window,
				refreshedAt: oldestAt,
				source: "run" as const,
			},
		};
		expect(factoryFreshness([observed, repo])).toEqual({
			oldestAt,
			latestAt: oldestAt,
			total: 2,
			missing: 1,
		});
		expect(
			factoryFreshness([
				observed,
				{ ...observed, observation: { ...observed.observation, refreshedAt: latestAt } },
			]),
		).toEqual({ oldestAt, latestAt, total: 2, missing: 0 });
		expect(factoryFreshness([])).toEqual({ oldestAt: null, latestAt: null, total: 0, missing: 0 });
	});
	it("defaults to starred, notifies only changes and supports unsubscribe", () => {
		expect(getRepositoryScope()).toBe("starred");
		const changed = vi.fn();
		const unsubscribe = subscribeRepositoryScope(changed);
		setRepositoryScope("starred");
		expect(changed).not.toHaveBeenCalled();
		setRepositoryScope("all");
		expect(getRepositoryScope()).toBe("all");
		expect(changed).toHaveBeenCalledTimes(1);
		unsubscribe();
		setRepositoryScope("starred");
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it("keeps read filters and replaces rather than duplicates a scope", () => {
		expect(scopedResource("issues")).toBe("issues?scope=starred");
		expect(scopedResource("factory/repos/o/r/prs?page=2&state=open&scope=starred", "all")).toBe(
			"factory/repos/o/r/prs?page=2&state=open&scope=all",
		);
		setRepositoryScope("all");
		expect(scopedResource("repos")).toBe("repos?scope=all");
	});

	it("scopes all business reads and retains source timestamps on the insights board", async () => {
		const freshness = {
			oldestAt: "2026-09-01T00:00:00Z",
			latestAt: "2026-09-02T00:00:00Z",
			total: 3,
			missing: 1,
		};
		const requests: URL[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "https://giraffe.test");
			requests.push(url);
			expect(init?.method ?? "GET").toBe("GET");
			if (url.pathname === "/api/accounts") {
				return Response.json({ accounts: [{ id: "account", login: "owner", is_active: true }] });
			}
			return Response.json({
				account_id: "account",
				fetched_at: freshness.latestAt,
				freshness,
				repos: [],
				issues: [],
				pull_requests: [],
			});
		});
		await Promise.all([
			loadRepos(),
			loadIssues(),
			loadPulls(),
			loadAlerts(),
			loadInbox(),
			loadCi(),
			loadFactory(),
			reloadFactory(),
			loadFocusSources(),
		]);
		const board = await loadInsightsBoard();
		expect(board).toMatchObject({
			insights: { freshness },
			issues: { fetched_at: freshness.latestAt, freshness, issues: [] },
			pulls: { fetched_at: freshness.latestAt, freshness, pull_requests: [] },
			ci: { fetched_at: freshness.latestAt, freshness },
			assessments: { fetched_at: freshness.latestAt, freshness },
		});
		const reads = requests.filter((url) => url.pathname !== "/api/accounts");
		expect(new Set(reads.map((url) => url.pathname))).toEqual(
			new Set([
				"/api/repos",
				"/api/issues",
				"/api/prs",
				"/api/alerts",
				"/api/notifications",
				"/api/ci",
				"/api/factory",
				"/api/insights",
				"/api/insights/assessments",
			]),
		);
		expect(reads.every((url) => url.searchParams.get("scope") === "starred")).toBe(true);
		const previous = requests.length;
		await Promise.all([
			loadRepos("all"),
			loadIssues("all"),
			loadPulls("all"),
			loadAlerts("all"),
			loadInbox("all"),
			loadCi("all"),
			loadFactory("all"),
			reloadFactory("all"),
			loadInsightsOptional("all"),
			loadInsightsBoard("all"),
		]);
		expect(
			requests
				.slice(previous)
				.filter((url) => url.pathname !== "/api/accounts")
				.every((url) => url.searchParams.get("scope") === "all"),
		).toBe(true);
		expect(getRepositoryScope()).toBe("starred");
	});

	it("keeps explicit repository reads available and scopes stream detail and notification writes", async () => {
		const requests: { resource: string; method: string }[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ resource: String(input), method: init?.method ?? "GET" });
			return Response.json(
				String(input) === "/api/accounts"
					? { accounts: [{ id: "account", login: "owner", is_active: true }] }
					: { account_id: "account" },
			);
		});
		await loadRepoTab("owner", "unstarred", "details");
		await loadFactory("all");
		await loadFactoryDetail("owner/repo", "prs", 2, "open", "2026-09-01");
		await markRead("thread", "account");
		await markReadAll("account");
		setRepositoryScope("all");
		await markReadAll("account");
		expect(requests.filter((request) => request.resource !== "/api/accounts")).toEqual([
			{ resource: "/api/repos/owner/unstarred", method: "GET" },
			{ resource: "/api/factory?scope=all", method: "GET" },
			{
				resource:
					"/api/factory/repos/owner/repo/prs?page=2&state=open&day=2026-09-01&scope=starred",
				method: "GET",
			},
			{ resource: "/api/notifications/read?scope=starred", method: "POST" },
			{ resource: "/api/notifications/read-all?scope=starred", method: "POST" },
			{ resource: "/api/notifications/read-all?scope=all", method: "POST" },
		]);
	});
});
