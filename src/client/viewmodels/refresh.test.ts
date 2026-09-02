// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearRefreshQueue,
	refreshInFlight,
	requestRefresh,
	resourceOfKind,
	subscribeRefresh,
} from "./refresh";
import { setActiveAccountId } from "./session";
import { clearSnapshots, loadKind } from "./snapshot";

function accountsFor(id: string): Response {
	return Response.json({ accounts: [{ id, login: "o", is_active: true }] });
}

describe("refresh coordinator", () => {
	afterEach(() => {
		clearRefreshQueue();
		clearSnapshots();
		setActiveAccountId(null);
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("throws account_missing without an active account", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input) === "/api/accounts") {
				return Response.json({ accounts: [] });
			}
			throw new Error(String(input));
		});
		await expect(requestRefresh(["repos"])).rejects.toMatchObject({ code: "account_missing" });
		expect(refreshInFlight()).toBe(false);
	});

	it("merges equivalent in-flight requests and follows up digest", async () => {
		setActiveAccountId("acc1");
		let posts = 0;
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return accountsFor("acc1");
			}
			if (url === "/api/refresh") {
				posts += 1;
				expect(String(init?.body)).toContain("acc1");
				return Response.json({ account_id: "acc1", kinds: ["repos"] });
			}
			if (url === "/api/insights" || url === "/api/digest" || url === "/api/repos") {
				return Response.json({ account_id: "acc1", truncated: false });
			}
			throw new Error(url);
		});
		const first = requestRefresh(["repos"]);
		const second = requestRefresh(["repos"]);
		expect(first).toBe(second);
		const [a, b] = await Promise.all([first, second]);
		expect(posts).toBe(1);
		expect(a?.kinds).toEqual(["repos"]);
		expect(b?.kinds).toEqual(["repos"]);
	});

	it("drops results after the account stamp changes", async () => {
		setActiveAccountId("acc1");
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return accountsFor(url.includes("never") ? "x" : "acc1");
			}
			if (url === "/api/refresh") {
				setActiveAccountId("acc2");
				return Response.json({ account_id: "acc1", kinds: ["repos"] });
			}
			throw new Error(url);
		});
		expect(await requestRefresh(["repos"])).toBeNull();
		setActiveAccountId("acc1");
		const queued = requestRefresh(["alerts"]);
		setActiveAccountId("acc2");
		expect(await queued).toBeNull();
	});

	it("skips follow-up when payload account_id mismatches and on error", async () => {
		setActiveAccountId("acc1");
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return accountsFor("acc1");
			}
			if (url === "/api/refresh") {
				return Response.json({ account_id: "other", kinds: ["repos"] });
			}
			throw new Error(url);
		});
		expect(await requestRefresh(["repos"])).toBeNull();
		setActiveAccountId("acc1");
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input) === "/api/accounts") {
				return accountsFor("acc1");
			}
			throw new Error("boom");
		});
		await expect(requestRefresh(["alerts"])).rejects.toThrow("boom");
		expect(refreshInFlight()).toBe(false);
	});

	it("wraps a single repo kind string as an array", async () => {
		setActiveAccountId("acc1");
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return accountsFor("acc1");
			}
			if (url === "/api/refresh") {
				expect(JSON.parse(String(init?.body)).kinds).toEqual(["repo:octocat/hello-world:details"]);
				return Response.json({
					account_id: "acc1",
					description: "A demo repo",
				});
			}
			if (url === "/api/insights" || url === "/api/digest") {
				return new Response(JSON.stringify({ error: { code: "snapshot_missing", message: "n" } }), {
					status: 409,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(url);
		});
		const body = await requestRefresh("repo:octocat/hello-world:details");
		expect(body?.description).toBe("A demo repo");
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return accountsFor("acc1");
			}
			if (url === "/api/refresh") {
				expect(JSON.parse(String(init?.body)).kinds).toBe("all");
				return Response.json({ account_id: "acc1", kinds: ["repos"] });
			}
			if (url === "/api/insights" || url === "/api/digest" || url === "/api/repos") {
				return Response.json({ account_id: "acc1" });
			}
			throw new Error(url);
		});
		expect((await requestRefresh("all"))?.kinds).toEqual(["repos"]);
	});

	it("does not refetch insights when kinds already include them", async () => {
		setActiveAccountId("acc1");
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url === "/api/accounts") {
				return accountsFor("acc1");
			}
			if (url === "/api/refresh") {
				return Response.json({ account_id: "acc1", kinds: ["repos", "insights", "digest"] });
			}
			if (url === "/api/repos" || url === "/api/insights" || url === "/api/digest") {
				return Response.json({ account_id: "acc1" });
			}
			throw new Error(url);
		});
		await requestRefresh();
		expect(urls.filter((url) => url === "/api/insights")).toHaveLength(1);
		expect(urls.filter((url) => url === "/api/digest")).toHaveLength(1);
	});

	it("treats a missing kinds field as all when none were requested", async () => {
		setActiveAccountId("acc1");
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url === "/api/accounts") {
				return accountsFor("acc1");
			}
			if (url === "/api/refresh") {
				return Response.json({ account_id: "acc1" });
			}
			if (
				url === "/api/insights" ||
				url === "/api/digest" ||
				url === "/api/repos" ||
				url === "/api/issues" ||
				url === "/api/prs" ||
				url === "/api/alerts" ||
				url === "/api/notifications"
			) {
				return Response.json({ account_id: "acc1" });
			}
			throw new Error(url);
		});
		await requestRefresh();
		expect(urls).toContain("/api/repos");
		expect(urls).toContain("/api/issues");
		expect(urls).toContain("/api/prs");
		expect(urls).toContain("/api/alerts");
		expect(urls).toContain("/api/notifications");
		expect(urls).toContain("/api/insights");
		expect(urls).toContain("/api/digest");
	});

	it("does not follow up digest unless repos were written", async () => {
		setActiveAccountId("acc1");
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url === "/api/accounts") {
				return accountsFor("acc1");
			}
			if (url === "/api/refresh") {
				return Response.json({ account_id: "acc1", kinds: ["alerts"] });
			}
			if (url === "/api/insights" || url === "/api/alerts") {
				return Response.json({ account_id: "acc1" });
			}
			throw new Error(url);
		});
		await requestRefresh(["alerts"]);
		expect(urls).toContain("/api/alerts");
		expect(urls).toContain("/api/insights");
		expect(urls).not.toContain("/api/digest");
	});

	it("resyncs session on account_conflict and does not replay", async () => {
		setActiveAccountId("acc1");
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url === "/api/accounts") {
				return accountsFor("acc1");
			}
			if (url === "/api/refresh") {
				return new Response(
					JSON.stringify({ error: { code: "account_conflict", message: "switched" } }),
					{ status: 409, headers: { "content-type": "application/json" } },
				);
			}
			throw new Error(url);
		});
		await expect(requestRefresh(["repos"])).rejects.toMatchObject({ code: "account_conflict" });
		expect(urls.filter((url) => url === "/api/accounts")).toHaveLength(2);
		expect(urls.filter((url) => url === "/api/refresh")).toHaveLength(1);
	});

	it("drops a refresh payload that omits account_id", async () => {
		setActiveAccountId("acc1");
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url === "/api/accounts") {
				return accountsFor("acc1");
			}
			if (url === "/api/refresh") {
				return Response.json({ kinds: ["repos"] });
			}
			throw new Error(url);
		});
		expect(await requestRefresh(["repos"])).toBeNull();
		expect(urls).toEqual(["/api/accounts", "/api/refresh", "/api/accounts"]);
	});

	it("caches a single-kind payload so the next load skips GET", async () => {
		setActiveAccountId("acc1");
		let issueGets = 0;
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return accountsFor("acc1");
			}
			if (url === "/api/refresh") {
				return Response.json({
					account_id: "acc1",
					fetched_at: "t",
					truncated: false,
					issues: [],
				});
			}
			if (url === "/api/insights") {
				return Response.json({ account_id: "acc1", insights: [] });
			}
			if (url === "/api/issues") {
				issueGets += 1;
				throw new Error("should use cache");
			}
			throw new Error(url);
		});
		await requestRefresh(["issues"]);
		expect(await loadKind("issues")).toMatchObject({ account_id: "acc1", issues: [] });
		expect(issueGets).toBe(0);
	});

	it("refetches each written kind after a multi-kind refresh", async () => {
		setActiveAccountId("acc1");
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url === "/api/accounts") {
				return accountsFor("acc1");
			}
			if (url === "/api/refresh") {
				return Response.json({ account_id: "acc1", kinds: ["repos", "alerts"] });
			}
			if (
				url === "/api/repos" ||
				url === "/api/alerts" ||
				url === "/api/insights" ||
				url === "/api/digest"
			) {
				return Response.json({ account_id: "acc1" });
			}
			throw new Error(url);
		});
		await requestRefresh(["repos", "alerts"]);
		expect(urls.filter((url) => url !== "/api/accounts")).toEqual([
			"/api/refresh",
			"/api/repos",
			"/api/alerts",
			"/api/insights",
			"/api/digest",
		]);
	});

	it("propagates non-missing follow-up errors", async () => {
		setActiveAccountId("acc1");
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return accountsFor("acc1");
			}
			if (url === "/api/refresh") {
				return Response.json({
					account_id: "acc1",
					fetched_at: "t",
					truncated: false,
					issues: [],
				});
			}
			if (url === "/api/insights") {
				return new Response(JSON.stringify({ error: { code: "github_error", message: "boom" } }), {
					status: 502,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(url);
		});
		await expect(requestRefresh(["issues"])).rejects.toMatchObject({ code: "github_error" });
	});

	it("clears in-flight state when session loading fails", async () => {
		setActiveAccountId("acc1");
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input) === "/api/accounts") {
				throw new Error("session boom");
			}
			throw new Error(String(input));
		});
		await expect(requestRefresh(["repos"])).rejects.toThrow("session boom");
		expect(refreshInFlight()).toBe(false);
	});

	it("drops a started refresh when ensureSession switches accounts", async () => {
		setActiveAccountId("acc1");
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return accountsFor("acc2");
			}
			throw new Error(url);
		});
		expect(await requestRefresh(["repos"])).toBeNull();
		expect(refreshInFlight()).toBe(false);
	});

	it("stops applying written kinds after a stamp change", async () => {
		setActiveAccountId("acc1");
		let current = "acc1";
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url === "/api/accounts") {
				return accountsFor(current);
			}
			if (url === "/api/refresh") {
				return Response.json({ account_id: "acc1", kinds: ["repos", "alerts"] });
			}
			if (url === "/api/repos") {
				current = "acc2";
				setActiveAccountId("acc2");
				return Response.json({ account_id: "acc1" });
			}
			throw new Error(url);
		});
		await requestRefresh(["repos", "alerts"]);
		expect(urls).not.toContain("/api/alerts");
	});

	it("maps repo kinds onto snapshot resources", () => {
		expect(resourceOfKind("issues")).toBe("issues");
		expect(resourceOfKind("repo:octocat/hello-world:details")).toBe("repos/octocat/hello-world");
		expect(resourceOfKind("repo:octocat/hello-world:security")).toBe(
			"repos/octocat/hello-world/security",
		);
	});

	it("merges an equivalent job even when another kind is queued", async () => {
		setActiveAccountId("acc1");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let posts = 0;
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return accountsFor("acc1");
			}
			if (url === "/api/refresh") {
				posts += 1;
				const kinds = JSON.parse(String(init?.body)).kinds as string[];
				if (kinds[0] === "repos") {
					await gate;
				}
				return Response.json({
					account_id: "acc1",
					fetched_at: "t",
					truncated: false,
				});
			}
			if (url === "/api/insights" || url === "/api/digest") {
				return Response.json({ account_id: "acc1" });
			}
			throw new Error(url);
		});
		const first = requestRefresh(["repos"]);
		const other = requestRefresh(["alerts"]);
		const again = requestRefresh(["repos"]);
		release();
		await Promise.all([first, other, again]);
		expect(posts).toBe(2);
	});

	it("notifies subscribers when the queue starts and drains", async () => {
		setActiveAccountId("acc1");
		const ticks: boolean[] = [];
		const stop = subscribeRefresh(() => {
			ticks.push(refreshInFlight());
		});
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return accountsFor("acc1");
			}
			if (url === "/api/refresh") {
				return Response.json({
					account_id: "acc1",
					fetched_at: "t",
					truncated: false,
					issues: [],
				});
			}
			if (url === "/api/insights") {
				return Response.json({ account_id: "acc1" });
			}
			throw new Error(url);
		});
		await requestRefresh(["issues"]);
		stop();
		expect(ticks[0]).toBe(true);
		expect(ticks.at(-1)).toBe(false);
	});
});
