import { expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { savedObservationStmts } from "../../../../../tests/fixtures/refresh";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import * as builders from "../lib/dashboard-builders";
import { accountObservationDataVersion } from "../lib/dashboard-data-version";
import { dashboardCacheKey, storeWarmDashboardBody } from "../lib/dashboard-response-cache";
import { createDb } from "../lib/db/d1";

async function seedFactory(db: ReturnType<typeof createDb>, account = "a") {
	await db.batch(
		await savedObservationStmts(
			db,
			account,
			"factory",
			factoryFixture(),
			"2026-10-22T00:00:00.000Z",
		),
	);
	await db.batch(
		await savedObservationStmts(
			db,
			account,
			"repos",
			{
				repos: factoryFixture().repos.map((repo) => ({
					id: repo.id,
					name_with_owner: repo.name,
				})),
			},
			"2026-10-22T00:00:00.000Z",
		),
	);
}

it("returns 304 from warm cache without running the heavy observation batch", async () => {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES('a','nocoo','fake','fake',1,'2026-10-22','2026-10-22')",
		)
		.run();
	const db = createDb(raw);
	await seedFactory(db);
	const built = await builders.buildBrowserFactory(db, "starred");
	const version = await accountObservationDataVersion(db, "a", "factory", "starred");
	const cacheKey = dashboardCacheKey("browser:/api/factory", { scope: "starred" });
	await storeWarmDashboardBody(db, "a", cacheKey, version, built.stored);
	const build = vi.spyOn(builders, "buildBrowserFactory");
	const env = {
		DB: raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as Env;
	const first = await createApp().request("http://localhost/api/factory?scope=starred", {}, env);
	expect(first.status).toBe(200);
	const etag = first.headers.get("etag");
	expect(etag).toBeTruthy();
	expect(build).not.toHaveBeenCalled();
	build.mockClear();
	const second = await createApp().request(
		"http://localhost/api/factory?scope=starred",
		{ headers: { "If-None-Match": String(etag) } },
		env,
	);
	expect(second.status).toBe(304);
	expect(build).not.toHaveBeenCalled();
	expect(second.headers.get("cache-control")).toBe("private, no-cache");
});

it("rebuilds and replaces warm rows when stars change without a refresh", async () => {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES('a','nocoo','fake','fake',1,'2026-10-22','2026-10-22')",
		)
		.run();
	const db = createDb(raw);
	await seedFactory(db);
	const version = await accountObservationDataVersion(db, "a", "factory", "starred");
	const cacheKey = dashboardCacheKey("browser:/api/factory", { scope: "starred" });
	await storeWarmDashboardBody(db, "a", cacheKey, version, { stale: true });
	await raw
		.prepare(
			"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at) VALUES('a','nocoo/app',1,'owner','2026-10-23T00:00:00.000Z')",
		)
		.run();
	const env = {
		DB: raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as Env;
	const response = await createApp().request("http://localhost/api/factory?scope=starred", {}, env);
	expect(response.status).toBe(200);
	const row = await raw
		.prepare("SELECT data_version,body FROM dashboard_warm_responses WHERE account_id='a'")
		.first<{ data_version: string; body: string }>();
	expect(row?.data_version).not.toBe(version);
	expect(row?.body.includes("stale")).toBe(false);
});

it("stores only the latest warm row per cache key", async () => {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES('a','nocoo','fake','fake',1,'2026-10-22','2026-10-22')",
		)
		.run();
	const db = createDb(raw);
	const cacheKey = dashboardCacheKey("browser:/api/ci", { scope: "all" });
	await storeWarmDashboardBody(db, "a", cacheKey, "v1", { one: 1 });
	await storeWarmDashboardBody(db, "a", cacheKey, "v2", { two: 2 });
	const rows = await raw.prepare("SELECT data_version,body FROM dashboard_warm_responses").all();
	expect(rows.results).toEqual([{ data_version: "v2", body: '{"two":2}' }]);
});
