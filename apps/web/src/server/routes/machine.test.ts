import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";

import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { createDb } from "../lib/db/d1";
import { replaceSnapshotStmts } from "../lib/db/snapshots";

const account = "a".repeat(21),
	other = "b".repeat(21);
async function setup() {
	const raw = sqliteFixture();
	for (const file of ["0011_api_access.sql", "0012_agent_resources.sql"])
		for (const sql of readFileSync(`migrations/${file}`, "utf8")
			.split(";")
			.filter((s) => s.trim()))
			await raw.prepare(sql).run();
	for (const id of [account, other])
		await raw
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,?, 'fake','fake',?, 't','t')",
			)
			.bind(id, id === account ? "nocoo" : "other", Number(id === other))
			.run();
	const db = createDb(raw);
	await db.batch(
		await replaceSnapshotStmts(
			db,
			account,
			"repos",
			{ repos: [{ name_with_owner: "nocoo/app", is_archived: true }] },
			"2026-10-02T00:00:00Z",
		),
	);
	const env = {
		DB: raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as unknown as Env;
	const token = await createApiToken(db, {
		accountId: account,
		label: "test",
		scopes: ["observations:read", "agent:read", "agent:write", "app:read", "app:write"],
		expiresInDays: 1,
		creator: "test@local",
	});
	const app = createApp();
	const call = (
		path: string,
		method = "GET",
		body?: unknown,
		bearer: string | null = token.token,
	) =>
		app.request(
			`http://localhost/api/v1${path}`,
			{
				method,
				headers: {
					...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
					"content-type": "application/json",
				},
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			},
			env,
		);
	return { db, raw, env, app, token, call, prefix: `/accounts/${account}` };
}

it("applies private headers to every machine response, including authentication and handler errors", async () => {
	const fixture = await setup();
	const readonly = await createApiToken(fixture.db, {
		accountId: account,
		label: "read",
		scopes: ["observations:read"],
		expiresInDays: 1,
		creator: "test@local",
	});
	const responses = [
		await fixture.call("/me", "GET", undefined, null),
		await fixture.call(`/accounts/${other}/repos`),
		await fixture.call(`${fixture.prefix}/settings`, "GET", undefined, readonly.token),
		await fixture.call(`${fixture.prefix}/refresh-runs/latest?kind=invalid`),
		await fixture.call(`${fixture.prefix}/refresh-runs/latest?kind=daily`),
		await fixture.call(`${fixture.prefix}/missing`),
		await fixture.call(`${fixture.prefix}/repos`, "DELETE"),
		await fixture.call(`${fixture.prefix}/repos/nocoo/app/agent-state`, "PUT", {}),
		...(await Promise.all(
			[
				"repos/nocoo/app/agent-state",
				"repos/nocoo/app/meta",
				"refresh-runs",
				"repos",
				"sources",
				"stars",
				"settings",
				"activity",
				"catalog/changes",
				"agent/reports",
			].map((path) => fixture.call(`${fixture.prefix}/${path}`)),
		)),
	];
	expect(responses.slice(0, 8).map((response) => response.status)).toEqual([
		401, 403, 403, 410, 410, 404, 405, 400,
	]);
	vi.spyOn(fixture.raw, "prepare").mockImplementationOnce(() => {
		throw new Error("fixture database failure");
	});
	const failure = await fixture.call("/me");
	expect(failure.status).toBe(500);
	for (const response of [...responses, failure]) {
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response.headers.get("Vary")).toBe("Authorization");
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	}
});

