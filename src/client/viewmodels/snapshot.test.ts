// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountId } from "./session";
import { clearSnapshots, fetchKindAs, loadKind } from "./snapshot";

describe("snapshot loader", () => {
	afterEach(() => {
		clearSnapshots();
		setActiveAccountId(null);
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("discards payloads whose account_id does not match the stamp", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			if (url === "/api/issues") {
				return Response.json({
					account_id: "acc2",
					fetched_at: "t",
					truncated: false,
					issues: [],
				});
			}
			throw new Error(url);
		});
		expect(await loadKind("issues")).toEqual({ missing: true });
	});

	it("discards payloads that omit account_id", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			if (url === "/api/issues") {
				return Response.json({ fetched_at: "t", truncated: false, issues: [] });
			}
			throw new Error(url);
		});
		expect(await loadKind("issues")).toEqual({ missing: true });
	});

	it("discards payloads after the session stamp changes mid-get", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			if (url === "/api/issues") {
				setActiveAccountId("acc2");
				return Response.json({
					account_id: "acc1",
					fetched_at: "t",
					truncated: false,
					issues: [],
				});
			}
			throw new Error(url);
		});
		expect(await loadKind("issues")).toEqual({ missing: true });
	});

	it("returns a cached snapshot without a second GET", async () => {
		let issuesGets = 0;
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			if (url === "/api/issues") {
				issuesGets += 1;
				return Response.json({
					account_id: "acc1",
					fetched_at: "t",
					truncated: false,
					issues: [],
				});
			}
			throw new Error(url);
		});
		expect(await loadKind("issues")).toMatchObject({ account_id: "acc1" });
		expect(await loadKind("issues")).toMatchObject({ account_id: "acc1" });
		expect(issuesGets).toBe(1);
	});

	it("skips fetchKindAs when the local stamp is stale", async () => {
		setActiveAccountId("acc2");
		expect(await fetchKindAs("issues", "acc1")).toEqual({ missing: true });
	});
});
