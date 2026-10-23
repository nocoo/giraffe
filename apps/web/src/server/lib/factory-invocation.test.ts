import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun, RUN_LEASE_MS } from "../../lib/factory-run";
import { createDb } from "./db/d1";
import { claimRun, startRun } from "./db/factory-runs";
import {
	FactoryInvocation,
	INVOCATION_DB_STATEMENTS,
	INVOCATION_STATEMENTS,
	InvocationStopped,
} from "./factory-invocation";

async function setup() {
	const snapshot = factoryFixture();
	const raw = sqliteFixture();
	const db = createDb(raw);
	const now = snapshot.fetched_at;
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','nocoo','encrypted','fake',?,?)",
		)
		.bind(now, now)
		.run();
	const run = makeRun("run", "a", "nocoo", "key", "refresh", snapshot.repos, now);
	await startRun(db, run);
	const lease = await claimRun(db, run.id, now);
	if (!lease) throw new Error("fixture");
	return { db: createDb(raw, undefined, INVOCATION_DB_STATEMENTS), lease, now };
}

it("stops at the D1 admission cap with room left for the atomic save", async () => {
	const { db, lease, now } = await setup();
	const invocation = new FactoryInvocation(db, lease, () => now);
	const step = lease.run.steps[0];
	if (!step) throw new Error("fixture");
	expect(invocation.canStart(step)).toBe(true);
	for (let index = 0; index < INVOCATION_STATEMENTS; index++) await db.prepare("SELECT 1").first();
	expect(invocation.canStart(step)).toBe(false);
	expect(invocation.canStart(step, true)).toBe(false);
	await expect(invocation.beforeRequest()).rejects.toMatchObject({ code: "factory_yield" });
	expect(db.statements).toBe(INVOCATION_STATEMENTS);
});

it("budgets every page including continuing work before the wall deadline", async () => {
	const { db, lease, now } = await setup();
	let time = now;
	const invocation = new FactoryInvocation(db, lease, () => time);
	const step = lease.run.steps[0];
	if (!step) throw new Error("fixture");
	step.status = "running";
	time = new Date(Date.parse(now) + 25_000).toISOString();
	expect(invocation.canStart(step)).toBe(false);
	expect(invocation.canStart(step, true)).toBe(false);
	await expect(invocation.beforeRequest()).rejects.toMatchObject({ code: "factory_yield" });
	invocation.requests = 40;
	expect(invocation.canStart(step, true)).toBe(false);
	await expect(invocation.beforeRequest()).rejects.toMatchObject({ code: "factory_yield" });
});

it("rejects expired heartbeats without extending a lost lease", async () => {
	const { db, lease, now } = await setup();
	const invocation = new FactoryInvocation(db, lease, () =>
		new Date(Date.parse(now) + 91_000).toISOString(),
	);
	await expect(invocation.heartbeat()).rejects.toEqual(new InvocationStopped(true));
	expect(lease.leaseUntil).toBe(new Date(Date.parse(now) + RUN_LEASE_MS).toISOString());
});

it("counts requests in memory and renews before half the lease remains", async () => {
	const { db, lease, now } = await setup();
	let time = now;
	const invocation = new FactoryInvocation(db, lease, () => time);
	await invocation.beforeRequest();
	await invocation.beforeRequest();
	expect(invocation.requests).toBe(2);
	expect(db.statements).toBe(0);
	time = new Date(Date.parse(now) + RUN_LEASE_MS / 2 + 1).toISOString();
	await invocation.heartbeat();
	expect(db.statements).toBe(1);
	expect(lease.leaseUntil).toBe(new Date(Date.parse(time) + RUN_LEASE_MS).toISOString());
});

it("reserves the shared request budget before concurrent admission can race", async () => {
	const { db, lease, now } = await setup();
	const invocation = new FactoryInvocation(db, lease, () => now);
	invocation.requests = 38;
	const results = await Promise.allSettled(
		Array.from({ length: 4 }, () => invocation.beforeRequest()),
	);
	expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
	expect(invocation.requests).toBe(40);
});

it("includes other lanes' queued writes in admission while retaining save headroom", async () => {
	const { db, lease, now } = await setup();
	const invocation = new FactoryInvocation(db, lease, () => now);
	const step = lease.run.steps[0];
	if (!step) throw new Error("fixture");
	for (let index = 0; index < INVOCATION_STATEMENTS - 2; index++)
		await db.prepare("SELECT 1").first();
	invocation.pendingWrites = 3;
	expect(invocation.canStart(step)).toBe(false);
	await expect(invocation.beforeRequest()).rejects.toMatchObject({ code: "factory_yield" });
	await db.batch(Array.from({ length: 3 }, () => db.prepare("SELECT 1")));
	invocation.pendingWrites = 0;
	expect(db.statements).toBe(601);
	expect(db.statements).toBeLessThan(INVOCATION_DB_STATEMENTS);
});

it.each(["wall", "writes", "stop"])(
	"rechecks %s after waiting for the shared heartbeat lock",
	async (reason) => {
		const { db, lease, now } = await setup();
		let time = now;
		const invocation = new FactoryInvocation(db, lease, () => time);
		await expect(
			invocation.beforeRequest(async () => {
				if (reason === "wall") time = new Date(Date.parse(now) + 20_000).toISOString();
				if (reason === "writes") invocation.pendingWrites = INVOCATION_STATEMENTS;
				if (reason === "stop") invocation.stopped = true;
			}),
		).rejects.toMatchObject({ code: "factory_yield" });
		expect(invocation.requests).toBe(0);
	},
);

it("admits parallel activity after earlier work while keeping global publication boundaries", async () => {
	const { db, lease, now } = await setup();
	const invocation = new FactoryInvocation(db, lease, () => now);
	const current = lease.run.steps[0];
	if (!current) throw new Error("fixture step missing");
	invocation.completed({ ...current, kind: "snapshot", repo: "nocoo/app0" });
	const activity = { ...current, kind: "activity" as const, repo: "nocoo/app1" };
	expect(invocation.endReason(activity)).toBe("publish_boundary");
	expect(invocation.endReason(activity, true)).toBeNull();
	expect(invocation.endReason({ ...activity, kind: "snapshot" })).toBe("snapshot_boundary");
	expect(invocation.endReason({ ...activity, kind: "snapshot" }, true)).toBeNull();
	expect(invocation.endReason({ ...activity, kind: "publish", repo: null }, true)).toBe(
		"publish_boundary",
	);
	expect(
		invocation.endReason({ ...activity, kind: "snapshot", resource: "insights", repo: null }, true),
	).toBe("publish_boundary");
});
