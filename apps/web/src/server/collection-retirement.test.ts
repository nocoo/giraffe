import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../tests/fixtures/sqlite";
import type { Env } from "./env";
import worker, { createApp } from "./index";
import { createApiToken } from "./lib/api-tokens";
import { createDb } from "./lib/db/d1";

const account = "a".repeat(21);

async function setup(
	scopes: ("app:read" | "app:write" | "observations:read")[] = ["app:read", "app:write"],
) {
	const raw = sqliteFixture();
	for (const sql of readFileSync("migrations/0011_api_access.sql", "utf8")
		.split(";")
		.filter((statement) => statement.trim()))
		await raw.prepare(sql).run();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?, 'owner','fake','fake',1,'t','t')",
		)
		.bind(account)
		.run();
	const token = await createApiToken(createDb(raw), {
		accountId: account,
		label: "retirement",
		scopes,
		expiresInDays: 1,
		creator: "fixture",
	});
	const env = {
		DB: raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as unknown as Env;
	const app = createApp();
	return { raw, app, env, token: token.token };
}

describe("legacy collection remains retired in phase two", () => {
	it.each([
		["DELETE", "refresh-runs"],
		["POST", "refresh-runs/latest"],
	])("rejects unsupported machine %s %s without collection", async (method, path) => {
		const fixture = await setup();
		const response = await fixture.app.request(
			`http://localhost/api/v1/accounts/${account}/${path}`,
			{
				method,
				headers: { authorization: `Bearer ${fixture.token}` },
			},
			fixture.env,
		);
		expect(response.status).toBe(405);
	});
	it("exports the unified schedule but no legacy queue handler", () => {
		expect(worker).toHaveProperty("scheduled");
		expect(worker).not.toHaveProperty("queue");
	});

	it.each([
		["POST", "/api/refresh"],
		["POST", "/api/factory/refresh"],
		["POST", "/api/factory/runs"],
		["POST", "/api/factory/runs/old/control"],
		["POST", "/api/refresh/schedules/daily"],
		["GET", "/api/factory/runs"],
		["GET", "/api/factory/runs/latest"],
		["GET", "/api/refresh/settings"],
		["GET", "/api/refresh/times"],
		["GET", "/api/agent/reports"],
	])("removes browser %s %s without fetching upstream", async (method, path) => {
		const fixture = await setup();
		const upstream = vi.spyOn(globalThis, "fetch");
		const response = await fixture.app.request(
			`http://localhost${path}`,
			{
				method,
				headers: { origin: "https://giraffe.dev.hexly.ai" },
			},
			fixture.env,
		);
		expect(response.status).toBe(404);
		expect(upstream).not.toHaveBeenCalled();
		upstream.mockRestore();
	});

	it.each([
		["POST", "refresh-runs/old/control"],
		["PUT", "schedules/daily"],
		["DELETE", "schedules/weekly"],
	])(
		"keeps removed machine endpoints behind account and scope checks: %s %s",
		async (method, path) => {
			const fixture = await setup();
			const request = (bearer?: string, accountId = account) =>
				fixture.app.request(
					`http://localhost/api/v1/accounts/${accountId}/${path}`,
					{
						method,
						headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
					},
					fixture.env,
				);
			expect((await request()).status).toBe(401);
			expect((await request(fixture.token, "b".repeat(21))).status).toBe(403);
			const response = await request(fixture.token);
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
			const readonly = await setup(["observations:read"]);
			expect(
				(
					await fixture.app.request(
						`http://localhost/api/v1/accounts/${account}/${path}`,
						{ method, headers: { authorization: `Bearer ${readonly.token}` } },
						readonly.env,
					)
				).status,
			).toBe(403);
		},
	);
});
