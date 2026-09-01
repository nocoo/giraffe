import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { createApp } from "../index";
import { insertAccountStmt } from "../lib/db/accounts";
import { createDb } from "../lib/db/d1";
import { replaceSnapshotStmts } from "../lib/db/snapshots";
import { openSqliteD1 } from "../lib/db/sqlite-d1";
import { encryptToken, parseKeyBytes } from "../lib/token-crypto";

const PAT = `ghp_${"A".repeat(36)}`;
const KEY = "0".repeat(64);

function env(): Env {
	return {
		DB: openSqliteD1(true),
		ASSETS: { fetch: async () => new Response("x") } as unknown as Fetcher,
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
		TOKEN_ENCRYPTION_KEY_V1: KEY,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://127.0.0.1:17046",
	} as Env;
}

const headers = {
	origin: "https://giraffe.dev.hexly.ai",
	"content-type": "application/json",
};

function graphqlData(query: string): Record<string, unknown> {
	if (query.includes("viewer")) {
		return {
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
								issues: { totalCount: 1 },
							},
						],
						pageInfo: { hasNextPage: false },
					},
				},
			},
		};
	}
	if (query.includes("search")) {
		return { data: { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } } } };
	}
	return { data: { repository: { vulnerabilityAlerts: { nodes: [] } } } };
}

function stubGithub(extra?: (url: string) => Response | undefined): void {
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const custom = extra?.(url);
		if (custom) {
			return custom;
		}
		if (url.endsWith("/user")) {
			return new Response(JSON.stringify({ login: "octocat", avatar_url: "" }), {
				headers: { "X-OAuth-Scopes": "repo, read:org, read:user, notifications" },
			});
		}
		if (url.endsWith("/graphql")) {
			const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
			return Response.json(graphqlData(body.query ?? ""));
		}
		if (url.includes("/notifications")) {
			return Response.json([]);
		}
		if (url.includes("/code-scanning")) {
			return Response.json([]);
		}
		if (url.includes("/repos/octocat/hello-world/languages")) {
			return Response.json({ TypeScript: 1 });
		}
		if (url.includes("/repos/octocat/hello-world/actions")) {
			return Response.json({ workflow_runs: [] });
		}
		if (url.includes("/traffic/")) {
			return Response.json({ count: 0, uniques: 0, views: [], clones: [] });
		}
		if (url.includes("/releases")) {
			return Response.json([]);
		}
		if (url.includes("/contributors")) {
			return Response.json([]);
		}
		if (url.includes("/repos/")) {
			return Response.json({ default_branch: "main", html_url: "u" });
		}
		throw new Error(`unexpected ${url}`);
	});
}

async function createAccount(e: Env): Promise<string> {
	stubGithub();
	const created = await createApp().request(
		"http://localhost/api/accounts",
		{ method: "POST", headers, body: JSON.stringify({ token: PAT }) },
		e,
	);
	const body = (await created.json()) as { id: string };
	return body.id;
}

