import { expect, it } from "vitest";
import { sourcesFixture } from "../../../../../tests/fixtures/sources";
import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { createDb } from "../lib/db/d1";

it("times approved saved reads without exposing private diagnostics", async () => {
	const fixture = await sourcesFixture();
	await fixture.raw
		.prepare("UPDATE accounts SET is_active=1 WHERE id=?")
		.bind(fixture.account)
		.run();
	const minted = await createApiToken(createDb(fixture.raw), {
		accountId: fixture.account,
		label: "local timing",
		scopes: ["observations:read", "app:read"],
		expiresInDays: 1,
		creator: "fixture@local.test",
	});
	const app = createApp();
	const env = {
		DB: fixture.raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as unknown as Env;
	for (const route of [
		"/api/repos",
		"/api/ci",
		"/api/factory",
		"/api/refresh/settings",
		"/api/factory/runs",
		`/api/v1/accounts/${fixture.account}/repos`,
		`/api/v1/accounts/${fixture.account}/ci`,
		`/api/v1/accounts/${fixture.account}/factory`,
		`/api/v1/accounts/${fixture.account}/settings`,
		`/api/v1/accounts/${fixture.account}/refresh-runs`,
	]) {
		const response = await app.request(
			route,
			{
				headers: { Authorization: `Bearer ${minted.token}` },
			},
			env,
		);
		expect(response.status, route).toBe(200);
		const header = response.headers.get("server-timing");
		expect(header, route).not.toBeNull();
		expect(header).toContain("d1_1;dur=");
		for (const metric of header?.split(", ") ?? [])
			expect(metric).toMatch(/^(?:[a-z][a-z0-9_]*;dur=\d+\.\d{2}|[a-z][a-z0-9_]*;desc="\d+")$/);
		expect(header).not.toContain(fixture.account);
		expect(header).not.toContain(minted.token);
	}
	for (const [route, headers] of [
		[`/api/v1/accounts/${fixture.account}/repos`, {}],
		[
			`/api/v1/accounts/${fixture.account}/repos?scope=invalid`,
			{ Authorization: `Bearer ${minted.token}` },
		],
	] as const) {
		const response = await app.request(route, { headers }, env);
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.headers.has("server-timing")).toBe(false);
	}
});