it.each(["POST", "PATCH"])(
	"preserves generic %s of JSON beyond JSON1's nesting depth",
	async (method) => {
		const s = await setup();
		const payload = JSON.parse(
			`{"scope":"global","domain":"prs","generatedAt":"2026-10-21T00:00:00Z","extension":${"[".repeat(1000)}0${"]".repeat(1000)}}`,
		);
		const path = `${s.prefix}/agent/reports`;
		const body = { id: "deep", type: "github-analysis", status: "completed", payload };
		if (method === "PATCH")
			expect((await s.call(path, "POST", { ...body, payload: {} })).status).toBe(201);
		const response = await s.call(
			method === "POST" ? path : `${path}/deep`,
			method,
			method === "POST" ? body : { revision: 1, payload },
		);
		expect(response.status).toBe(method === "POST" ? 201 : 200);
		expect(await response.json()).toMatchObject({ item: { payload } });
		expect(await (await s.call(`${path}/deep`)).json()).toMatchObject({ item: { payload } });
	},
);

it("enforces bearer, scopes and fixed account independently of dashboard activation", async () => {
	const s = await setup();
	expect((await s.call("/me", "GET", undefined, null)).status).toBe(401);
	expect((await s.call("/me", "GET", undefined, "bad")).status).toBe(401);
	const me = await s.call("/me");
	expect(await me.json()).toMatchObject({
		account_id: account,
		login: "nocoo",
		capabilities: { agentWrite: true },
	});
	expect((await s.call(`/accounts/${other}/repos`)).status).toBe(403);
	expect((await s.call(`${s.prefix}/repos`)).status).toBe(200);
	const readonly = await createApiToken(s.db, {
		accountId: account,
		label: "read",
		scopes: ["observations:read"],
		expiresInDays: 1,
		creator: "x",
	});
	expect(
		(
			await s.call(
				`${s.prefix}/agent/reports`,
				"POST",
				{ type: "analysis", status: "pending", payload: {} },
				readonly.token,
			)
		).status,
	).toBe(403);
	expect((await s.call(`${s.prefix}/repos`, "DELETE")).status).toBe(405);
	expect((await s.call(`${s.prefix}/missing`)).status).toBe(404);
	expect((await s.call(`${s.prefix}/repos/nocoo/app/nope`)).status).toBe(404);
	expect((await s.call(`${s.prefix}/repos/nocoo/missing`)).status).toBe(404);
	expect((await s.call(`${s.prefix}/repos/nocoo/app`)).status).toBe(409);
	expect((await s.call(`${s.prefix}/factory/repos/nocoo/app/commits`)).status).toBe(404);
	const prod = { ...s.env, ENVIRONMENT: "production" };
	expect((await s.app.request("http://localhost/api/repos", {}, prod)).status).toBe(401);
	expect((await s.app.request("http://localhost/api/tokens", {}, prod)).status).toBe(401);
});

