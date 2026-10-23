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
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES('a','owner','encrypted','fake',?,? ,?)",
		)
		.bind(Number(active), at, at)
		.run();
	await raw
		.prepare(
			"INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,first_seen_at,last_seen_at,is_archived,visibility,is_fork,first_seen_source) VALUES('a','R_app','R_app','owner/app','{\"name_with_owner\":\"owner/app\"}',?,?,0,'PUBLIC',0,'github_catalog')",
		)
		.bind(at, at)
		.run();
	const db = createDb(raw);
	await db.batch(
		await replaceSnapshotStmts(db, "a", "repos", { repos: [{ name_with_owner: "owner/app" }] }, at),
	);
	const mint = (scopes: ApiScope[]) =>
		createApiToken(createDb(raw), {
			accountId: "a",
			label: "state-test",
			scopes,
			expiresInDays: 1,
			creator: "fixture@local",
		});
	const token = await mint(["app:read", "app:write", "observations:read"]);
	const env = {
		DB: raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as unknown as Env;
	const app = createApp();
	const call = (
		method = "GET",
		body?: unknown,
		headers: Record<string, string> = {},
		browser = false,
		selected = "a",
		name = "owner/app",
		query = "",
	) =>
		app.request(
			`http://localhost${browser ? `/api/repos/${name}/agent-state` : `/api/v1/accounts/${selected}/repos/${name}/agent-state`}${query}`,
			{
				method,
				headers: {
					...(browser
						? { origin: "http://localhost" }
						: { authorization: `Bearer ${token.token}` }),
					"content-type": "application/json",
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			env,
		);
	return { raw, env, app, call, mint, token };
}

it("accepts the missing-state ETag for create-only PUT and rejects subsequent creates", async () => {
	const state = await fixture();
	const absent = await state.call();
	expect(absent.headers.get("ETag")).toBe('"0"');
	const created = await state.call(
		"PUT",
		{ payload: { summary: "Created once" } },
		{ "If-Match": '"0"' },
	);
	expect(created.status).toBe(200);
	expect(await created.json()).toMatchObject({ payload: { summary: "Created once" }, revision: 1 });
	const conflict = await state.call(
		"PUT",
		{ payload: { summary: "Overwrite" } },
		{ "If-Match": '"0"' },
	);
	expect(conflict.status).toBe(409);
	expect(await conflict.json()).toMatchObject({ error: { code: "revision_conflict" } });
	for (const response of [created, conflict]) {
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response.headers.get("Vary")).toBe("Authorization");
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	}
});

it("R5 browser and machine GET expose flat null state, concurrency-only ETags and private 200 without writes", async () => {
	const s = await fixture();
	const before = (await s.raw.prepare("SELECT * FROM api_tokens").all()).results;
	const network = vi.spyOn(globalThis, "fetch");
	try {
		for (const browser of [true, false]) {
			const response = await s.call("GET", undefined, {}, browser);
			expect(response.status).toBe(200);
			expect(response.headers.get("etag")).toBe('"0"');
			expect(await response.json()).toEqual({
				account_id: "a",
				repo: "owner/app",
				repo_removed: false,
				payload: null,
				revision: null,
				updated_at: null,
				updated_by: null,
			});
			for (const tag of ['"0"', 'W/"0"', "*"]) {
				const conditional = await s.call("GET", undefined, { "if-none-match": tag }, browser);
				expect(conditional.status).toBe(200);
				expect(await conditional.json()).toMatchObject({
					revision: null,
					repo: "owner/app",
					repo_removed: false,
				});
				expect(conditional.headers.get("cache-control")).toBe("private, no-store");
				expect(conditional.headers.get("referrer-policy")).toBe("no-referrer");
				expect(conditional.headers.get("vary")).toBe(
					browser ? "Cookie, Cf-Access-Jwt-Assertion" : "Authorization",
				);
			}
		}
		expect((await s.raw.prepare("SELECT * FROM api_tokens").all()).results).toEqual(before);
		expect(network).not.toHaveBeenCalled();
	} finally {
		network.mockRestore();
	}
});

it("R5 machine PUT uses token identity, conditional revisions and first-write/update conflict responses", async () => {
	const s = await fixture();
	const created = await s.call("PUT", {
		payload: { summary: "reviewed", status: "blocked", custom: { value: 1 } },
	});
	expect(created.status).toBe(200);
	expect(created.headers.get("etag")).toBe('"1"');
	expect(await created.json()).toMatchObject({
		account_id: "a",
		repo: "owner/app",
		revision: 1,
		updated_by: s.token.id,
		payload: { custom: { value: 1 } },
	});
	expect((await s.call("PUT", { payload: {} })).status).toBe(428);
	expect((await s.call("PUT", { revision: 2, payload: {} })).status).toBe(409);
	const updated = await s.call(
		"PUT",
		{ revision: 99, payload: { next: true } },
		{ "if-match": '"1"' },
	);
	expect(updated.status).toBe(200);
	expect(updated.headers.get("etag")).toBe('"2"');
	expect((await s.call("GET", undefined, { "if-none-match": '"1"' })).status).toBe(200);
	expect((await s.call("GET", undefined, { "if-none-match": '"2"' })).status).toBe(200);
});

it("R5 unchanged revisions never hide catalog rename/removal behind a false 304", async () => {
	const s = await fixture();
	await s.call("PUT", { payload: { summary: "stable" } });
	await s.raw
		.prepare(
			"UPDATE catalog_repositories SET repo='owner/renamed',removed_at=? WHERE identity_key='R_app'",
		)
		.bind("2026-10-23T00:00:00.000Z")
		.run();
	for (const browser of [true, false]) {
		const response = await s.call(
			"GET",
			undefined,
			{ "if-none-match": '"1"' },
			browser,
			"a",
			"owner/renamed",
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("etag")).toBe('"1"');
		expect(await response.json()).toMatchObject({
			repo: "owner/renamed",
			repo_removed: true,
			revision: 1,
			payload: { summary: "stable" },
		});
	}
});

it("R5 state scopes/account/Access boundaries reject unauthorized readers and keep browser writes forbidden", async () => {
	const s = await fixture();
	for (const scopes of [
		["observations:read"],
		["agent:read", "agent:write"],
		["app:write"],
	] as ApiScope[][]) {
		const token = await s.mint(scopes);
		expect(
			(await s.call("GET", undefined, { authorization: `Bearer ${token.token}` })).status,
		).toBe(403);
	}
	const reader = await s.mint(["app:read"]);
	expect((await s.call("GET", undefined, { authorization: `Bearer ${reader.token}` })).status).toBe(
		200,
	);
	expect(
		(await s.call("PUT", { payload: {} }, { authorization: `Bearer ${reader.token}` })).status,
	).toBe(403);
	expect(
		(await s.call("GET", undefined, { authorization: "Bearer invalid", "if-none-match": "*" }))
			.status,
	).toBe(401);
	expect((await s.call("GET", undefined, {}, false, "other")).status).toBe(403);
	expect((await (await fixture(false)).call("GET", undefined, {}, true)).status).toBe(409);
	expect(
		(
			await s.app.request(
				"http://localhost/api/repos/owner/app/agent-state",
				{},
				{ ...s.env, ENVIRONMENT: "production" },
			)
		).status,
	).toBe(401);
	expect((await s.call("PUT", { payload: {} }, {}, true)).status).toBe(405);
	expect(
		(await s.call("PUT", { payload: {} }, { origin: "https://evil.example" }, true)).status,
	).toBe(403);
	for (const method of ["POST", "DELETE", "HEAD"]) expect((await s.call(method)).status).toBe(405);
});

it("R5 rejects unknown queries, unknown repos, invalid JSON and unsupported preconditions without writes", async () => {
	const s = await fixture();
	for (const browser of [false, true]) {
		expect((await s.call("GET", undefined, {}, browser, "a", "owner/app", "?x=1")).status).toBe(
			400,
		);
		expect((await s.call("GET", undefined, {}, browser, "a", "owner/unknown")).status).toBe(404);
	}
	for (const body of [null, { payload: [] }, { payload: {}, unknown: true }]) {
		const response = await s.call("PUT", body);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "invalid_payload" } });
	}
	for (const header of ['W/"1"', "*", '"00"'])
		expect((await s.call("PUT", { payload: {} }, { "if-match": header })).status).toBe(400);
	const invalid = await s.app.request(
		"http://localhost/api/v1/accounts/a/repos/owner/app/agent-state",
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

it.each(["owner/agent", "agent/app"])(
	"R5 fixed route prefixes prevent agent-scoped writes to %s",
	async (name) => {
		const s = await fixture();
		await s.raw
			.prepare("UPDATE catalog_repositories SET repo=? WHERE identity_key='R_app'")
			.bind(name)
			.run();
		const agent = await s.mint(["agent:read", "agent:write"]);
		for (const method of ["GET", "PUT"]) {
			const response = await s.call(
				method,
				method === "PUT" ? { payload: { summary: "forbidden" } } : undefined,
				{ authorization: `Bearer ${agent.token}` },
				false,
				"a",
				name,
			);
			expect(response.status).toBe(403);
		}
		expect(await s.raw.prepare("SELECT COUNT(*) AS count FROM repo_agent_state").first()).toEqual({
			count: 0,
		});
		expect((await s.call("GET", undefined, {}, false, "a", name)).status).toBe(200);
		expect(
			(await s.call("PUT", { payload: { summary: "allowed" } }, {}, false, "a", name)).status,
		).toBe(200);
	},
);

it("R5 raw opaque JSON round-trips special keys and rejects oversized or overdeep payloads without mutation", async () => {
	const s = await fixture();
	const payload = JSON.parse('{"summary":"safe","__proto__":{"polluted":"opaque"}}');
	const created = await s.call("PUT", { payload });
	expect(created.status).toBe(200);
	const saved = (await created.json()) as { revision: number; payload: unknown };
	expect(JSON.stringify(saved.payload)).toBe(JSON.stringify(payload));
	expect(Object.getPrototypeOf(saved.payload)).toBe(Object.prototype);
	const oversized = JSON.parse(`{"__proto__":{"value":"${"x".repeat(17000)}"}}`);
	const large = await s.call("PUT", { revision: saved.revision, payload: oversized });
	expect(large.status).toBe(400);
	expect(await large.json()).toMatchObject({ error: { code: "payload_too_large" } });
	for (const depth of [65, 1001]) {
		const nested = JSON.parse(`${'{"nested":'.repeat(depth)}null${"}".repeat(depth)}`);
		const response = await s.call("PUT", { revision: saved.revision, payload: nested });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "invalid_payload" } });
	}
	expect(await (await s.call()).json()).toMatchObject(saved);
});

