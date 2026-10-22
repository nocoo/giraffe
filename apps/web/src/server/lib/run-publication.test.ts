import { expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import { createDb } from "./db/d1";
import { claimRun, getRun, saveRun, startRun } from "./db/factory-runs";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { newFactory } from "./factory-collect";
import { publicationWrites } from "./factory-publish";
import { publishSiteSnapshots } from "./site-publication";

const now = "2026-10-22T04:00:00.000Z";

it("R9 promotion uses a constant number of fenced statements across site snapshots", async () => {
	const { db, lease } = await fixture();
	for (const kind of ["issues", "prs", "repo:owner/app:details"])
		await db.batch(await replaceSnapshotStmts(db, "account", kind, { items: [] }, now, "ready"));
	expect(await publishSiteSnapshots(db, lease, now)).toHaveLength(2);
});

async function fixture() {
	const db = createDb(sqliteFixture());
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account','owner','encrypted','fake',?,?)",
		)
		.bind(now, now)
		.run();
	const run = makeRun("ready", "account", "owner", "ready", "refresh", [], now);
	run.checkpoint = newFactory("account", "owner", now);
	await db.batch(await replaceSnapshotStmts(db, "account", "factory", run.checkpoint, now));
	await startRun(db, run);
	const lease = await claimRun(db, run.id, now);
	if (!lease) throw new Error("fixture lease missing");
	return { db, lease };
}

it("R9 stages site snapshots without changing visible data until atomic publication", async () => {
	const { db, lease } = await fixture();
	await db.batch(
		await replaceSnapshotStmts(db, "account", "issues", { issues: [{ title: "old" }] }, now),
	);
	await db.batch(
		await replaceSnapshotStmts(
			db,
			"account",
			"issues",
			{ issues: [{ title: "new" }] },
			now,
			"ready",
		),
	);
	expect(await readSnapshot(db, "account", "issues")).toMatchObject({ issues: [{ title: "old" }] });
	expect(await readSnapshot(db, "account", "issues", "ready")).toMatchObject({
		issues: [{ title: "new" }],
	});
	expect((await getRun(db, "account", "ready"))?.run.publishedAt).toBeNull();
	const writes = await publicationWrites(db, lease, now);
	lease.run.status = "completed";
	lease.run.publishedAt = now;
	expect(await saveRun(db, lease, writes, now)).toBe(true);
	expect(await readSnapshot(db, "account", "issues")).toMatchObject({
		issues: [{ title: "new" }],
		publication: { runId: "ready", publishedAt: now },
	});
	expect((await getRun(db, "account", "ready"))?.run.publishedAt).toBe(now);
});

it("R9 a revoked publication fence preserves old snapshots and a null readiness marker", async () => {
	const { db, lease } = await fixture();
	await db.batch(await replaceSnapshotStmts(db, "account", "issues", { issues: [] }, now, "ready"));
	const writes = await publicationWrites(db, lease, now);
	lease.run.status = "completed";
	lease.run.publishedAt = now;
	await db.prepare("UPDATE factory_runs SET version=version+1 WHERE id='ready'").run();
	expect(await saveRun(db, lease, writes, now)).toBe(false);
	expect(await readSnapshot(db, "account", "issues")).toBeNull();
	expect((await getRun(db, "account", "ready"))?.run.publishedAt).toBeNull();
});
