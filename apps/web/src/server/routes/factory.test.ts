import { afterEach, expect, it, vi } from "vitest";
import { NOW, rawEvent, ready } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { insertAccountStmt } from "../lib/db/accounts";
import { createDb } from "../lib/db/d1";
import { readSnapshot, replaceSnapshotStmts } from "../lib/db/snapshots";
import { mapFactoryEvents } from "../lib/factory-map";
import { encryptToken, parseKeyBytes } from "../lib/token-crypto";

const KEY = "0".repeat(64);
const ID = "a".repeat(21);
const headers = { origin: "https://giraffe.dev.hexly.ai", "content-type": "application/json" };
async function setup(withAccount = true) {
	const env = {
		FACTORY_QUEUE: {} as Queue,
		DB: sqliteFixture(),
		ASSETS: { fetch: async () => new Response("app") },
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://127.0.0.1:17046",
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
		TOKEN_ENCRYPTION_KEY_V1: KEY,
	} as unknown as Env;
	const db = createDb(env.DB);
	if (withAccount)
		await db.batch([
			insertAccountStmt(db, {
				id: ID,
				login: "nocoo",
				avatar_url: "",
				token_ciphertext: await encryptToken("test-pat", parseKeyBytes(KEY)),
				token_last4: "-pat",
				key_version: 1,
				scopes: "repo",
				capabilities: "{}",
				is_active: 1,
				created_at: NOW,
				updated_at: NOW,
				last_used_at: null,
			}),
		]);
	const app = createApp();
	return {
		env,
		db,
		call: (path = "/api/factory", body?: unknown, method = body === undefined ? "GET" : "POST") =>
			app.request(
				`http://localhost${path}`,
				{ method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
				env,
			),
	};
}
afterEach(() => vi.unstubAllGlobals());

it("projects starred factory repositories and dates from their observations, not unrelated publication time", async () => {
	const fixture = await setup();
	const state = ready();
	const first = state.repos[0];
	if (!first) throw new Error("fixture");
	const early = "2026-09-01T00:00:00.000Z";
	const latest = "2026-09-15T00:00:00.000Z";
	state.repos = [
		{
			...first,
			name: "nocoo/app",
			observation: { version: "old", window: state.window, source: "legacy", refreshedAt: latest },
		},
		{
			...first,
			name: "nocoo/mixed",
			observation: { version: "older", window: state.window, source: "legacy", refreshedAt: early },
		},
		{ ...first, name: "nocoo/new" },
		{
			...first,
			name: "nocoo/hidden",
			observation: { version: "newest", window: state.window, source: "legacy", refreshedAt: NOW },
		},
	];
	await fixture.db.batch(replaceSnapshotStmts(fixture.db, ID, "factory", { ...state }, NOW));
	for (const repo of ["NOCOO/APP", "nocoo/mixed", "nocoo/new"])
		await fixture.db.prepare("INSERT INTO repo_stars VALUES(?,?)").bind(ID, repo).run();
	const before = await readSnapshot(fixture.db, ID, "factory");
	const response = await fixture.call("/api/factory?scope=starred");
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		repos: [{ name: "nocoo/app" }, { name: "nocoo/mixed" }, { name: "nocoo/new" }],
		fetched_at: latest,
		freshness: { oldestAt: early, latestAt: latest, total: 3, missing: 1 },
	});
	expect(await readSnapshot(fixture.db, ID, "factory")).toEqual(before);
	expect((await fixture.call("/api/factory/repos/nocoo/hidden/prs?scope=starred")).status).toBe(
		404,
	);
	expect((await fixture.call("/api/factory/repos/nocoo/hidden/prs")).status).toBe(200);
	expect((await fixture.call("/api/factory/repos/NOCOO/APP/prs?scope=starred")).status).toBe(200);
	for (const path of ["/api/factory", "/api/factory/repos/nocoo/app/prs"])
		expect((await fixture.call(`${path}?scope=invalid`)).status).toBe(400);
	await fixture.db.prepare("DELETE FROM repo_stars WHERE account_id=?").bind(ID).run();
	expect(await (await fixture.call("/api/factory?scope=starred")).json()).toMatchObject({
		repos: [],
		fetched_at: "",
		freshness: { total: 0, missing: 0 },
	});
});

