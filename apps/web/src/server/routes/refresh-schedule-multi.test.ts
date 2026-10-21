import { expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { createDb } from "../lib/db/d1";

it("normalizes browser slots and rejects ambiguous, empty, oversized or malformed schedules", async () => {
	const account = "a".repeat(21);
	const env = {
		DB: sqliteFixture(),
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as Env;
	await createDb(env.DB)
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,'schedule-test','fake','fake',1,'2026','2026')",
		)
		.bind(account)
		.run();
	const app = createApp();
	const body = { account_id: account, enabled: false, weekday: 0, scope: "starred" };
	const save = (patch: unknown) =>
		app.request(
			"http://localhost/api/refresh/schedules/daily",
			{
				method: "POST",
				headers: { origin: "https://giraffe.dev.hexly.ai", "content-type": "application/json" },
				body: JSON.stringify({ ...body, ...(patch as object) }),
			},
			env,
		);
	const response = await save({ times: ["19:30", "05:30", "05:30"] });
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		schedules: expect.arrayContaining([
			expect.objectContaining({ kind: "daily", time: "05:30", times: ["05:30", "19:30"] }),
		]),
	});
	for (const patch of [
		{},
		{ times: [] },
		{ times: ["24:00"] },
		{ times: ["5:30"] },
		{ times: ["00:00", "01:00", "02:00", "03:00", "04:00", "05:00", "06:00"] },
		{ time: "19:30", times: ["05:30", "19:30"] },
		{ times: [null] },
	]) {
		const invalid = await save(patch);
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toMatchObject({ error: { code: "validation_failed" } });
	}
	expect((await save({ time: "19:30", times: ["19:30", "19:31"] })).status).toBe(200);
	const legacy = await save({ time: "19:30" });
	expect(await legacy.json()).toMatchObject({
		schedules: expect.arrayContaining([
			expect.objectContaining({ kind: "daily", time: "19:30", times: ["19:30"] }),
		]),
	});
});
