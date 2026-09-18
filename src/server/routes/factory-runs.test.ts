import { afterEach, expect, it, vi } from "vitest";
import { factoryFixture } from "../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../tests/fixtures/sqlite";
import type { FactoryRunResponse } from "../../lib/factory-run";
import type { Env } from "../env";
import { createApp } from "../index";
import { createDb } from "../lib/db/d1";
import { replaceSnapshotStmts } from "../lib/db/snapshots";

const snapshot = factoryFixture();
const id = snapshot.account_id;
const headers = { origin: "https://giraffe.dev.hexly.ai", "content-type": "application/json" };
async function setup(withAccount = true, withSnapshot = true) {
	const send = vi.fn().mockResolvedValue(undefined);
	const env = {
		DB: sqliteFixture(),
		FACTORY_QUEUE: { send },
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as unknown as Env;
	const db = createDb(env.DB);
	if (withAccount)
		await db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,?,?, ?,1,?,?)",
			)
			.bind(id, "nocoo", "encrypted", "fake", snapshot.fetched_at, snapshot.fetched_at)
			.run();
	if (withAccount && withSnapshot) {
		await db.batch(replaceSnapshotStmts(db, id, "factory", { ...snapshot }, snapshot.fetched_at));
		await db.batch(
			replaceSnapshotStmts(
				db,
				id,
				"repos",
				{ repos: snapshot.repos.map((r) => ({ name_with_owner: r.name })), truncated: false },
				snapshot.fetched_at,
			),
		);
	}
	const app = createApp();
	return {
		env,
		db,
		send,
		call: (path = "/api/factory/runs", body?: unknown, h = headers) =>
			app.request(
				`http://localhost${path}`,
				{
					method: body === undefined ? "GET" : "POST",
					headers: h,
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				},
				env,
			),
	};
}
const plan = () => ({
	account_id: id,
	requestKey: crypto.randomUUID(),
	mode: "refresh",
	scope: "selected",
	repos: ["nocoo/app"],
});
afterEach(() => vi.unstubAllGlobals());
it("restores server state after reload, preserves the old overview and freezes the submitted plan", async () => {
	const s = await setup();
	const original = (await s.call("/api/factory")).clone();
	const input = plan();
	const created = await s.call("/api/factory/runs", input);
	expect(created.status).toBe(202);
	const createdBody = (await created.json()) as { id: string };
	expect((await s.call("/api/factory/runs", input)).status).toBe(202);
	expect((await s.call("/api/factory/runs", plan())).status).toBe(409);
	const state = (await (await s.call()).json()) as FactoryRunResponse;
	expect(state.current).toMatchObject({
		id: createdBody.id,
		repos: ["nocoo/app"],
		progress: { total: 25, completed: 0 },
	});
	expect(state.current).not.toHaveProperty("checkpoint");
	expect(await (await s.call("/api/factory")).json()).toEqual(await original.json());
	expect(
		(
			await s.call(`/api/factory/runs/${createdBody.id}/control`, {
				account_id: id,
				action: "pause",
			})
		).status,
	).toBe(200);
	expect(((await (await s.call()).json()) as FactoryRunResponse).current?.status).toBe("paused");
	expect(
		(
			await s.call(`/api/factory/runs/${createdBody.id}/control`, {
				account_id: id,
				action: "resume",
			})
		).status,
	).toBe(200);
	expect(
		(
			await s.call(`/api/factory/runs/${createdBody.id}/control`, {
				account_id: id,
				action: "cancel",
			})
		).status,
	).toBe(200);
	const ended = (await (await s.call()).json()) as FactoryRunResponse;
	expect(ended.current).toBeNull();
	expect(ended.history[0]?.status).toBe("cancelled");
	expect(ended.nextAllowedAt).not.toBeNull();
	expect((await s.call("/api/factory/runs", plan())).status).toBe(409);
});
it("persists work even if dispatch fails and protects controls with active-account/Origin validation", async () => {
	const s = await setup();
	s.send.mockRejectedValue(new Error("queue offline"));
	expect((await s.call("/api/factory/runs", plan())).status).toBe(202);
	const state = (await (await s.call()).json()) as FactoryRunResponse;
	const runId = state.current?.id;
	const control = `/api/factory/runs/${runId}/control`;
	expect((await s.call(control, { account_id: id, action: "resume" })).status).toBe(200);
	expect((await s.call(control, {})).status).toBe(400);
	expect((await s.call(control, { account_id: "b".repeat(21), action: "pause" })).status).toBe(409);
	expect(
		(await s.call("/api/factory/runs/unknown/control", { account_id: id, action: "pause" })).status,
	).toBe(404);
	expect(
		(
			await s.call("/api/factory/runs", plan(), {
				"content-type": "application/json",
			} as typeof headers)
		).status,
	).toBe(403);
	expect(
		(
			await s.call(
				control,
				{ account_id: id, action: "pause" },
				{ ...headers, origin: "https://evil.example" },
			)
		).status,
	).toBe(403);
});
it("rejects empty, duplicate, foreign, cooling and incomplete all scopes; discovery remains explicit", async () => {
	const none = await setup(false);
	expect((await none.call()).status).toBe(409);
	const s = await setup();
	expect((await s.call("/api/factory/runs", {})).status).toBe(400);
	expect(
		(await s.call("/api/factory/runs", { ...plan(), account_id: "b".repeat(21) })).status,
	).toBe(409);
	for (const repos of [[], ["evil/repo"], ["nocoo/app", "nocoo/app"]])
		expect((await s.call("/api/factory/runs", { ...plan(), repos })).status).toBe(400);
	const noCatalog = await setup(true, false);
	expect((await noCatalog.call("/api/factory/runs", plan())).status).toBe(409);
	const noState = (await (await noCatalog.call()).json()) as FactoryRunResponse;
	expect(noState.catalog).toEqual([]);
	expect(noState.catalogComplete).toBe(false);
	const incomplete = { ...snapshot, inventory: { ...snapshot.inventory, complete: false } };
	await s.db.batch(replaceSnapshotStmts(s.db, id, "factory", incomplete, snapshot.fetched_at));
	expect((await s.call("/api/factory/runs", { ...plan(), scope: "all" })).status).toBe(409);
	await s.db
		.prepare("INSERT INTO factory_repo_state(account_id,repo,payload) VALUES(?,?,?)")
		.bind(
			id,
			"nocoo/app",
			JSON.stringify({
				repo: "nocoo/app",
				status: "success",
				refreshedAt: snapshot.fetched_at,
				nextAllowedAt: "2999-01-01T00:00:00.000Z",
			}),
		)
		.run();
	expect((await s.call("/api/factory/runs", plan())).status).toBe(409);
	expect((await noCatalog.call("/api/factory/runs", { ...plan(), mode: "catalog" })).status).toBe(
		202,
	);
});