it("rejects unknown query keys on every documented machine GET", async () => {
	const s = await setup();
	const paths = [
		"/me",
		...[
			"sources",
			"repos",
			"issues",
			"prs",
			"ci",
			"factory",
			"settings",
			"refresh-runs",
			"repos/nocoo/app",
			...[
				"details",
				"issues",
				"prs",
				"actions",
				"releases",
				"traffic",
				"security",
				"languages",
				"contributors",
			].map((resource) => `repos/nocoo/app/${resource}`),
			...["commits", "issues", "prs", "actions", "releases", "alerts", "dependencies"].map(
				(stream) => `factory/repos/nocoo/app/${stream}`,
			),
			...["records", "reports", "jobs"].flatMap((collection) => [
				`agent/${collection}`,
				`agent/${collection}/saved`,
			]),
		].map((path) => `${s.prefix}/${path}`),
	];
	for (const path of paths) {
		const response = await s.call(`${path}?x=1`);
		expect.soft(response.status, path).toBe(400);
		expect.soft(await response.json(), path).toMatchObject({
			error: { code: "validation_failed", message: expect.any(String) },
		});
	}
	expect((await s.call("/me?x=1", "GET", undefined, null)).status).toBe(401);
	expect((await s.call(`/accounts/${other}/repos?x=1`)).status).toBe(403);
	for (const path of ["repos/nocoo/app", "factory/repos/nocoo/app/commits"])
		expect((await s.call(`${s.prefix}/${path}?scope=all`)).status).toBe(400);
	expect((await s.call(`${s.prefix}/repos?scope=all`)).status).toBe(200);
	expect((await s.call(`${s.prefix}/repos?scope=all&scope=all`)).status).toBe(400);
});
it("performs all agent CRUD methods with validation and concurrency errors", async () => {
	const s = await setup();
	const path = `${s.prefix}/agent/reports`;
	const body = {
		id: "stable",
		type: "github-analysis",
		status: "pending",
		repository: "nocoo/app",
		source_version: "v1",
		payload: { domain: "prs" },
	};
	expect((await s.call(path, "POST", body)).status).toBe(201);
	expect((await s.call(path, "POST", body)).status).toBe(409);
	expect(await (await s.call(path)).json()).toMatchObject({
		account_id: account,
		items: [{ id: "stable", revision: 1 }],
	});
	expect((await s.call(`${path}/stable`)).status).toBe(200);
	expect((await s.call(`${path}/missing`)).status).toBe(404);
	expect(
		(await s.call(`${path}/stable`, "PATCH", { revision: 1, status: "completed" })).status,
	).toBe(200);
	expect((await s.call(`${path}/stable`, "PATCH", { revision: 1, status: "failed" })).status).toBe(
		409,
	);
	expect((await s.call(`${path}/stable?revision=2`, "DELETE")).status).toBe(204);
	expect((await s.call(path, "PUT", {})).status).toBe(405);
	expect((await s.call(`${s.prefix}/agent/invalid`)).status).toBe(404);
	expect((await s.call(`${path}/bad!`)).status).toBe(404);
	expect((await s.call(path, "POST", [])).status).toBe(400);
	expect((await s.call(`${path}?limit=101`)).status).toBe(400);
});

it("lists saved source versions for the token account without writes", async () => {
	const setupResult = await setup();
	const { db, call, prefix, token } = setupResult;
	await db.batch(
		await replaceSnapshotStmts(
			db,
			account,
			"repo:nocoo/app:issues",
			{ issues: [] },
			"2026-10-02T08:00:00Z",
		),
	);
	await db.batch(
		await replaceSnapshotStmts(
			db,
			other,
			"repo:other/private:issues",
			{ issues: [] },
			"2026-10-03T08:00:00Z",
		),
	);
	const before = await db.prepare("SELECT * FROM api_tokens WHERE id=?").bind(token.id).first();
	const response = await call(`${prefix}/sources?repository=NOCOO%2FAPP`);
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("private, no-store");
	const result = (await response.json()) as {
		sources: { resource: string; version: string; fetchedAt: string | null }[];
		repositories: string[];
	};
	expect(result.repositories).toEqual(["nocoo/app"]);
	expect(result.sources).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				resource: "repo:nocoo/app:issues",
				fetchedAt: "2026-10-02T08:00:00Z",
			}),
			expect.objectContaining({ resource: "account:repos" }),
		]),
	);
	expect(result.sources.some((source) => source.resource.includes("other/private"))).toBe(false);
	const incremental = await call(`${prefix}/sources?since=2026-10-02T08%3A00%3A00Z`);
	expect(await incremental.json()).toMatchObject({
		sources: [expect.objectContaining({ resource: "account:ci", fetchedAt: "" })],
	});
	expect(
		await (await call(`${prefix}/sources?since=2026-10-02T09%3A00%3A00%2B02%3A00`)).json(),
	).toMatchObject({
		sources: expect.arrayContaining([
			expect.objectContaining({ resource: "repo:nocoo/app:issues" }),
		]),
	});
	for (const query of [
		"since=bad",
		"since=2026-02-30T00%3A00%3A00Z",
		"repository=bad",
		"since=",
		"repository=",
	])
		expect((await call(`${prefix}/sources?${query}`)).status).toBe(400);
	expect((await call(`${prefix}/sources?repository=nocoo%2Fmissing`)).status).toBe(404);
	expect((await call(`${prefix}/sources`, "POST", {})).status).toBe(405);
	expect((await call(`${prefix}/sources`, "GET", undefined, null)).status).toBe(401);
	expect((await call(`/accounts/${other}/sources`)).status).toBe(403);
	const noObservations = await createApiToken(db, {
		accountId: account,
		label: "agent only",
		scopes: ["agent:read"],
		expiresInDays: 1,
		creator: "test",
	});
	expect((await call(`${prefix}/sources`, "GET", undefined, noObservations.token)).status).toBe(
		403,
	);
	expect(await db.prepare("SELECT * FROM api_tokens WHERE id=?").bind(token.id).first()).toEqual(
		before,
	);
});

