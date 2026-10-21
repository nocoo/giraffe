import { expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { createDb } from "../lib/db/d1";

it("roundtrips machine slots for every kind with legacy writes, scope checks and read-only GETs", async () => {
	const account = "a".repeat(21);
	const dbRaw = sqliteFixture();
	const db = createDb(dbRaw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'schedule-test','fake','fake','2026','2026')",
		)
		.bind(account)
		.run();
	const mint = (scopes: ("app:read" | "app:write")[]) =>
		createApiToken(db, {
			accountId: account,
			label: "schedules",
			scopes,
			creator: "test",
			expiresInDays: 1,
		});
	const token = await mint(["app:read", "app:write"]);
	const reader = await mint(["app:read"]);
	const app = createApp();
	const call = (path: string, method = "GET", body?: unknown, bearer = token.token) =>
		app.request(
			`http://localhost/api/v1/accounts/${account}/${path}`,
			{
				method,
				headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			{ DB: dbRaw } as Env,
		);
	for (const kind of ["daily", "weekly", "catalog"]) {
		const body = {
			enabled: false,
			times: ["19:30", "05:30", "05:30"],
			weekday: 0,
			scope: kind === "daily" ? "starred" : "all",
		};
		const saved = await call(`schedules/${kind}`, "PUT", body);
		expect(saved.status).toBe(200);
		expect(await saved.json()).toMatchObject({
			schedules: expect.arrayContaining([
				expect.objectContaining({ kind, time: "05:30", times: ["05:30", "19:30"] }),
			]),
		});
		const ambiguous = await call(`schedules/${kind}`, "PUT", { ...body, time: "19:30" });
		expect(ambiguous.status).toBe(400);
		expect(await ambiguous.json()).toMatchObject({ error: { code: "validation_failed" } });
		const { times: _, ...legacyBody } = body;
		const legacy = await call(`schedules/${kind}`, "PUT", { ...legacyBody, time: "19:30" });
		expect(await legacy.json()).toMatchObject({
			schedules: expect.arrayContaining([
				expect.objectContaining({ kind, time: "19:30", times: ["19:30"] }),
			]),
		});
		expect((await call(`schedules/${kind}`, "PUT", body, reader.token)).status).toBe(403);
	}
	const before = await db.prepare("SELECT * FROM refresh_schedule_times ORDER BY kind").all();
	const activity = await db.prepare("SELECT id,last_used_at FROM api_tokens ORDER BY id").all();
	expect((await call("settings")).status).toBe(200);
	expect((await call("settings")).status).toBe(200);
	expect(await db.prepare("SELECT * FROM refresh_schedule_times ORDER BY kind").all()).toEqual(
		before,
	);
	expect(await db.prepare("SELECT id,last_used_at FROM api_tokens ORDER BY id").all()).toEqual(
		activity,
	);
	expect((await call("schedules/daily", "PUT", {}, "invalid")).status).toBe(401);
	for (const kind of ["daily", "weekly", "catalog"])
		expect((await call(`schedules/${kind}`, "DELETE")).status).toBe(204);
	expect((await db.prepare("SELECT * FROM refresh_schedule_times").all()).results).toEqual([]);
});
