import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { factoryFixture } from "../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../tests/fixtures/sqlite";
import { makeRun } from "../../../lib/factory-run";
import { createDb } from "./d1";
import { claimRun, controlRun, getRun, saveRun, startRun } from "./factory-runs";

const snap = factoryFixture();
const now = snap.fetched_at;
async function setup() {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,?,?,?,?)",
		)
		.bind(snap.account_id, "nocoo", "encrypted", "fake", now, now)
		.run();
	return {
		raw,
		db,
		run: makeRun("r1", snap.account_id, "nocoo", "key1", "refresh", snap.repos, now),
	};
}
describe("D1 durable runs", () => {
	it("migrates twice without changing legacy rows", () => {
		const db = new DatabaseSync(":memory:");
		db.exec(readFileSync("src/server/lib/db/schema.sql", "utf8"));
		db.exec(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','user','encrypted','fake','date','date'); INSERT INTO snapshots VALUES('a','factory','{\"old\":true}','date')",
		);
		const before = db.prepare("SELECT * FROM snapshots").all();
		const migration = readFileSync("migrations/0001_factory_runs.sql", "utf8");
		db.exec(migration);
		db.exec(migration);
		expect(db.prepare("SELECT * FROM snapshots").all()).toEqual(before);
		db.close();
	});
	it("serializes concurrent starts, deduplicates idempotency keys and enforces cooldown", async () => {
		const { db, raw, run } = await setup();
		expect(await startRun(db, run)).toEqual(run);
		expect((await startRun(createDb(raw), { ...run, id: "r2" })).id).toBe("r1");
		await expect(
			startRun(createDb(raw), { ...run, id: "r3", requestKey: "new" }),
		).rejects.toMatchObject({ code: "account_conflict" });
		await controlRun(createDb(raw), snap.account_id, "r1", "cancel", now);
		await expect(
			startRun(createDb(raw), { ...run, id: "r3", requestKey: "new" }),
		).rejects.toMatchObject({ code: "refresh_cooldown" });
	});
	it("recovers expired leases and fences writes by old or paused workers", async () => {
		const { db, raw, run } = await setup();
		await startRun(db, run);
		const first = await claimRun(createDb(raw), "r1", now);
		expect(first).not.toBeNull();
		expect(await claimRun(createDb(raw), "r1", now)).toBeNull();
		if (!first) throw new Error("fixture");
		const later = "2026-09-15T22:02:00.000Z";
		const next = await claimRun(createDb(raw), "r1", later);
		if (!next) throw new Error("fixture");
		expect(await saveRun(createDb(raw), first, [], later)).toBe(false);
		expect(await saveRun(createDb(raw), next, [], later)).toBe(true);
		const third = await claimRun(createDb(raw), "r1", later);
		if (!third) throw new Error("fixture");
		await controlRun(createDb(raw), snap.account_id, "r1", "pause", later);
		expect(await saveRun(createDb(raw), third, [], later)).toBe(false);
		expect((await getRun(createDb(raw), snap.account_id, "r1"))?.run.status).toBe("paused");
		await controlRun(createDb(raw), snap.account_id, "r1", "resume", later);
		expect(await claimRun(createDb(raw), "r1", later)).not.toBeNull();
	});
});

it("keeps publications, catalog and history readable without GitHub and scopes account reads", async () => {
	const { db, raw, run } = await setup();
	const { publishedFactory, catalogFactory, listRuns, repoStates, dueRuns, factoryHead } =
		await import("./factory-runs");
	const { replaceSnapshotStmts } = await import("./snapshots");
	expect(await publishedFactory(db, snap.account_id)).toBeNull();
	expect(await catalogFactory(db, snap.account_id)).toBeNull();
	await db.batch(replaceSnapshotStmts(db, snap.account_id, "factory", { ...snap }, now));
	expect((await catalogFactory(db, snap.account_id))?.runId).toBe(snap.runId);
	await startRun(createDb(raw), run);
	expect(await dueRuns(createDb(raw), now)).toEqual(["r1"]);
	expect((await listRuns(createDb(raw), snap.account_id))[0]?.run.id).toBe("r1");
	expect(await listRuns(createDb(raw), "other")).toEqual([]);
	expect(await getRun(createDb(raw), "other", "r1")).toBeNull();
	await expect(controlRun(createDb(raw), "other", "r1", "cancel", now)).rejects.toMatchObject({
		code: "not_found",
	});
	await db.batch([
		...replaceSnapshotStmts(
			db,
			snap.account_id,
			"factory:v:r1",
			{ ...snap, runId: "published" },
			now,
		),
		...replaceSnapshotStmts(
			db,
			snap.account_id,
			"factory:catalog:r1",
			{ ...snap, runId: "catalog" },
			now,
		),
		db
			.prepare("UPDATE factory_state SET published_id=?,catalog_id=? WHERE account_id=?")
			.bind("r1", "r1", snap.account_id),
		db
			.prepare("INSERT INTO factory_repo_state(account_id,repo,payload) VALUES(?,?,?)")
			.bind(snap.account_id, "nocoo/app", JSON.stringify({ repo: "nocoo/app", status: "success" })),
	]);
	expect((await publishedFactory(createDb(raw), snap.account_id))?.runId).toBe("published");
	expect((await catalogFactory(createDb(raw), snap.account_id))?.runId).toBe("catalog");
	expect(await repoStates(createDb(raw), snap.account_id)).toEqual([
		{ repo: "nocoo/app", status: "success" },
	]);
	expect((await factoryHead(createDb(raw), snap.account_id))?.published_id).toBe("r1");
	await controlRun(createDb(raw), snap.account_id, "r1", "cancel", now);
	expect((await controlRun(createDb(raw), snap.account_id, "r1", "resume", now)).status).toBe(
		"cancelled",
	);
});

it("allows only one concurrent start across independent request wrappers", async () => {
	const { raw, run } = await setup();
	const results = await Promise.allSettled([
		startRun(createDb(raw), run),
		startRun(createDb(raw), { ...run, id: "competing", requestKey: "different" }),
	]);
	expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
});
it("rolls staging and progress back together when a later statement fails, then recovers the expired lease", async () => {
	const { db, raw, run } = await setup();
	await startRun(db, run);
	const lease = await claimRun(db, run.id, now);
	if (!lease) throw new Error("fixture");
	const { fenced } = await import("./factory-runs");
	const stage = fenced(
		db,
		lease,
		now,
		"INSERT INTO factory_resources(run_id,repo,stream,payload) SELECT 'r1','nocoo/app','commits','{}' WHERE $guard",
	);
	const failure = db.prepare(
		"INSERT INTO factory_repo_state(account_id,repo,payload) VALUES(NULL,'repo','{}')",
	);
	await expect(saveRun(db, lease, [stage, failure], now)).rejects.toMatchObject({
		code: "db_error",
	});
	expect((await db.prepare("SELECT * FROM factory_resources").all()).results).toEqual([]);
	expect(await claimRun(createDb(raw), run.id, "2026-09-15T22:02:00.000Z")).not.toBeNull();
});

it("serializes competing controls instead of overwriting a newer run version", async () => {
	const { db, raw, run } = await setup();
	await startRun(db, run);
	const controls = await Promise.allSettled([
		controlRun(createDb(raw), snap.account_id, "r1", "pause", now),
		controlRun(createDb(raw), snap.account_id, "r1", "cancel", now),
	]);
	expect(controls.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	expect(controls.find((r) => r.status === "rejected")).toMatchObject({
		reason: { code: "account_conflict" },
	});
});

it("does not change factory metric cooldowns when pausing or cancelling a site page", async () => {
	for (const action of ["pause", "cancel"] as const) {
		const { db, run } = await setup();
		run.cursor = run.steps.findIndex((step) => step.resource === "repo:nocoo/app:traffic");
		const step = run.steps[run.cursor];
		if (!step) throw new Error("fixture");
		step.status = "running";
		step.startedAt = now;
		await startRun(db, run);
		await controlRun(db, snap.account_id, run.id, action, now);
		expect((await db.prepare("SELECT * FROM factory_repo_state").all()).results).toEqual([]);
	}
});

it("rolls every staged write back if the lease expires between preparing writes and committing the batch", async () => {
	const { db, run } = await setup();
	await startRun(db, run);
	const lease = await claimRun(db, run.id, now);
	if (!lease) throw new Error("fixture");
	const { fenced } = await import("./factory-runs");
	const stage = fenced(
		db,
		lease,
		now,
		"INSERT INTO factory_resources(run_id,repo,stream,payload) SELECT 'r1','nocoo/app','commits','{}' WHERE $guard",
	);
	expect(await saveRun(db, lease, [stage], "2026-09-15T22:02:00.000Z")).toBe(false);
	expect((await db.prepare("SELECT * FROM factory_resources").all()).results).toEqual([]);
});

it("uses the latest prepared fence timestamp even if the caller clock moves backwards", async () => {
	const { db, run } = await setup();
	await startRun(db, run);
	const lease = await claimRun(db, run.id, now);
	if (!lease) throw new Error("fixture");
	const { fenced } = await import("./factory-runs");
	const future = "2026-09-15T22:02:00.000Z";
	const late = fenced(
		db,
		lease,
		future,
		"INSERT INTO factory_resources SELECT 'r1','nocoo/app','commits','{}' WHERE $guard",
	);
	const earlier = fenced(
		db,
		lease,
		now,
		"INSERT INTO factory_resources SELECT 'r1','nocoo/app','issues','{}' WHERE $guard",
	);
	expect(await saveRun(db, lease, [late, earlier], now)).toBe(false);
	expect((await db.prepare("SELECT * FROM factory_resources").all()).results).toEqual([]);
});
