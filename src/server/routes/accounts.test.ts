import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { createApp } from "../index";
import { insertAccountStmt } from "../lib/db/accounts";
import { createDb } from "../lib/db/d1";
import { openSqliteD1 } from "../lib/db/sqlite-d1";

const PAT = `ghp_${"A".repeat(36)}`;

function env(): Env {
	return {
		DB: openSqliteD1(true),
		ASSETS: { fetch: async () => new Response("x") } as unknown as Fetcher,
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
		TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64),
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://127.0.0.1:17046",
	} as Env;
}

describe("accounts routes", () => {
	afterEach(() => {
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("creates an account and lists it", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/user")) {
				return new Response(JSON.stringify({ login: "octocat", avatar_url: "" }), {
					headers: { "X-OAuth-Scopes": "repo, read:org, read:user, notifications" },
				});
			}
			throw new Error(`unexpected ${url}`);
		});
		const e = env();
		const headers = {
			origin: "https://giraffe.dev.hexly.ai",
			"content-type": "application/json",
		};
		const created = await createApp().request(
			"http://localhost/api/accounts",
			{ method: "POST", headers, body: JSON.stringify({ token: PAT }) },
			e,
		);
		expect(created.status).toBe(201);
		const body = (await created.json()) as { id: string; login: string; is_active: boolean };
		expect(body.login).toBe("octocat");
		expect(body.is_active).toBe(true);
		const listed = await createApp().request("http://localhost/api/accounts", {}, e);
		expect(((await listed.json()) as { accounts: unknown[] }).accounts).toHaveLength(1);
		const repos = await createApp().request("http://localhost/api/repos", {}, e);
		expect(repos.status).toBe(409);
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/graphql")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
				const query = body.query ?? "";
				if (query.includes("search")) {
					return Response.json({
						data: { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } } },
					});
				}
				if (query.includes("vulnerabilityAlerts")) {
					return Response.json({
						data: { repository: { vulnerabilityAlerts: { nodes: [] } } },
					});
				}
				return Response.json({
					data: {
						viewer: {
							repositories: {
								nodes: [
									{
										nameWithOwner: "octocat/hello-world",
										name: "hello-world",
										owner: { login: "octocat" },
										stargazerCount: 1,
										forkCount: 0,
										pushedAt: "2026-08-01T00:00:00.000Z",
									},
								],
								pageInfo: { hasNextPage: false },
							},
						},
					},
				});
			}
			if (url.includes("/notifications") || url.includes("/code-scanning")) {
				return Response.json([]);
			}
			throw new Error(`unexpected ${url}`);
		});
		const refreshed = await createApp().request(
			"http://localhost/api/refresh",
			{
				method: "POST",
				headers,
				body: JSON.stringify({ account_id: body.id, kinds: ["repos"] }),
			},
			e,
		);
		expect(refreshed.status).toBe(200);
		const after = await createApp().request("http://localhost/api/repos", {}, e);
		expect(after.status).toBe(200);
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{
						method: "POST",
						headers,
						body: JSON.stringify({ account_id: body.id, kinds: ["repos", "repos"] }),
					},
					e,
				)
			).status,
		).toBe(400);
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ account_id: body.id }) },
					e,
				)
			).status,
		).toBe(200);
		const id = body.id;
		expect(
			(
				await createApp().request(
					`http://localhost/api/accounts/${id}/activate`,
					{
						method: "POST",
						headers: { origin: "https://giraffe.dev.hexly.ai" },
					},
					e,
				)
			).status,
		).toBe(200);
		expect(
			(
				await createApp().request(
					`http://localhost/api/accounts/${id}`,
					{
						method: "DELETE",
						headers: { origin: "https://giraffe.dev.hexly.ai" },
					},
					e,
				)
			).status,
		).toBe(204);
		expect(
			(
				await createApp().request(
					"http://localhost/api/accounts/nope/activate",
					{ method: "POST", headers: { origin: "https://giraffe.dev.hexly.ai" } },
					e,
				)
			).status,
		).toBe(404);
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ account_id: body.id, kinds: [] }) },
					e,
				)
			).status,
		).toBe(400);
		expect(
			(
				await createApp().request(
					"http://localhost/api/accounts",
					{ method: "POST", headers, body: JSON.stringify({ token: "nope" }) },
					e,
				)
			).status,
		).toBe(400);
		expect(
			(
				await createApp().request(
					"http://localhost/api/accounts",
					{ method: "POST", headers, body: "null" },
					e,
				)
			).status,
		).toBe(400);
		expect(
			(
				await createApp().request(
					"http://localhost/api/accounts",
					{ method: "POST", headers, body: JSON.stringify({ token: 1 }) },
					e,
				)
			).status,
		).toBe(400);
		expect(
			(
				await createApp().request(
					"http://localhost/api/accounts/missing",
					{ method: "DELETE", headers: { origin: "https://giraffe.dev.hexly.ai" } },
					e,
				)
			).status,
		).toBe(404);
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{
						method: "POST",
						headers,
						body: JSON.stringify({ account_id: "gone_account_id_00000", kinds: ["insights"] }),
					},
					e,
				)
			).status,
		).toBe(409);
	});

	it("upserts the same login and rejects missing scopes", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/user")) {
				return new Response(JSON.stringify({ login: "octocat", avatar_url: "x" }), {
					headers: { "X-OAuth-Scopes": "repo" },
				});
			}
			throw new Error(`unexpected ${url}`);
		});
		const e = env();
		const headers = { origin: "https://giraffe.dev.hexly.ai", "content-type": "application/json" };
		const missing = await createApp().request(
			"http://localhost/api/accounts",
			{ method: "POST", headers, body: JSON.stringify({ token: PAT }) },
			e,
		);
		expect(missing.status).toBe(400);
		expect(await missing.json()).toMatchObject({
			error: {
				code: "scopes_missing",
				message: "缺少权限：read:org、read:user、notifications",
			},
		});
		vi.stubGlobal("fetch", async () => {
			return new Response(JSON.stringify({ login: "octocat", avatar_url: "x" }), {
				headers: { "X-OAuth-Scopes": "repo, read:org, read:user, notifications" },
			});
		});
		const first = await createApp().request(
			"http://localhost/api/accounts",
			{ method: "POST", headers, body: JSON.stringify({ token: PAT }) },
			e,
		);
		expect(first.status).toBe(201);
		const second = await createApp().request(
			"http://localhost/api/accounts",
			{ method: "POST", headers, body: JSON.stringify({ token: PAT }) },
			e,
		);
		expect(second.status).toBe(201);
		vi.stubGlobal("fetch", async () => {
			return new Response(JSON.stringify({ login: "hubber", avatar_url: "x" }), {
				headers: { "X-OAuth-Scopes": "repo, read:org, read:user, notifications" },
			});
		});
		const third = await createApp().request(
			"http://localhost/api/accounts",
			{ method: "POST", headers, body: JSON.stringify({ token: PAT }) },
			e,
		);
		expect(third.status).toBe(201);
		expect(((await third.json()) as { is_active: boolean }).is_active).toBe(false);
	});

	it("retries an insert conflict and then fails", async () => {
		vi.stubGlobal("fetch", async () => {
			return new Response(JSON.stringify({ login: "octocat", avatar_url: "" }), {
				headers: { "X-OAuth-Scopes": "repo, read:org, read:user, notifications" },
			});
		});
		const raw = openSqliteD1(true);
		let blows = 1;
		const e = {
			...env(),
			DB: {
				prepare: (sql: string) => raw.prepare(sql),
				batch: async (statements: D1PreparedStatement[]) => {
					const out = await raw.batch(statements);
					if (blows > 0) {
						blows -= 1;
						throw new Error("conflict");
					}
					return out;
				},
			} as unknown as D1Database,
		};
		const headers = { origin: "https://giraffe.dev.hexly.ai", "content-type": "application/json" };
		expect(
			(
				await createApp().request(
					"http://localhost/api/accounts",
					{ method: "POST", headers, body: JSON.stringify({ token: PAT }) },
					e,
				)
			).status,
		).toBe(201);
		const empty = openSqliteD1(true);
		const e2 = {
			...env(),
			DB: {
				prepare: (sql: string) => empty.prepare(sql),
				batch: async () => {
					throw new Error("conflict");
				},
			} as unknown as D1Database,
		};
		expect(
			(
				await createApp().request(
					"http://localhost/api/accounts",
					{
						method: "POST",
						headers,
						body: JSON.stringify({ token: PAT }),
					},
					e2,
				)
			).status,
		).toBe(500);
	});

	it("retries a different-login active-account race as inactive", async () => {
		vi.stubGlobal("fetch", async () => {
			return new Response(JSON.stringify({ login: "octocat", avatar_url: "" }), {
				headers: { "X-OAuth-Scopes": "repo, read:org, read:user, notifications" },
			});
		});
		const raw = openSqliteD1(true);
		const seed = createDb(raw);
		await seed.batch([
			insertAccountStmt(seed, {
				id: "hub1",
				login: "hub",
				avatar_url: "",
				token_ciphertext: "{}",
				token_last4: "hub1",
				key_version: 1,
				scopes: "repo",
				capabilities: "{}",
				is_active: 1,
				created_at: "t",
				updated_at: "t",
				last_used_at: null,
			}),
		]);
		let counts = 0;
		const e = {
			...env(),
			DB: {
				prepare(sql: string) {
					const stmt = raw.prepare(sql);
					if (sql.replace(/\s+/g, " ").startsWith("SELECT COUNT(*)")) {
						return {
							bind: () => this,
							first: async () => {
								counts += 1;
								return { n: counts === 1 ? 0 : 1 };
							},
							all: async () => stmt.all(),
							run: async () => stmt.run(),
						};
					}
					return stmt;
				},
				batch: (statements: D1PreparedStatement[]) => raw.batch(statements),
			} as unknown as D1Database,
		};
		const created = await createApp().request(
			"http://localhost/api/accounts",
			{
				method: "POST",
				headers: { origin: "https://giraffe.dev.hexly.ai", "content-type": "application/json" },
				body: JSON.stringify({ token: PAT }),
			},
			e,
		);
		expect(created.status).toBe(201);
		expect(((await created.json()) as { is_active: boolean }).is_active).toBe(false);
	});

	it("rejects a missing encryption key", async () => {
		vi.stubGlobal("fetch", async () => {
			return new Response(JSON.stringify({ login: "octocat", avatar_url: "" }), {
				headers: { "X-OAuth-Scopes": "repo, read:org, read:user, notifications" },
			});
		});
		const e = env();
		expect(
			(
				await createApp().request(
					"http://localhost/api/accounts",
					{
						method: "POST",
						headers: { origin: "https://giraffe.dev.hexly.ai", "content-type": "application/json" },
						body: JSON.stringify({ token: PAT }),
					},
					{ ...e, TOKEN_ENCRYPTION_KEY_CURRENT: "nope" },
				)
			).status,
		).toBe(500);
	});
});
