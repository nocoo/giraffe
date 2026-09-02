import { afterEach, describe, expect, it, vi } from "vitest";
import { apiDelete, apiGet, apiPost } from "./api";

describe("api client", () => {
	afterEach(() => {
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("gets json from relative /api paths and throws envelopes", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			expect(url.startsWith("/api/")).toBe(true);
			expect(init?.credentials).toBe("same-origin");
			if (url === "/api/repos") {
				return Response.json({ account_id: "a", fetched_at: "t", truncated: false, repos: [] });
			}
			if (url === "/api/accounts") {
				return new Response(
					JSON.stringify({ error: { code: "account_missing", message: "none" } }),
					{
						status: 409,
						headers: { "content-type": "application/json" },
					},
				);
			}
			throw new Error(url);
		});
		const repos = await apiGet<{ repos: unknown[] }>("repos");
		expect(repos.repos).toEqual([]);
		await expect(apiGet("accounts")).rejects.toMatchObject({
			code: "account_missing",
			status: 409,
		});
	});

	it("posts json, deletes, and treats 204 as void", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			seen.push(`${init?.method ?? "GET"} ${url}`);
			if (url === "/api/refresh") {
				expect(init?.body).toContain("account_id");
				return Response.json({ account_id: "a", kinds: ["repos"] });
			}
			if (url === "/api/accounts/x") {
				return new Response(null, { status: 204 });
			}
			throw new Error(url);
		});
		const posted = await apiPost<{ kinds: string[] }>("refresh", { account_id: "a", kinds: "all" });
		expect(posted.kinds).toEqual(["repos"]);
		await apiDelete("accounts/x");
		expect(seen).toEqual(["POST /api/refresh", "DELETE /api/accounts/x"]);
	});

	it("covers envelope fallbacks and empty post", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "/api/a") {
				return new Response("null", {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
			if (url === "/api/b") {
				return new Response(JSON.stringify({ error: {} }), {
					status: 502,
					headers: { "content-type": "application/json" },
				});
			}
			if (url === "/api/c") {
				expect(init?.body).toBeUndefined();
				return new Response(null, { status: 204 });
			}
			if (url === "/api/d") {
				return new Response(JSON.stringify({ error: { code: "nope", message: "x" } }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(url);
		});
		await expect(apiGet("a")).rejects.toMatchObject({ code: "internal_error", status: 500 });
		await expect(apiGet("b")).rejects.toMatchObject({ code: "internal_error", status: 502 });
		await expect(apiPost("c")).resolves.toBeUndefined();
		await expect(apiGet("d")).rejects.toMatchObject({ code: "internal_error", status: 500 });
	});
});
