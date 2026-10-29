import { Hono } from "hono";
import { expect, it } from "vitest";
import { refreshActivityFixture } from "../../../../../tests/fixtures/refresh-activity";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { AppVars, Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { createDb } from "../lib/db/d1";
import { activityEtag } from "./activity";

it("serves partial meaningful Activity200 after a new refresh on browser and machine GETs", async () => {
	const { raw } = await refreshActivityFixture();
	const token = await createApiToken(createDb(raw), {
		accountId: "a",
		label: "activity",
		scopes: ["observations:read"],
		expiresInDays: 1,
		creator: "fixture",
	});
	const app = createApp();
	const env = {
		DB: raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://activity.fixture",
	} as Env;
	for (const path of ["/api/activity", "/api/v1/accounts/a/activity"]) {
		const headers = path.startsWith("/api/v1/") ? { Authorization: `Bearer ${token.token}` } : {};
		const response = await app.request(`http://localhost${path}`, { headers }, env);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			runId: "current-refresh",
			totals: { merged_prs: 1, issues_opened: 1 },
			repos: [
				{
					commits: { default: null, other: null, items: null },
					coverage: { commits: { status: "unavailable" } },
				},
			],
		});
		const etag = response.headers.get("etag");
		expect(etag).toMatch(/^"[a-f0-9]+"$/);
		expect(
			(
				await app.request(
					`http://localhost${path}`,
					{ headers: { ...headers, "If-None-Match": String(etag) } },
					env,
				)
			).status,
		).toBe(304);
	}
});

it.each(["/api/activity", "/api/v1/accounts/a/activity"])(
	"keeps private successful and conditional activity headers for %s",
	async (path) => {
		const app = new Hono<{ Bindings: Env; Variables: AppVars }>();
		app.get(path, activityEtag, (c) => c.json({ runId: "published" }));
		const response = await app.request(`http://localhost${path}`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ runId: "published" });
		const tag = response.headers.get("etag");
		expect(tag).toMatch(/^"[a-f0-9]+"$/);
		const conditional = await app.request(`http://localhost${path}`, {
			headers: { "If-None-Match": `W/${tag}` },
		});
		expect(conditional.status).toBe(304);
		expect(await conditional.text()).toBe("");
		for (const result of [response, conditional]) {
			expect(result.headers.get("cache-control")).toBe("private, no-store");
			expect(result.headers.get("referrer-policy")).toBe("no-referrer");
			expect(result.headers.get("vary")).toBe(
				path.startsWith("/api/v1/") ? "Authorization" : "Cookie, Cf-Access-Jwt-Assertion",
			);
		}
	},
);

it.each([
	{ machine: false, query: "unknown=1", status: 400, code: "validation_failed" },
	{ machine: false, query: "run=unknown", status: 404, code: "not_found" },
	{ machine: false, query: "run=latest", status: 409, code: "activity_unpublished" },
	{ machine: true, query: "unknown=1", status: 400, code: "validation_failed" },
	{ machine: true, query: "run=unknown", status: 404, code: "not_found" },
	{ machine: true, query: "run=latest", status: 409, code: "activity_unpublished" },
])(
	"keeps private activity error headers for $status (machine=$machine)",
	async ({ machine, query, status, code }) => {
		const raw = sqliteFixture();
		await raw
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES('a','nocoo','fake','fake',1,'2026-10-22','2026-10-22')",
			)
			.run();
		const token = await createApiToken(createDb(raw), {
			accountId: "a",
			label: "activity-headers",
			scopes: ["observations:read"],
			expiresInDays: 1,
			creator: "fixture@local.test",
		});
		const env = {
			DB: raw,
			ENVIRONMENT: "development",
			GITHUB_API_BASE: "http://fixture",
		} as unknown as Env;
		const response = await createApp().request(
			`http://localhost${machine ? "/api/v1/accounts/a/activity" : "/api/activity"}?${query}`,
			{
				headers: {
					...(machine ? { Authorization: `Bearer ${token.token}` } : {}),
					"If-None-Match": "*",
				},
			},
			env,
		);
		expect(response.status).toBe(status);
		expect(await response.json()).toMatchObject({ error: { code } });
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("vary")).toBe(
			machine ? "Authorization" : "Cookie, Cf-Access-Jwt-Assertion",
		);
		expect(response.headers.get("etag")).toBeNull();
	},
);
