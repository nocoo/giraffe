import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
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
		replaceSnapshotStmts(
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
		FACTORY_QUEUE: { send: vi.fn() },
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
it("keeps unavailable counts in compact machine history without writes", async () => {
	const s = await setup();
	for (const [id, at] of [
		["old", "2026-01-01T00:00:00.000Z"],
		["new", "2026-01-02T00:00:00.000Z"],
	]) {
		if (!id || !at) throw new Error("fixture");
		const run = makeRun(id, account, "nocoo", id, "catalog", [], at);
		for (const step of run.steps) step.status = "success";
		Object.assign(run.steps[1] ?? {}, { status: "unavailable", error: "permission_denied" });
		run.status = "completed";
		await s.db
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,?,?,'completed',?,?,?,?)",
			)
			.bind(id, account, id, JSON.stringify(run), at, at, at)
			.run();
	}
	const before = await s.db.prepare("SELECT * FROM factory_runs ORDER BY id").all();
	const response = await s.call(`${s.prefix}/refresh-runs`);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		items: [
			{ id: "new", counts: { total: 4, success: 3, failed: 0, unavailable: 1, skipped: 0 } },
			{
				id: "old",
				steps: [],
				counts: { total: 4, success: 3, failed: 0, unavailable: 1, skipped: 0 },
			},
		],
	});
	expect(await s.db.prepare("SELECT * FROM factory_runs ORDER BY id").all()).toEqual(before);
});
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
		replaceSnapshotStmts(
			db,
			account,
			"repo:nocoo/app:issues",
			{ issues: [] },
			"2026-10-02T08:00:00Z",
		),
	);
	await db.batch(
		replaceSnapshotStmts(
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
		await db.batch(replaceSnapshotStmts(db, account, kind, payload, oldAt));
	const before = (await (await call(`${prefix}/sources`)).json()) as {
		sources: { resource: string; version: string }[];
	};
	for (const [kind, payload] of Object.entries(snapshots))
		await db.batch(
			replaceSnapshotStmts(
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
		replaceSnapshotStmts(
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
		replaceSnapshotStmts(db, account, "factory:v:pub", publication, publication.fetched_at),
	);
	await db
		.prepare("INSERT INTO factory_state(account_id,published_id,next_at) VALUES(?,'pub','t')")
		.bind(account)
		.run();
	await db.batch(
		replaceSnapshotStmts(
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
	await db.batch(replaceSnapshotStmts(db, account, "factory", publication, publication.fetched_at));
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
			replaceSnapshotStmts(
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
it("manages only explicit local configuration and durable refresh controls", async () => {
	const s = await setup();
	const p = s.prefix;
	expect((await s.call(`${p}/settings`)).status).toBe(200);
	for (const kind of ["stars", "statistics"]) {
		const path = `${p}/${kind}/nocoo/app`;
		expect((await s.call(path, "PUT", { enabled: false })).status).toBe(200);
		expect((await s.call(path, "GET")).status).toBe(405);
		expect((await s.call(path, "DELETE")).status).toBe(204);
	}
	expect((await s.call(`${p}/statistics/nocoo/app`, "PUT", {})).status).toBe(400);
	for (const kind of ["daily", "weekly", "catalog"]) {
		const path = `${p}/schedules/${kind}`;
		const body = {
			enabled: true,
			time: "08:00",
			weekday: 0,
			scope: kind === "daily" ? "starred" : "all",
		};
		expect((await s.call(path, "PUT", body)).status).toBe(200);
		expect((await s.call(path, "DELETE")).status).toBe(204);
	}
	expect((await s.call(`${p}/schedules/no`, "PUT", {})).status).toBe(400);
	expect(
		(
			await s.call(`${p}/schedules/daily`, "PUT", {
				enabled: true,
				time: "08:00",
				weekday: 0,
				scope: "all",
			})
		).status,
	).toBe(400);
	expect((await s.call(`${p}/schedules/catalog`, "PUT", {})).status).toBe(400);
	expect((await s.call(`${p}/refresh-runs`)).status).toBe(200);
	expect((await s.call(`${p}/refresh-runs`, "DELETE")).status).toBe(405);
	expect((await s.call(`${p}/refresh-runs`, "POST", {})).status).toBe(400);
	expect((await s.call(`${p}/refresh-runs/no/control`, "POST", {})).status).toBe(400);
	expect((await s.call(`${p}/refresh-runs/no/control`, "POST", { action: "pause" })).status).toBe(
		404,
	);
	const run = await s.call(`${p}/refresh-runs`, "POST", {
		requestKey: crypto.randomUUID(),
		mode: "catalog",
		scope: "all",
	});
	expect(run.status).toBe(202);
	const id = ((await run.json()) as { id: string }).id;
	expect(
		(await s.call(`${p}/refresh-runs/${id}/control`, "POST", { action: "pause" })).status,
	).toBe(202);
	expect(
		(await s.call(`${p}/refresh-runs/${id}/control`, "POST", { action: "resume" })).status,
	).toBe(202);
	expect(
		(await s.call(`${p}/refresh-runs/${id}/control`, "POST", { action: "cancel" })).status,
	).toBe(202);
});
