import { expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { ApiScope } from "../../lib/api-access";
import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { createDb } from "../lib/db/d1";
import { replaceSnapshotStmts } from "../lib/db/snapshots";
import { readSources } from "../lib/machine-sources";

async function fixture(active = true) {
	const raw = sqliteFixture();
	const at = "2026-10-22T00:00:00.000Z";
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES('a','owner','fake','fake',?,?,?)",
		)
		.bind(Number(active), at, at)
		.run();
	await raw
		.prepare(
			"INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,first_seen_at,is_archived,visibility,is_fork,first_seen_source) VALUES('a','R_app','R_app','owner/app','{\"name_with_owner\":\"owner/app\"}',?,0,'PUBLIC',0,'github_catalog')",
		)
		.bind(at)
		.run();
	const db = createDb(raw);
	await db.batch(
		await replaceSnapshotStmts(db, "a", "repos", { repos: [{ name_with_owner: "owner/app" }] }, at),
	);
	const mint = (scopes: ApiScope[]) =>
		createApiToken(db, {
			accountId: "a",
			label: "meta test",
			scopes,
			expiresInDays: 1,
			creator: "fixture@local",
		});
	const token = await mint(["app:read", "app:write", "observations:read"]);
	const app = createApp();
	const env = {
		DB: raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as unknown as Env;
	const call = (
		method = "GET",
		body?: unknown,
		browser = false,
		name = "owner/app",
		headers: Record<string, string> = {},
		account = "a",
		query = "",
	) =>
		app.request(
			`http://localhost${browser ? `/api/repos/${name}/meta` : `/api/v1/accounts/${account}/repos/${name}/meta`}${query}`,
			{
				method,
				headers: {
					"content-type": "application/json",
					...(browser
						? { origin: "http://localhost" }
						: { authorization: `Bearer ${token.token}` }),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			env,
		);
	return { raw, db, app, env, token, mint, call };
}

it("R6 browser/machine GET are read-only and PUT enriches /repos without altering source versions or queries", async () => {
	const s = await fixture();
	const sources = await readSources(createDb(s.raw), "a", {});
	const before = (await s.raw.prepare("SELECT * FROM api_tokens").all()).results;
	const network = vi.spyOn(globalThis, "fetch");
	try {
		for (const browser of [false, true]) {
			const response = await s.call("GET", undefined, browser);
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("private, no-store");
			expect(await response.json()).toMatchObject({
				account_id: "a",
				created_at: null,
				first_seen_at: "2026-10-22T00:00:00.000Z",
				field_sources: {},
			});
		}
		expect((await s.raw.prepare("SELECT * FROM api_tokens").all()).results).toEqual(before);
		expect((await s.raw.prepare("SELECT * FROM repo_meta").all()).results).toEqual([]);
		expect(network).not.toHaveBeenCalled();
	} finally {
		network.mockRestore();
	}
	const list = async (browser: boolean) =>
		(
			await s.app.request(
				`http://localhost${browser ? "/api/repos" : "/api/v1/accounts/a/repos"}`,
				{ headers: browser ? {} : { authorization: `Bearer ${s.token.token}` } },
				s.env,
			)
		).json() as Promise<Record<string, unknown>>;
	const original = await list(false);
	expect(
		(await s.call("PUT", { created_at: "2020-01-01T00:00:00Z", category: "app" })).status,
	).toBe(200);
	for (const browser of [false, true]) {
		const result = await list(browser);
		const data = (browser ? result : result.data) as { repos: unknown[] };
		expect(data.repos).toEqual([
			expect.objectContaining({
				agent_state: null,
				meta: expect.objectContaining({
					created_at: "2020-01-01T00:00:00Z",
					category: "app",
					field_sources: { created_at: "agent", category: "agent" },
				}),
			}),
		]);
		if (!browser) {
			expect(result.sourceVersion).toBe(original.sourceVersion);
			expect(result.contentVersion).toBe(original.contentVersion);
		}
	}
	expect(await readSources(createDb(s.raw), "a", {})).toEqual(sources);
});

it.each(["owner/app", "owner/agent", "agent/app"])(
	"R6 app scopes enforce metadata boundaries for %s",
	async (name) => {
		const s = await fixture();
		await s.raw
			.prepare("UPDATE catalog_repositories SET repo=? WHERE identity_key='R_app'")
			.bind(name)
			.run();
		for (const scopes of [["agent:read", "agent:write"], ["observations:read"]] as ApiScope[][]) {
			const token = await s.mint(scopes);
			for (const method of ["GET", "PUT"])
				expect(
					(
						await s.call(method, method === "PUT" ? { category: "app" } : undefined, false, name, {
							authorization: `Bearer ${token.token}`,
						})
					).status,
				).toBe(403);
		}
		const reader = await s.mint(["app:read"]);
		expect(
			(await s.call("GET", undefined, false, name, { authorization: `Bearer ${reader.token}` }))
				.status,
		).toBe(200);
		expect(
			(
				await s.call("PUT", { category: "app" }, false, name, {
					authorization: `Bearer ${reader.token}`,
				})
			).status,
		).toBe(403);
		expect((await s.call("PUT", { category: "app" }, false, name)).status).toBe(200);
	},
);

it("R6 rejects malformed writes, queries and unauthorized browser/account access", async () => {
	const s = await fixture();
	for (const browser of [false, true]) {
		expect(
			(await s.call("GET", undefined, browser, "owner/app", {}, "a", "?unknown=1")).status,
		).toBe(400);
		expect((await s.call("GET", undefined, browser, "owner/unknown")).status).toBe(404);
	}
	for (const body of [{}, { unknown: true }, { category: null }, { archived_at: "today" }]) {
		const response = await s.call("PUT", body);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "invalid_payload" } });
	}
	for (const method of ["POST", "DELETE", "HEAD"]) expect((await s.call(method)).status).toBe(405);
	expect(
		(await s.call("GET", undefined, false, "owner/app", { authorization: "Bearer invalid" }))
			.status,
	).toBe(401);
	expect((await s.call("GET", undefined, false, "owner/app", {}, "other")).status).toBe(403);
	expect((await s.call("PUT", { category: "app" }, true)).status).toBe(405);
	expect(
		(
			await s.call("PUT", { category: "app" }, true, "owner/app", {
				origin: "https://evil.example",
			})
		).status,
	).toBe(403);
	expect((await (await fixture(false)).call("GET", undefined, true)).status).toBe(409);
	expect(
		(
			await s.app.request(
				"http://localhost/api/repos/owner/app/meta",
				{},
				{ ...s.env, ENVIRONMENT: "production" },
			)
		).status,
	).toBe(401);
	const invalid = await s.app.request(
		"http://localhost/api/v1/accounts/a/repos/owner/app/meta",
		{
			method: "PUT",
			headers: { authorization: `Bearer ${s.token.token}`, "content-type": "application/json" },
			body: "{",
		},
		s.env,
	);
	expect(invalid.status).toBe(400);
	expect(await invalid.json()).toMatchObject({ error: { code: "invalid_payload" } });
});
