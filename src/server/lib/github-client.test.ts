import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { ApiError } from "./errors";
import { createGithubClient, TruncatedError } from "./github-client";

function env(partial: Partial<Env>): Env {
	return {
		DB: {} as D1Database,
		ASSETS: { fetch: () => Promise.reject(new Error("no assets")) } as unknown as Fetcher,
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
		...partial,
	};
}

describe("createGithubClient", () => {
	it("ignores GITHUB_API_BASE in production", async () => {
		let called = 0;
		const fake = async (input: RequestInfo | URL) => {
			called += 1;
			expect(String(input)).toBe("https://api.github.com/user");
			return new Response("{}", { status: 200 });
		};
		const client = createGithubClient(
			env({ ENVIRONMENT: "production", GITHUB_API_BASE: "http://127.0.0.1:17046" }),
			fake,
		);
		await client.githubFetch("https://api.github.com/user");
		expect(called).toBe(1);
	});

	it("does not fetch when development origin mismatches", async () => {
		let called = 0;
		const fake = async () => {
			called += 1;
			return new Response("{}", { status: 200 });
		};
		const client = createGithubClient(
			env({ ENVIRONMENT: "development", GITHUB_API_BASE: "http://127.0.0.1:17046" }),
			fake,
		);
		await expect(client.githubFetch("https://api.github.com/user")).rejects.toBeInstanceOf(
			ApiError,
		);
		expect(called).toBe(0);
	});

	it("stops on the 41st fetch", async () => {
		const fake = async () => new Response("{}", { status: 200 });
		const client = createGithubClient(
			env({ ENVIRONMENT: "development", GITHUB_API_BASE: "http://127.0.0.1:17046" }),
			fake,
		);
		for (let i = 0; i < 40; i += 1) {
			await client.githubFetch("http://127.0.0.1:17046/x");
		}
		await expect(client.githubFetch("http://127.0.0.1:17046/x")).rejects.toBeInstanceOf(
			TruncatedError,
		);
		const other = createGithubClient(
			env({ ENVIRONMENT: "development", GITHUB_API_BASE: "http://127.0.0.1:17046" }),
			fake,
		);
		expect(other.count).toBe(0);
	});

	it("maps github statuses and accepts empty 205", async () => {
		const client = createGithubClient(
			env({ ENVIRONMENT: "development", GITHUB_API_BASE: "http://127.0.0.1:17046" }),
			async (input) => {
				const path = String(input);
				if (path.endsWith("/empty")) {
					return new Response(null, { status: 205 });
				}
				if (path.endsWith("/notifications")) {
					return new Response(null, { status: 202 });
				}
				if (path.endsWith("/accepted")) {
					return new Response("{}", { status: 202 });
				}
				if (path.endsWith("/unauth")) {
					return new Response("no", { status: 401 });
				}
				if (path.endsWith("/graphql")) {
					return Response.json({
						data: { ok: true },
						errors: [{ type: "FORBIDDEN" }],
					});
				}
				return new Response("no", { status: 500 });
			},
		);
		expect((await client.githubApi("t", "/empty")).status).toBe(205);
		expect((await client.githubApi("t", "/notifications", { method: "PUT" })).status).toBe(202);
		await expect(client.githubApi("t", "/accepted")).rejects.toMatchObject({
			code: "github_error",
		});
		await expect(client.githubApi("t", "/unauth")).rejects.toMatchObject({
			code: "github_unauthorized",
		});
		const data = await client.githubGraphql("t", "query { ok }", {});
		expect(data).toEqual({});
		const dropped = createGithubClient(
			env({ ENVIRONMENT: "development", GITHUB_API_BASE: "http://127.0.0.1:17046" }),
			async () =>
				Response.json({
					data: { nodes: [null, { name: "kept" }] },
					errors: [{ type: "FORBIDDEN" }],
				}),
		);
		const cleaned = await dropped.githubGraphql("t", "q", {});
		expect(cleaned).toEqual({});
		const byPath = createGithubClient(
			env({ ENVIRONMENT: "development", GITHUB_API_BASE: "http://127.0.0.1:17046" }),
			async () =>
				Response.json({
					data: { nodes: [{ name: "a" }, { name: "drop-me" }] },
					errors: [{ type: "FORBIDDEN", path: ["nodes", 1] }],
				}),
		);
		expect((await byPath.githubGraphql("t", "q", {})).nodes).toEqual([{ name: "a" }]);
		const nested = createGithubClient(
			env({ ENVIRONMENT: "development", GITHUB_API_BASE: "http://127.0.0.1:17046" }),
			async () =>
				Response.json({
					data: {
						viewer: { repositories: { nodes: [{ name: "drop" }, { name: "keep" }] } },
					},
					errors: [{ type: "NOT_FOUND", path: ["viewer", "repositories", "nodes", 0] }],
				}),
		);
		expect((await nested.githubGraphql("t", "q", {})).viewer).toEqual({
			repositories: { nodes: [{ name: "keep" }] },
		});
		const inside = createGithubClient(
			env({ ENVIRONMENT: "development", GITHUB_API_BASE: "http://127.0.0.1:17046" }),
			async () =>
				Response.json({
					data: { nodes: [{ name: "drop", extra: 1 }, { name: "keep" }] },
					errors: [{ type: "FORBIDDEN", path: ["nodes", 0, "name"] }],
				}),
		);
		expect((await inside.githubGraphql("t", "q", {})).nodes).toEqual([{ name: "keep" }]);
		expect(() => createGithubClient(env({ ENVIRONMENT: "development" }))).toThrow(ApiError);
		const net = createGithubClient(
			env({ ENVIRONMENT: "development", GITHUB_API_BASE: "http://127.0.0.1:17046" }),
			async () => {
				throw new Error("offline");
			},
		);
		await expect(net.githubFetch("http://127.0.0.1:17046/x")).rejects.toMatchObject({
			code: "github_error",
		});
		const prefixed = createGithubClient(
			env({ ENVIRONMENT: "development", GITHUB_API_BASE: "http://127.0.0.1:17046/github" }),
			async (input) => {
				expect(String(input)).toBe("http://127.0.0.1:17046/github/user");
				return new Response("{}", { status: 200 });
			},
		);
		await prefixed.githubApi("t", "/user");
		const badJson = createGithubClient(
			env({ ENVIRONMENT: "development", GITHUB_API_BASE: "http://127.0.0.1:17046" }),
			async () => new Response("not-json", { status: 200 }),
		);
		await expect(badJson.githubApi("t", "/user")).rejects.toMatchObject({ code: "github_error" });
		const cap = createGithubClient(
			env({ ENVIRONMENT: "development", GITHUB_API_BASE: "http://127.0.0.1:17046" }),
			async () => {
				throw new TruncatedError();
			},
		);
		await expect(cap.githubFetch("http://127.0.0.1:17046/x")).rejects.toBeInstanceOf(
			TruncatedError,
		);
	});

	it("maps remaining github error statuses and graphql failures", async () => {
		const replies: Response[] = [
			new Response("{}", { status: 200 }),
			new Response("no", { status: 429 }),
			new Response("no", { status: 403 }),
			new Response("no", { status: 403, headers: { "X-RateLimit-Remaining": "0" } }),
			new Response("rate limit exceeded", { status: 403 }),
			new Response("no", { status: 404 }),
			new Response("no", { status: 422 }),
			new Response("no", { status: 500 }),
			new Response("{}", { status: 202 }),
			new Response("not-json", { status: 200 }),
			Response.json({ errors: [{ type: "RATE_LIMITED" }] }),
			Response.json({ data: { ok: true }, errors: [{ type: "OTHER" }] }),
			Response.json({ data: null }),
		];
		const client = createGithubClient(
			env({ ENVIRONMENT: "development", GITHUB_API_BASE: "http://127.0.0.1:17046" }),
			async () => replies.shift() ?? new Response("no", { status: 500 }),
		);
		expect((await client.githubApi("t", "/ok")).status).toBe(200);
		await expect(client.githubApi("t", "/a")).rejects.toMatchObject({
			code: "github_rate_limited",
		});
		await expect(client.githubApi("t", "/f")).rejects.toMatchObject({ code: "github_forbidden" });
		await expect(client.githubApi("t", "/b")).rejects.toMatchObject({
			code: "github_rate_limited",
		});
		await expect(client.githubApi("t", "/b2")).rejects.toMatchObject({
			code: "github_rate_limited",
		});
		await expect(client.githubApi("t", "/c")).rejects.toMatchObject({ code: "not_found" });
		await expect(client.githubApi("t", "/d")).rejects.toMatchObject({ code: "github_error" });
		await expect(client.githubGraphql("t", "q", {})).rejects.toMatchObject({
			code: "github_error",
		});
		await expect(client.githubGraphql("t", "q", {})).rejects.toMatchObject({
			code: "github_error",
		});
		await expect(client.githubGraphql("t", "q", {})).rejects.toMatchObject({
			code: "github_error",
		});
		await expect(client.githubGraphql("t", "q", {})).rejects.toMatchObject({
			code: "github_rate_limited",
		});
		await expect(client.githubGraphql("t", "q", {})).rejects.toMatchObject({
			code: "github_error",
		});
		await expect(client.githubGraphql("t", "q", {})).rejects.toMatchObject({
			code: "github_error",
		});
	});
});
