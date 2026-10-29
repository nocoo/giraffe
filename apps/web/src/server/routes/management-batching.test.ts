import { expect, it } from "vitest";
import { profileDb } from "../../../../../tests/fixtures/profile-db";
import { sourcesFixture } from "../../../../../tests/fixtures/sources";
import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { createDb } from "../lib/db/d1";

it("reads settings and retired machine run skeleton without collection", async () => {
	const fixture = await sourcesFixture();
	await fixture.raw
		.prepare("UPDATE accounts SET is_active=1 WHERE id=?")
		.bind(fixture.account)
		.run();
	const minted = await createApiToken(createDb(fixture.raw), {
		accountId: fixture.account,
		label: "local management",
		scopes: ["app:read"],
		expiresInDays: 1,
		creator: "fixture@local.test",
	});
	for (const route of [
		`/api/v1/accounts/${fixture.account}/settings`,
		`/api/v1/accounts/${fixture.account}/refresh-runs`,
	]) {
		const profile = profileDb(fixture.raw);
		const response = await createApp().request(
			route,
			{
				headers: { Authorization: `Bearer ${minted.token}` },
			},
			{
				DB: profile.raw,
				ENVIRONMENT: "development",
				GITHUB_API_BASE: "http://fixture",
			} as unknown as Env,
		);
		expect(response.status, route).toBe(200);
		expect(profile.trips, route).toHaveLength(route.endsWith("/settings") ? 2 : 1);
		expect(response.headers.get("server-timing")).toContain("serialized_bytes;desc=");
	}
});
