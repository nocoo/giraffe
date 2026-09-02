import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { createApp } from "../index";
import { openSqliteD1 } from "../lib/db/sqlite-d1";

function env(): Env {
	return {
		DB: openSqliteD1(true),
		ASSETS: { fetch: async () => new Response("x") } as unknown as Fetcher,
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://127.0.0.1:17046",
	};
}

describe("snapshot routes", () => {
	it("returns 409 without account and 400 for bad repo names", async () => {
		const e = env();
		expect((await createApp().request("http://localhost/api/issues", {}, e)).status).toBe(409);
		expect((await createApp().request("http://localhost/api/repos/o!/n", {}, e)).status).toBe(400);
		expect((await createApp().request("http://localhost/api/repos/o/n", {}, e)).status).toBe(409);
		for (const path of [
			"/api/prs",
			"/api/insights",
			"/api/alerts",
			"/api/notifications",
			"/api/digest",
			"/api/repos/o/n/actions",
			"/api/repos/o/n/traffic",
			"/api/repos/o/n/security",
			"/api/repos/o/n/issues",
			"/api/repos/o/n/prs",
			"/api/repos/o/n/releases",
			"/api/repos/o/n/languages",
			"/api/repos/o/n/contributors",
		]) {
			expect((await createApp().request(`http://localhost${path}`, {}, e)).status).toBe(409);
		}
		const headers = { origin: "https://giraffe.dev.hexly.ai", "content-type": "application/json" };
		expect(
			(
				await createApp().request(
					"http://localhost/api/notifications/read-all",
					{ method: "POST", headers: { origin: "https://giraffe.dev.hexly.ai" } },
					e,
				)
			).status,
		).toBe(400);
		expect(
			(
				await createApp().request(
					"http://localhost/api/notifications/read",
					{ method: "POST", headers, body: JSON.stringify({ id: "1", account_id: "x" }) },
					e,
				)
			).status,
		).toBe(409);
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							account_id: "x",
							kinds: Array.from({ length: 17 }, (_, i) => `k${i}`),
						}),
					},
					e,
				)
			).status,
		).toBe(400);
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ account_id: "x", kinds: 1 }) },
					e,
				)
			).status,
		).toBe(400);
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ account_id: "x", kinds: ["digest"] }) },
					e,
				)
			).status,
		).toBe(409);
	});
});
