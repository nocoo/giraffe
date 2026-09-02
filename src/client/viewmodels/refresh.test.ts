import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRefreshQueue, refreshInFlight, requestRefresh } from "./refresh";
import { setActiveAccountId } from "./session";

function accountsFor(id: string): Response {
	return Response.json({ accounts: [{ id, login: "o", is_active: true }] });
}

describe("refresh coordinator", () => {
	afterEach(() => {
		clearRefreshQueue();
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
			if (url === "/api/insights" || url === "/api/digest") {
				return Response.json({ account_id: "acc1", truncated: false });
			}
			throw new Error(url);
		});
		const [a, b] = await Promise.all([requestRefresh(["repos"]), requestRefresh(["repos"])]);
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
			if (url === "/api/insights" || url === "/api/digest") {
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
			throw new Error(url);
		});
		await requestRefresh();
		expect(urls).toEqual(["/api/accounts", "/api/refresh"]);
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
			if (url === "/api/insights" || url === "/api/digest") {
				return Response.json({ account_id: "acc1" });
			}
			throw new Error(url);
		});
		await requestRefresh();
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
			if (url === "/api/insights") {
				return Response.json({ account_id: "acc1" });
			}
			throw new Error(url);
		});
		await requestRefresh(["alerts"]);
		expect(urls).toEqual(["/api/accounts", "/api/refresh", "/api/insights"]);
	});
});