it("R5 enriches both /repos responses without changing source versions, content hashes or source-index SQL", async () => {
	const s = await fixture();
	const sources = await readSources(createDb(s.raw), "a", {});
	const machine = () =>
		s.app.request(
			"http://localhost/api/v1/accounts/a/repos",
			{ headers: { authorization: `Bearer ${s.token.token}` } },
			s.env,
		);
	const before = (await (await machine()).json()) as {
		sourceVersion: string;
		contentVersion: string;
	};
	await s.call("PUT", { payload: { summary: "ready", status: "attention" } });
	const after = (await (await machine()).json()) as {
		sourceVersion: string;
		contentVersion: string;
		data: { repos: unknown[] };
	};
	expect(after.sourceVersion).toBe(before.sourceVersion);
	expect(after.contentVersion).toBe(before.contentVersion);
	expect(after.data.repos).toEqual([
		expect.objectContaining({
			agent_state: {
				revision: 1,
				updated_at: expect.any(String),
				summary: "ready",
				status: "attention",
			},
		}),
	]);
	const browser = await s.app.request("http://localhost/api/repos", {}, s.env);
	expect(browser.status).toBe(200);
	expect(await browser.json()).toMatchObject({
		repos: [
			expect.objectContaining({
				agent_state: {
					revision: 1,
					updated_at: expect.any(String),
					summary: "ready",
					status: "attention",
				},
			}),
		],
	});
	expect(await readSources(createDb(s.raw), "a", {})).toEqual(sources);
});

