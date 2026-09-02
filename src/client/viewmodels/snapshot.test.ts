import { afterEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountId } from "./session";
import { loadKind } from "./snapshot";

describe("snapshot loader", () => {
	afterEach(() => {
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
});
