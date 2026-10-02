import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { createApp } from "../index";
import { openSqliteD1 } from "../lib/db/sqlite-d1";
import { projectApiBase } from "../lib/project-identity";

const env: Env = {
	FACTORY_QUEUE: {} as Queue,
	DB: openSqliteD1(true),
	ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
	TOKEN_ENCRYPTION_KEY_CURRENT: "1",
	ENVIRONMENT: "development",
	GITHUB_API_BASE: "http://127.0.0.1:17046",
};
afterEach(() => vi.unstubAllGlobals());

describe("project identity endpoint", () => {
	it("keeps the optional lookup independent of accounts and snapshot writes", async () => {
		const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
		vi.stubGlobal("fetch", fetch);
		const response = await createApp().request("/api/projects/Team/App.Web-Kit", {}, env);
		expect(response.status).toBe(200);
		expect(await response.json()).toBeNull();
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(fetch).toHaveBeenCalledWith(
			"https://hexly.ai/api/projects/team/app.web-kit",
			expect.any(Object),
		);
	});
	it("preserves Access and HTTP method restrictions and rejects queries", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const app = createApp();
		expect(
			(await app.request("/api/projects/team/app", {}, { ...env, ENVIRONMENT: "production" }))
				.status,
		).toBe(401);
		for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
			expect(
				(
					await app.request(
						"/api/projects/team/app",
						{ method, headers: { origin: "https://giraffe.dev.hexly.ai" } },
						env,
					)
				).status,
			).toBe(405);
		for (const path of ["/api/projects/team/app?all=1", "/api/projects/team/app!"])
			expect((await app.request(path, {}, env)).status).toBe(400);
		expect(fetch).not.toHaveBeenCalled();
	});
	it("keeps temporary failures safe and uncached", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private diagnostic")));
		const response = await createApp().request("/api/projects/team/app", {}, env);
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("private diagnostic");
		expect(response.headers.get("cache-control")).toBe("no-store");
	});
	it("only accepts loopback fixtures outside production", () => {
		expect(projectApiBase({ ...env, HEXLY_API_BASE: "http://127.0.0.1:17046/hexly" })).toBe(
			"http://127.0.0.1:17046/hexly",
		);
		expect(
			projectApiBase({
				...env,
				ENVIRONMENT: "production",
				HEXLY_API_BASE: "https://malicious.example",
			}),
		).toBe("https://hexly.ai/api/projects");
		for (const url of [
			"https://127.0.0.1:17046",
			"http://example.com",
			"http://u@127.0.0.1",
			"http://127.0.0.1?x=1",
			"http://127.0.0.1#hash",
		])
			expect(() => projectApiBase({ ...env, HEXLY_API_BASE: url })).toThrow();
	});
});