it("R5 same-name removed identities with identical removal timestamps retain distinct /repos state", async () => {
	const s = await fixture();
	const removed = "2026-10-23T00:00:00.000Z";
	await s.call("PUT", { payload: { summary: "first identity", status: "ok" } });
	await s.raw
		.prepare(
			"UPDATE catalog_repositories SET removed_at=?,row_payload=? WHERE identity_key='R_app'",
		)
		.bind(removed, JSON.stringify({ name_with_owner: "owner/app", description: "first" }))
		.run();
	await s.raw
		.prepare(
			"INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,is_archived,visibility,is_fork,first_seen_source) VALUES('a','R_second','R_second','owner/app','{\"name_with_owner\":\"owner/app\",\"description\":\"second\"}',0,'PUBLIC',0,'github_catalog')",
		)
		.run();
	await s.call("PUT", { payload: { summary: "second identity", status: "blocked" } });
	await s.raw
		.prepare("UPDATE catalog_repositories SET removed_at=? WHERE identity_key='R_second'")
		.bind(removed)
		.run();
	for (const browser of [true, false]) {
		const response = await s.app.request(
			`http://localhost${browser ? "/api/repos" : "/api/v1/accounts/a/repos"}?include=removed`,
			{ headers: browser ? {} : { authorization: `Bearer ${s.token.token}` } },
			s.env,
		);
		expect(response.status).toBe(200);
		const result = (await response.json()) as {
			repos?: Record<string, unknown>[];
			data?: { repos: Record<string, unknown>[] };
		};
		const repos = browser ? result.repos : result.data?.repos;
		expect(repos).toHaveLength(2);
		expect(repos?.find((repo) => repo.description === "first")).toMatchObject({
			agent_state: { summary: "first identity", status: "ok" },
		});
		expect(repos?.find((repo) => repo.description === "second")).toMatchObject({
			agent_state: { summary: "second identity", status: "blocked" },
		});
	}
});

it("R5 absent state retains renamed/removed catalog context with a zero concurrency ETag", async () => {
	const s = await fixture();
	await s.raw
		.prepare(
			"UPDATE catalog_repositories SET repo='owner/renamed',removed_at='2026-10-23T00:00:00.000Z' WHERE identity_key='R_app'",
		)
		.run();
	for (const browser of [true, false]) {
		const response = await s.call(
			"GET",
			undefined,
			{ "if-none-match": '"0"' },
			browser,
			"a",
			"owner/renamed",
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("etag")).toBe('"0"');
		expect(await response.json()).toMatchObject({
			repo: "owner/renamed",
			repo_removed: true,
			payload: null,
			revision: null,
		});
	}
});
