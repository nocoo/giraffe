import { expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";

it("reads only completed refresh windows for the active account without collecting", async () => {
	const db = sqliteFixture();
	const env = { DB: db, ENVIRONMENT: "development", GITHUB_API_BASE: "http://fixture" } as Env;
	const app = createApp();
	const call = (method = "GET") =>
		app.request(
			"http://localhost/api/refresh/times",
			{ method, headers: { origin: "https://giraffe.dev.hexly.ai" } },
			env,
		);
	expect((await call()).status).toBe(409);
	for (const id of ["a", "b"])
		await db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,?, 'fake','fake',?, 't','t')",
			)
			.bind(id, id, Number(id === "a"))
			.run();
	for (const [id, account, status, finishedAt, steps] of [
		["ok", "a", "completed", "2026-10-02T08:10:00Z", [{ kind: "snapshot", status: "success" }]],
		["partial", "a", "partial", "2026-10-02T09:10:00Z", [{ kind: "commit", status: "success" }]],
		["running", "a", "running", null, [{ kind: "snapshot", status: "success" }]],
		["failed", "a", "failed", "2026-10-02T10:00:00Z", [{ kind: "snapshot", status: "failed" }]],
		["other", "b", "completed", "2026-10-02T11:00:00Z", [{ kind: "publish", status: "success" }]],
	] as const) {
		await db
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,?,?,?,?,'t','t','t')",
			)
			.bind(
				id,
				account,
				id,
				status,
				JSON.stringify({ startedAt: "2026-10-02T08:00:00Z", finishedAt, steps }),
			)
			.run();
	}
	const response = await call();
	expect(response.headers.get("cache-control")).toBe("private, no-store");
	expect(await response.json()).toEqual({
		account_id: "a",
		runs: [
			{ startedAt: "2026-10-02T08:00:00Z", finishedAt: "2026-10-02T09:10:00Z" },
			{ startedAt: "2026-10-02T08:00:00Z", finishedAt: "2026-10-02T08:10:00Z" },
		],
	});
	expect((await call("DELETE")).status).toBe(405);
});
