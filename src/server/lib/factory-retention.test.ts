import { expect, it } from "vitest";
import { factoryFixture } from "../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import { createDb } from "./db/d1";
import { claimRun, startRun } from "./db/factory-runs";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { publicationWrites, repositoryWrites } from "./factory-publish";
import {
	checkResourceCapacity,
	FACTORY_STORAGE_LIMIT,
	factoryStorage,
	pruneFactory,
} from "./factory-retention";

const snap = factoryFixture();
const account = snap.account_id;
async function setup() {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,?,?,?,?)",
		)
		.bind(account, "nocoo", "encrypted", "fake", snap.fetched_at, snap.fetched_at)
		.run();
	return { raw, db };
}
it("records publication roots atomically and protects mixed-version detail when pruning old runs", async () => {
	const { raw, db } = await setup();
	await db.batch(replaceSnapshotStmts(db, account, "factory", { ...snap }, snap.fetched_at));
	const run = makeRun("root-run", account, "nocoo", "key", "refresh", snap.repos, snap.fetched_at);
	await startRun(db, run);
	const lease = await claimRun(db, run.id, snap.fetched_at);
	if (!lease) throw new Error("fixture");
	const repo = structuredClone(snap.repos[0]);
	if (!repo) throw new Error("fixture");
	repo.observation = {
		source: "run",
		version: run.id,
		refreshedAt: snap.fetched_at,
		window: snap.window,
	};
	await db.batch(await repositoryWrites(db, lease, snap.fetched_at, repo, repo.name, null));
	await db.batch(await publicationWrites(db, lease, snap.fetched_at));
	const refs = await db.prepare("SELECT * FROM factory_version_refs").all();
	expect(refs.results).toHaveLength(1);
	await db
		.prepare("UPDATE factory_runs SET status='completed',created_at='2000-01-01' WHERE id=?")
		.bind(run.id)
		.run();
	await db
		.prepare("INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,?,?,?)")
		.bind(run.id, repo.name, "commits", "{}")
		.run();
	for (let i = 0; i < 24; i++) {
		const item = makeRun(
			`old-${i}`,
			account,
			"nocoo",
			`key-${i}`,
			"catalog",
			[],
			`2010-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
		);
		item.status = "cancelled";
		await createDb(raw)
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
			)
			.bind(
				item.id,
				account,
				item.requestKey,
				"cancelled",
				JSON.stringify(item),
				item.startedAt,
				item.startedAt,
				item.startedAt,
			)
			.run();
		const rowDb = createDb(raw);
		await rowDb.batch(
			replaceSnapshotStmts(
				rowDb,
				account,
				`factory:v:${item.id}`,
				{ ...snap, runId: item.id },
				item.startedAt,
			),
		);
		await createDb(raw)
			.prepare("INSERT INTO factory_version_refs VALUES(?,?,?,?,?)")
			.bind(account, item.id, repo.name, item.id, "run")
			.run();
		await createDb(raw)
			.prepare("INSERT INTO factory_repo_versions VALUES(?,?,?,?,?)")
			.bind(account, repo.name, item.id, JSON.stringify(repo), item.startedAt)
			.run();
		await createDb(raw)
			.prepare("INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,?,?,?)")
			.bind(item.id, repo.name, "commits", "{}")
			.run();
	}
	await createDb(raw)
		.prepare("DELETE FROM factory_repo_state WHERE account_id=?")
		.bind(account)
		.run();
	expect((await factoryStorage(createDb(raw), account)).resourceBytes).toBe(50);
	await pruneFactory(createDb(raw), "2026-09-16T00:00:00.000Z");
	expect(
		(
			await createDb(raw)
				.prepare("SELECT run_id FROM factory_resources WHERE run_id=?")
				.bind(run.id)
				.all()
		).results,
	).toHaveLength(1);
	expect((await factoryStorage(createDb(raw), account)).resourceBytes).toBe(42);
	expect(await readSnapshot(createDb(raw), account, "factory")).toMatchObject({
		runId: snap.runId,
	});
	expect(await readSnapshot(createDb(raw), account, "factory:v:root-run")).not.toBeNull();
});
it("accounts for resource replacements and enforces capacity before destructive writes", async () => {
	const { db } = await setup();
	expect(await factoryStorage(db, account)).toEqual({
		resourceBytes: 0,
		limitBytes: FACTORY_STORAGE_LIMIT,
	});
	const run = makeRun("r", account, "nocoo", "k", "catalog", [], snap.fetched_at);
	await startRun(db, run);
	await checkResourceCapacity(db, account, "r", "repo", "commits", "{}");
	await db
		.prepare("INSERT INTO factory_resources VALUES(?,?,?,?)")
		.bind("r", "repo", "commits", "{}")
		.run();
	await db.prepare("UPDATE factory_resources SET payload=?").bind('{"x":1}').run();
	expect((await factoryStorage(db, account)).resourceBytes).toBe(7);
	await db.prepare("UPDATE factory_storage SET bytes=?").bind(FACTORY_STORAGE_LIMIT).run();
	await checkResourceCapacity(db, account, "r", "repo", "commits", "{}");
	await expect(
		checkResourceCapacity(db, account, "r", "another", "commits", "{}"),
	).rejects.toMatchObject({ code: "factory_capacity" });
});
