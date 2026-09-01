import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { createApp } from "../index";
import { insertAccountStmt } from "../lib/db/accounts";
import { createDb } from "../lib/db/d1";
import { upsertDayStmt } from "../lib/db/snapshot-days";
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
		const later = env();
		await createAccount(later);
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/graphql")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
				if ((body.query ?? "").includes("viewer")) {
					return Response.json(graphqlData(body.query ?? ""));
				}
				return new Response("no", { status: 401 });
			}
			throw new Error(`unexpected ${url}`);
		});
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ kinds: ["repos", "issues"] }) },
					later,
				)
			).status,
		).toBe(401);
		expect((await createApp().request("http://localhost/api/repos", {}, later)).status).toBe(409);
		expect((await createApp().request("http://localhost/api/issues", {}, later)).status).toBe(409);
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
		expect((await createApp().request("http://localhost/api/notifications", {}, e)).status).toBe(
			409,
		);
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

	it("treats fetch cap as truncation and keeps batches small", async () => {
		const e = env();
		let lastBatch = 0;
		const sqlOf = new WeakMap<object, string>();
		const raw = e.DB;
		e.DB = {
			prepare: (sql: string) => {
				const stmt = raw.prepare(sql);
				const originalBind = stmt.bind.bind(stmt);
				stmt.bind = (...values: unknown[]) => {
					const bound = originalBind(...values);
					sqlOf.set(bound as object, sql);
					return bound;
				};
				sqlOf.set(stmt as object, sql);
				return stmt;
			},
			batch: async (statements: D1PreparedStatement[]) => {
				lastBatch = statements.length;
				if (statements.length > 2) {
					const sqls = statements.map((statement) => sqlOf.get(statement as object) ?? "");
					expect(sqls.some((sql) => sql.includes("snapshots"))).toBe(true);
					expect(sqls.some((sql) => sql.includes("last_used_at"))).toBe(true);
				}
				return raw.batch(statements);
			},
		} as D1Database;
		await createAccount(e);
		stubGithub();
		const all = await createApp().request(
			"http://localhost/api/refresh",
			{ method: "POST", headers, body: JSON.stringify({}) },
			e,
		);
		expect(all.status).toBe(200);
		expect(lastBatch).toBeLessThan(80);
		let n = 0;
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/user")) {
				return new Response(JSON.stringify({ login: "octocat", avatar_url: "" }), {
					headers: { "X-OAuth-Scopes": "repo, read:org, read:user, notifications" },
				});
			}
			n += 1;
			if (url.includes("/notifications")) {
				return new Response("[]", {
					headers: { link: '<http://127.0.0.1:17046/notifications?page=2>; rel="next"' },
				});
			}
			if (url.includes("/repos/")) {
				return Response.json({ default_branch: "main", html_url: "u" });
			}
			throw new Error(`unexpected ${url}`);
		});
		const capped = await createApp().request(
			"http://localhost/api/refresh",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					kinds: ["notifications", "repo:octocat/hello-world:details"],
				}),
			},
			e,
		);
		expect(capped.status).toBe(200);
		expect(n).toBeGreaterThan(30);
		const details = await createApp().request(
			"http://localhost/api/repos/octocat/hello-world",
			{},
			e,
		);
		expect(details.status).toBe(409);
		const huge = env();
		const hugeId = await createAccount(huge);
		const hugeDb = createDb(huge.DB);
		const repos = Array.from({ length: 40 }, (_, i) => ({
			name_with_owner: `org/r${i}`,
			open_issue_count: 0,
			pushed_at: "2026-08-01T00:00:00.000Z",
			stargazer_count: 0,
			fork_count: 0,
		}));
		const items = repos.flatMap((repo) =>
			Array.from({ length: 80 }, () => ({
				name_with_owner: repo.name_with_owner,
				source: "dependabot",
				severity: "low",
				summary: "s".repeat(2_000),
				url: "https://example.com/a",
			})),
		);
		const fetchedAt = "2026-09-01T00:00:00.000Z";
		await hugeDb.batch(
			replaceSnapshotStmts(hugeDb, hugeId, "repos", { truncated: false, repos }, fetchedAt),
		);
		await hugeDb.batch(
			replaceSnapshotStmts(hugeDb, hugeId, "issues", { truncated: false, issues: [] }, fetchedAt),
		);
		await hugeDb
			.prepare("INSERT INTO snapshots (account_id, kind, payload, fetched_at) VALUES (?, ?, ?, ?)")
			.bind(
				hugeId,
				"alerts",
				JSON.stringify({
					truncated: false,
					items,
					unavailable: false,
					dependabot_open: items.length,
					code_scanning_open: 0,
				}),
				fetchedAt,
			)
			.run();
		stubGithub();
		const explicit = await createApp().request(
			"http://localhost/api/refresh",
			{ method: "POST", headers, body: JSON.stringify({ kinds: ["insights"] }) },
			huge,
		);
		expect(explicit.status).toBe(200);
		const explicitBody = (await explicit.json()) as { truncated: boolean };
		expect(explicitBody.truncated).toBe(true);
		const got = await createApp().request("http://localhost/api/insights", {}, huge);
		expect(await got.json()).toEqual(explicitBody);
		const skip = env();
		const skipId = await createAccount(skip);
		const skipDb = createDb(skip.DB);
		await skipDb.batch(
			replaceSnapshotStmts(skipDb, skipId, "repos", { truncated: false, repos }, fetchedAt),
		);
		await skipDb.batch(
			replaceSnapshotStmts(skipDb, skipId, "issues", { truncated: false, issues: [] }, fetchedAt),
		);
		await skipDb
			.prepare("INSERT INTO snapshots (account_id, kind, payload, fetched_at) VALUES (?, ?, ?, ?)")
			.bind(
				skipId,
				"alerts",
				JSON.stringify({
					truncated: false,
					items,
					unavailable: false,
					dependabot_open: items.length,
					code_scanning_open: 0,
				}),
				fetchedAt,
			)
			.run();
		stubGithub();
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ kinds: ["notifications"] }) },
					skip,
				)
			).status,
		).toBe(200);
		expect((await createApp().request("http://localhost/api/insights", {}, skip)).status).toBe(409);
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/graphql")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
				if ((body.query ?? "").includes("viewer")) {
					return Response.json({
						data: {
							viewer: {
								repositories: {
									nodes: Array.from({ length: 40 }, (_, i) => ({
										nameWithOwner: `org/r${i}`,
										name: `r${i}`,
										owner: { login: "org" },
										pushedAt: "2026-08-01T00:00:00.000Z",
										issues: { totalCount: 0 },
									})),
									pageInfo: { hasNextPage: false },
								},
							},
						},
					});
				}
				return Response.json(graphqlData(body.query ?? ""));
			}
			throw new Error(`unexpected ${url}`);
		});
		const mixed = await createApp().request(
			"http://localhost/api/refresh",
			{ method: "POST", headers, body: JSON.stringify({ kinds: ["repos", "insights"] }) },
			huge,
		);
		expect(mixed.status).toBe(200);
		const mixedBody = (await mixed.json()) as { truncated_kinds: string[] };
		expect(mixedBody.truncated_kinds).toContain("insights");
		const digestEnv = env();
		const digestId = await createAccount(digestEnv);
		const digestDb = createDb(digestEnv.DB);
		const fatRepos = Array.from({ length: 80 }, (_, i) => ({
			name_with_owner: `org/${"r".repeat(80_000)}${i}`,
			stargazer_count: 0,
			fork_count: 0,
			open_issue_count: 0,
		}));
		await digestDb
			.prepare("INSERT INTO snapshots (account_id, kind, payload, fetched_at) VALUES (?, ?, ?, ?)")
			.bind(digestId, "repos", JSON.stringify({ truncated: false, repos: fatRepos }), fetchedAt)
			.run();
		await digestDb.batch([
			upsertDayStmt(digestDb, digestId, new Date().toISOString().slice(0, 10), {
				stars: 0,
				forks: 0,
				open_issues: 0,
				repos: fatRepos.length,
				by_repo: [],
			}),
		]);
		stubGithub();
		const digestRes = await createApp().request(
			"http://localhost/api/refresh",
			{ method: "POST", headers, body: JSON.stringify({ kinds: ["digest"] }) },
			digestEnv,
		);
		expect(digestRes.status).toBe(200);
		const digestBody = (await digestRes.json()) as { truncated: boolean };
		expect(digestBody.truncated).toBe(true);
		expect(
			await (await createApp().request("http://localhost/api/digest", {}, digestEnv)).json(),
		).toEqual(digestBody);
	});

	it("aborts cross-repo search http errors without writing", async () => {
		const e = env();
		await createAccount(e);
		stubGithub();
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ kinds: ["repos"] }) },
					e,
				)
			).status,
		).toBe(200);
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/graphql")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
				if ((body.query ?? "").includes("search")) {
					return new Response("no", { status: 403 });
				}
				return Response.json(graphqlData(body.query ?? ""));
			}
			throw new Error(`unexpected ${url}`);
		});
		const failed = await createApp().request(
			"http://localhost/api/refresh",
			{ method: "POST", headers, body: JSON.stringify({ kinds: ["issues"] }) },
			e,
		);
		expect(failed.status).toBe(403);
		expect((await createApp().request("http://localhost/api/issues", {}, e)).status).toBe(409);
		expect((await createApp().request("http://localhost/api/repos", {}, e)).status).toBe(200);
	});

	it("does not write later kinds after the fetch cap", async () => {
		const e = env();
		await createAccount(e);
		let pages = 0;
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (!url.endsWith("/graphql")) {
				throw new Error(`unexpected ${url}`);
			}
			pages += 1;
			return Response.json({
				data: {
					viewer: {
						repositories: {
							nodes: [{ nameWithOwner: "o/n", issues: { totalCount: 0 } }],
							pageInfo: { hasNextPage: true, endCursor: `c${pages}` },
						},
					},
				},
			});
		});
		const res = await createApp().request(
			"http://localhost/api/refresh",
			{ method: "POST", headers, body: JSON.stringify({}) },
			e,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { kinds: string[] };
		expect(body.kinds).toEqual(["repos"]);
		expect(pages).toBe(40);
		expect((await createApp().request("http://localhost/api/issues", {}, e)).status).toBe(409);
	});
});
