import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../../tests/fixtures/sqlite";
import { makeRun, RUN_LEASE_MS } from "../../../lib/factory-run";
import { createDb } from "./d1";
import { beginRunStep, renewRunLease, saveRunAudits } from "./factory-run-journal";
import { claimRun, controlRun, getRun, saveRun, startRun } from "./factory-runs";

const snap = factoryFixture();
const now = snap.fetched_at;
afterEach(() => vi.useRealTimers());
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
	it("checkpoints completed steps while fencing one interrupted successor", async () => {
		const { raw, db, run } = await setup();
		await startRun(db, run);
		const lease = await claimRun(createDb(raw), run.id, now);
		if (!lease) throw new Error("fixture");
		const first = lease.run.steps[0];
		if (!first) throw new Error("fixture");
		Object.assign(first, { status: "running", attempts: 1, startedAt: now });
		await beginRunStep(createDb(raw), lease, now);
		Object.assign(first, { status: "success", finishedAt: now });
		lease.run.requests = 3;
		lease.run.cursor = 1;
		expect(await saveRun(createDb(raw), lease, [], now, true)).toBe(true);
		expect(await claimRun(createDb(raw), run.id, now)).toBeNull();
		Object.assign(lease.run.steps[1] ?? {}, { status: "running", attempts: 1, startedAt: now });
		await beginRunStep(createDb(raw), lease, now);
		const later = new Date(Date.parse(now) + RUN_LEASE_MS + 1).toISOString();
		const recovered = await claimRun(createDb(raw), run.id, later);
		expect(recovered?.run.requests).toBe(3);
		expect(recovered?.run.steps[0]).toMatchObject({ status: "success", attempts: 1, error: null });
		expect(recovered?.run.steps[1]).toMatchObject({
			status: "pending",
			attempts: 1,
			error: "worker_interrupted",
		});
		expect(await saveRun(createDb(raw), lease, [], later, true)).toBe(false);
	});
	it("journals attempts without rewriting payload and recovers a crash", async () => {
		const { db, raw, run } = await setup();
		await startRun(db, run);
		const lease = await claimRun(createDb(raw), run.id, now);
		if (!lease) throw new Error("fixture");
		const before = await raw
			.prepare("SELECT payload FROM factory_runs WHERE id=?")
			.bind(run.id)
			.first();
		Object.assign(lease.run.steps[0] ?? {}, { status: "running", attempts: 1, startedAt: now });
		expect(await beginRunStep(createDb(raw), lease, now)).toBe(true);
		expect(
			await raw.prepare("SELECT payload FROM factory_runs WHERE id=?").bind(run.id).first(),
		).toEqual(before);
		const later = new Date(Date.parse(now) + 91_000).toISOString();
		const recovered = await claimRun(createDb(raw), run.id, later);
		expect(recovered?.run.steps[0]).toMatchObject({
			attempts: 1,
			retryFailures: 1,
			error: "worker_interrupted",
		});
		expect(recovered?.run.invocations).toBe(2);
		expect(await renewRunLease(createDb(raw), lease, later)).toBe(false);
		if (!recovered) throw new Error("fixture");
		expect(await renewRunLease(createDb(raw), recovered, later)).toBe(true);
		expect(await saveRun(createDb(raw), recovered, [], later)).toBe(true);
		expect(
			await createDb(raw)
				.prepare("SELECT journal FROM factory_run_journal WHERE run_id=?")
				.bind(run.id)
				.first("journal"),
		).toBe("{}");
	});
	it("migrates twice without changing legacy rows", () => {
		const db = new DatabaseSync(":memory:");
		db.exec(readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8"));
		db.exec(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','user','encrypted','fake','date','date'); INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('a','factory','{\"old\":true}','date')",
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
	await db.batch(await replaceSnapshotStmts(db, snap.account_id, "factory", { ...snap }, now));
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
		...(await replaceSnapshotStmts(
			db,
			snap.account_id,
			"factory:v:r1",
			{ ...snap, runId: "published" },
			now,
		)),
		...(await replaceSnapshotStmts(
			db,
			snap.account_id,
			"factory:catalog:r1",
			{ ...snap, runId: "catalog" },
			now,
		)),
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

it("rejects a stale control without discarding a concurrent step audit", async () => {
	const { db, raw, run } = await setup();
	await startRun(db, run);
	const lease = await claimRun(createDb(raw), run.id, now);
	if (!lease) throw new Error("fixture");
	const controlDb = createDb(raw);
	const batch = controlDb.batch.bind(controlDb);
	vi.spyOn(controlDb, "batch").mockImplementationOnce(async (statements) => {
		lease.run.requests++;
		expect(await saveRunAudits(createDb(raw), lease, now)).toBe(true);
		return batch(statements);
	});
	await expect(controlRun(controlDb, snap.account_id, run.id, "pause", now)).rejects.toMatchObject({
		code: "account_conflict",
	});
	expect((await getRun(createDb(raw), snap.account_id, run.id))?.run).toMatchObject({
		status: "running",
		requests: 1,
	});
	expect(await controlRun(createDb(raw), snap.account_id, run.id, "pause", now)).toMatchObject({
		status: "paused",
		requests: 1,
	});
});

it("preserves a genuine control transaction error without changing the run", async () => {
	const { db, raw, run } = await setup();
	await startRun(db, run);
	const controlDb = createDb(raw);
	vi.spyOn(controlDb, "batch").mockRejectedValueOnce(new Error("fixture transaction failure"));
	await expect(controlRun(controlDb, snap.account_id, run.id, "cancel", now)).rejects.toThrow(
		"fixture transaction failure",
	);
	expect((await getRun(createDb(raw), snap.account_id, run.id))?.run.status).toBe("running");
});

it.each(["pause", "cancel"] as const)(
	"applies %s cooldowns to every audited repo but not prior or untouched work",
	async (action) => {
		const { db, raw, run } = await setup();
		const metadata = run.steps.find((step) => step.kind === "metadata");
		const contributions = run.steps.find((step) => step.kind === "contributions");
		if (!metadata || !contributions) throw new Error("fixture");
		run.steps = [
			{ ...metadata, repo: "nocoo/old", status: "success", startedAt: now },
			contributions,
			{ ...metadata },
			{ ...metadata, kind: "commits" },
			{ ...metadata, repo: "nocoo/second" },
			{ ...metadata, repo: "nocoo/untouched" },
		];
		run.cursor = 1;
		await startRun(db, run);
		const lease = await claimRun(createDb(raw), run.id, now);
		if (!lease) throw new Error("fixture");
		for (const index of [2, 3, 4]) {
			lease.run.cursor = index;
			Object.assign(lease.run.steps[index] ?? {}, {
				status: "running",
				attempts: 1,
				startedAt: now,
			});
			expect(await beginRunStep(createDb(raw), lease, now)).toBe(true);
		}
		await controlRun(db, snap.account_id, run.id, action, now);
		const states = await db
			.prepare("SELECT repo,payload FROM factory_repo_state ORDER BY repo")
			.all<{ repo: string; payload: string }>();
		expect(states.results.map((row) => row.repo)).toEqual(["nocoo/app", "nocoo/second"]);
		for (const row of states.results)
			expect(JSON.parse(row.payload)).toMatchObject({
				attemptRunId: run.id,
				attemptStatus: action,
				nextAllowedAt: "2026-09-15T22:15:00.000Z",
			});
	},
);

it.each(["snapshot", "assessment"] as const)(
	"does not change factory metric cooldowns when controlling a stored %s step",
	async (kind) => {
		for (const action of ["pause", "cancel"] as const) {
			const { db, run } = await setup();
			run.cursor = run.steps.findIndex((step) => step.resource === "repo:nocoo/app:traffic");
			const step = run.steps[run.cursor];
			if (!step) throw new Error("fixture");
			Object.assign(step, { kind, status: "running", startedAt: now });
			await startRun(db, run);
			await controlRun(db, snap.account_id, run.id, action, now);
			expect((await db.prepare("SELECT * FROM factory_repo_state").all()).results).toEqual([]);
		}
	},
);

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
		"INSERT INTO factory_resources(run_id,repo,stream,payload) SELECT 'r1','nocoo/app','commits','{}' WHERE $guard",
	);
	const earlier = fenced(
		db,
		lease,
		now,
		"INSERT INTO factory_resources(run_id,repo,stream,payload) SELECT 'r1','nocoo/app','issues','{}' WHERE $guard",
	);
	expect(await saveRun(db, lease, [late, earlier], now)).toBe(false);
	expect((await db.prepare("SELECT * FROM factory_resources").all()).results).toEqual([]);
});

it.each([
	["catalog", "quick", 30 * 60_000, "running"],
	["refresh", "quick", 6 * 3600_000, "running"],
	["refresh", "deep", 12 * 3600_000, "paused"],
] as const)(
	"recovers expired %s/%s %s locks before a new start",
	async (mode, depth, bound, status) => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { db, raw, run } = await setup();
		Object.assign(run, { mode, depth });
		await startRun(db, run);
		const oldLease = await claimRun(db, run.id, now);
		if (status === "paused") await controlRun(db, run.account_id, run.id, "pause", now);
		vi.advanceTimersByTime(bound);
		const later = new Date().toISOString();
		const next = makeRun(
			"replacement",
			run.account_id,
			"nocoo",
			"replacement",
			"catalog",
			[],
			later,
		);
		await Promise.allSettled([
			startRun(createDb(raw), next),
			startRun(createDb(raw), { ...next, id: "duplicate", requestKey: "duplicate" }),
		]);
		const expired = await getRun(createDb(raw), run.account_id, run.id);
		expect(expired).toMatchObject({
			run: { status: "failed", error: "run_timed_out", finishedAt: later },
			leaseUntil: null,
		});
		expect(
			(
				await createDb(raw)
					.prepare("SELECT id FROM factory_runs WHERE status IN ('running','paused')")
					.all()
			).results,
		).toHaveLength(1);
		if (!oldLease) throw new Error("fixture");
		expect(await saveRun(createDb(raw), oldLease, [], later)).toBe(false);
	},
);

it("caps the final lease at the hard deadline and rolls back all writes at the boundary", async () => {
	const { db, run } = await setup();
	run.mode = "catalog";
	await startRun(db, run);
	const before = new Date(Date.parse(now) + 30 * 60_000 - 1000).toISOString();
	const deadline = new Date(Date.parse(now) + 30 * 60_000).toISOString();
	const lease = await claimRun(db, run.id, before);
	if (!lease) throw new Error("fixture");
	expect(lease.leaseUntil).toBe(deadline);
	const { fenced } = await import("./factory-runs");
	const stage = fenced(
		db,
		lease,
		before,
		"INSERT INTO factory_resources(run_id,repo,stream,payload) SELECT 'r1','nocoo/app','commits','{}' WHERE $guard",
	);
	expect(await saveRun(db, lease, [stage], deadline)).toBe(false);
	expect((await db.prepare("SELECT * FROM factory_resources").all()).results).toEqual([]);
	expect((await getRun(db, run.account_id, run.id))?.run.error).toBe("run_timed_out");
	expect(await claimRun(db, run.id, deadline)).toBeNull();
	expect((await controlRun(db, run.account_id, run.id, "resume", deadline)).status).toBe("failed");
});