describe("refresh route", () => {
	afterEach(() => {
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("refreshes all kinds and single repo kinds", async () => {
		const e = env();
		await createAccount(e);
		stubGithub();
		const all = await createApp().request(
			"http://localhost/api/refresh",
			{ method: "POST", headers, body: JSON.stringify({}) },
			e,
		);
		expect(all.status).toBe(200);
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							kinds: Array.from({ length: 16 }, (_, i) => `repo:octocat/r${i}:details`),
						}),
					},
					e,
				)
			).status,
		).toBe(200);
		const body = (await all.json()) as { kinds: string[] };
		expect(body.kinds).toContain("repos");
		const single = await createApp().request(
			"http://localhost/api/refresh",
			{ method: "POST", headers, body: JSON.stringify({ kinds: ["repos"] }) },
			e,
		);
		expect(single.status).toBe(200);
		expect(await single.json()).toMatchObject({ truncated: false });
		const details = await createApp().request(
			"http://localhost/api/refresh",
			{
				method: "POST",
				headers,
				body: JSON.stringify({ kinds: ["repo:octocat/hello-world:details"] }),
			},
			e,
		);
		expect(details.status).toBe(200);
		expect(
			(await createApp().request("http://localhost/api/repos/octocat/hello-world", {}, e)).status,
		).toBe(200);
		for (const suffix of [
			"actions",
			"traffic",
			"security",
			"issues",
			"prs",
			"releases",
			"languages",
			"contributors",
		]) {
			expect(
				(
					await createApp().request(
						"http://localhost/api/refresh",
						{
							method: "POST",
							headers,
							body: JSON.stringify({ kinds: [`repo:octocat/hello-world:${suffix}`] }),
						},
						e,
					)
				).status,
			).toBe(200);
		}
	});

	it("validates kinds and requires sources", async () => {
		const e = env();
		await createAccount(e);
		stubGithub();
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ kinds: ["nope"] }) },
					e,
				)
			).status,
		).toBe(400);
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ kinds: ["repo:./n:details"] }) },
					e,
				)
			).status,
		).toBe(400);
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ kinds: ["issues"] }) },
					e,
				)
			).status,
		).toBe(409);
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ kinds: ["insights"] }) },
					e,
				)
			).status,
		).toBe(409);
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ kinds: ["digest"] }) },
					e,
				)
			).status,
		).toBe(409);
		await createApp().request(
			"http://localhost/api/refresh",
			{ method: "POST", headers, body: JSON.stringify({ kinds: ["repos"] }) },
			e,
		);
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ kinds: ["digest"] }) },
					e,
				)
			).status,
		).toBe(200);
		await createApp().request(
			"http://localhost/api/refresh",
			{ method: "POST", headers, body: JSON.stringify({ kinds: ["repos"] }) },
			e,
		);
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ kinds: ["issues", "prs", "alerts"] }) },
					e,
				)
			).status,
		).toBe(200);
	});

	it("does not persist on github hard failure", async () => {
		const e = env();
		await createAccount(e);
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input).endsWith("/graphql")) {
				return new Response("no", { status: 401 });
			}
			throw new Error("unexpected");
		});
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ kinds: ["repos"] }) },
					e,
				)
			).status,
		).toBe(401);
		expect((await createApp().request("http://localhost/api/repos", {}, e)).status).toBe(409);
	});

	it("rejects missing capabilities and encryption", async () => {
		const e = env();
		const db = createDb(e.DB);
		const envelope = await encryptToken(PAT, parseKeyBytes(KEY));
		await db.batch([
			insertAccountStmt(db, {
				id: "acc_missing_caps",
				login: "octocat",
				avatar_url: "",
				token_ciphertext: envelope,
				token_last4: "AAAA",
				key_version: 1,
				scopes: "repo",
				capabilities: JSON.stringify({
					repo: false,
					"read:org": false,
					"read:user": false,
					notifications: false,
				}),
				is_active: 1,
				created_at: "t",
				updated_at: "t",
				last_used_at: null,
			}),
		]);
		stubGithub();
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ kinds: ["repos"] }) },
					e,
				)
			).status,
		).toBe(409);
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ kinds: ["notifications"] }) },
					e,
				)
			).status,
		).toBe(409);
		const broken = env();
		const db2 = createDb(broken.DB);
		await db2.batch([
			insertAccountStmt(db2, {
				id: "acc_bad_json",
				login: "octocat",
				avatar_url: "",
				token_ciphertext: envelope,
				token_last4: "AAAA",
				key_version: 1,
				scopes: "repo",
				capabilities: "not-json",
				is_active: 1,
				created_at: "t",
				updated_at: "t",
				last_used_at: null,
			}),
		]);
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ kinds: ["repos"] }) },
					broken,
				)
			).status,
		).toBe(409);
		const noKey = {
			...env(),
			TOKEN_ENCRYPTION_KEY_V1: undefined,
		} as Env;
		noKey.DB = e.DB;
		await createApp().request(
			"http://localhost/api/accounts",
			{ method: "POST", headers, body: JSON.stringify({ token: PAT }) },
			e,
		);
		const missingKey = await createApp().request(
			"http://localhost/api/refresh",
			{ method: "POST", headers, body: JSON.stringify({ kinds: ["repos"] }) },
			{ ...e, TOKEN_ENCRYPTION_KEY_V1: undefined } as Env,
		);
		expect(missingKey.status).toBe(500);
	});

	it("writes explicit insights and stops later kinds after the staged cap", async () => {
		const e = env();
		const id = await createAccount(e);
		const db = createDb(e.DB);
		const fetchedAt = "2026-09-01T00:00:00.000Z";
		await db.batch(
			replaceSnapshotStmts(db, id, "issues", { truncated: false, issues: [] }, fetchedAt),
		);
		await db.batch(
			replaceSnapshotStmts(
				db,
				id,
				"alerts",
				{
					truncated: false,
					unavailable: false,
					items: [],
					dependabot_open: 0,
					code_scanning_open: 0,
				},
				fetchedAt,
			),
		);
		stubGithub();
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ kinds: ["repos", "insights"] }) },
					e,
				)
			).status,
		).toBe(200);
		expect((await createApp().request("http://localhost/api/insights", {}, e)).status).toBe(200);
		let notifications = 0;
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/graphql")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
				if ((body.query ?? "").includes("viewer")) {
					return Response.json({
						data: {
							viewer: {
								repositories: {
									nodes: Array.from({ length: 9 }, (_, i) => ({
										nameWithOwner: `o/n${i}`,
										description: "x".repeat(2_000_000),
									})),
									pageInfo: { hasNextPage: false },
								},
							},
						},
					});
				}
				return Response.json(graphqlData(body.query ?? ""));
			}
			if (url.includes("/notifications")) {
				notifications += 1;
				return Response.json([]);
			}
			throw new Error(`unexpected ${url}`);
		});
		const capped = await createApp().request(
			"http://localhost/api/refresh",
			{ method: "POST", headers, body: JSON.stringify({ kinds: ["repos", "notifications"] }) },
			e,
		);
		expect(capped.status).toBe(200);
		expect(notifications).toBe(0);
		const odd = env();
		const oddId = await createAccount(odd);
		const oddDb = createDb(odd.DB);
		await oddDb.batch(replaceSnapshotStmts(oddDb, oddId, "repos", { truncated: false }, fetchedAt));
		await oddDb.batch(
			replaceSnapshotStmts(oddDb, oddId, "issues", { truncated: false, issues: [] }, fetchedAt),
		);
		await oddDb.batch(
			replaceSnapshotStmts(
				oddDb,
				oddId,
				"alerts",
				{
					truncated: false,
					items: [],
					unavailable: false,
					dependabot_open: 0,
					code_scanning_open: 0,
				},
				fetchedAt,
			),
		);
		stubGithub();
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ kinds: ["insights"] }) },
					odd,
				)
			).status,
		).toBe(200);
		const trunc = env();
		const truncId = await createAccount(trunc);
		const truncDb = createDb(trunc.DB);
		await truncDb.batch(
			replaceSnapshotStmts(
				truncDb,
				truncId,
				"repos",
				{ truncated: true, repos: [{ name_with_owner: "o/n" }, {}] },
				fetchedAt,
			),
		);
		stubGithub();
		const issues = await createApp().request(
			"http://localhost/api/refresh",
			{ method: "POST", headers, body: JSON.stringify({ kinds: ["issues"] }) },
			trunc,
		);
		expect(issues.status).toBe(200);
		expect(((await issues.json()) as { truncated: boolean }).truncated).toBe(true);
	});
});
