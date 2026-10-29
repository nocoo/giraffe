import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../../tests/fixtures/sqlite";
import { createDb } from "./d1";
import { publishedFactory } from "./factory-runs";
import { replaceSnapshotStmts } from "./snapshots";

it("reads the latest immutable saved publication without requiring a collection run", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
		)
		.run();
	expect(await publishedFactory(db, "a")).toBeNull();
	const snapshot = factoryFixture();
	await db.batch(
		await replaceSnapshotStmts(db, "a", "factory", { ...snapshot }, snapshot.fetched_at),
	);
	expect(await publishedFactory(db, "a")).toMatchObject({ runId: snapshot.runId });
	const version = { ...snapshot, runId: "saved-version" };
	await db.batch(
		await replaceSnapshotStmts(db, "a", "factory:v:saved-version", version, snapshot.fetched_at),
	);
	await db
		.prepare(
			"INSERT INTO factory_state(account_id,published_id,next_at) VALUES('a','saved-version','t')",
		)
		.run();
	expect(await publishedFactory(db, "a")).toMatchObject({ runId: "saved-version" });
	expect((await raw.prepare("SELECT id FROM factory_runs").all()).results).toEqual([]);
});
