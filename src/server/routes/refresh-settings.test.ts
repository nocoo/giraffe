import { expect, it } from "vitest";
import { factoryFixture } from "../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../tests/fixtures/sqlite";
import type { RefreshSettings } from "../../lib/refresh-schedule";
import type { Env } from "../env";
import { createApp } from "../index";
import { createDb } from "../lib/db/d1";
import { replaceSnapshotStmts } from "../lib/db/snapshots";

it("keeps stars local and account scoped; validates schedules and exposes safe status", async () => {
	const snap = factoryFixture();
	const env = {
		DB: sqliteFixture(),
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as Env;
	const db = createDb(env.DB);
	const app = createApp();
	const call = (path: string, body?: unknown, method = body ? "POST" : "GET") =>
		app.request(
			`http://localhost/api/${path}`,
			{
				method,
				headers: { origin: "https://giraffe.dev.hexly.ai", "content-type": "application/json" },
				...(body ? { body: JSON.stringify(body) } : {}),
			},
			env,
		);
	expect((await call("refresh/settings")).status).toBe(409);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,?,?,?,1,?,?)",
		)
		.bind(snap.account_id, "nocoo", "fake", "fake", snap.fetched_at, snap.fetched_at)
		.run();
	await db.batch(
		replaceSnapshotStmts(
			db,
			snap.account_id,
			"repos",
			{ repos: [{ name_with_owner: "nocoo/app" }], truncated: false },
			snap.fetched_at,
		),
	);
	const initial = (await (await call("refresh/settings")).json()) as RefreshSettings;
	expect(initial.schedules.every((s) => !s.enabled)).toBe(true);
	const star = { account_id: snap.account_id, enabled: true };
	expect((await call("repos/nocoo/app/star", star)).status).toBe(200);
	expect((await call("repos/nocoo/app/star", star)).status).toBe(200);
	const current = (await (await call("refresh/settings")).json()) as RefreshSettings;
	expect(current.starred).toEqual(["nocoo/app"]);
	expect(current.schedules.filter((s) => s.kind !== "catalog").every((s) => s.enabled)).toBe(true);
	expect(current.schedules.find((s) => s.kind === "catalog")?.enabled).toBe(false);
	expect((await call("repos/nocoo/missing/star", star)).status).toBe(404);
	expect((await call("repos/nocoo/app/star", { ...star, account_id: "b".repeat(21) })).status).toBe(
		409,
	);
	expect((await call("repos/nocoo/app/star", {})).status).toBe(400);
	const daily = {
		account_id: snap.account_id,
		enabled: true,
		time: "23:59",
		weekday: 0,
		scope: "starred",
	};
	expect((await call("refresh/schedules/daily", daily)).status).toBe(200);
	expect((await call("refresh/schedules/catalog", { ...daily, scope: "all" })).status).toBe(200);
	expect((await call("refresh/schedules/catalog", daily)).status).toBe(400);
	for (const patch of [{ time: "24:00" }, { weekday: 7 }, { scope: "all" }, { extra: true }])
		expect((await call("refresh/schedules/daily", { ...daily, ...patch })).status).toBe(400);
	expect((await call("refresh/schedules/invalid", daily)).status).toBe(400);
	expect(
		(await call("refresh/schedules/weekly", { ...daily, account_id: "b".repeat(21) })).status,
	).toBe(409);
	expect((await call("refresh/settings", undefined, "DELETE")).status).toBe(405);
	expect((await call("repos/nocoo/app/star", { ...star, enabled: false })).status).toBe(200);
	expect(((await (await call("refresh/settings")).json()) as RefreshSettings).starred).toEqual([]);
});
