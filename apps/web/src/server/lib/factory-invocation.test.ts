import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import { createDb } from "./db/d1";
import { claimRun, startRun } from "./db/factory-runs";
import { FactoryInvocation, InvocationStopped } from "./factory-invocation";

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
	return { db: createDb(raw), lease, now };
}

it("stops at the D1 admission cap with room left for the atomic save", async () => {
	const { db, lease, now } = await setup();
	const invocation = new FactoryInvocation(db, lease, () => now);
	const step = lease.run.steps[0];
	if (!step) throw new Error("fixture");
	expect(invocation.canStart(step)).toBe(true);
	for (let index = 0; index < 36; index++) await db.prepare("SELECT 1").first();
	expect(invocation.canStart(step)).toBe(false);
	for (let index = 36; index < 60; index++) await db.prepare("SELECT 1").first();
	await expect(invocation.beforeRequest()).rejects.toMatchObject({ code: "factory_yield" });
	expect(db.statements).toBe(60);
});

it("rejects expired heartbeats without extending a lost lease", async () => {
	const { db, lease, now } = await setup();
	const invocation = new FactoryInvocation(db, lease, () =>
		new Date(Date.parse(now) + 91_000).toISOString(),
	);
	await expect(invocation.heartbeat()).rejects.toEqual(new InvocationStopped(true));
	expect(lease.leaseUntil).toBe(new Date(Date.parse(now) + 90_000).toISOString());
});