it("applies explicit priority order to complete filtered scopes", async () => {
	const s = await setup();
	const first = snapshot.repos[0];
	if (!first) throw new Error("fixture");
	const repo2 = { ...first, id: "two", name: "nocoo/two" };
	await s.db.batch(
		replaceSnapshotStmts(
			s.db,
			id,
			"factory",
			{ ...snapshot, repos: [first, repo2] },
			snapshot.fetched_at,
		),
	);
	expect(
		(
			await s.call("/api/factory/runs", {
				...plan(),
				scope: "filter",
				repos: undefined,
				language: "TypeScript",
				topic: "cli",
				query: "Example",
				order: ["nocoo/two", "nocoo/app"],
			})
		).status,
	).toBe(202);
	expect(((await (await s.call()).json()) as FactoryRunResponse).current?.repos).toEqual([
		"nocoo/two",
		"nocoo/app",
	]);
});

it("returns the same completed run for a retried request even when repository cooldown changed", async () => {
	const s = await setup();
	const input = plan();
	const first = (await (await s.call("/api/factory/runs", input)).json()) as { id: string };
	await s.call(`/api/factory/runs/${first.id}/control`, { account_id: id, action: "cancel" });
	await s.db
		.prepare("INSERT INTO factory_repo_state(account_id,repo,payload) VALUES(?,?,?)")
		.bind(
			id,
			"nocoo/app",
			JSON.stringify({
				repo: "nocoo/app",
				status: "success",
				refreshedAt: snapshot.fetched_at,
				nextAllowedAt: "2999-01-01T00:00:00.000Z",
			}),
		)
		.run();
	const retry = await s.call("/api/factory/runs", input);
	expect(retry.status).toBe(202);
	expect(await retry.json()).toMatchObject({ id: first.id, status: "cancelled" });
});