it("filters full resource WIP and UTC days before pagination, rejecting malformed filters", async () => {
	const s = await setup();
	const state = ready("prs");
	const repo = state.repos[0];
	if (!repo) throw new Error("fixture");
	repo.coverage.prs.status = "complete";
	const items = mapFactoryEvents(
		"prs",
		Array.from({ length: 201 }, (_, i) => ({
			...rawEvent(i),
			state: i === 200 ? "open" : "closed",
		})),
	);
	await s.db.batch([
		...replaceSnapshotStmts(s.db, ID, "factory", { ...state }, NOW),
		...replaceSnapshotStmts(s.db, ID, "factory:nocoo/app:prs", { items, runId: state.runId }, NOW),
	]);
	const response = await s.call("/api/factory/repos/nocoo/app/prs?state=open&day=2026-09-01");
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		total: 1,
		items: [{ state: "open", id: "N_200" }],
	});
	for (const suffix of [
		"?day=bad",
		"?day=2026-02-31",
		"?day=2026-99-99",
		"?state=bad%20filter",
		"?page=1.5",
		"?page=51",
	])
		expect((await s.call(`/api/factory/repos/nocoo/app/prs${suffix}`)).status).toBe(400);
});

it("never serves detail from another survey generation", async () => {
	const s = await setup();
	const state = ready("commits");
	if (state.repos[0]) state.repos[0].coverage.commits.status = "complete";
	await s.db.batch([
		...replaceSnapshotStmts(s.db, ID, "factory", { ...state }, NOW),
		...replaceSnapshotStmts(
			s.db,
			ID,
			"factory:nocoo/app:commits",
			{ items: [], runId: "other" },
			NOW,
		),
	]);
	expect((await s.call("/api/factory/repos/nocoo/app/commits")).status).toBe(409);
});

it("rejects legacy implicit full refresh without changing stored data", async () => {
	const s = await setup();
	const old = ready();
	old.status = "complete";
	await s.db.batch(replaceSnapshotStmts(s.db, ID, "factory", { ...old }, NOW));
	expect((await s.call("/api/factory/refresh", { account_id: ID, restart: true })).status).toBe(
		400,
	);
	expect(await readSnapshot(s.db, ID, "factory")).toMatchObject({
		runId: old.runId,
		status: "complete",
	});
});
it("keeps factory GET read-only and validates repository/stream/page boundaries", async () => {
	const no = await setup(false);
	expect((await no.call()).status).toBe(409);
	const s = await setup();
	expect((await s.call()).status).toBe(409);
	const state = ready();
	await s.db.batch(replaceSnapshotStmts(s.db, ID, "factory", { ...state }, NOW));
	expect((await s.call()).headers.get("cache-control")).toBe("private, no-store");
	expect((await s.call("/api/factory/repos/nocoo/no/commits")).status).toBe(404);
	expect((await s.call("/api/factory/repos/nocoo/app/other")).status).toBe(400);
	expect((await s.call("/api/factory/repos/nocoo/app/prs?page=0")).status).toBe(400);
	expect((await s.call("/api/factory/repos/nocoo/app/prs")).status).toBe(200);
});

it("does not invent an empty result when a published resource reference is missing", async () => {
	const s = await setup();
	const state = ready();
	const repo = state.repos[0];
	if (!repo) throw new Error("fixture");
	repo.coverage.commits.status = "complete";
	await s.db.batch(replaceSnapshotStmts(s.db, ID, "factory", { ...state }, NOW));
	expect((await s.call("/api/factory/repos/nocoo/app/commits")).status).toBe(409);
});

it("returns a stable empty starred projection before the first factory publication", async () => {
	const fixture = await setup();
	const before = await fixture.env.DB.prepare("SELECT * FROM snapshots").all();
	const response = await fixture.call("/api/factory?scope=starred");
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body).toMatchObject({
		account_id: ID,
		repos: [],
		fetched_at: "",
		freshness: { oldestAt: null, latestAt: null, total: 0, missing: 0 },
	});
	expect(await (await fixture.call("/api/factory?scope=starred")).json()).toEqual(body);
	expect(await fixture.env.DB.prepare("SELECT * FROM snapshots").all()).toEqual(before);
	expect((await fixture.call("/api/factory?scope=all")).status).toBe(409);
});
