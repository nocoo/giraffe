import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { createDb } from "../lib/db/d1";
import { readSnapshot, replaceSnapshotStmts } from "../lib/db/snapshots";

function env(): Env {
	return {
		DB: sqliteFixture(),
		ASSETS: { fetch: async () => new Response("x") } as unknown as Fetcher,
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://127.0.0.1:17046",
	};
}

const baselineAt = "2026-09-01T00:00:00.000Z";
const checkedAt = "2026-09-30T12:00:00.000Z";
const recentAt = "2026-10-01T01:00:00.000Z";
async function scopedSetup() {
	const bindings = { ...env(), DB: sqliteFixture() };
	const db = createDb(bindings.DB);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES('active','owner','encrypted','fake',1,?,?)",
		)
		.bind(baselineAt, baselineAt)
		.run();
	const save = async (kind: string, payload: Record<string, unknown>, at = baselineAt) =>
		db.batch(await replaceSnapshotStmts(db, "active", kind, payload, at));
	await save(
		"repos",
		{
			repos: [
				{ name_with_owner: "owner/app", open_issue_count: 90, pushed_at: baselineAt },
				{ name_with_owner: "owner/empty", open_issue_count: 8, pushed_at: baselineAt },
				{ name_with_owner: "owner/new", open_issue_count: 0 },
				{ name_with_owner: "owner/hidden", open_issue_count: 100 },
				{ name_with_owner: "owner/fork", is_fork: true },
			],
		},
		recentAt,
	);
	for (const repo of ["OWNER/APP", "owner/empty", "owner/new", "owner/fork"])
		await db.prepare("INSERT INTO repo_stars(account_id,repo) VALUES('active',?)").bind(repo).run();
	const request = (path: string) =>
		createApp().request(`http://localhost/api/${path}`, {}, bindings);
	return { bindings, db, save, request };
}

afterEach(() => vi.unstubAllGlobals());

