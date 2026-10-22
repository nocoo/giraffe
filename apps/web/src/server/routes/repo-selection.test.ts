import { describe, expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { createDb } from "../lib/db/d1";
import { replaceSnapshotStmts } from "../lib/db/snapshots";

const id = "account_statistics_01";
const at = "2026-09-18T00:00:00.000Z";
async function setup() {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,?,?,?,1,?,?)",
		)
		.bind(id, "nocoo", "encrypted", "fake", at, at)
		.run();
	const env = {
		FACTORY_QUEUE: {} as Queue,
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
		DB: raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://127.0.0.1:17046",
		ASSETS: { fetch: async () => new Response() } as unknown as Fetcher,
	} satisfies Env;
	const save = async (kind: string, payload: Record<string, unknown>) => {
		const db = createDb(raw);
		await db.batch(await replaceSnapshotStmts(db, id, kind, payload, at));
	};
	const repos = [
		{
			name_with_owner: "nocoo/app",
			is_fork: false,
			is_archived: false,
			stargazer_count: 12,
			fork_count: 2,
			open_issue_count: 1,
		},
		{
			name_with_owner: "nocoo/fork",
			is_fork: true,
			is_archived: false,
			stargazer_count: 90,
			fork_count: 9,
			open_issue_count: 8,
		},
		{
			name_with_owner: "nocoo/archive",
			is_fork: false,
			is_archived: true,
			stargazer_count: 100,
			fork_count: 10,
			open_issue_count: 9,
		},
	];
	await save("repos", { repos });
	for (const [kind, key] of [
		["issues", "issues"],
		["prs", "pull_requests"],
		["insights", "insights"],
		["notifications", "notifications"],
		["alerts", "items"],
	]) {
		await save(kind as string, {
			[key as string]: repos.map((r) => ({
				name_with_owner: r.name_with_owner,
				source: "dependabot",
			})),
			dependabot_open: 3,
			code_scanning_open: 0,
		});
	}
	const factory = factoryFixture();
	factory.account_id = id;
	const first = factory.repos[0];
	if (!first) throw new Error("fixture");
	factory.repos = repos.map((r, i) => ({
		...first,
		id: String(i),
		name: r.name_with_owner,
	}));
	await save("factory", { ...factory });
	const request = (path: string, body?: unknown) =>
		createApp().request(
			`http://localhost/api/${path}`,
			body === undefined
				? {}
				: {
						method: "POST",
						headers: { origin: "https://giraffe.dev.hexly.ai", "content-type": "application/json" },
						body: JSON.stringify(body),
					},
			env,
		);
	const get = async (path: string) => {
		const response = await request(path);
		expect(response.status).toBe(200);
		return response.json() as Promise<{
			[key: string]: unknown;
			repos: Array<{ statistics_enabled: boolean; name: string }>;
			issues: unknown[];
		}>;
	};
	return { raw, env, save, request, get };
}

describe("owned catalog and local star selection", () => {
	it("includes owned forks and archives in all scope and derives the deprecated flag from stars", async () => {
		const { get, request } = await setup();
		expect((await get("repos")).repos.map((repo) => repo.statistics_enabled)).toEqual([
			false,
			false,
			false,
		]);
		for (const [path, key] of [
			["issues", "issues"],
			["prs", "pull_requests"],
			["insights", "insights"],
			["notifications", "notifications"],
			["alerts", "items"],
		] as const)
			expect((await get(path))[key]).toHaveLength(3);
		expect((await get("alerts")).dependabot_open).toBe(3);
		expect((await get("factory")).repos.map((repo) => repo.name)).toEqual([
			"nocoo/app",
			"nocoo/fork",
			"nocoo/archive",
		]);
		expect((await get("factory?scope=starred")).repos).toEqual([]);
		expect((await request("repos/nocoo/fork/star", { account_id: id, enabled: true })).status).toBe(
			200,
		);
		expect((await get("repos")).repos.map((repo) => repo.statistics_enabled)).toEqual([
			false,
			true,
			false,
		]);
		expect((await get("factory?scope=starred")).repos.map((repo) => repo.name)).toEqual([
			"nocoo/fork",
		]);
		expect((await get("issues?scope=starred")).issues).toHaveLength(1);
	});

	it("rejects deprecated statistics writes without reading or changing legacy overrides", async () => {
		const { request, raw } = await setup();
		await raw.prepare("INSERT INTO repo_statistics VALUES(?, 'nocoo/fork', 0)").bind(id).run();
		const before = await raw.prepare("SELECT * FROM repo_statistics").all();
		for (const name of ["nocoo/fork", "nocoo/missing"])
			for (const enabled of [true, false, "invalid"]) {
				const response = await request(`repos/${name}/statistics`, { account_id: id, enabled });
				expect(response.status).toBe(410);
				expect(await response.json()).toMatchObject({ error: { code: "deprecated" } });
			}
		expect(await raw.prepare("SELECT * FROM repo_statistics").all()).toEqual(before);
	});

	it("validates stars against the whole saved catalog with account and Origin fences", async () => {
		const { request, env, raw, save, get } = await setup();
		expect(
			(await request("repos/nocoo/app/star", { account_id: id, enabled: "false" })).status,
		).toBe(400);
		expect(
			(await request("repos/nocoo/missing/star", { account_id: id, enabled: true })).status,
		).toBe(404);
		expect(
			(
				await request("repos/nocoo/app/star", {
					account_id: "account_statistics_02",
					enabled: true,
				})
			).status,
		).toBe(409);
		expect(
			(
				await createApp().request(
					"http://localhost/api/repos/nocoo/app/star",
					{
						method: "POST",
						headers: { origin: "https://evil.example", "content-type": "application/json" },
						body: JSON.stringify({ account_id: id, enabled: true }),
					},
					env,
				)
			).status,
		).toBe(403);
		await save("repos", {
			repos: [{ name_with_owner: "external/fork", is_archived: true, is_fork: true }],
		});
		expect(
			(await request("repos/EXTERNAL/FORK/star", { account_id: id, enabled: true })).status,
		).toBe(200);
		expect((await raw.prepare("SELECT repo FROM repo_stars").all()).results).toEqual([
			{ repo: "external/fork" },
		]);
		expect((await get("repos?scope=starred")).repos).toEqual([]);
		expect(
			(await request("repos/external/fork/star", { account_id: id, enabled: false })).status,
		).toBe(200);
		await raw.prepare("UPDATE accounts SET is_active=0").run();
		expect(
			(await request("repos/external/fork/star", { account_id: id, enabled: true })).status,
		).toBe(409);
	});

	it("refreshes owned forks and rejects nonowned selected refresh membership", async () => {
		const { request, get, save } = await setup();
		expect((await request("factory/repos/nocoo/fork/commits")).status).toBe(200);
		expect((await get("factory/runs")).catalog).toHaveLength(3);
		await save("repos", {
			repos: [{ name_with_owner: "nocoo/fork" }, { name_with_owner: "external/app" }],
		});
		expect(
			(
				await request("factory/runs", {
					account_id: id,
					requestKey: crypto.randomUUID(),
					mode: "refresh",
					scope: "selected",
					repos: ["external/app"],
				})
			).status,
		).toBe(400);
		expect(
			(
				await request("factory/runs", {
					account_id: id,
					requestKey: crypto.randomUUID(),
					mode: "refresh",
					scope: "selected",
					repos: ["nocoo/fork"],
				})
			).status,
		).toBe(202);
	});
});
