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
