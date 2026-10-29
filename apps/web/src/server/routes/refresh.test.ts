import { expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { createDb } from "../lib/db/d1";
import { parseRefreshParams } from "../lib/refresh-params";
import { createRefreshRun } from "../lib/refresh-store";

async function fixture(
	scopes: ("app:read" | "app:write" | "observations:read")[] = ["app:read", "app:write"],
) {
	const raw = sqliteFixture();
	const accountId = "a".repeat(21);
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,'octo','encrypted','xxxx',1,'t','t')",
		)
		.bind(accountId)
		.run();
	const db = createDb(raw);
	const token = await createApiToken(db, {
		accountId,
		label: "fixture",
		scopes,
		creator: "test@local",
	});
	const env = {
		DB: raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
		REFRESH_RUNNER: {
			getByName: (account: string) => ({
				fetch: async (request: Request) => {
					const body = (await request.json()) as { params: unknown };
					return Response.json(
						await createRefreshRun(
							createDb(raw),
							account,
							parseRefreshParams(body.params),
							"manual",
							new Date().toISOString(),
						),
						{ status: 202 },
					);
				},
			}),
		},
	} as unknown as Env;
	const call = (path: string, method = "GET", body?: unknown, machine = true) =>
		createApp().request(
			`http://localhost/api/${machine ? `v1/accounts/${accountId}/` : ""}${path}`,
			{
				method,
				headers: machine
					? { authorization: `Bearer ${token.token}`, "content-type": "application/json" }
					: { origin: "https://giraffe.dev.hexly.ai", "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			env,
		);
	return { call, raw, env, accountId };
}
it("starts and reads the same unified run through browser and scoped machine APIs", async () => {
	const { call } = await fixture();
	expect((await call("refresh-runs/latest")).status).toBe(409);
	expect(await (await call("refresh-runs")).json()).toMatchObject({
		items: [],
		collectionAvailable: true,
	});
	const response = await call("refresh-runs", "POST", { repo: "octo/hello", force: true });
	expect(response.status).toBe(202);
	const run = (await response.json()) as { id: string };
	for (const machine of [true, false]) {
		expect(
			await (await call(`refresh-runs/${run.id}`, "GET", undefined, machine)).json(),
		).toMatchObject({ id: run.id, params: { repo: "octo/hello", force: true } });
		expect(
			await (await call("refresh-runs/latest", "GET", undefined, machine)).json(),
		).toMatchObject({ id: run.id });
	}
	expect((await call("refresh-runs/missing")).status).toBe(404);
	expect(await (await call("settings")).json()).toMatchObject({
		collectionAvailable: true,
		schedules: [{ timezone: "Asia/Shanghai", time: "03:00", scope: "starred" }],
	});
});
it("validates run methods and parameters before durable dispatch", async () => {
	const { call } = await fixture();
	for (const body of [
		{ mode: "quick" },
		{ dimensions: [] },
		{ repo: "bad" },
		{ since: "2026-02-30" },
	])
		expect((await call("refresh-runs", "POST", body)).status).toBe(400);
	for (const path of ["refresh-runs", "refresh-runs/latest", "refresh-runs/id"]) {
		expect((await call(path, "PUT", {})).status).toBe(405);
		expect((await call(`${path}?mode=full`)).status).toBe(400);
	}
	expect((await call("refresh-runs/id", "POST", {})).status).toBe(405);
});
it("requires app scopes, account fencing and same-origin browser writes", async () => {
	const scoped = await fixture(["observations:read"]);
	expect((await scoped.call("refresh-runs")).status).toBe(403);
	expect((await scoped.call("refresh-runs", "POST", {})).status).toBe(403);
	const { env, call } = await fixture();
	expect(
		(
			await createApp().request(
				"http://localhost/api/refresh-runs",
				{ method: "POST", headers: { origin: "https://evil.test" }, body: "{}" },
				env,
			)
		).status,
	).toBe(403);
	expect(
		(await createApp().request("http://localhost/api/v1/accounts/other/refresh-runs", {}, env))
			.status,
	).toBe(401);
	expect((await call("refresh-runs", "POST", {}, false)).status).toBe(202);
});
it("keeps GETs read-only and reports missing active accounts", async () => {
	const { raw, call } = await fixture();
	const changes = await raw.prepare("SELECT total_changes() AS count").first();
	await call("refresh-runs");
	await call("refresh-runs/latest");
	await call("refresh-runs/missing");
	expect(await raw.prepare("SELECT total_changes() AS count").first()).toEqual(changes);
	await raw.prepare("UPDATE accounts SET is_active=0").run();
	expect((await call("refresh-runs", "GET", undefined, false)).status).toBe(404);
});
it("accepts the default refresh with an empty request body", async () => {
	const { call } = await fixture();
	expect((await call("refresh-runs", "POST")).status).toBe(202);
});
