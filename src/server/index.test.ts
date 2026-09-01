import { describe, expect, it } from "vitest";
import type { Env } from "./env";
import worker, { createApp } from "./index";
import { openSqliteD1 } from "./lib/db/sqlite-d1";

function env(): Env {
	return {
		DB: openSqliteD1(true),
		ASSETS: {
			fetch: async () => new Response("asset"),
		} as unknown as Fetcher,
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://127.0.0.1:17046",
	};
}

describe("worker fetch", () => {
	it("serves live json and assets for non-api", async () => {
		const e = env();
		const live = await worker.fetch(
			new Request("http://localhost/api/live"),
			e,
			{} as ExecutionContext,
		);
		expect(live.status).toBe(200);
		expect(await live.json()).toMatchObject({ name: "giraffe", d1_marker: "test" });
		const asset = await worker.fetch(new Request("http://localhost/"), e, {} as ExecutionContext);
		expect(await asset.text()).toBe("asset");
		const me = await createApp().request("http://localhost/api/me", {}, e);
		expect(me.status).toBe(200);
		expect(await me.json()).toEqual({ email: "dev@local", name: "dev" });
		const missing = await createApp().request("http://localhost/api/nope", {}, e);
		expect(missing.status).toBe(404);
		const method = await createApp().request("http://localhost/api/live", { method: "POST" }, e);
		expect(method.status).toBe(405);
		expect(
			(
				await createApp().request(
					"http://localhost/api/me",
					{ method: "POST", headers: { origin: "https://giraffe.dev.hexly.ai" } },
					e,
				)
			).status,
		).toBe(405);
		expect(
			(await createApp().request("http://localhost/api/refresh", { method: "GET" }, e)).status,
		).toBe(405);
		expect(
			(await createApp().request("http://localhost/api/live", { method: "HEAD" }, e)).status,
		).toBe(405);
		expect(
			(await createApp().request("http://localhost/api/me", { method: "HEAD" }, e)).status,
		).toBe(405);
		expect(
			(await createApp().request("http://localhost/api/nope", { method: "HEAD" }, e)).status,
		).toBe(404);
		const boom = env();
		boom.DB = {
			prepare: () => {
				throw new TypeError("db down");
			},
			batch: async () => [],
		} as unknown as D1Database;
		const crashed = await createApp().request("http://localhost/api/accounts", {}, boom);
		expect(crashed.status).toBe(500);
		expect(await crashed.json()).toEqual({
			error: { code: "internal_error", message: "db down" },
		});
		const prod = { ...e, ENVIRONMENT: "production" as const };
		const unauth = await createApp().request("http://localhost/api/me", {}, prod);
		expect(unauth.status).toBe(401);
		expect(
			(await createApp().request("http://localhost/api/me", { method: "HEAD" }, prod)).status,
		).toBe(401);
		expect(
			(await createApp().request("http://localhost/api/repos", { method: "HEAD" }, prod)).status,
		).toBe(401);
		const root = await createApp().request("http://localhost/", {}, e);
		expect(await root.text()).toBe("asset");
	});
});
