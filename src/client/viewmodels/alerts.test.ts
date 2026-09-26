// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAlerts } from "./alerts";
import { setActiveAccountId } from "./session";

describe("alerts viewmodel", () => {
	afterEach(() => {
		setActiveAccountId(null);
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("loads alerts after session and maps snapshot_missing", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			if (url === "/api/alerts") {
				return Response.json({
					account_id: "acc1",
					fetched_at: "t",
					truncated: false,
					unavailable: false,
					dependabot_open: 1,
					code_scanning_open: 0,
					items: [],
				});
			}
			throw new Error(url);
		});
		const snap = await loadAlerts();
		expect("missing" in snap).toBe(false);
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input) === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			return new Response(JSON.stringify({ error: { code: "snapshot_missing", message: "n" } }), {
				status: 409,
				headers: { "content-type": "application/json" },
			});
		});
		expect(await loadAlerts()).toEqual({ missing: true });
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
		await expect(loadAlerts()).rejects.toMatchObject({ code: "github_error" });
	});
});