it("retains incrementally merged global sources with newer repository observation times", async () => {
	const { db, call, prefix } = await setup();
	const oldAt = "2026-10-01T00:00:00Z";
	const newAt = "2026-10-03T00:00:00Z";
	const snapshots = {
		repos: { repos: [{ name_with_owner: "nocoo/app" }] },
		issues: { issues: [] },
		prs: { pull_requests: [] },
	};
	for (const [kind, payload] of Object.entries(snapshots))
		await db.batch(await replaceSnapshotStmts(db, account, kind, payload, oldAt));
	const before = (await (await call(`${prefix}/sources`)).json()) as {
		sources: { resource: string; version: string }[];
	};
	for (const [kind, payload] of Object.entries(snapshots))
		await db.batch(
			await replaceSnapshotStmts(
				db,
				account,
				kind,
				{ ...payload, repository_fetched_at: { "nocoo/app": newAt } },
				oldAt,
			),
		);
	const response = await call(`${prefix}/sources?since=2026-10-02T00%3A00%3A00Z`);
	expect(response.status).toBe(200);
	const after = (await response.json()) as { sources: { resource: string; version: string }[] };
	for (const kind of Object.keys(snapshots)) {
		const current = after.sources.find((source) => source.resource === `account:${kind}`);
		expect(current).toMatchObject({ fetchedAt: newAt, freshness: { latestAt: newAt } });
		expect(current?.version).not.toBe(
			before.sources.find((source) => source.resource === `account:${kind}`)?.version,
		);
	}
});

it("filters retained factory publications case-insensitively without rewriting their identities", async () => {
	const { db, call, prefix } = await setup();
	await db.batch(
		await replaceSnapshotStmts(
			db,
			account,
			"repos",
			{ repos: [{ name_with_owner: "NoCoo/App" }] },
			"2026-10-03T00:00:00Z",
		),
	);
	const publication = factoryFixture();
	const repository = publication.repos[0];
	if (!repository) throw new Error("fixture missing");
	repository.observation = {
		version: "immutable-v1",
		window: publication.window,
		refreshedAt: publication.fetched_at,
		source: "legacy",
	};
	await db.batch(
		await replaceSnapshotStmts(db, account, "factory:v:pub", publication, publication.fetched_at),
	);
	await db
		.prepare("INSERT INTO factory_state(account_id,published_id,next_at) VALUES(?,'pub','t')")
		.bind(account)
		.run();
	await db.batch(
		await replaceSnapshotStmts(
			db,
			account,
			"factory:nocoo/app:commits",
			{ runId: "immutable-v1", coverage: repository.coverage.commits, events: [] },
			publication.fetched_at,
		),
	);
	const response = await call(`${prefix}/sources?repository=NOCOO%2FAPP`);
	expect(response.status).toBe(200);
	const result = (await response.json()) as { sources: { resource: string; version: string }[] };
	expect(result.sources.filter((source) => source.resource.startsWith("factory:"))).toEqual(
		Object.keys(repository.coverage).map((stream) =>
			expect.objectContaining({ resource: `factory:nocoo/app:${stream}`, version: "immutable-v1" }),
		),
	);
	const resource = await call(`${prefix}/factory/repos/NoCoo/App/commits`);
	expect(resource.status).toBe(200);
	expect(await resource.json()).toMatchObject({
		sourceVersion: "immutable-v1",
		source: { resource: "factory:nocoo/app:commits" },
	});
});

