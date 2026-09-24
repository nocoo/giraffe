import { describe, expect, it } from "vitest";
import { factoryFixture } from "../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../tests/fixtures/sqlite";
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
		await db.batch(replaceSnapshotStmts(db, id, kind, payload, at));
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

describe("global repository statistics selection", () => {
	it("defaults forks/archives off across lists, counters, factory and insights", async () => {
		const { get } = await setup();
		expect(
			(await get("repos")).repos.map((r: { statistics_enabled: boolean }) => r.statistics_enabled),
		).toEqual([true, false, false]);
		for (const [path, key] of [
			["issues", "issues"],
			["prs", "pull_requests"],
			["insights", "insights"],
			["notifications", "notifications"],
			["alerts", "items"],
		] as const)
			expect((await get(path))[key]).toHaveLength(1);
		expect((await get("alerts")).dependabot_open).toBe(1);
		expect((await get("factory")).repos.map((r: { name: string }) => r.name)).toEqual([
			"nocoo/app",
		]);
		expect((await get("factory")).contribution).toBeNull();
	});
	it("persists overrides across refreshes and can re-enable a fork without destroying snapshots", async () => {
		const { request, get, save } = await setup();
		expect(
			(await request("repos/nocoo/fork/statistics", { account_id: id, enabled: true })).status,
		).toBe(200);
		expect((await get("issues")).issues).toHaveLength(2);
		expect((await get("factory")).repos).toHaveLength(2);
		expect(
			(await request("repos/nocoo/app/statistics", { account_id: id, enabled: false })).status,
		).toBe(200);
		const current = await get("repos");
		await save("repos", {
			repos: current.repos.map((r: Record<string, unknown>) => ({
				...r,
				statistics_enabled: undefined,
			})),
		});
		expect(
			(await get("repos")).repos.map((r: { statistics_enabled: boolean }) => r.statistics_enabled),
		).toEqual([false, true, false]);
		expect(
			(await request("repos/nocoo/app/statistics", { account_id: id, enabled: true })).status,
		).toBe(200);
		expect((await get("issues")).issues).toHaveLength(2);
	});
	it("rejects invalid settings, unknown repositories, stale accounts and cross-origin writes", async () => {
		const { request, env, raw } = await setup();
		expect(
			(
				await createApp().request(
					"http://localhost/api/repos/nocoo/app/statistics",
					{
						method: "POST",
						headers: { origin: "https://evil.example", "content-type": "application/json" },
						body: JSON.stringify({ account_id: id, enabled: false }),
					},
					env,
				)
			).status,
		).toBe(403);
		expect(
			(await request("repos/nocoo/app/statistics", { account_id: id, enabled: "false" })).status,
		).toBe(400);
		expect(
			(await request("repos/nocoo/missing/statistics", { account_id: id, enabled: false })).status,
		).toBe(404);
		expect(
			(
				await request("repos/nocoo/app/statistics", {
					account_id: "account_statistics_02",
					enabled: false,
				})
			).status,
		).toBe(409);
		await raw.prepare("UPDATE accounts SET is_active=0").run();
		expect(
			(await request("repos/nocoo/app/statistics", { account_id: id, enabled: false })).status,
		).toBe(409);
	});
	it("blocks factory detail/selection for disabled repos, includes explicit archived overrides and isolates accounts", async () => {
		const { request, get, raw } = await setup();
		expect((await request("factory/repos/nocoo/fork/commits")).status).toBe(404);
		expect((await get("factory/runs")).catalog).toHaveLength(1);
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
		).toBe(400);
		await request("repos/nocoo/archive/statistics", { account_id: id, enabled: true });
		expect((await get("factory")).repos).toHaveLength(2);
		await request("repos/NOCOO/ARCHIVE/statistics", { account_id: id, enabled: false });
		expect((await get("factory")).repos).toHaveLength(1);
		await raw
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,?,?,?,?)",
			)
			.bind("account_statistics_02", "other", "encrypted", "fake", at, at)
			.run();
		await raw
			.prepare("INSERT INTO repo_statistics(account_id,repo,enabled) VALUES(?,?,?)")
			.bind("account_statistics_02", "nocoo/app", 0)
			.run();
		expect((await get("repos")).repos[0]?.statistics_enabled).toBe(true);
	});
});
