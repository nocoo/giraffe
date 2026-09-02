import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRefreshQueue, refreshInFlight, requestRefresh } from "./refresh";
import { setActiveAccountId } from "./session";

describe("refresh coordinator", () => {
	afterEach(() => {
		clearRefreshQueue();
		setActiveAccountId(null);
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("returns null without a session stamp", async () => {
		expect(await requestRefresh(["repos"])).toBeNull();
		expect(refreshInFlight()).toBe(false);
	});

	it("merges equivalent in-flight requests and follows up digest", async () => {
		setActiveAccountId("acc1");
		let posts = 0;
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
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
			if (url === "/api/refresh") {
				return Response.json({ account_id: "other", kinds: ["repos"] });
			}
			throw new Error(url);
		});
		const body = await requestRefresh(["repos"]);
		expect(body?.account_id).toBe("other");
		setActiveAccountId("acc1");
		vi.stubGlobal("fetch", async () => {
			throw new Error("boom");
		});
		await expect(requestRefresh(["alerts"])).rejects.toThrow("boom");
		expect(refreshInFlight()).toBe(false);
	});

	it("does not refetch insights when kinds already include them", async () => {
		setActiveAccountId("acc1");
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url === "/api/refresh") {
				return Response.json({ account_id: "acc1", kinds: ["repos", "insights", "digest"] });
			}
			throw new Error(url);
		});
		await requestRefresh();
		expect(urls).toEqual(["/api/refresh"]);
	});
});