it("projects saved account rates independently of publication and dashboard activation without writes", async () => {
	const { db, call, prefix, token } = await setup();
	const publication = factoryFixture();
	await db.batch(
		await replaceSnapshotStmts(db, account, "factory", publication, publication.fetched_at),
	);
	const rate = {
		remaining: 500,
		resource: "graphql",
		resetAt: new Date(Date.now() + 3_600_000).toISOString(),
		observedAt: new Date(Date.now() - 60_000).toISOString(),
	};
	for (const id of [account, other])
		await db
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,?,?,'running',?,'t','t','t')",
			)
			.bind(
				id,
				id,
				id,
				JSON.stringify({
					mode: "catalog",
					checkpoint: { rate: id === account ? rate : { ...rate, remaining: 999 } },
				}),
			)
			.run();
	const before = (await db.prepare("SELECT * FROM factory_runs ORDER BY id").all()).results;
	const tokenBefore = await db
		.prepare("SELECT * FROM api_tokens WHERE id=?")
		.bind(token.id)
		.first();
	expect(await (await call(`${prefix}/factory`)).json()).toMatchObject({
		sourceVersion: publication.runId,
		data: { rate },
	});
	expect((await db.prepare("SELECT * FROM factory_runs ORDER BY id").all()).results).toEqual(
		before,
	);
	expect(await db.prepare("SELECT * FROM api_tokens WHERE id=?").bind(token.id).first()).toEqual(
		tokenBefore,
	);
});

it.each([
	["2026-10-03T00:00:00Z", "2026-10-01T00:00:00Z", true],
	["2026-10-01T00:00:00Z", "2026-10-03T00:00:00Z", true],
	["2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", false],
	["invalid", "2026-10-03T00:00:00Z", true],
	["2026-10-03T00:00:00Z", null, true],
	["invalid", "invalid", true],
	["invalid", null, true],
] as const)(
	"filters repository pages by the newest valid source time (%s, %s)",
	async (fetchedAt, latestAt, retained) => {
		const { db, call, prefix } = await setup();
		await db.batch(
			await replaceSnapshotStmts(
				db,
				account,
				"repo:nocoo/app:issues",
				{ issues: [], freshness: { latestAt } },
				fetchedAt,
			),
		);
		const result = (await (
			await call(`${prefix}/sources?since=2026-10-02T00%3A00%3A00Z`)
		).json()) as { sources: { resource: string }[] };
		expect(result.sources.some((source) => source.resource === "repo:nocoo/app:issues")).toBe(
			retained,
		);
	},
);
it("manages only explicit local configuration without collection", async () => {
	const s = await setup();
	const p = s.prefix;
	expect((await s.call(`${p}/settings`)).status).toBe(200);
	const starPath = `${p}/stars/nocoo/app`;
	for (const method of ["PUT", "DELETE"] as const) {
		const response = await s.call(starPath, method, { reason: "local configuration" });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			repo: "nocoo/app",
			starred: method === "PUT",
			source: "agent",
			reason: "local configuration",
		});
	}
	expect((await s.call(starPath, "GET")).status).toBe(405);
	expect((await s.call(starPath, "PUT", { enabled: false })).status).toBe(400);
	for (const method of ["PUT", "DELETE"]) {
		const response = await s.call(`${p}/statistics/nocoo/app`, method, {});
		expect(response.status).toBe(410);
		expect(await response.json()).toMatchObject({ error: { code: "deprecated" } });
	}
	expect(await (await s.call(`${p}/settings`)).json()).toMatchObject({
		statistics: [],
		statistics_deprecated: true,
	});
});