describe("scoped snapshot projections", () => {
	it("returns an empty starred view when all saved stars are nonowned", async () => {
		const setup = await scopedSetup();
		await setup.save("repos", { repos: [{ name_with_owner: "external/repo" }] });
		await setup.db
			.prepare("INSERT INTO repo_stars(account_id,repo) VALUES('active','external/repo')")
			.run();
		const response = await setup.request("issues?scope=starred");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			issues: [],
			freshness: { total: 0, missing: 0 },
		});
	});

	it("resolves browser repository pages using the newest stored case alias", async () => {
		const setup = await scopedSetup();
		await setup.save("repo:OWNER/APP:prs", { pull_requests: [{ number: 1 }] }, recentAt);
		const response = await setup.request("repos/owner/app/prs");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ pull_requests: [{ number: 1 }] });
		await setup.save("repo:owner/app:prs", { pull_requests: [{ number: 2 }] }, baselineAt);
		expect(await (await setup.request("repos/owner/app/prs")).json()).toMatchObject({
			pull_requests: [{ number: 1 }],
		});
	});

	it("removes departed repositories from every browser inbox and aggregate at read time", async () => {
		const setup = await scopedSetup();
		for (const [kind, key] of [
			["issues", "issues"],
			["prs", "pull_requests"],
			["alerts", "items"],
			["notifications", "notifications"],
		]) {
			await setup.save(String(kind), {
				[String(key)]: [{ name_with_owner: "OWNER/APP" }, { name_with_owner: "owner/removed" }],
				truncated: true,
			});
			const before = await setup.bindings.DB.prepare("SELECT * FROM snapshots ORDER BY kind").all();
			const body = await (await setup.request(`${kind}?scope=all`)).json();
			expect(body).toMatchObject({
				[String(key)]: [{ name_with_owner: "OWNER/APP" }],
				freshness: { oldestAt: baselineAt, total: 5, missing: 4 },
			});
			expect(
				await setup.bindings.DB.prepare("SELECT * FROM snapshots ORDER BY kind").all(),
			).toEqual(before);
		}
	});

	it("projects saved rows before counters, keeps owned forks and leaves storage untouched", async () => {
		const setup = await scopedSetup();
		for (const [kind, key] of [
			["issues", "issues"],
			["prs", "pull_requests"],
			["alerts", "items"],
			["notifications", "notifications"],
		] as const)
			await setup.save(kind, {
				[key]: ["owner/app", "owner/hidden", "owner/fork"].map((name_with_owner) => ({
					name_with_owner,
					source: "dependabot",
				})),
			});
		const before = await setup.bindings.DB.prepare("SELECT * FROM snapshots ORDER BY kind").all();
		const network = vi.fn();
		vi.stubGlobal("fetch", network);
		for (const [kind, key] of [
			["issues", "issues"],
			["prs", "pull_requests"],
			["alerts", "items"],
			["notifications", "notifications"],
		] as const) {
			const response = await setup.request(`${kind}?scope=starred`);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				[key]: [{ name_with_owner: "owner/app" }, { name_with_owner: "owner/fork" }],
				...(kind === "alerts" ? { dependabot_open: 2, code_scanning_open: null } : {}),
			});
			const unscoped = await (await setup.request(kind)).json();
			expect(unscoped).toEqual(await (await setup.request(`${kind}?scope=all`)).json());
			expect((unscoped as Record<string, unknown[]>)[key]).toHaveLength(3);
		}
		expect(await (await setup.request("repos?scope=starred")).json()).toMatchObject({
			repos: [
				{ name_with_owner: "owner/app", starred: true, statistics_enabled: true },
				{ name_with_owner: "owner/empty", starred: true },
				{ name_with_owner: "owner/new", starred: true },
				{ name_with_owner: "owner/fork", starred: true, statistics_enabled: true },
			],
		});
		expect(await setup.bindings.DB.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(
			before,
		);
		expect(network).not.toHaveBeenCalled();
	});

	it("uses per-repository provenance, includes checked empty repositories and counts new repositories missing", async () => {
		const setup = await scopedSetup();
		for (const [kind, key] of [
			["issues", "issues"],
			["prs", "pull_requests"],
		] as const) {
			await setup.save(kind, {
				[key]: [{ name_with_owner: "owner/app" }, { name_with_owner: "owner/hidden" }],
				repository_fetched_at: { "OWNER/APP": checkedAt, "owner/hidden": baselineAt },
			});
			await setup.save(`repo:Owner/Empty:${kind}`, { [key]: [] }, recentAt);
			const response = await setup.request(`${kind}?scope=starred`);
			expect(await response.json()).toMatchObject({
				fetched_at: recentAt,
				freshness: { oldestAt: checkedAt, latestAt: recentAt, total: 4, missing: 2 },
			});
		}
		expect((await readSnapshot(setup.db, "active", "issues"))?.fetched_at).toBe(baselineAt);
	});

	it("accepts a full-scan baseline only when that repository was proven in its catalog", async () => {
		const setup = await scopedSetup();
		await setup.save("repos", { repos: [{ name_with_owner: "owner/empty" }] });
		await setup.save("issues", { issues: [] }, checkedAt);
		expect(await (await setup.request("issues?scope=starred")).json()).toMatchObject({
			fetched_at: checkedAt,
			freshness: { oldestAt: checkedAt, latestAt: checkedAt, total: 1, missing: 0 },
		});
		await setup.save(
			"repos",
			{ repos: [{ name_with_owner: "owner/empty" }, { name_with_owner: "owner/new" }] },
			recentAt,
		);
		expect(await (await setup.request("issues?scope=starred")).json()).toMatchObject({
			freshness: { oldestAt: null, latestAt: null, total: 2, missing: 2 },
		});
	});

	it("derives insights from saved scoped primary sources without using the request clock or optional old security", async () => {
		const setup = await scopedSetup();
		await setup.save("repos", {
			repos: [
				{ name_with_owner: "owner/app", open_issue_count: 90, pushed_at: baselineAt },
				{ name_with_owner: "owner/hidden" },
			],
			repository_fetched_at: { "owner/app": checkedAt },
		});
		await setup.save("issues", {
			issues: [
				{ name_with_owner: "OWNER/APP", state: "OPEN" },
				{ name_with_owner: "owner/hidden" },
			],
			repository_fetched_at: { "owner/app": recentAt },
		});
		await setup.save("alerts", {
			items: [{ name_with_owner: "owner/app", severity: "high", source: "dependabot" }],
		});
		await setup.save(
			"insights",
			{ insights: [{ name_with_owner: "owner/hidden" }] },
			"2026-10-01T23:00:00.000Z",
		);
		const response = await setup.request("insights?scope=starred");
		expect(await response.json()).toMatchObject({
			fetched_at: recentAt,
			freshness: { oldestAt: checkedAt, latestAt: recentAt, total: 1, missing: 0 },
			insights: [
				{ name_with_owner: "owner/app", open_issue_count: 1, days_since_push: 30, health: "risky" },
			],
		});
	});

	it.each(["all", "starred"])(
		"keeps incomplete issue counts conservative in %s insights",
		async (scope) => {
			const setup = await scopedSetup();
			await setup.save(
				"repos",
				{
					repos: ["owner/app", "owner/empty"].map((name_with_owner) => ({
						name_with_owner,
						open_issue_count: 90,
						pushed_at: recentAt,
					})),
				},
				recentAt,
			);
			await setup.save(
				"issues",
				{
					issues: ["owner/app", "owner/empty"].map((name_with_owner) => ({
						name_with_owner,
						number: 1,
					})),
					truncated: true,
				},
				recentAt,
			);
			await setup.save("alerts", { items: [] }, recentAt);
			await setup.save("insights", { insights: [] }, recentAt);
			const read = async () => (await setup.request(`insights?scope=${scope}`)).json();
			expect(await read()).toMatchObject({
				truncated: true,
				freshness: { total: 2, missing: 0 },
				insights: [
					{ name_with_owner: "owner/app", open_issue_count: 90, health: "watch" },
					{ name_with_owner: "owner/empty", open_issue_count: 90, health: "watch" },
				],
			});
			await setup.save("repo:owner/empty:issues", { issues: [] }, recentAt);
			expect(await read()).toMatchObject({
				truncated: true,
				insights: [
					{ name_with_owner: "owner/app", open_issue_count: 90, health: "watch" },
					{ name_with_owner: "owner/empty", open_issue_count: 0, health: "strong" },
				],
			});
			await setup.save("repo:owner/app:issues", { issues: [] }, recentAt);
			expect(await read()).toMatchObject({
				truncated: false,
				insights: [{ open_issue_count: 0 }, { open_issue_count: 0 }],
			});
			await setup.save(
				"repos",
				{
					repos: [{ name_with_owner: "owner/app", open_issue_count: 90, pushed_at: recentAt }],
					truncated: true,
				},
				recentAt,
			);
			expect(await read()).toMatchObject({ truncated: true, freshness: { missing: 0 } });
		},
	);

	it("rejects invalid scope and preserves direct detail access while an empty star set stays empty", async () => {
		const setup = await scopedSetup();
		await setup.save("issues", { issues: [{ name_with_owner: "owner/hidden" }] });
		await setup.save("repo:owner/hidden:issues", { issues: [{ number: 1 }] });
		await setup.db.prepare("DELETE FROM repo_stars WHERE account_id='active'").run();
		expect(await (await setup.request("issues?scope=starred")).json()).toMatchObject({
			issues: [],
			freshness: { total: 0, missing: 0 },
		});
		expect(await (await setup.request("repos?scope=starred")).json()).toMatchObject({ repos: [] });
		expect(
			await (await setup.request("repos/owner/hidden/issues?scope=starred")).json(),
		).toMatchObject({ issues: [{ number: 1 }] });
		for (const path of [
			"repos",
			"issues",
			"prs",
			"alerts",
			"notifications",
			"insights",
			"repos/owner/hidden/issues",
		])
			expect((await setup.request(`${path}?scope=invalid`)).status).toBe(400);
		expect((await setup.request("issues?scope=all&scope=starred")).status).toBe(400);
	});

	it("serves empty projected lists without saved collections when no repositories are starred", async () => {
		const setup = await scopedSetup();
		await setup.db.prepare("DELETE FROM repo_stars WHERE account_id='active'").run();
		await setup.db.prepare("DELETE FROM snapshots WHERE account_id='active'").run();
		for (const [kind, key] of [
			["repos", "repos"],
			["issues", "issues"],
			["prs", "pull_requests"],
			["alerts", "items"],
			["notifications", "notifications"],
			["insights", "insights"],
		]) {
			const response = await setup.request(`${kind}?scope=starred`);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				[String(key)]: [],
				freshness: { oldestAt: null, latestAt: null, total: 0, missing: 0 },
			});
		}
		expect((await setup.request("issues?scope=all")).status).toBe(409);
	});

	it("keeps missing-snapshot behavior consistent for omitted and explicit all scope", async () => {
		const setup = await scopedSetup();
		await setup.save(
			"repos",
			{ repos: [{ name_with_owner: "owner/app", open_issue_count: 8, pushed_at: baselineAt }] },
			checkedAt,
		);
		await setup.save("issues", { issues: [] }, recentAt);
		const before = await setup.bindings.DB.prepare("SELECT * FROM snapshots ORDER BY kind").all();
		for (const suffix of ["", "?scope=all", "?scope=starred"])
			expect((await setup.request(`insights${suffix}`)).status).toBe(409);
		expect(await setup.bindings.DB.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(
			before,
		);
	});

	it("retains collection order and excludes another account's stars", async () => {
		const setup = await scopedSetup();
		await setup.save("notifications", {
			notifications: [
				{ name_with_owner: "owner/app", id: "1" },
				{ name_with_owner: "owner/empty", id: "2" },
				{ name_with_owner: "owner/app", id: "3" },
				{ name_with_owner: "owner/hidden", id: "4" },
			],
		});
		await setup.db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('other','other','encrypted','fake','t','t')",
			)
			.run();
		await setup.db
			.prepare("INSERT INTO repo_stars(account_id,repo) VALUES('other','owner/hidden')")
			.run();
		expect(await (await setup.request("notifications?scope=starred")).json()).toMatchObject({
			notifications: [{ id: "1" }, { id: "2" }, { id: "3" }],
		});
	});
});