it("returns compact history with accurate totals and expands only the requested account-bound run", async () => {
	const s = await setup();
	const first = (await (await s.call("/api/factory/runs", plan())).json()) as { id: string };
	await s.call(`/api/factory/runs/${first.id}/control`, { account_id: id, action: "cancel" });
	const compact = (await (await s.call()).json()) as FactoryRunResponse;
	expect(compact.history[0]?.steps).toHaveLength(25);
	expect(compact.history[0]?.progress).toMatchObject({ total: 25, completed: 25, skipped: 25 });
	const detail = (await (
		await s.call(`/api/factory/runs?history=${first.id}`)
	).json()) as FactoryRunResponse;
	expect(detail.history[0]?.steps).toHaveLength(25);
	expect((await s.call(`/api/factory/runs?history=${"x".repeat(81)}`)).status).toBe(400);
});

it("freezes all accessible detail pages, including repositories excluded from factory metrics", async () => {
	const s = await setup();
	await s.db.batch(
		replaceSnapshotStmts(
			s.db,
			id,
			"repos",
			{
				repos: [{ name_with_owner: "nocoo/app" }, { name_with_owner: "org/archived-fork" }],
				truncated: false,
			},
			snapshot.fetched_at,
		),
	);
	expect(
		(await s.call("/api/factory/runs", { ...plan(), scope: "all", repos: undefined })).status,
	).toBe(202);
	const state = (await (await s.call()).json()) as FactoryRunResponse;
	expect(state.current?.repos).toEqual(["nocoo/app"]);
	expect(state.current?.siteRepos).toEqual(["nocoo/app", "org/archived-fork"]);
	expect(state.current?.steps).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ resource: "repo:org/archived-fork:details" }),
		]),
	);
});

it("requires a complete site catalog before a full refresh, including on an existing installation", async () => {
	for (const missing of [true, false]) {
		const s = await setup();
		if (missing) await s.db.prepare("DELETE FROM snapshots WHERE kind='repos'").run();
		else
			await s.db.batch(
				replaceSnapshotStmts(
					s.db,
					id,
					"repos",
					{ repos: [], truncated: true },
					snapshot.fetched_at,
				),
			);
		expect(((await (await s.call()).json()) as FactoryRunResponse).catalogComplete).toBe(false);
		const res = await s.call("/api/factory/runs", { ...plan(), scope: "all", repos: undefined });
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: { code: "catalog_incomplete" } });
	}
});

it("rejects ambiguous scope/order and refuses new resource work beyond its account budget", async () => {
	const s = await setup();
	expect((await s.call("/api/factory/runs", { ...plan(), scope: "all" })).status).toBe(400);
	expect((await s.call("/api/factory/runs", { ...plan(), order: ["unknown/repo"] })).status).toBe(
		400,
	);
	expect(
		(await s.call("/api/factory/runs", { ...plan(), order: ["nocoo/app", "nocoo/app"] })).status,
	).toBe(400);
	await s.db
		.prepare(
			"INSERT INTO factory_budget VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET bytes=excluded.bytes",
		)
		.bind(id, 256_000_000)
		.run();
	expect((await s.call("/api/factory/runs", plan())).status).toBe(422);
});
